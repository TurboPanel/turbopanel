import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { claimDisconnectNotices } from './postgres-projection.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const GRACE_MS = 150_000
const WINDOW_MS = 30 * 60_000

test('claimDisconnectNotices claims a due plain disconnect once and leaves the rest', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('disconnect notice claim')
    return
  }
  const db = createDenoDb()
  const nowMs = Date.now()
  const ago = (ms: number) => new Date(nowMs - ms).toISOString()
  const [org] = await db
    .insert(organization)
    .values({ name: 'disconnect notice claim' })
    .returning({ id: organization.id })
  const stamp = new Date(nowMs).toISOString()
  const make = async (
    label: string,
    changedAgoMs: number,
    offlineReason: 'disconnect' | 'sweep_stale',
    isConnected = false
  ) => {
    const [row] = await db
      .insert(server)
      .values({
        createdAt: stamp,
        updatedAt: stamp,
        organizationId: org!.id,
        name: `claim-${label}-${crypto.randomUUID().slice(0, 8)}`,
        isConnected,
        statusChangedAt: ago(changedAgoMs),
        offlineReason: isConnected ? null : offlineReason,
        daemon: { projection: { hostname: label, offlineReason } },
      })
      .returning({ id: server.id })
    return row!.id
  }
  const due = await make('due', GRACE_MS + 5_000, 'disconnect')
  const inside = await make('inside', GRACE_MS - 30_000, 'disconnect')
  const swept = await make('swept', GRACE_MS + 5_000, 'sweep_stale')
  const old = await make('old', WINDOW_MS + 60_000, 'disconnect')
  const online = await make('online', GRACE_MS + 5_000, 'disconnect', true)
  const ids = [due, inside, swept, old, online]
  const opts = { nowMs, graceMs: GRACE_MS, windowMs: WINDOW_MS }
  try {
    const first = await claimDisconnectNotices(db, opts)
    assert(first.includes(due))
    for (const other of [inside, swept, old, online]) assert(!first.includes(other))

    const second = await claimDisconnectNotices(db, opts)
    assert(!second.includes(due))

    const [stored] = await db
      .select({ daemon: server.daemon })
      .from(server)
      .where(eq(server.id, due))
    const projection = (stored?.daemon as { projection: Record<string, unknown> }).projection
    assertEquals(projection.hostname, 'due')
    assertEquals(projection.offlineReason, 'disconnect')
    assertEquals(typeof projection.offlineNoticeAt, 'string')
  } finally {
    await db.delete(server).where(inArray(server.id, ids))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
})
