/**
 * Consumers for the hosted dead-letter queues (`<env>-daemon-commands-dlq`
 * and `<env>-system-email-dlq`). Cloudflare keeps a dead letter about four
 * days and then drops it; without a consumer nobody learns it existed.
 *
 * Each message is turned into a redacted record (queue, message id, type,
 * attempt count, a short error, time), written once to the audit trail as an
 * instance-wide row, acked, and announced to the install's administrators
 * through the notification path (`queue.dead_lettered`). Nothing from the
 * message body beyond ids and a type name is kept: an email job carries
 * sign-in codes and links, and a command may carry a secret, so neither body
 * is ever stored, logged or replayed. To recover, re-issue the work through
 * the API.
 *
 * Idempotent: the audit row carries the queue message id, and the check and
 * the insert run in one transaction under an advisory lock, so a redelivered
 * message adds no second row and no second notice. The lock also serialises
 * the "first in the window / past the threshold" decision.
 *
 * Workers-bundle safe: no Deno-only specifiers, no I/O at module load.
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { audit } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export type DeadLetterQueueKind = 'commands' | 'email'

/** Which hosted dead-letter queue a Workers queue name is, or null. */
export function deadLetterQueueKind(name: string): DeadLetterQueueKind | null {
  if (name === 'daemon-commands-dlq' || name.endsWith('-daemon-commands-dlq')) return 'commands'
  if (name === 'system-email-dlq' || name.endsWith('-system-email-dlq')) return 'email'
  return null
}

/** The redacted record: ids, type, attempts, a short error, times. No bodies. */
export type DeadLetterRecord = {
  queue: DeadLetterQueueKind
  /** The queue's id for this message; the idempotency key. */
  messageId: string
  type: string | null
  commandId: string | null
  serverId: string | null
  attempts: number
  error: string
  /** When Cloudflare delivered it here. */
  seenAt: string
}

/** A dead-letter message as the consumer sees it (a subset of the Workers `Message`). */
export type DeadLetterMessage = {
  id: string
  body: unknown
  attempts: number
  timestamp?: Date
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

const MAX_ERROR_LENGTH = 160
const MAX_ID_LENGTH = 80
/** Dead letters in one day at which the admins hear again, after the first. */
export const DEAD_LETTER_ALERT_THRESHOLD = 10
const WINDOW_MS = 86_400_000
const LOCK_KEY = 'queue.dead_letter'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A short, single-line token, or null; never a free-form payload. */
function idOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value.slice(0, MAX_ID_LENGTH) : null
}

/** Strips addresses and anything that looks like a token or a URL, then cuts it short. */
export function redactError(text: string): string {
  const cleaned = text
    .replace(/[^\s@]+@[^\s@]+/g, '[address]')
    .replace(/\bhttps?:\/\/\S+/gi, '[url]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > MAX_ERROR_LENGTH ? `${cleaned.slice(0, MAX_ERROR_LENGTH - 1)}…` : cleaned
}

/**
 * Pure: reduce a dead-letter message to its redacted record. A body that does
 * not parse still yields a record (type null), so a broken message is counted
 * rather than lost.
 */
export function redactDeadLetter(
  queue: DeadLetterQueueKind,
  message: DeadLetterMessage
): DeadLetterRecord {
  const base = {
    queue,
    messageId: message.id.slice(0, MAX_ID_LENGTH),
    attempts: Number.isInteger(message.attempts) && message.attempts > 0 ? message.attempts : 1,
    seenAt: (message.timestamp ?? new Date()).toISOString(),
  }
  const body = message.body
  if (queue === 'commands') {
    let parsed: unknown = body
    if (typeof body === 'string') {
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = null
      }
    }
    const envelope = isRecord(parsed) ? parsed : {}
    return {
      ...base,
      type: idOf(envelope.type),
      commandId: idOf(envelope.commandId),
      serverId: idOf(envelope.serverId),
      error: 'delivery retries exhausted',
    }
  }
  // Email: either the code's `{ body: { v, job }, reason, at }` or the raw
  // `{ v, job }` the platform moved after its own retries.
  const outer = isRecord(body) ? body : {}
  const inner = isRecord(outer.body) ? outer.body : outer
  const job = isRecord(inner.job) ? inner.job : {}
  const reason = typeof outer.reason === 'string' ? outer.reason : 'delivery retries exhausted'
  return {
    ...base,
    type: idOf(job.type),
    commandId: null,
    serverId: null,
    error: redactError(reason),
  }
}

export type RecordOutcome =
  { recorded: false } | { recorded: true; alert: 'first' | 'threshold' | null }

/**
 * Write the audit row once. `recorded: false` means this message id was
 * already recorded (a redelivery). `alert` says whether the administrators
 * should hear about this one: the first dead letter in the last day, or the
 * one that reaches the threshold.
 */
export async function recordDeadLetter(
  db: Db,
  record: DeadLetterRecord,
  nowMs = Date.now()
): Promise<RecordOutcome> {
  const since = new Date(nowMs - WINDOW_MS).toISOString()
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`)
    const [seen] = await tx
      .select({ id: audit.id })
      .from(audit)
      .where(
        and(
          eq(audit.action, 'queue.dead_letter'),
          sql`${audit.context} ->> 'queue' = ${record.queue}`,
          sql`${audit.context} ->> 'messageId' = ${record.messageId}`
        )
      )
      .limit(1)
    if (seen) return { recorded: false } as const
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(audit)
      .where(and(eq(audit.action, 'queue.dead_letter'), gte(audit.createdAt, since)))
    await tx.insert(audit).values({
      organizationId: null,
      actorUserId: null,
      action: 'queue.dead_letter',
      targetType: 'queue',
      targetId: null,
      context: {
        queue: record.queue,
        messageId: record.messageId,
        type: record.type,
        commandId: record.commandId,
        serverId: record.serverId,
        attempts: record.attempts,
        error: record.error,
        seenAt: record.seenAt,
      },
    })
    const before = recent?.n ?? 0
    let alert: 'first' | 'threshold' | null = null
    if (before === 0) alert = 'first'
    else if (before + 1 === DEAD_LETTER_ALERT_THRESHOLD) alert = 'threshold'
    return { recorded: true, alert } as const
  })
}

export type DeadLetterDeps = {
  record(record: DeadLetterRecord): Promise<RecordOutcome>
  /** Tells the administrators; never throws. */
  notify(record: DeadLetterRecord, alert: 'first' | 'threshold'): Promise<void>
}

/**
 * Settle one dead-letter message: record it, notify when the record says so,
 * ack. A failed record is retried later (the message stays in the queue); a
 * redelivered, already-recorded message is acked without a second notice.
 */
export async function settleDeadLetter(
  queue: DeadLetterQueueKind,
  message: DeadLetterMessage,
  deps: DeadLetterDeps
): Promise<'recorded' | 'duplicate' | 'retry'> {
  const record = redactDeadLetter(queue, message)
  let outcome: RecordOutcome
  try {
    outcome = await deps.record(record)
  } catch (error) {
    compatLogWarn(
      'dead-letter',
      `could not record a ${queue} dead letter: ${error instanceof Error ? error.name : 'unknown'}`
    )
    message.retry({ delaySeconds: 60 })
    return 'retry'
  }
  if (!outcome.recorded) {
    message.ack()
    return 'duplicate'
  }
  // The row is written, so the message is done whatever the notice does.
  message.ack()
  if (outcome.alert) await deps.notify(record, outcome.alert)
  return 'recorded'
}

export async function consumeDeadLetterBatch(
  queue: DeadLetterQueueKind,
  messages: readonly DeadLetterMessage[],
  deps: DeadLetterDeps
): Promise<void> {
  await forEachSequential(messages, async (message) => {
    await settleDeadLetter(queue, message, deps)
  })
}
