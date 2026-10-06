/**
 * The mail dead-letter queue as an operator sees it: which jobs gave up, why,
 * and how to put them back.
 *
 * A job lands in `turbopanel.email.dead` when a send was refused for good or
 * its retries ran out (`deno-mailer-consumer.ts`). The queue holds sign-in
 * codes and addresses, so the listing never carries a job's body (no code, no
 * link) and masks the recipient. Replaying republishes the original bytes to
 * the send queue with the attempt count reset, so the job gets the full retry
 * schedule again.
 *
 * Pure: the broker-free part (summaries, masking, ids, replayed headers). The
 * broker side is `lib/email/mailer/deno-mail-dead-letters.ts`.
 */
import { EMAIL_ATTEMPT_HEADER, failedAttemptsFromHeaders } from './retry-policy.ts'

/** Set on a message when it is dead-lettered. */
export const EMAIL_DEAD_REASON_HEADER = 'x-tp-dead-reason'
export const EMAIL_DEAD_AT_HEADER = 'x-tp-dead-at'
/** Set on a message when an operator replays it (it keeps the trail). */
export const EMAIL_REPLAYED_AT_HEADER = 'x-tp-replayed-at'

/** The dead queue holds at most 1000 messages (`amqp-topology.ts`). */
export const DEAD_LETTER_REPLAY_MAX = 1000
export const DEAD_LETTER_LIST_DEFAULT = 50
export const DEAD_LETTER_LIST_MAX = 100

export type DeadLetterSummary = {
  /** Stable handle for "replay this one": the message id, else a hash of its bytes. */
  id: string
  /** The job kind (`email-otp`, `password-reset`, ...), or `unknown` when the body does not parse. */
  jobType: string
  /** The recipient with the middle hidden (`j***@example.com`), or null when unknown. */
  to: string | null
  failedAttempts: number
  /** Why it was dead-lettered, as the consumer recorded it. */
  reason: string | null
  deadAt: string | null
}

export type DeadLetterList = {
  /** Messages in the queue now (the page may show fewer). */
  total: number
  items: DeadLetterSummary[]
}

export type DeadLetterReplayAll = {
  replayed: number
  /** Jobs the broker refused to republish; they stay in the dead queue. */
  failed: number
  /** Jobs still in the dead queue afterwards. */
  remaining: number
}

/** The broker side, so the routes and their tests never see AMQP. */
export type MailDeadLetterStore = {
  list(limit: number): Promise<DeadLetterList>
  /** `false` when no message has that id. */
  replayOne(id: string): Promise<{ replayed: boolean }>
  replayAll(limit: number): Promise<DeadLetterReplayAll>
}

/** The broker could not be reached or refused the request. */
export class MailQueueUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailQueueUnavailableError'
  }
}

/** `jane.doe@example.com` -> `j***@example.com`; null for anything that is not an address. */
export function maskEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const at = value.lastIndexOf('@')
  if (at < 1 || at === value.length - 1) return null
  return `${value.slice(0, 1)}***${value.slice(at)}`
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return null
}

function readJobFields(content: Uint8Array): { jobType: string; to: string | null } {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(content))
    if (typeof parsed !== 'object' || parsed === null) return { jobType: 'unknown', to: null }
    const job = parsed as Record<string, unknown>
    return {
      jobType: typeof job.type === 'string' ? job.type : 'unknown',
      to: maskEmailAddress(job.to),
    }
  } catch {
    return { jobType: 'unknown', to: null }
  }
}

/** The id of a dead letter: its message id, else `h-` plus a hash of its bytes. */
export async function deadLetterId(messageId: unknown, content: Uint8Array): Promise<string> {
  if (typeof messageId === 'string' && messageId.length > 0) return messageId
  const digest = await crypto.subtle.digest('SHA-256', content as BufferSource)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `h-${hex.slice(0, 16)}`
}

export async function summarizeDeadLetter(message: {
  content: Uint8Array
  properties?: { messageId?: unknown; headers?: Record<string, unknown> }
}): Promise<DeadLetterSummary> {
  const headers = message.properties?.headers ?? {}
  return {
    id: await deadLetterId(message.properties?.messageId, message.content),
    ...readJobFields(message.content),
    failedAttempts: failedAttemptsFromHeaders(headers),
    reason: asText(headers[EMAIL_DEAD_REASON_HEADER]),
    deadAt: asText(headers[EMAIL_DEAD_AT_HEADER]),
  }
}

/**
 * Headers for the republished copy: the attempt count and dead-letter notes
 * are dropped so the job starts a fresh retry schedule, and the replay time is
 * stamped.
 */
export function replayHeaders(
  headers: Record<string, unknown> | undefined,
  now: Date
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...headers }
  delete next[EMAIL_ATTEMPT_HEADER]
  delete next[EMAIL_DEAD_REASON_HEADER]
  delete next[EMAIL_DEAD_AT_HEADER]
  next[EMAIL_REPLAYED_AT_HEADER] = now.toISOString()
  return next
}
