/**
 * A count of system mail that gave up on High Availability, for the notice on
 * Admin › Settings › Email. Self-hosted counts its RabbitMQ dead-letter queue
 * directly; a Worker cannot count a Cloudflare queue, so the mail consumer
 * adds one to a per-day count each time it dead-letters a job.
 *
 * One row of the `setting` table (`EMAIL_DEAD_LETTER_TALLY`), value
 * `{ "YYYY-MM-DD": count }` for the last {@link TALLY_DAYS} days (the
 * dead-letter queue keeps messages about four days). A write happens only when
 * a job is dead-lettered, which is rare, so the load is negligible. The write
 * is best effort and never blocks the dead-letter send: the database may be
 * the reason the mail could not go out.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'

export const EMAIL_DEAD_LETTER_TALLY_KEY = 'EMAIL_DEAD_LETTER_TALLY'

/** Days the count covers, matching how long the dead-letter queue keeps messages. */
export const TALLY_DAYS = 4

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The oldest day still counted, as `YYYY-MM-DD`. */
function oldestDay(nowMs: number): string {
  return dayKey(nowMs - (TALLY_DAYS - 1) * 86_400_000)
}

/**
 * Add one dead-lettered job to today's count, dropping days older than the
 * window, in one atomic statement (no lost count when two arrive together).
 */
export async function recordEmailDeadLetter(db: Db, nowMs = Date.now()): Promise<void> {
  const today = dayKey(nowMs)
  const oldest = oldestDay(nowMs)
  try {
    await db
      .insert(setting)
      .values({ key: EMAIL_DEAD_LETTER_TALLY_KEY, value: { [today]: 1 } })
      .onConflictDoUpdate({
        target: setting.key,
        set: {
          value: sql`(
            select coalesce(jsonb_object_agg(day, count), '{}'::jsonb)
            from jsonb_each(${setting.value}) as kept(day, count)
            where kept.day >= ${oldest} and kept.day <> ${today}
          ) || jsonb_build_object(
            ${today}::text,
            coalesce((${setting.value} ->> ${today})::int, 0) + 1
          )`,
          updatedAt: new Date(nowMs).toISOString(),
        },
      })
  } catch (error) {
    compatLogWarn(
      'email',
      `could not count a dead-lettered mail job: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Jobs dead-lettered in the window; 0 when none were recorded. */
export async function countEmailDeadLetters(db: Db, nowMs = Date.now()): Promise<number> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, EMAIL_DEAD_LETTER_TALLY_KEY))
    .limit(1)
  return sumTally(row?.value, nowMs)
}

/** Pure: the count inside the window from a stored tally value. */
export function sumTally(value: unknown, nowMs = Date.now()): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 0
  const oldest = oldestDay(nowMs)
  let total = 0
  for (const [day, count] of Object.entries(value as Record<string, unknown>)) {
    if (day >= oldest && typeof count === 'number' && Number.isInteger(count) && count > 0) {
      total += count
    }
  }
  return total
}
