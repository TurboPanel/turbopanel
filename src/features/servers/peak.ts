/**
 * Highest RAM and physical core readings per server, kept per UTC hour in the
 * `peak` table. The over-tier rules judge a server on the highest reading of
 * the last 7 days (the grace window), so ballooning memory or a hot-added core
 * never flips the verdict on one low sample.
 *
 * Hourly buckets: 7 days is 168 rows per server at most, a write only happens
 * when a reading beats the hour's stored figure, and the window edge is exact
 * to the hour (daily buckets would stretch a 7-day window to 8).
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { peak } from '../../db/schema.ts'

/** Days a reading counts for the over-tier rules; older buckets are pruned. */
export const PEAK_WINDOW_DAYS = 7

/** Rows removed per prune call (the cron runs it every 15 minutes). */
export const PEAK_PRUNE_BATCH_LIMIT = 2000

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

export type PeakReading = {
  /** Total RAM in bytes; omit when the report carried none. */
  memoryBytes?: number | null
  /** Physical core count; omit when the report carried none. */
  cores?: number | null
}

export type ServerPeak = {
  memoryBytes: number | null
  cores: number | null
}

/** Start of the UTC hour containing `ms`, as an ISO string. */
export function peakBucket(ms: number): string {
  return new Date(Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR).toISOString()
}

function validReading(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null
}

/**
 * Raise the stored figures for the hour containing `at` to the readings given.
 * Never lowers a figure, and an unchanged hour writes nothing.
 */
export async function recordPeak(
  db: Db,
  serverId: string,
  reading: PeakReading,
  at: number = Date.now()
): Promise<void> {
  const memoryBytes = validReading(reading.memoryBytes)
  const cores = validReading(reading.cores)
  if (memoryBytes === null && cores === null) return
  await db
    .insert(peak)
    .values({ serverId, bucket: peakBucket(at), memoryBytes, cores })
    .onConflictDoUpdate({
      target: [peak.serverId, peak.bucket],
      set: {
        memoryBytes: sql`GREATEST(${peak.memoryBytes}, excluded.memory_bytes)`,
        cores: sql`GREATEST(${peak.cores}, excluded.cores)`,
      },
      setWhere: sql`excluded.memory_bytes > COALESCE(${peak.memoryBytes}, -1)
        OR excluded.cores > COALESCE(${peak.cores}, -1)`,
    })
}

/**
 * The highest RAM and cores read in the last `windowDays` days, or `null` when
 * the window holds no reading.
 */
export async function readPeak(
  db: Db,
  serverId: string,
  opts: { now?: number; windowDays?: number } = {}
): Promise<ServerPeak | null> {
  const now = opts.now ?? Date.now()
  const since = peakBucket(now - (opts.windowDays ?? PEAK_WINDOW_DAYS) * MS_PER_DAY)
  const [row] = await db
    .select({
      memoryBytes: sql<string | null>`max(${peak.memoryBytes})`,
      cores: sql<number | null>`max(${peak.cores})`,
    })
    .from(peak)
    .where(and(eq(peak.serverId, serverId), gte(peak.bucket, since)))
  if (!row || (row.memoryBytes === null && row.cores === null)) return null
  return {
    memoryBytes: row.memoryBytes === null ? null : Number(row.memoryBytes),
    cores: row.cores === null ? null : Number(row.cores),
  }
}

/**
 * Delete up to `limit` buckets older than the grace window; returns how many
 * went. A database error propagates to the caller (the sweep traces it).
 */
export async function prunePeaks(
  db: Db,
  opts: { now?: number; limit?: number; windowDays?: number } = {}
): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? PEAK_PRUNE_BATCH_LIMIT), 1), 5000)
  const cutoff = peakBucket(
    (opts.now ?? Date.now()) - (opts.windowDays ?? PEAK_WINDOW_DAYS) * MS_PER_DAY
  )
  const deleted = await db
    .delete(peak)
    .where(
      sql`${peak.id} in (
        select p.id from ${peak} p
        where p.bucket < ${cutoff}::timestamptz
        order by p.bucket
        limit ${limit}
      )`
    )
    .returning({ id: peak.id })
  return deleted.length
}
