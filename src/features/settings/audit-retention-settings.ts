/**
 * How many months of audit history the instance keeps, backed by the
 * `setting` table (same shape as `server-metrics-settings.ts`): one jsonb row
 * keyed by a stable name, read fresh on every call so a change takes effect
 * without a redeploy. `0` keeps everything; otherwise 3 to 120 months.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'
import { AUDIT_RETENTION_MONTHS_DEFAULT } from '../audit/prune.ts'

export const AUDIT_RETENTION_MONTHS_KEY = 'AUDIT_RETENTION_MONTHS'

/** Shortest non-zero window (months). */
export const AUDIT_RETENTION_MIN_MONTHS = 3

/** Longest window (months). */
export const AUDIT_RETENTION_MAX_MONTHS = 120

/** `0` (keep everything) or a whole number within the window. */
export function isValidAuditRetentionMonths(value: number): boolean {
  return (
    Number.isInteger(value) &&
    (value === 0 ||
      (value >= AUDIT_RETENTION_MIN_MONTHS && value <= AUDIT_RETENTION_MAX_MONTHS))
  )
}

function parseStoredMonths(raw: unknown): number | null {
  let parsed: number
  if (typeof raw === 'number') {
    parsed = raw
  } else if (typeof raw === 'string') {
    parsed = Number.parseInt(raw, 10)
  } else {
    return null
  }
  return isValidAuditRetentionMonths(parsed) ? parsed : null
}

/** Read the window; falls back to the default when unset or invalid. */
export async function getAuditRetentionMonths(db: Db): Promise<number> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, AUDIT_RETENTION_MONTHS_KEY))
    .limit(1)
  return parseStoredMonths(rows[0]?.value) ?? AUDIT_RETENTION_MONTHS_DEFAULT
}

/** Persist the window; `0` keeps everything, any other value must be 3 to 120. */
export async function setAuditRetentionMonths(db: Db, months: number): Promise<void> {
  if (!isValidAuditRetentionMonths(months)) {
    throw new TypeError('months must be 0 or a whole number between 3 and 120')
  }
  const value = `${months}`
  await db
    .insert(setting)
    .values({ key: AUDIT_RETENTION_MONTHS_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
}
