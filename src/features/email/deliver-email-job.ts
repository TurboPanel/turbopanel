/**
 * The one place that decides what a mail send's outcome means, for both
 * runtimes. A runtime hands in the job, the transport it sends through and how
 * many sends of this job have now failed or are being tried; it gets back
 * `sent`, `retry` (with the wait) or `dead`, and only maps that to its own
 * queue: Workers acks, `message.retry` or the platform dead-letter queue, Deno
 * a RabbitMQ ack, a delay-tier queue or the dead-letter queue.
 *
 * Host-free: no queue, clock or provider is imported. The retry schedule is
 * `smtp/retry-policy.ts`.
 */
import { decideEmailRetry } from './smtp/retry-policy.ts'
import type { MailerSender } from './sender-types.ts'
import type { EmailJob } from './types.ts'

/** What the transport is asked to send through: the current settings' sender, or nothing configured. */
export type EmailDeliverySender = MailerSender | null

export type EmailDeliveryOutcome =
  | { kind: 'sent' }
  | {
      kind: 'retry'
      /** Whole seconds to wait, at least 1. */
      delayS: number
      delayMs: number
      /** Index into `EMAIL_RETRY_TIER_DELAYS_MS`, for runtimes that queue per tier. */
      tier: number
      /** Why this send failed, for the log. */
      reason: string
    }
  | {
      kind: 'dead'
      reason: string
      /** The provider refused the job for good, as opposed to running out of tries. */
      permanent: boolean
    }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What a failed send means: wait and try again, or give up. `failedAttempts`
 * counts the failure being decided, so it is 1 for a first delivery.
 */
export function decideEmailFailure(
  job: Pick<EmailJob, 'type'>,
  failedAttempts: number,
  failure: string,
  random?: () => number
): Exclude<EmailDeliveryOutcome, { kind: 'sent' }> {
  const attempt = Math.max(1, failedAttempts)
  const decision = decideEmailRetry(job.type, attempt, random)
  if (decision.action === 'dead_letter') {
    return {
      kind: 'dead',
      reason: `${job.type} gave up after ${attempt} attempts: ${failure}`,
      permanent: false,
    }
  }
  return {
    kind: 'retry',
    delayS: Math.max(1, Math.ceil(decision.delayMs / 1000)),
    delayMs: decision.delayMs,
    tier: decision.tier,
    reason: failure,
  }
}

/**
 * Send one job and decide what its outcome means. A sender that throws, or
 * none configured yet, is a passing failure.
 */
export async function deliverEmailJob(
  job: EmailJob,
  sender: EmailDeliverySender,
  failedAttempts: number,
  random?: () => number
): Promise<EmailDeliveryOutcome> {
  let failure: string
  if (sender === null) {
    failure = 'system email is not configured'
  } else {
    try {
      const result = await sender.sendJob(job)
      if (result.success) return { kind: 'sent' }
      if (result.permanent) {
        return { kind: 'dead', reason: `${job.type} refused: ${result.error}`, permanent: true }
      }
      failure = result.error
    } catch (error) {
      failure = errorText(error)
    }
  }
  return decideEmailFailure(job, failedAttempts, failure, random)
}
