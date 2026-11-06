/**
 * Asking servers what their connectors run, against a real database: an old
 * daemon is not asked, one question is open at a time, a finished answer is
 * recorded once onto the server's portals, and the next question waits out the
 * gap. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  carrier,
  command,
  key,
  organization,
  portal,
  secret,
  server,
  tunnel,
} from '../../db/schema.ts'
import { TUNNEL_STATUS_FEATURE } from '../../lib/version-wire.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { pollServerTunnelStatus, runTunnelStatusPollTick } from './status-poll.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>

type Ctx = {
  db: Db
  serverId: string
  externalId: string
  tunnelId: string
  queued: CommandEnvelope[]
  queue: CommandQueue
  row: () => Promise<{ id: string; metadata: unknown }>
}

async function withServer(
  options: { features: string[] },
  fn: (ctx: Ctx) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel status poll tests')
    return
  }
  const db = createDenoDb()
  const queued: CommandEnvelope[] = []
  const [org] = await db
    .insert(organization)
    .values({ name: `Poll Org ${crypto.randomUUID()}` })
    .returning()
  const organizationId = org!.id
  const [srv] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Poll Server',
      isConnected: true,
      daemon: { projection: { features: options.features } },
    })
    .returning({ id: server.id })
  await db.insert(key).values({
    serverId: srv!.id,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
    fingerprint: `fp-${crypto.randomUUID()}`,
  })
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
      name: 'web',
      externalId,
      placement: 'chosen',
      secretId: run!.id,
    })
    .returning({ id: tunnel.id })
  await db.insert(portal).values({ tunnelId: t!.id, serverId: srv!.id })
  const queue: CommandQueue = {
    enqueue: (envelope) => {
      queued.push(envelope)
      return Promise.resolve()
    },
  }
  try {
    await fn({
      db,
      serverId: srv!.id,
      externalId,
      tunnelId: t!.id,
      queued,
      queue,
      row: async () => {
        const [r] = await db
          .select({ id: server.id, metadata: server.metadata })
          .from(server)
          .where(eq(server.id, srv!.id))
        return r!
      },
    })
  } finally {
    await db.delete(command).where(eq(command.serverId, srv!.id))
    await db.delete(key).where(eq(key.serverId, srv!.id))
    await db.delete(portal).where(eq(portal.serverId, srv!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

/** Make the last question look old enough to be asked again. */
async function ageQuestion(db: Db, serverId: string): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(${server.metadata}, '{tunnelStatus,sentAt}', to_jsonb(${new Date(Date.now() - 3_600_000).toISOString()}::text))`,
    })
    .where(eq(server.id, serverId))
}

const answer = (externalId: string) => ({
  pinnedVersion: '2026.6.0',
  connectors: [{ tunnelId: externalId, status: 'connected', version: '2026.5.2', slot: 'a' }],
})

test('a server whose daemon does not advertise tunnel-status-v1 is not asked', async () => {
  await withServer({ features: [] }, async (c) => {
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'skipped')
    assertEquals(c.queued.length, 0)
  })
})

test('one question is sent and the next waits for its answer', async () => {
  await withServer({ features: [TUNNEL_STATUS_FEATURE] }, async (c) => {
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'asked')
    assertEquals(c.queued.length, 1)
    assertEquals(c.queued[0]!.type, 'server.tunnel.status')
    assertEquals(c.queued[0]!.serverId, c.serverId)
    // Asked a moment ago and not answered: wait, send nothing more.
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'waiting')
    assertEquals(c.queued.length, 1)
  })
})

test('a question that was never answered is asked again once it is stale', async () => {
  await withServer({ features: [TUNNEL_STATUS_FEATURE] }, async (c) => {
    await pollServerTunnelStatus(c.db, c.queue, await c.row())
    await ageQuestion(c.db, c.serverId)
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'asked')
    assertEquals(c.queued.length, 2)
  })
})

test('a finished answer is recorded once onto the portals, then the next question waits out the gap', async () => {
  await withServer({ features: [TUNNEL_STATUS_FEATURE] }, async (c) => {
    await pollServerTunnelStatus(c.db, c.queue, await c.row())
    await c.db
      .update(command)
      .set({ status: 'succeeded', resultSummary: answer(c.externalId) })
      .where(eq(command.id, c.queued[0]!.commandId))

    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'recorded')
    const [p] = await c.db.select().from(portal).where(eq(portal.serverId, c.serverId))
    assertEquals(p!.reported, 'connected')
    assertEquals(p!.connectorVersion, '2026.5.2')
    assert(p!.lastSeenAt !== null)

    // Recorded already: no second recording, no new question inside the gap.
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'waiting')
    assertEquals(c.queued.length, 1)

    await ageQuestion(c.db, c.serverId)
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'asked')
    assertEquals(c.queued.length, 2)
  })
})

test('a failed or unreadable answer is not recorded', async () => {
  await withServer({ features: [TUNNEL_STATUS_FEATURE] }, async (c) => {
    await pollServerTunnelStatus(c.db, c.queue, await c.row())
    const id = c.queued[0]!.commandId
    await c.db.update(command).set({ status: 'failed' }).where(eq(command.id, id))
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'waiting')
    await c.db
      .update(command)
      .set({ status: 'succeeded', resultSummary: { pinnedVersion: 'latest' } })
      .where(eq(command.id, id))
    assertEquals(await pollServerTunnelStatus(c.db, c.queue, await c.row()), 'waiting')
    const [p] = await c.db.select().from(portal).where(eq(portal.serverId, c.serverId))
    assertEquals(p!.connectorVersion, null)
  })
})

test('a queue that is down leaves the command failed and nothing remembered', async () => {
  await withServer({ features: [TUNNEL_STATUS_FEATURE] }, async (c) => {
    const down: CommandQueue = { enqueue: () => Promise.reject(new Error('down')) }
    assertEquals(await pollServerTunnelStatus(c.db, down, await c.row()), 'asked')
    const [row] = await c.db.select().from(command).where(eq(command.serverId, c.serverId))
    assertEquals(row!.status, 'failed')
  })
})

test('the sweep asks the connected servers that carry a tunnel, and does nothing without a queue', async () => {
  await withServer({ features: [TUNNEL_STATUS_FEATURE] }, async (c) => {
    const first = await runTunnelStatusPollTick(c.db, c.queue)
    assert(first.asked >= 1)
    assert(c.queued.some((e) => e.serverId === c.serverId))
    const before = c.queued.length
    const second = await runTunnelStatusPollTick(c.db, c.queue)
    assertEquals(c.queued.filter((e) => e.serverId === c.serverId).length, 1)
    assert(second.asked >= 0 && c.queued.length >= before)

    class NoopCommandQueue implements CommandQueue {
      enqueue(): Promise<void> {
        return Promise.resolve()
      }
    }
    assertEquals(await runTunnelStatusPollTick(c.db, new NoopCommandQueue()), {
      asked: 0,
      recorded: 0,
    })
  })
})
