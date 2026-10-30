/**
 * Trusted LAN wins, against a real Postgres: two servers on a shared trusted
 * datacenter network have no tunnel between them (not peers, LAN routes
 * instead), an older daemon keeps today's tunnel, an untrusted LAN carries
 * the tunnel, cross-server networks reach servers outside a running mesh with
 * a payload that has no tunnel, the address ladder never aims at a fabric
 * address for a LAN pair or a dead tunnel, and the container range migration
 * backfills from relays. Skipped without TURBOPANEL_DATABASE_URL, the way
 * every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  command,
  datacenter,
  dispatch,
  fabric,
  ip,
  network,
  organization,
  relay,
  server,
  subnet,
} from '../../db/schema.ts'
import type { FabricReconcileCommandPayload } from '../../contracts/commands/schemas.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { resolvePrivateEndpoint } from '../net/private-endpoint.ts'
import { isFabricMembershipConverged } from './enqueue.ts'
import {
  buildFabricReconcilePayloadFromSnapshot,
  getFabricById,
  loadFabricReconcileSnapshot,
  type RelayRecord,
} from './fabric-records.ts'
import { loadPairRules } from './pair-rules.ts'
import { loadFabricPairs } from './pair-paths.ts'
import { reconcileServerNetworking } from './server-networking.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type TestDb = ReturnType<typeof createDenoDb>

const KEY_A = `${'A'.repeat(43)}=`
const KEY_B = `${'B'.repeat(42)}A=`
const KEY_C = `${'C'.repeat(42)}A=`
const LAN_ROUTES = { projection: { features: ['fabric-lan-routes-v1'] } }
const ACTOR_ID = '00000000-0000-4000-8000-0000000000ad'

type Rig = {
  db: TestDb
  organizationId: string
  fabricId: string
  datacenterId: string
  /** `alpha` and `bravo` share the trusted `rack-a` network. */
  a: string
  b: string
  /** `charlie` is in another datacenter; every server has a public address. */
  c: string
}

async function insertServer(db: TestDb, organizationId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(server)
    .values({
      organizationId,
      name,
      isConnected: true,
      statusChangedAt: new Date().toISOString(),
      daemon: LAN_ROUTES,
    })
    .returning({ id: server.id })
  return row!.id
}

async function seedLan(db: TestDb, organizationId: string, a: string, b: string): Promise<string> {
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'rack-a', addressPreference: 'ipv4' })
    .returning({ id: datacenter.id })
  const datacenterId = dc!.id
  const [lan] = await db
    .insert(network)
    .values({ organizationId, datacenterId, kind: 'datacenter', cidr: '10.0.0.0/24', name: 'lan' })
    .returning({ id: network.id })
  await db.insert(ip).values(
    [
      [a, '10.0.0.1'],
      [b, '10.0.0.2'],
    ].map(([serverId, address]) => ({
      organizationId,
      serverId,
      datacenterId,
      networkId: lan!.id,
      address,
      allocation: 'dedicated',
      scope: 'datacenter',
    }))
  )
  return datacenterId
}

async function cleanup(db: TestDb, organizationId: string): Promise<void> {
  const ids = (
    await db.select({ id: server.id }).from(server).where(eq(server.organizationId, organizationId))
  ).map((row) => row.id)
  if (ids.length > 0) {
    const commands = await db
      .select({ id: command.id })
      .from(command)
      .where(inArray(command.serverId, ids))
    if (commands.length > 0) {
      const commandIds = commands.map((row) => row.id)
      await db.delete(dispatch).where(inArray(dispatch.commandId, commandIds))
      await db.delete(command).where(inArray(command.id, commandIds))
    }
    await db.delete(subnet).where(inArray(subnet.serverId, ids))
    await db.delete(relay).where(inArray(relay.serverId, ids))
  }
  await db.delete(ip).where(eq(ip.organizationId, organizationId))
  await db.delete(network).where(eq(network.organizationId, organizationId))
  await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
  await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('TurboFabric LAN path tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Fabric LAN Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const a = await insertServer(db, organizationId, 'alpha')
    const b = await insertServer(db, organizationId, 'bravo')
    const c = await insertServer(db, organizationId, 'charlie')
    const datacenterId = await seedLan(db, organizationId, a, b)
    await db.insert(ip).values(
      [
        [a, '203.0.113.31'],
        [b, '203.0.113.32'],
        [c, '203.0.113.30'],
      ].map(([serverId, address]) => ({
        organizationId,
        serverId,
        address,
        allocation: 'dedicated',
        scope: 'public',
      }))
    )
    const [fab] = await db
      .insert(fabric)
      .values({ organizationId, cidr: '10.250.0.0/16', options: null })
      .returning({ id: fabric.id })
    const fabricId = fab!.id
    const members: Array<[string, string, string, string]> = [
      [a, '10.250.0.1', '10.192.0.0/16', KEY_A],
      [b, '10.250.0.2', '10.193.0.0/16', KEY_B],
      [c, '10.250.0.3', '10.194.0.0/16', KEY_C],
    ]
    for (const [serverId, address, prefix, publicKey] of members) {
      await db.insert(relay).values({ fabricId, serverId, address, prefix, publicKey })
      await db.update(server).set({ containerPrefix: prefix }).where(eq(server.id, serverId))
    }
    await fn({ db, organizationId, fabricId, datacenterId, a, b, c })
  } finally {
    await cleanup(db, organizationId)
    await endDbConnection(db)
  }
}

type Enabled = Extract<FabricReconcileCommandPayload, { enabled: true }>

async function payloadFor(rig: Rig, serverId: string): Promise<Enabled> {
  const record = (await getFabricById(rig.db, rig.fabricId))!
  const snapshot = await loadFabricReconcileSnapshot(rig.db, record)
  const built = await buildFabricReconcilePayloadFromSnapshot(snapshot, { serverId })
  if (!built?.payload.enabled) throw new TypeError('expected an enabled payload')
  assertEquals(built.unreachablePeers, [])
  return built.payload
}

/** A queue that records what was put on it. */
function recordingQueue(): CommandQueue & { sent: CommandEnvelope[] } {
  const sent: CommandEnvelope[] = []
  return {
    sent,
    enqueue: (envelope: CommandEnvelope) => {
      sent.push(envelope)
      return Promise.resolve()
    },
  } as unknown as CommandQueue & { sent: CommandEnvelope[] }
}

async function queuedPayloads(
  db: TestDb,
  sent: readonly CommandEnvelope[]
): Promise<Map<string, Enabled>> {
  const out = new Map<string, Enabled>()
  for (const envelope of sent) {
    const [row] = await db
      .select({ payload: dispatch.payload })
      .from(dispatch)
      .where(eq(dispatch.commandId, envelope.commandId))
    out.set(envelope.serverId, row!.payload as Enabled)
  }
  return out
}

async function networking(rig: Rig): Promise<Map<string, Enabled>> {
  const queue = recordingQueue()
  await reconcileServerNetworking({
    db: rig.db,
    commandQueue: queue,
    actor: { type: 'user', id: ACTOR_ID },
    organizationId: rig.organizationId,
    secrets: {},
  })
  return queuedPayloads(rig.db, queue.sent)
}

test('a trusted LAN pair is not a peer while the remote pair is, and each routes the other over the LAN', async () => {
  await withRig(async (rig) => {
    const alpha = await payloadFor(rig, rig.a)
    assertEquals(
      alpha.peers.map((peer) => peer.publicKey),
      [KEY_C]
    )
    assertEquals(alpha.tunnel, true)
    assertEquals(alpha.lanRoutes, [{ cidr: '10.193.0.0/16', via: '10.0.0.2' }])

    const charlie = await payloadFor(rig, rig.c)
    assertEquals(charlie.peers.map((peer) => peer.publicKey).sort(), [KEY_A, KEY_B].sort())
    assertEquals(charlie.tunnel, true)
    assertEquals(charlie.lanRoutes, [])
  })
})

test('a member whose only partners share its trusted LAN gets no tunnel', async () => {
  await withRig(async (rig) => {
    await rig.db.update(server).set({ isFabricEnabled: false }).where(eq(server.id, rig.c))
    const alpha = await payloadFor(rig, rig.a)
    assertEquals(alpha.peers, [])
    assertEquals(alpha.tunnel, false)
    assertEquals(alpha.lanRoutes, [{ cidr: '10.193.0.0/16', via: '10.0.0.2' }])
    // No tunnel, so no key is waited for: the applied hash alone converges it.
    const relays = [{ serverId: rig.a, publicKey: null, metadata: { appliedPayloadHash: 'h' } }]
    assertEquals(
      isFabricMembershipConverged({
        participatingServerIds: [rig.a],
        relays: relays as unknown as RelayRecord[],
        desiredHashByServer: new Map([[rig.a, 'h']]),
        tunnelByServer: new Map([[rig.a, false]]),
      }),
      true
    )
  })
})

test('a pair with an older daemon keeps its tunnel over the LAN', async () => {
  await withRig(async (rig) => {
    await rig.db.update(server).set({ daemon: null }).where(eq(server.id, rig.b))
    const alpha = await payloadFor(rig, rig.a)
    const bravoPeer = alpha.peers.find((peer) => peer.publicKey === KEY_B)
    assertEquals(bravoPeer?.endpoint, '10.0.0.2:51821')
    assertEquals(bravoPeer?.pathKind, 'direct_lan')
    assertEquals(alpha.lanRoutes, [])
    const bravo = await payloadFor(rig, rig.b)
    assertEquals('tunnel' in bravo || 'lanRoutes' in bravo, false)
  })
})

test('marking the LAN untrusted re-plans: the pair peers again and the tunnel runs over that LAN', async () => {
  await withRig(async (rig) => {
    const before = await networking(rig)
    assertEquals(before.get(rig.a)?.peers.length, 1)

    await rig.db
      .update(datacenter)
      .set({ isTrusted: false })
      .where(eq(datacenter.id, rig.datacenterId))
    const after = await networking(rig)
    const alpha = after.get(rig.a)!
    const bravoPeer = alpha.peers.find((peer) => peer.publicKey === KEY_B)
    assertEquals(bravoPeer?.endpoint, '10.0.0.2:51821')
    assertEquals(bravoPeer?.pathKind, 'direct_lan')
    assertEquals(alpha.lanRoutes, [])

    const pairs = await loadFabricPairs(rig.db, {
      organizationId: rig.organizationId,
      fabric: await getFabricById(rig.db, rig.fabricId),
    })
    const ab = pairs.find(
      (row) => [row.fromServerId, row.toServerId].sort().join() === [rig.a, rig.b].sort().join()
    )
    assertEquals(ab?.path, 'fabric_over_untrusted_lan')
    assertEquals(
      ab?.reason,
      'Shared network "rack-a" is untrusted: TurboFabric runs over it, encrypted.'
    )
  })
})

test('with TurboFabric off a LAN-only network plans and its servers get payloads with no tunnel', async () => {
  await withRig(async (rig) => {
    await rig.db.delete(relay).where(eq(relay.fabricId, rig.fabricId))
    await rig.db.delete(fabric).where(eq(fabric.id, rig.fabricId))

    const rules = await loadPairRules(rig.db, {
      organizationId: rig.organizationId,
      serverIds: [rig.a, rig.b, rig.c],
    })
    assertEquals(rules.pairSharesTrustedLan(rig.a, rig.b), true)
    assertEquals(rules.pairSharesTrustedLan(rig.a, rig.c), false)

    const [net] = await rig.db
      .insert(network)
      .values({ organizationId: rig.organizationId, kind: 'compose', name: 'app' })
      .returning({ id: network.id })
    await rig.db.insert(subnet).values([
      { networkId: net!.id, serverId: rig.a, cidr: '10.192.0.0/24' },
      { networkId: net!.id, serverId: rig.b, cidr: '10.193.0.0/24' },
    ])

    const sent = await networking(rig)
    assertEquals([...sent.keys()].sort(), [rig.a, rig.b].sort())
    const alpha = sent.get(rig.a)!
    assertEquals(alpha.tunnel, false)
    assertEquals(alpha.address, undefined)
    assertEquals(alpha.fabricId, undefined)
    assertEquals(alpha.peers, [])
    assertEquals(alpha.prefix, '10.192.0.0/16')
    assertEquals(
      alpha.networks?.map((row) => row.subnet),
      ['10.192.0.0/24']
    )
    assertEquals(alpha.lanRoutes, [{ cidr: '10.193.0.0/16', via: '10.0.0.2' }])
  })
})

test('the ladder never aims at a fabric address for a LAN pair or over a dead tunnel', async () => {
  await withRig(async (rig) => {
    // Both ends of the LAN report the NIC down: the LAN becomes a last resort,
    // and since the pair has no tunnel the fabric rung is skipped: public wins.
    await rig.db
      .update(ip)
      .set({ metadata: { linkDown: { since: new Date().toISOString() } } })
      .where(eq(ip.datacenterId, rig.datacenterId))
    const lanPair = await resolvePrivateEndpoint(rig.db, {
      fromServerId: rig.a,
      toServerId: rig.b,
      purpose: 'client-backend',
    })
    assertEquals('transport' in lanPair ? [lanPair.transport, lanPair.address] : lanPair, [
      'public',
      '203.0.113.32',
    ])

    // alpha's live reading shows fresh handshakes with bravo and charlie.
    const now = new Date().toISOString()
    const fresh = (at: string) => ({
      observed: {
        at: now,
        peers: [KEY_B, KEY_C].map((publicKey) => ({ publicKey, lastHandshakeAt: at })),
      },
    })
    await rig.db
      .update(relay)
      .set({ metadata: fresh(now) })
      .where(eq(relay.serverId, rig.a))
    const remote = await resolvePrivateEndpoint(rig.db, {
      fromServerId: rig.a,
      toServerId: rig.c,
      purpose: 'client-backend',
    })
    assertEquals('transport' in remote ? remote.transport : remote, 'fabric')

    // The same LAN pair with an older daemon still has a live tunnel, so it takes it.
    await rig.db.update(server).set({ daemon: null }).where(eq(server.id, rig.b))
    const olderPair = await resolvePrivateEndpoint(rig.db, {
      fromServerId: rig.a,
      toServerId: rig.b,
      purpose: 'client-backend',
    })
    assertEquals('transport' in olderPair ? olderPair.transport : olderPair, 'fabric')

    // A stale handshake means the tunnel is down: never aim at its tp0 address.
    const stale = new Date(Date.now() - 600_000).toISOString()
    await rig.db
      .update(relay)
      .set({ metadata: fresh(stale) })
      .where(eq(relay.serverId, rig.a))
    const downTunnel = await resolvePrivateEndpoint(rig.db, {
      fromServerId: rig.a,
      toServerId: rig.c,
      purpose: 'client-backend',
    })
    assertEquals('transport' in downTunnel ? downTunnel.transport : downTunnel, 'public')

    await rig.db
      .update(relay)
      .set({ metadata: fresh(now) })
      .where(eq(relay.serverId, rig.a))
    await rig.db.update(server).set({ isConnected: false }).where(eq(server.id, rig.c))
    const offline = await resolvePrivateEndpoint(rig.db, {
      fromServerId: rig.a,
      toServerId: rig.c,
      purpose: 'client-backend',
    })
    assertEquals('transport' in offline ? [offline.transport, offline.address] : offline, [
      'public',
      '203.0.113.30',
    ])
  })
})

test('the container range migration backfills a server from its relay', async () => {
  await withRig(async (rig) => {
    await rig.db.update(server).set({ containerPrefix: null }).where(eq(server.id, rig.b))
    const sql = await Deno.readTextFile(
      new URL('../../../migrations/0010_server_container_prefix.sql', import.meta.url)
    )
    const backfill = sql
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .find((part) => part.startsWith('UPDATE'))!
    await rig.db.execute(backfill)
    const [row] = await rig.db
      .select({ prefix: server.containerPrefix })
      .from(server)
      .where(eq(server.id, rig.b))
    assertEquals(row?.prefix, '10.193.0.0/16')
  })
})
