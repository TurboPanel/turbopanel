/**
 * Sending forwarding tables against a real database: offline and old-daemon
 * servers are left alone, a server that should hold no table and never got one
 * is not bothered, a server that should now hold none is told, and a send that
 * did not finish is repeated. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { command, key, organization, server } from '../../db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { TUNNEL_FORWARDING_FEATURE } from '../../lib/version-wire.ts'
import { getCommandDispatchPayload } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { runTunnelRoutesSweepTick, syncServerTunnelRoutes } from './sync.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

async function withServer(
  options: { connected: boolean; features: string[] },
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
    queued: CommandEnvelope[]
    deps: Parameters<typeof syncServerTunnelRoutes>[1]
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel sync tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const queued: CommandEnvelope[] = []
  const [org] = await db.insert(organization).values({ name: 'Tunnel Sync Org' }).returning()
  const [row] = await db
    .insert(server)
    .values({
      organizationId: org!.id,
      name: 'Sync Server',
      isConnected: options.connected,
      daemon: { projection: { features: options.features } },
    })
    .returning({ id: server.id })
  await db.insert(key).values({
    serverId: row!.id,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
    fingerprint: `fp-${crypto.randomUUID()}`,
  })
  try {
    await fn({
      db,
      organizationId: org!.id,
      serverId: row!.id,
      queued,
      deps: {
        commandQueue: {
          enqueue: (envelope) => {
            queued.push(envelope)
            return Promise.resolve()
          },
        },
        secretsConfig,
        dataEncryptionSecrets,
      },
    })
  } finally {
    await db.delete(command).where(eq(command.serverId, row!.id))
    await db.delete(key).where(eq(key.serverId, row!.id))
    await db.delete(server).where(eq(server.id, row!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
}

test('an offline server and an old daemon are skipped', async () => {
  await withServer({ connected: false, features: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    const outcome = await syncServerTunnelRoutes(c.db, c.deps, c)
    assertEquals(outcome, { status: 'skipped', reason: 'server offline' })
  })
  await withServer({ connected: true, features: [] }, async (c) => {
    const outcome = await syncServerTunnelRoutes(c.db, c.deps, c)
    assertEquals(outcome, { status: 'skipped', reason: 'daemon too old' })
    assertEquals(c.queued.length, 0)
  })
})

test('a server that should hold no table and never got one is left alone', async () => {
  await withServer({ connected: true, features: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    assertEquals(await syncServerTunnelRoutes(c.db, c.deps, c), { status: 'unchanged' })
    assertEquals(c.queued.length, 0)
  })
})

test('a server that once held a table is told to drop it, and a send that failed is repeated', async () => {
  await withServer({ connected: true, features: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await c.db
      .update(server)
      .set({
        metadata: sql`jsonb_build_object('tunnelRoutes', jsonb_build_object('stateHash', ${'b'.repeat(64)}::text, 'commandId', ${crypto.randomUUID()}::text, 'sentAt', ${new Date().toISOString()}::text, 'forwarded', 1))`,
      })
      .where(eq(server.id, c.serverId))
    const first = await syncServerTunnelRoutes(c.db, c.deps, c)
    assertEquals(first.status, 'sent')
    assertEquals(c.queued.length, 1)
    assertEquals(c.queued[0]!.type, 'server.tunnel.routes')
    const payload = JSON.stringify(await getCommandDispatchPayload(c.db, c.queued[0]!.commandId))
    assert(payload.includes('"routes":[]') && payload.includes('"peerAddresses":[]'))
    // Still moving: nothing more is sent.
    assertEquals(await syncServerTunnelRoutes(c.db, c.deps, c), { status: 'unchanged' })
    // The command failed (the server was offline): the next pass sends it again.
    await c.db.update(command).set({ status: 'failed' }).where(eq(command.serverId, c.serverId))
    assertEquals((await syncServerTunnelRoutes(c.db, c.deps, c)).status, 'sent')
    assertEquals(c.queued.length, 2)
    // The sweep reaches the same server through its remembered table.
    await c.db.update(command).set({ status: 'failed' }).where(eq(command.serverId, c.serverId))
    const swept = await runTunnelRoutesSweepTick(c.db, c.deps)
    assert(swept.sent >= 1)
  })
})
