/**
 * How often the panel may start an order for one name set. The authority
 * refuses a name after 5 failed checks in an hour, so the panel stays well
 * under it: at most 3 attempts in any rolling hour, and after each failure a
 * longer wait (10 minutes, 30 minutes, 1 hour, 2 hours, then doubling up to a
 * day). Pure; the caller supplies the clock.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Attempts allowed in any rolling hour. */
export const MAX_ATTEMPTS_PER_HOUR = 3
/** Attempts allowed in any rolling week, a stop for a loop that backs off but never ends. */
export const MAX_ATTEMPTS_PER_WEEK = 50
/** Start times older than this are dropped so the stored list stays short. */
export const ATTEMPT_MEMORY_MS = 7 * DAY

const WAITS_MS = [10 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR]

/** The wait after the `failures`-th failure in a row (1 for the first). */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0
  if (failures <= WAITS_MS.length) return WAITS_MS[failures - 1]
  const doubled = 2 * HOUR * 2 ** (failures - WAITS_MS.length)
  return Math.min(doubled, DAY)
}

/** When the authority said it is rate limiting, wait at least this long. */
export const RATE_LIMIT_WAIT_MS = HOUR

/** Whether a failure reason is the authority's own rate-limit answer. */
export function isRateLimitReason(reason: string): boolean {
  return /rate ?limit|too many (?:certificates|requests|failed)/i.test(reason)
}

export function pruneAttempts(times: readonly string[], now: Date): string[] {
  const floor = now.getTime() - ATTEMPT_MEMORY_MS
  return times.filter((t) => Date.parse(t) >= floor)
}

export type AttemptVerdict = { ok: true } | { ok: false; notBefore: Date }

/** Whether a new order may start at `now`, or the earliest time it may. */
export function mayStartAttempt(
  history: { attemptTimes: readonly string[]; nextAttemptAt: string | null },
  now: Date
): AttemptVerdict {
  const t = now.getTime()
  const waits: number[] = []
  const next = history.nextAttemptAt === null ? Number.NaN : Date.parse(history.nextAttemptAt)
  if (!Number.isNaN(next) && next > t) waits.push(next)
  const times = history.attemptTimes.map((a) => Date.parse(a)).filter((a) => !Number.isNaN(a))
  const lastHour = times.filter((a) => a > t - HOUR).sort((a, b) => a - b)
  if (lastHour.length >= MAX_ATTEMPTS_PER_HOUR) {
    waits.push(lastHour[lastHour.length - MAX_ATTEMPTS_PER_HOUR] + HOUR)
  }
  const lastWeek = times.filter((a) => a > t - 7 * DAY).sort((a, b) => a - b)
  if (lastWeek.length >= MAX_ATTEMPTS_PER_WEEK) {
    waits.push(lastWeek[lastWeek.length - MAX_ATTEMPTS_PER_WEEK] + 7 * DAY)
  }
  return waits.length === 0 ? { ok: true } : { ok: false, notBefore: new Date(Math.max(...waits)) }
}
