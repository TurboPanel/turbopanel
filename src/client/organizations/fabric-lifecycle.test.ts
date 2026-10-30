/**
 * Switching a server out of TurboFabric against a real Postgres, through the
 * route's own lifecycle code: the switch is written first and undone when the
 * tunnel cannot be taken down or when something comes to depend on the server
 * in between. Skipped without TURBOPANEL_DATABASE_URL, the way every Postgres
 * suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertNotEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, type Db, endDbConnection } from '../../db/connection.ts'
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
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { applyServerFabricPatch, pauseFabric, removeFabric } from './fabric-lifecycle.ts'
import { readFabricReconcileOutcome } from '../../features/fabric/reconcile-outcome.ts'
import { FABRIC_RETAIN_KEYS_FEATURE } from '../../lib/version-wire.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

/** Only what the lifecycle code reads from a Hono context. */
const fakeContext = {
  json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
} as unknown as Context

type Rig = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  fabricId: string
  serverId: string
}

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('TurboFabric switch-off route tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Fabric Lifecycle Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'switch-me',
        isConnected: true,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    const serverId = srv!.id
    const [fab] = await db
      .insert(fabric)
      .values({ organizationId, cidr: '10.250.0.0/16', options: null })
      .returning({ id: fabric.id })
    await db
      .insert(relay)
      .values({ fabricId: fab!.id, serverId, address: '10.250.0.1', prefix: '10.192.0.0/16' })
    await fn({ db, organizationId, fabricId: fab!.id, serverId })
  } finally {
    await db.delete(subnet).where(eq(subnet.cidr, '10.192.1.0/24'))
    await db.delete(ip).where(eq(ip.organizationId, organizationId))
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    const rows = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, organizationId))
    const commands = await db
      .select({ id: command.id })
      .from(command)
      .where(
        inArray(
          command.serverId,
          rows.map((row) => row.id)
        )
      )
    if (commands.length > 0) {
      const commandIds = commands.map((row) => row.id)
      await db.delete(dispatch).where(inArray(dispatch.commandId, commandIds))
      await db.delete(command).where(inArray(command.id, commandIds))
    }
    for (const row of rows) await db.delete(relay).where(eq(relay.serverId, row.id))
    await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

function queue(fails: boolean): CommandQueue {
  return {
    enqueue: () => (fails ? Promise.reject(new Error('queue down')) : Promise.resolve()),
  } as unknown as CommandQueue
}

function switchOff(db: Db, rig: Rig, commandQueue: CommandQueue): Promise<Response | null> {
  return applyServerFabricPatch(fakeContext, {
    db,
    commandQueue,
    organizationId: rig.organizationId,
    actorId: crypto.randomUUID(),
    secrets: {},
    serverId: rig.serverId,
    serverName: 'switch-me',
    currentlyEnabled: true,
    patch: { enabled: false },
  })
}

async function switchedOn(db: Db, serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: server.isFabricEnabled })
    .from(server)
    .where(eq(server.id, serverId))
  return row!.on
}

async function relayKept(db: Db, serverId: string): Promise<boolean> {
  const rows = await db.select({ id: relay.id }).from(relay).where(eq(relay.serverId, serverId))
  return rows.length === 1
}

test('switching off writes the switch, keeps the relay and takes the tunnel down', async () => {
  await withRig(async (rig) => {
    const refused = await switchOff(rig.db, rig, queue(false))
    assertEquals(refused, null)
    assertEquals(await switchedOn(rig.db, rig.serverId), false)
    assertEquals(await relayKept(rig.db, rig.serverId), true)
  })
})

async function reconcileOf(db: Db, serverId: string) {
  const [row] = await db
    .select({ metadata: relay.metadata })
    .from(relay)
    .where(eq(relay.serverId, serverId))
  return readFabricReconcileOutcome(row?.metadata)
}

test('turning off an already-off TurboFabric asks every server again', async () => {
  await withRig(async (rig) => {
    await rig.db
      .update(server)
      .set({ daemon: { projection: { features: [FABRIC_RETAIN_KEYS_FEATURE] } } })
      .where(eq(server.id, rig.serverId))
    const params = {
      db: rig.db,
      commandQueue: queue(false),
      organizationId: rig.organizationId,
      actorId: crypto.randomUUID(),
      secrets: {},
    }
    assertEquals(await pauseFabric(fakeContext, params), null)
    const first = await reconcileOf(rig.db, rig.serverId)
    assertEquals(first?.action, 'pause')
    assertEquals(first?.state, 'pending')

    assertEquals(await pauseFabric(fakeContext, params), null)
    const again = await reconcileOf(rig.db, rig.serverId)
    assertEquals(again?.state, 'pending')
    assertNotEquals(again?.commandId, first?.commandId)
  })
})

test('switching off is undone when the tunnel cannot be taken down', async () => {
  await withRig(async (rig) => {
    const refused = await switchOff(rig.db, rig, queue(true))
    assertEquals(refused?.status, 503)
    assertEquals(((await refused!.json()) as { error: string }).error, 'fabric_teardown_not_queued')
    assertEquals(await switchedOn(rig.db, rig.serverId), true)
    assertEquals(await relayKept(rig.db, rig.serverId), true)
  })
})

/**
 * A database handle that, right after the switch is written, lets a deploy
 * create a cross-server network piece on the server: the race the check after
 * the write is there for.
 */
function racingDb(db: ReturnType<typeof createDenoDb>, rig: Rig): Db {
  let raced = false
  const race = async () => {
    const [net] = await db
      .insert(network)
      .values({ organizationId: rig.organizationId, kind: 'compose', name: 'tpn_race' })
      .returning({ id: network.id })
    await db
      .insert(subnet)
      .values({ networkId: net!.id, serverId: rig.serverId, cidr: '10.192.1.0/24' })
  }
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'update') return Reflect.get(target, key, receiver)
      return (table: unknown) => {
        const builder = target.update(table as typeof server)
        if (table !== server) return builder
        return {
          set: (values: { isFabricEnabled?: boolean }) => {
            const pending = builder.set(values)
            return {
              where: async (condition: Parameters<typeof pending.where>[0]) => {
                const result = await pending.where(condition)
                if (values.isFabricEnabled === false && !raced) {
                  raced = true
                  await race()
                }
                return result
              },
            }
          },
        }
      }
    },
  }) as unknown as Db
}

test('a network created on the server while switching off undoes the switch', async () => {
  await withRig(async (rig) => {
    const refused = await switchOff(racingDb(rig.db, rig), rig, queue(false))
    assertEquals(refused?.status, 409)
    const body = (await refused!.json()) as { error: string; message: string }
    assertEquals(body.error, 'fabric_server_in_use')
    assertEquals(body.message.includes('container network "tpn_race"'), true)
    assertEquals(await switchedOn(rig.db, rig.serverId), true)
  })
})

const LAN_ROUTES = { projection: { features: ['fabric-lan-routes-v1'] } }

async function addServer(rig: Rig, name: string, prefix: string, address: string): Promise<string> {
  const [srv] = await rig.db
    .insert(server)
    .values({
      organizationId: rig.organizationId,
      name,
      isConnected: true,
      statusChangedAt: new Date().toISOString(),
      daemon: LAN_ROUTES,
      containerPrefix: prefix,
    })
    .returning({ id: server.id })
  await rig.db.insert(relay).values({ fabricId: rig.fabricId, serverId: srv!.id, address, prefix })
  return srv!.id
}

/**
 * `switch-me` and a new `partner` share a trusted LAN and hold the LAN-only
 * container network `lan-app`; `faraway` (another datacenter) and `switch-me`
 * hold `wide-app`, which needs a tunnel, unless `withWide` is false.
 */
async function seedLanNetworks(
  rig: Rig,
  withWide: boolean
): Promise<{ partner: string; lanApp: string; wideApp: string | null }> {
  await rig.db
    .update(server)
    .set({ daemon: LAN_ROUTES, containerPrefix: '10.192.0.0/16' })
    .where(eq(server.id, rig.serverId))
  const partner = await addServer(rig, 'partner', '10.193.0.0/16', '10.250.0.2')
  const [dc] = await rig.db
    .insert(datacenter)
    .values({ organizationId: rig.organizationId, name: 'rack-a', addressPreference: 'ipv4' })
    .returning({ id: datacenter.id })
  const [lan] = await rig.db
    .insert(network)
    .values({
      organizationId: rig.organizationId,
      datacenterId: dc!.id,
      kind: 'datacenter',
      cidr: '10.0.0.0/24',
      name: 'lan',
    })
    .returning({ id: network.id })
  await rig.db.insert(ip).values(
    [
      [rig.serverId, '10.0.0.1'],
      [partner, '10.0.0.2'],
    ].map(([serverId, address]) => ({
      organizationId: rig.organizationId,
      serverId,
      datacenterId: dc!.id,
      networkId: lan!.id,
      address,
      allocation: 'dedicated',
      scope: 'datacenter',
    }))
  )
  const lanApp = await composeNetwork(rig, 'lan-app', [
    [rig.serverId, '10.192.2.0/24'],
    [partner, '10.193.2.0/24'],
  ])
  if (!withWide) return { partner, lanApp, wideApp: null }
  const faraway = await addServer(rig, 'faraway', '10.194.0.0/16', '10.250.0.3')
  const wideApp = await composeNetwork(rig, 'wide-app', [
    [rig.serverId, '10.192.3.0/24'],
    [faraway, '10.194.3.0/24'],
  ])
  return { partner, lanApp, wideApp }
}

async function composeNetwork(
  rig: Rig,
  name: string,
  pieces: ReadonlyArray<[string, string]>
): Promise<string> {
  const [net] = await rig.db
    .insert(network)
    .values({ organizationId: rig.organizationId, kind: 'compose', name, composeKey: name })
    .returning({ id: network.id })
  await rig.db
    .insert(subnet)
    .values(pieces.map(([serverId, cidr]) => ({ networkId: net!.id, serverId, cidr })))
  return net!.id
}

type Enabled = Extract<FabricReconcileCommandPayload, { enabled: true }>

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

/** The last payload with a tunnel field queued for each server. */
async function lastPayloads(
  db: Db,
  sent: readonly CommandEnvelope[]
): Promise<Map<string, FabricReconcileCommandPayload>> {
  const out = new Map<string, FabricReconcileCommandPayload>()
  for (const envelope of sent) {
    const [row] = await db
      .select({ payload: dispatch.payload })
      .from(dispatch)
      .where(eq(dispatch.commandId, envelope.commandId))
    out.set(envelope.serverId, row!.payload as FabricReconcileCommandPayload)
  }
  return out
}

async function networkExists(db: Db, id: string): Promise<boolean> {
  return (await db.select({ id: network.id }).from(network).where(eq(network.id, id))).length === 1
}

test('removing TurboFabric completely keeps a LAN-only network and resends its servers their payload', async () => {
  await withRig(async (rig) => {
    const { partner, lanApp, wideApp } = await seedLanNetworks(rig, true)
    const commandQueue = recordingQueue()
    const refused = await removeFabric(fakeContext, {
      db: rig.db,
      commandQueue,
      organizationId: rig.organizationId,
      actorId: crypto.randomUUID(),
      secrets: {},
    })
    assertEquals(refused, null)
    assertEquals(await networkExists(rig.db, lanApp), true)
    assertEquals(await networkExists(rig.db, wideApp!), false)

    const last = await lastPayloads(rig.db, commandQueue.sent)
    for (const [serverId, via] of [
      [rig.serverId, '10.0.0.2'],
      [partner, '10.0.0.1'],
    ]) {
      const payload = last.get(serverId!) as Enabled
      assertEquals(payload.enabled, true)
      assertEquals(payload.tunnel, false)
      assertEquals(payload.lanRoutes?.[0]?.via, via)
    }
    const [mine] = [last.get(rig.serverId) as Enabled]
    assertEquals(
      mine.networks?.map((row) => row.subnet),
      ['10.192.2.0/24']
    )
  })
})

test('a server holding only LAN-only networks switches off and keeps its network', async () => {
  await withRig(async (rig) => {
    const { lanApp } = await seedLanNetworks(rig, false)
    const commandQueue = recordingQueue()
    const refused = await switchOff(rig.db, rig, commandQueue)
    assertEquals(refused, null)
    assertEquals(await switchedOn(rig.db, rig.serverId), false)
    assertEquals(await networkExists(rig.db, lanApp), true)
    const last = (await lastPayloads(rig.db, commandQueue.sent)).get(rig.serverId) as Enabled
    assertEquals(last.tunnel, false)
    assertEquals(last.lanRoutes, [{ cidr: '10.193.0.0/16', via: '10.0.0.2' }])
  })
})
