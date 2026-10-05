/**
 * What happens to a mail job whose send failed for a reason that may pass.
 *
 * The send queue used to requeue such a job at the head of the queue with no
 * limit, so one message the provider kept refusing (a full mailbox, a
 * greylisting relay) was retried at the limiter's pace forever and every
 * sign-in code and password reset behind it waited. Now a failed job goes to a
 * delay queue for a growing, jittered time, comes back at the tail of the send
 * queue, and after a fixed number of attempts lands in a dead-letter queue
 * where an operator can look at it.
 *
 * Pure: the clock-free, broker-free part, so the whole schedule is testable.
 */
import type { EmailJob } from '../types.ts'

/** Delay tiers: one broker queue each, so every queue is first-in-first-out by delay. */
export const EMAIL_RETRY_TIER_DELAYS_MS = [
  30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000,
] as const

/** Header that carries how many sends of this job have failed so far. */
export const EMAIL_ATTEMPT_HEADER = 'x-tp-attempt'

/**
 * Jobs a person is waiting on right now (sign-in code, password reset, sign-up
 * confirmation): retried sooner and one more time than the rest.
 */
const SIGN_IN_JOB_TYPES: ReadonlySet<EmailJob['type']> = new Set([
  'email-otp',
  'password-reset',
  'signup-verification',
])

/** Tier index per failed attempt, per job class. Length + 1 = attempts allowed. */
const SIGN_IN_SCHEDULE = [0, 1, 2, 3, 3] as const
const OTHER_SCHEDULE = [1, 3, 4, 5] as const

export type RetryDecision =
  { action: 'retry'; tier: number; delayMs: number } | { action: 'dead_letter' }

/** `failedAttempts` is how many sends of this job have already failed, this one included. */
export function decideRetry(
  type: EmailJob['type'],
  failedAttempts: number,
  random: () => number = Math.random
): RetryDecision {
  const schedule = SIGN_IN_JOB_TYPES.has(type) ? SIGN_IN_SCHEDULE : OTHER_SCHEDULE
  const tier = schedule[failedAttempts - 1]
  if (tier === undefined) return { action: 'dead_letter' }
  const base = EMAIL_RETRY_TIER_DELAYS_MS[tier]!
  // Within a tier the jitter only shortens the wait (to 50-100%): the tier
  // queue is first-in-first-out, so a later message never overtakes the one
  // ahead of it, and a retry is never later than the tier says.
  const delayMs = Math.round(base * (0.5 + random() * 0.5))
  return { action: 'retry', tier, delayMs }
}

/** The failed-attempt count a delivery carries; a first delivery has none. */
export function failedAttemptsFromHeaders(headers: Record<string, unknown> | undefined): number {
  const raw = headers?.[EMAIL_ATTEMPT_HEADER]
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0
}
