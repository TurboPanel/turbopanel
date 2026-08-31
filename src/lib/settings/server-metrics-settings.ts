/**
 * Server-metrics live-session settings backed by the `setting` table.
 *
 * Mirrors the signup-setting shape (`install-state.ts`): one jsonb row keyed
 * by a stable name, read fresh on every call so panel changes take effect
 * without a redeploy. `0` disables live sessions entirely; otherwise the cap
 * is clamped to a 5–240 minute window at write time.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'

/** Default cap on a single live-metrics session, in minutes. */
export const DEFAULT_SERVER_METRICS_LIVE_MAX_MINUTES = 60

export const SERVER_METRICS_LIVE_MAX_MINUTES_KEY =
  'SERVER_METRICS_LIVE_MAX_MINUTES'

/** Minimum non-zero live-session cap (minutes). */
export const SERVER_METRICS_LIVE_MIN_MINUTES = 5

/** Maximum live-session cap (minutes). */
export const SERVER_METRICS_LIVE_MAX_MINUTES = 240

function nowTs(): string {
  return new Date().toISOString()
}

/** `0` (disabled) or an integer within the 5–240 minute window. */
export function isValidServerMetricsLiveMaxMinutes(value: number): boolean {
  return Number.isInteger(value) &&
    (value === 0 ||
      (value >= SERVER_METRICS_LIVE_MIN_MINUTES &&
        value <= SERVER_METRICS_LIVE_MAX_MINUTES))
}

function parseStoredMinutes(raw: unknown): number | null {
  let parsed: number
  if (typeof raw === 'number') {
    parsed = raw
  } else if (typeof raw === 'string') {
    parsed = Number.parseInt(raw, 10)
  } else {
    return null
  }
  return isValidServerMetricsLiveMaxMinutes(parsed) ? parsed : null
}

/**
 * Read the live-session cap; falls back to the default when unset/invalid.
 */
export async function getServerMetricsLiveMaxMinutes(
  db: Db,
): Promise<number> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, SERVER_METRICS_LIVE_MAX_MINUTES_KEY))
    .limit(1)
  return parseStoredMinutes(rows[0]?.value) ??
    DEFAULT_SERVER_METRICS_LIVE_MAX_MINUTES
}

/**
 * Persist the live-session cap. `0` disables live sessions; any other value
 * must be an integer in [5, 240] minutes.
 */
export async function setServerMetricsLiveMaxMinutes(
  db: Db,
  minutes: number,
): Promise<void> {
  if (!isValidServerMetricsLiveMaxMinutes(minutes)) {
    throw new TypeError(
      'maxMinutes must be 0 or an integer between 5 and 240',
    )
  }
  const value = `${minutes}`
  await db
    .insert(setting)
    .values({ key: SERVER_METRICS_LIVE_MAX_MINUTES_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value,
        updatedAt: nowTs(),
      },
    })
}
