/**
 * The offline mark against a real Postgres: a late socket close must never
 * downgrade an earlier stale-sweep mark (host-loss failover trusts only the
 * sweep mark) or restart its clock. Skipped without TURBOPANEL_DATABASE_URL.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { key, organization, server } from '../../db/schema.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { projectServerDaemon } from './postgres-projection.ts'

/** Sonar typescript:S2187 only recognizes `test()`; see postgres-projection.test.ts. */
const test = Deno.test.bind(Deno)

const SWEEP_AT = '2020-01-01T00:00:00.000Z'

async function withServer(
  fn: (
    db: ReturnType<typeof createDenoDb>,
    serverId: string,
    read: () => Promise<{ reason: unknown; at: string | null; connected: boolean }>
  ) => Promise<void>
): Promise<void> {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('offline mark projection tests')
    return
  }
  const db = createDenoDb()
  let organizationId: string | undefined
  try {
    const [org] = await db
      .insert(organization)
      .values({ name: 'Offline Mark Org' })
      .returning({ id: organization.id })
    organizationId = org!.id
    const [row] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Offline Mark Server',
        isConnected: true,
        statusChangedAt: SWEEP_AT,
      })
      .returning({ id: server.id })
    const serverId = row!.id
    // Projection only reaches enrolled servers: a key row is required.
    await db.insert(key).values({
      serverId,
      algorithm: 'Ed25519',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'offline-mark-test' },
      fingerprint: `offline-mark-${serverId}`,
    })
    const read = async () => {
      const [r] = await db
        .select({
          daemon: server.daemon,
          at: server.statusChangedAt,
          connected: server.isConnected,
        })
        .from(server)
        .where(eq(server.id, serverId))
      const projection = (r?.daemon as { projection?: { offlineReason?: unknown } } | null)
        ?.projection
      return {
        reason: projection?.offlineReason,
        at: r?.at ? new Date(r.at).toISOString() : null,
        connected: Boolean(r?.connected),
      }
    }
    await fn(db, serverId, read)
  } finally {
    if (organizationId) {
      await db.delete(server).where(eq(server.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
    await endDbConnection(db)
  }
}

test('a stale-sweep mark survives a late socket close, timestamp included', async () => {
  await withServer(async (db, serverId, read) => {
    await projectServerDaemon(db, serverId, { kind: 'offline', reason: 'sweep_stale' })
    const marked = await read()
    assertEquals(marked.reason, 'sweep_stale')
    assertEquals(marked.connected, false)

    await projectServerDaemon(db, serverId, { kind: 'disconnected', reason: 'disconnect' })
    assertEquals(await read(), marked)
    await projectServerDaemon(db, serverId, { kind: 'disconnected' })
    assertEquals(await read(), marked)
  })
})

test('a disconnect mark is upgraded by a later stale sweep', async () => {
  await withServer(async (db, serverId, read) => {
    await projectServerDaemon(db, serverId, { kind: 'disconnected', reason: 'disconnect' })
    assertEquals((await read()).reason, 'disconnect')
    await projectServerDaemon(db, serverId, { kind: 'offline', reason: 'sweep_stale' })
    assertEquals((await read()).reason, 'sweep_stale')
  })
})

test('coming online clears the mark', async () => {
  await withServer(async (db, serverId, read) => {
    await projectServerDaemon(db, serverId, { kind: 'offline', reason: 'sweep_stale' })
    await projectServerDaemon(db, serverId, { kind: 'online', identity: { hostname: 'h' } })
    const after = await read()
    assertEquals(after.reason, undefined)
    assertEquals(after.connected, true)
  })
})
