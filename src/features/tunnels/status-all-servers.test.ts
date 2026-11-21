/**
 * An all-servers tunnel stores no portal rows, so what its connectors report
 * has to be kept, shown and asked for another way: servers of the datacenter
 * are asked without a forwarding table, a recorded answer is kept on the
 * server and listed in the tunnel response, and a new tunnel is asked again
 * after the short gap. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  carrier,
  command,
  datacenter,
  ip,
  key,
  network,
  organization,
  portal,
  secret,
  server,
  tunnel,
} from '../../db/schema.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { toApiTunnel } from './lifecycle.ts'
import {
  pollServerTunnelStatus,
  runTunnelStatusPollTick,
  TUNNEL_STATUS_NEW_PORTAL_GAP_MS,
} from './status-poll.ts'
import { recordTunnelStatus } from './status.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

async function withAllServersTunnel(
  fn: (c: {
    db: ReturnType<typeof createDenoDb>
    serverIds: string[]
    skippedId: string
    externalId: string
    tunnelId: string
    queued: CommandEnvelope[]
    queue: CommandQueue
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('all-servers tunnel status tests')
    return
  }
  const db = createDenoDb()
  const queued: CommandEnvelope[] = []
  const [org] = await db
    .insert(organization)
    .values({ name: `All Org ${crypto.randomUUID()}` })
    .returning()
  const organizationId = org!.id
  let tunnelId: string = crypto.randomUUID()
  try {
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'All DC' })
      .returning({ id: datacenter.id })
    const [net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.95.0.0/24',
        name: 'LAN',
      })
      .returning({ id: network.id })
    const servers = await db
      .insert(server)
      .values(
        ['One', 'Two', 'Skipped'].map((name) => ({ organizationId, name, isConnected: true }))
      )
      .returning({ id: server.id })
    for (const [index, s] of servers.entries()) {
      await db.insert(key).values({
        serverId: s.id,
        algorithm: 'Ed25519',
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
        fingerprint: `fp-${crypto.randomUUID()}`,
      })
      await db.insert(ip).values({
        organizationId,
        datacenterId: dc!.id,
        networkId: net!.id,
        serverId: s.id,
        address: `10.95.0.${10 + index}`,
        allocation: 'dedicated',
        scope: 'datacenter',
      })
    }
    const [c] = await db
      .insert(carrier)
      .values({ organizationId, provider: 'cloudflare', name: 'Main', externalAccountId: 'acct' })
      .returning({ id: carrier.id })
    const [run] = await db
      .insert(secret)
      .values({
        organizationId,
        provider: 'tunnel_run',
        name: 'sealed',
        secretEnvelope: 'tpsecret:test',
      })
      .returning({ id: secret.id })
    const externalId = crypto.randomUUID()
    const [t] = await db
      .insert(tunnel)
      .values({
        organizationId,
        routingOrganizationId: organizationId,
        carrierId: c!.id,
        provider: 'cloudflare',
        name: 'everywhere',
        externalId,
        placement: 'all',
        datacenterId: dc!.id,
        secretId: run!.id,
      })
      .returning({ id: tunnel.id })
    tunnelId = t!.id
    const skippedId = servers[2]!.id
    await db.insert(portal).values({ tunnelId: t!.id, serverId: skippedId, wanted: 'skip' })
    const queue: CommandQueue = {
      enqueue: (envelope) => {
        queued.push(envelope)
        return Promise.resolve()
      },
    }
    await fn({
      db,
      serverIds: [servers[0]!.id, servers[1]!.id],
      skippedId,
      externalId,
      tunnelId: t!.id,
      queued,
      queue,
    })
  } finally {
    for (const s of await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, organizationId))) {
      await db.delete(command).where(eq(command.serverId, s.id))
      await db.delete(key).where(eq(key.serverId, s.id))
    }
    await db.delete(portal).where(eq(portal.tunnelId, tunnelId))
    await db.delete(tunnel).where(eq(tunnel.organizationId, organizationId))
    await db.delete(ip).where(eq(ip.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    await db.delete(carrier).where(eq(carrier.organizationId, organizationId))
    await db.delete(secret).where(eq(secret.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

const connected = (externalId: string) => ({
  pinnedVersion: '2026.6.0',
  connectors: [
    {
      tunnelId: externalId,
      status: 'connected' as const,
      version: '2026.11.1',
      slot: 'a' as const,
    },
  ],
})

test('servers of the datacenter are asked without a forwarding table', async () => {
  await withAllServersTunnel(async (c) => {
    const result = await runTunnelStatusPollTick(c.db, c.queue)
    assert(result.asked >= 2, `asked ${result.asked}`)
    const askedServers = new Set(c.queued.map((e) => e.serverId))
    for (const id of c.serverIds) assert(askedServers.has(id), 'a carrying server is asked')
  })
})

test('the tunnel response lists carrying servers as not reported, then with what they reported', async () => {
  await withAllServersTunnel(async (c) => {
    const [row] = await c.db.select().from(tunnel).where(eq(tunnel.id, c.tunnelId))
    const before = await toApiTunnel(c.db, row!)
    // Two carrying servers plus the stored skip portal.
    assertEquals(before.portals.filter((p) => p.wanted === 'run').length, 2)
    assert(before.portals.every((p) => p.reported === 'unknown'))
    assert(before.portals.every((p) => p.connectorVersion === null))

    await recordTunnelStatus(c.db, c.serverIds[0]!, connected(c.externalId))
    const [after] = await c.db.select().from(tunnel).where(eq(tunnel.id, c.tunnelId))
    assertEquals(after!.status, 'active')
    const shown = await toApiTunnel(c.db, after!)
    const one = shown.portals.find((p) => p.serverId === c.serverIds[0])
    assertEquals(one?.reported, 'connected')
    assertEquals(one?.connectorVersion, '2026.11.1')
    assert(one?.lastSeenAt)
    const two = shown.portals.find((p) => p.serverId === c.serverIds[1])
    assertEquals(two?.reported, 'unknown')
    // The skip portal stays as it is.
    assertEquals(shown.portals.filter((p) => p.wanted === 'skip').length, 1)
  })
})

test('a later answer replaces the kept reports, so a connector no longer listed leaves nothing', async () => {
  await withAllServersTunnel(async (c) => {
    await recordTunnelStatus(c.db, c.serverIds[0]!, connected(c.externalId))
    await recordTunnelStatus(c.db, c.serverIds[0]!, { pinnedVersion: '2026.6.0', connectors: [] })
    const [s] = await c.db.select().from(server).where(eq(server.id, c.serverIds[0]!))
    assertEquals((s!.metadata as Record<string, unknown> | null)?.tunnelConnectorReports, undefined)
  })
})

test('a new all-servers tunnel is asked again after the short gap until a server reports', async () => {
  await withAllServersTunnel(async (c) => {
    const id = c.serverIds[0]!
    const row = async () => {
      const [r] = await c.db.select().from(server).where(eq(server.id, id))
      return { id, metadata: r!.metadata }
    }
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row()), 'asked')
    await c.db
      .update(command)
      .set({ status: 'succeeded', resultSummary: { pinnedVersion: '2026.6.0', connectors: [] } })
      .where(eq(command.id, c.queued[0]!.commandId))
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row()), 'recorded')
    const soon = Date.now() + TUNNEL_STATUS_NEW_PORTAL_GAP_MS + 5_000
    // Nothing reported for the new tunnel yet: the short gap applies.
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row(), soon), 'asked')
  })
})

/** Answer the first question sent to a server, as the daemon would with nothing running. */
async function askAndAnswer(
  c: Parameters<Parameters<typeof withAllServersTunnel>[0]>[0],
  id: string
) {
  const row = async () => {
    const [r] = await c.db.select().from(server).where(eq(server.id, id))
    return { id, metadata: r!.metadata }
  }
  assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row()), 'asked')
  const sent = c.queued.filter((e) => e.serverId === id).at(-1)!
  await c.db
    .update(command)
    .set({ status: 'succeeded', resultSummary: { pinnedVersion: '2026.6.0', connectors: [] } })
    .where(eq(command.id, sent.commandId))
  assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row()), 'recorded')
  return row
}

const soonAfter = () => Date.now() + TUNNEL_STATUS_NEW_PORTAL_GAP_MS + 5_000
const longAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

test('a new tunnel in another datacenter does not fast-poll servers of this one', async () => {
  await withAllServersTunnel(async (c) => {
    const [mine] = await c.db.select().from(tunnel).where(eq(tunnel.id, c.tunnelId))
    const organizationId = mine!.organizationId
    // This tunnel is old; a new all-servers tunnel starts in a second datacenter.
    await c.db.update(tunnel).set({ updatedAt: longAgo() }).where(eq(tunnel.id, c.tunnelId))
    const [dc2] = await c.db
      .insert(datacenter)
      .values({ organizationId, name: 'Other DC' })
      .returning({ id: datacenter.id })
    await c.db.insert(tunnel).values({
      organizationId,
      routingOrganizationId: organizationId,
      carrierId: mine!.carrierId,
      provider: 'cloudflare',
      name: 'elsewhere',
      externalId: crypto.randomUUID(),
      placement: 'all',
      datacenterId: dc2!.id,
      secretId: mine!.secretId,
    })
    const row = await askAndAnswer(c, c.serverIds[0]!)
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row(), soonAfter()), 'waiting')
  })
})

test('a server left out by a skip portal is not fast-polled for the tunnel', async () => {
  await withAllServersTunnel(async (c) => {
    // The skip row is old too, so only the all-servers rule could ask early.
    await c.db.update(portal).set({ createdAt: longAgo() }).where(eq(portal.tunnelId, c.tunnelId))
    const row = await askAndAnswer(c, c.skippedId)
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row(), soonAfter()), 'waiting')
  })
})

test('a server marked as never carrying tunnels is neither asked nor fast-polled for it', async () => {
  await withAllServersTunnel(async (c) => {
    const id = c.serverIds[0]!
    await c.db
      .update(server)
      .set({ options: { tunnels: { carry: false } } })
      .where(eq(server.id, id))
    await runTunnelStatusPollTick(c.db, c.queue)
    assert(!c.queued.some((e) => e.serverId === id), 'a server that never carries is not asked')
    const row = await askAndAnswer(c, id)
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row(), soonAfter()), 'waiting')
  })
})

test('a tunnel moved to all servers is asked again after the short gap', async () => {
  await withAllServersTunnel(async (c) => {
    // Made long ago, then changed just now: the change restarts the window.
    await c.db.update(tunnel).set({ createdAt: longAgo() }).where(eq(tunnel.id, c.tunnelId))
    const row = await askAndAnswer(c, c.serverIds[0]!)
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await row(), soonAfter()), 'asked')
  })
})
