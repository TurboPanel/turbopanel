/**
 * Bounded retention prune for the append-only `audit` table.
 *
 * Audit rows are kept for a window (13 months by default, set on the instance
 * settings, `0` keeps everything) and older ones are removed in small batches,
 * oldest first, so the table stays a working size without one long delete.
 *
 * Rows get a time-ordered id (uuidv7), so "older than the cutoff" is also a
 * range on the primary key: the delete finds its rows from the front of the
 * index and stops after one batch, and a run with nothing old touches one
 * index page instead of reading the table. `created_at` is checked as well, so
 * a row whose id was not time-ordered is never removed early.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { audit } from '../../db/schema.ts'

/** Months of audit history kept unless the instance setting says otherwise. */
export const AUDIT_RETENTION_MONTHS_DEFAULT = 13

/** Rows removed per call (the sweep runs the prune every 15 minutes). */
export const AUDIT_PRUNE_BATCH_LIMIT = 1000

const MAX_BATCH = 5000

export type PruneAuditHistoryOpts = {
  /** `0` keeps everything; otherwise whole months back from `now`. */
  months?: number
  limit?: number
  now?: string
}

/**
 * The smallest uuidv7 that can belong to `ms` (48-bit millisecond prefix,
 * version 7, variant bits set, the rest zero). Every id made before that
 * millisecond sorts below it.
 */
export function auditBoundaryId(ms: number): string {
  const hex = Math.max(0, Math.trunc(ms)).toString(16).padStart(12, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`
}

/** The moment `months` whole months before `now`. */
export function auditCutoff(now: string, months: number): Date {
  const cutoff = new Date(Date.parse(now))
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
  return cutoff
}

/**
 * Delete up to `limit` audit rows older than the retention window; returns how
 * many went. A database error propagates to the caller (the sweep traces it).
 */
export async function pruneAuditHistory(db: Db, opts: PruneAuditHistoryOpts = {}): Promise<number> {
  const months = opts.months ?? AUDIT_RETENTION_MONTHS_DEFAULT
  if (!Number.isInteger(months) || months < 0) {
    throw new TypeError('months must be 0 or a positive whole number')
  }
  if (months === 0) return 0
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? AUDIT_PRUNE_BATCH_LIMIT), 1), MAX_BATCH)
  const cutoff = auditCutoff(opts.now ?? new Date().toISOString(), months)
  const boundary = auditBoundaryId(cutoff.getTime())

  const deleted = await db
    .delete(audit)
    .where(
      sql`${audit.id} in (
        select a.id from ${audit} a
        where a.id < ${boundary}::uuid
          and a.created_at < ${cutoff.toISOString()}::timestamptz
        order by a.id
        limit ${limit}
      )`
    )
    .returning({ id: audit.id })
  return deleted.length
}
