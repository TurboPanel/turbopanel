/**
 * The `peak` table against a real database: an hour keeps its highest
 * readings, the window reads only recent buckets, pruning removes only buckets
 * past the grace window, and deleting the server takes its readings along.
 * Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { peak, server } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { PEAK_WINDOW_DAYS, peakBucket, prunePeaks, readPeak, recordPeak } from './peak.ts'

const test = Deno.test.bind(Deno)

const GIB = 1024 ** 3
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-23T12:30:00.000Z')

test('peakBucket is the start of the UTC hour', () => {
  assertEquals(peakBucket(NOW), '2026-10-23T12:00:00.000Z')
  assertEquals(PEAK_WINDOW_DAYS, 7)
})

test('peak rows keep the highest reading, read over the window, prune past it and cascade', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('peak table tests')
    return
  }
  const db = createDenoDb()
  const [row] = await db
    .insert(server)
    .values({
      hostname: `peak-${crypto.randomUUID()}`,
      machineKey: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, '0')
      ).join(''),
    })
    .returning({ id: server.id })
  const serverId = row!.id
  try {
    assertEquals(await readPeak(db, serverId, { now: NOW }), null)

    await recordPeak(db, serverId, { memoryBytes: 8 * GIB, cores: 4 }, NOW)
    // A lower reading in the same hour changes nothing; a higher one raises it.
    await recordPeak(db, serverId, { memoryBytes: 2 * GIB, cores: 2 }, NOW + 60_000)
    await recordPeak(db, serverId, { memoryBytes: 16 * GIB }, NOW + 120_000)
    assertEquals(await readPeak(db, serverId, { now: NOW }), { memoryBytes: 16 * GIB, cores: 4 })
    assertEquals((await db.select().from(peak).where(eq(peak.serverId, serverId))).length, 1)

    // A reading with nothing in it writes nothing.
    await recordPeak(db, serverId, {}, NOW)
    assertEquals((await db.select().from(peak).where(eq(peak.serverId, serverId))).length, 1)

    // An old hour counts inside the window, not outside it, and is then pruned.
    await recordPeak(db, serverId, { memoryBytes: 64 * GIB, cores: 16 }, NOW - 6 * DAY)
    await recordPeak(db, serverId, { memoryBytes: 128 * GIB, cores: 32 }, NOW - 9 * DAY)
    assertEquals(await readPeak(db, serverId, { now: NOW }), { memoryBytes: 64 * GIB, cores: 16 })
    assertEquals(await prunePeaks(db, { now: NOW }), 1)
    assertEquals((await db.select().from(peak).where(eq(peak.serverId, serverId))).length, 2)
    assertEquals(await prunePeaks(db, { now: NOW }), 0)

    await db.delete(server).where(eq(server.id, serverId))
    assertEquals((await db.select().from(peak).where(eq(peak.serverId, serverId))).length, 0)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
  }
})
