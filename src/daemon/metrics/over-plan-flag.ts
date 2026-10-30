/**
 * The server-record side of the over-plan check (`over-plan.ts`): keep the
 * hour's highest RAM and physical core readings in the `peak` table, judge the
 * server on the highest of the last 7 days, stamp `server.metadata.overPlan`
 * when that is past the licensed box size, and clear it once the window holds
 * no reading past it. The sample itself is stored either way, and nothing here
 * ever refuses a sample or touches the server.
 *
 * Cost: each isolate remembers what it last wrote and judged per server, so a
 * steady server costs one upsert, one read and at most one stamp write per UTC
 * hour, not one per sample. A reading that beats the hour's figure, or a tier
 * change, is written and judged at once.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { parseServerHostResources } from '../../features/servers/server-metadata.ts'
import { peakBucket, readPeak, recordPeak } from '../../features/servers/peak.ts'
import { totalPhysicalCores } from '../../features/tiers/tier-placement.ts'
import { evaluateOverPlanFromPeak, isOverPlan, type OverPlan } from './over-plan.ts'

const OVER_PLAN_REFRESH_SECONDS = 3600

/** Servers remembered per isolate before the memo starts over. */
const PEAK_MEMO_LIMIT = 10_000

/**
 * `at` is when the stamp was last refreshed; `since` is when the server first
 * went over in this run of being over (kept across refreshes).
 */
export type OverPlanMetadata = { at: string; since: string; memory: boolean; cpu: boolean }

type PeakMemo = {
  bucket: string
  memoryBytes: number
  cores: number
  tierRank: number | null
}

const peakMemo = new Map<string, PeakMemo>()

/** Test hook: forget what this isolate already wrote and judged. */
export function resetOverPlanMemoForTests(): void {
  peakMemo.clear()
}

/** The stamp on a server's metadata, or `null` when it is not flagged. */
export function readOverPlanStamp(serverMetadata: unknown): OverPlanMetadata | null {
  if (typeof serverMetadata !== 'object' || serverMetadata === null) return null
  const stamp = (serverMetadata as Record<string, unknown>).overPlan
  if (typeof stamp !== 'object' || stamp === null) return null
  const { at, since, memory, cpu } = stamp as Record<string, unknown>
  if (typeof at !== 'string') return null
  return {
    at,
    since: typeof since === 'string' ? since : at,
    memory: memory === true,
    cpu: cpu === true,
  }
}

function positive(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The readings this report gives: total RAM is the higher of the sample's own
 * size (read every minute) and the host report's; physical cores come from the
 * host report only (one entry per socket), since the sample carries logical
 * CPUs, which are never the plan's unit. An older daemon that sends no sample
 * sizes falls back to the host report alone. 0 means no reading.
 */
export function peakReadingFromReport(
  serverMetadata: unknown,
  sampleMemoryTotalBytes: number | null | undefined
): { memoryBytes: number; cores: number } {
  const metadata =
    typeof serverMetadata === 'object' && serverMetadata !== null
      ? (serverMetadata as Record<string, unknown>)
      : undefined
  const resources = parseServerHostResources(metadata?.resources)
  return {
    memoryBytes: Math.max(
      positive(sampleMemoryTotalBytes),
      positive(resources?.memory?.totalBytes)
    ),
    cores: resources === undefined ? 0 : totalPhysicalCores(resources),
  }
}

/**
 * Record the report's readings in the hour's peak row and flag or unflag the
 * server from the highest readings of the grace window. `serverMetadata` is
 * the record the ingest route already loaded, so a steady server within the
 * hour costs no query at all.
 */
export async function recordOverPlan(
  db: Db,
  serverId: string,
  tierRank: number | null | undefined,
  serverMetadata: unknown,
  sampleMemoryTotalBytes?: number | null,
  now: number = Date.now()
): Promise<void> {
  const reading = peakReadingFromReport(serverMetadata, sampleMemoryTotalBytes)
  const bucket = peakBucket(now)
  const rank = tierRank ?? null
  const memo = peakMemo.get(serverId)
  if (
    memo !== undefined &&
    memo.bucket === bucket &&
    memo.tierRank === rank &&
    reading.memoryBytes <= memo.memoryBytes &&
    reading.cores <= memo.cores
  ) {
    return
  }

  await recordPeak(
    db,
    serverId,
    { memoryBytes: reading.memoryBytes || null, cores: reading.cores || null },
    now
  )
  const result =
    rank === null ? null : evaluateOverPlanFromPeak(rank, await readPeak(db, serverId, { now }))
  await applyOverPlanStamp(db, serverId, result, readOverPlanStamp(serverMetadata), now)

  if (peakMemo.size >= PEAK_MEMO_LIMIT && memo === undefined) peakMemo.clear()
  const sameHour = memo !== undefined && memo.bucket === bucket
  peakMemo.set(serverId, {
    bucket,
    memoryBytes: Math.max(reading.memoryBytes, sameHour ? memo.memoryBytes : 0),
    cores: Math.max(reading.cores, sameHour ? memo.cores : 0),
    tierRank: rank,
  })
}

/**
 * One single-key `jsonb_set` (or key removal) statement, so a concurrent write
 * to another key is never stomped; an unchanged verdict refreshes the stamp at
 * most hourly.
 */
async function applyOverPlanStamp(
  db: Db,
  serverId: string,
  result: OverPlan | null,
  stamped: OverPlanMetadata | null,
  now: number
): Promise<void> {
  if (!isOverPlan(result)) {
    if (stamped === null) return
    await db.execute(sql`
      UPDATE server SET metadata = metadata - 'overPlan'
      WHERE id = ${serverId}::uuid AND metadata ? 'overPlan'
    `)
    return
  }
  const over = result!
  const unchanged =
    stamped !== null &&
    stamped.memory === over.memory &&
    stamped.cpu === over.cpu &&
    now - Date.parse(stamped.at) < OVER_PLAN_REFRESH_SECONDS * 1000
  if (unchanged) return
  const at = new Date(now).toISOString()
  const stamp = JSON.stringify({
    at,
    since: stamped?.since ?? at,
    memory: over.memory,
    cpu: over.cpu,
  })
  await db.execute(sql`
    UPDATE server
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{overPlan}', ${stamp}::jsonb)
    WHERE id = ${serverId}::uuid
  `)
}
