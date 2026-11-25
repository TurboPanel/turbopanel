/**
 * System mail through a platform queue on Workers, so High Availability gets
 * what self-hosted already has from RabbitMQ: a send survives a failure of the
 * request that asked for it, a passing provider failure is retried later with
 * the same schedule (`smtp/retry-policy.ts`), and a job that cannot be sent
 * ends in a dead-letter queue instead of a log line.
 *
 * The request path only puts the job on the queue (`createWorkersQueuedEmailQueue`).
 * The queue consumer (`consumeEmailBatch` in `src/workers.ts`, one
 * `settleEmailMessage` per message)
 * resolves the current mail settings, sends, and acks, retries or dead-letters
 * each message. The `TURBOPANEL_EMAIL_QUEUE` binding is required: the Worker
 * fails to start without it, so no request or sweep sends directly. Direct
 * sending (`mailgun/workers-queue.ts`) only happens inside the consumer.
 */
import { parseEmailJob } from './mailer/parse-email-job.ts'
import { compatLogError, compatLogWarn } from '../../lib/log-compat.ts'
import { deliverEmailJob, type EmailDeliverySender } from './deliver-email-job.ts'
import type { MailerSender } from './sender-types.ts'
import type { EmailJob, EmailQueue } from './types.ts'

/** Narrow view of a Workers `Queue` producer binding (see `commands/workers-queue.ts`). */
export type EmailQueueBinding = {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<unknown>
}

/** The message body on the mail queue. Versioned so the shape can grow. */
export type QueuedEmailMessage = { v: 1; job: EmailJob }

/** A send that failed, and whether trying again could help. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super(message)
    this.name = 'EmailSendError'
  }
}

class WorkersQueuedEmailQueue implements EmailQueue {
  constructor(private readonly binding: EmailQueueBinding) {}

  async enqueue(job: EmailJob): Promise<void> {
    const message: QueuedEmailMessage = { v: 1, job }
    await this.binding.send(message)
  }
}

export function createWorkersQueuedEmailQueue(binding: EmailQueueBinding): EmailQueue {
  return new WorkersQueuedEmailQueue(binding)
}

/** One queue message as the consumer sees it (a subset of the Workers `Message`). */
export type EmailQueueMessage = {
  id: string
  body: unknown
  attempts: number
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

/**
 * The Workers direct queue as a sender for the delivery core: a send that
 * throws becomes a failed result, permanent when it is an `EmailSendError`
 * that says so.
 */
export function emailQueueSender(queue: EmailQueue): MailerSender {
  return {
    async sendJob(job) {
      try {
        await queue.enqueue(job)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: errorText(error),
          permanent: error instanceof EmailSendError && error.permanent,
        }
      }
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jobFromBody(body: unknown): EmailJob | null {
  if (typeof body !== 'object' || body === null) return null
  const message = body as Partial<QueuedEmailMessage>
  return message.v === 1 ? parseEmailJob(message.job) : null
}

async function deadLetter(
  dead: EmailQueueBinding | undefined,
  message: EmailQueueMessage,
  reason: string,
  onDeadLetter: (() => Promise<void>) | undefined
): Promise<void> {
  compatLogError('email', `mail job dead-lettered: ${reason}`)
  if (!dead) return
  try {
    await dead.send({ body: message.body, reason, at: new Date().toISOString() })
    // Counted for the notice on Admin › Settings › Email; best effort.
    await onDeadLetter?.()
  } catch (error) {
    // Could not keep it: hand it back rather than lose it silently.
    compatLogWarn('email', `could not dead-letter a mail job: ${errorText(error)}`)
    message.retry({ delaySeconds: 60 })
    throw error
  }
}

/**
 * Send one queued job and settle its message: ack on success; retry later
 * with the self-hosted schedule on a passing failure (or while mail is not
 * configured); dead-letter a job that cannot be read, that the provider
 * refused for good, or that ran out of tries.
 */
export async function settleEmailMessage(input: {
  message: EmailQueueMessage
  sender: EmailDeliverySender
  deadLetterQueue?: EmailQueueBinding
  /** Counts a dead-lettered job (`dead-letter-tally.ts`); never throws. */
  onDeadLetter?: () => Promise<void>
  random?: () => number
}): Promise<'sent' | 'retry' | 'dead'> {
  const { message } = input
  const job = jobFromBody(message.body)
  if (!job) {
    try {
      await deadLetter(input.deadLetterQueue, message, 'unreadable mail job', input.onDeadLetter)
      message.ack()
    } catch {
      // handed back above
    }
    return 'dead'
  }
  // One count for the decision and the log line, never below 1.
  const attempt = Math.max(1, message.attempts)
  const outcome = await deliverEmailJob(job, input.sender, attempt, input.random)
  if (outcome.kind === 'sent') {
    message.ack()
    return 'sent'
  }
  if (outcome.kind === 'retry') {
    compatLogWarn(
      'email',
      `${job.type} failed (attempt ${attempt}), retrying in ${outcome.delayMs}ms: ${outcome.reason}`
    )
    message.retry({ delaySeconds: outcome.delayS })
    return 'retry'
  }
  try {
    await deadLetter(input.deadLetterQueue, message, outcome.reason, input.onDeadLetter)
    message.ack()
  } catch {
    // handed back above
  }
  return 'dead'
}
