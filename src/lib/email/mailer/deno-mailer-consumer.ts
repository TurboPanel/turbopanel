import amqplib from 'amqplib'
import type { Db } from '../../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../secrets/secrets.ts'
import { logError, logInfo, logWarn } from '../../logger.ts'
import {
  type EmailProvider,
  type ResolvedEmailSettings,
  resolveEmailSettings,
} from '../../../features/settings/email-settings.ts'
import type { MailerSender } from '../../../features/email/sender-types.ts'
import {
  assertEmailAmqpTopology,
  EMAIL_AMQP_DEAD_QUEUE,
  EMAIL_AMQP_QUEUE,
  emailRetryQueueName,
} from '../../../features/email/smtp/amqp-topology.ts'
import {
  decideRetry,
  EMAIL_ATTEMPT_HEADER,
  failedAttemptsFromHeaders,
} from '../../../features/email/smtp/retry-policy.ts'
import type { EmailJob } from '../../../features/email/types.ts'
import { createMailerSmtpSender } from '@turbopanel/email/smtp-sender'
import { createMailerMailgunSender } from './mailgun-sender.ts'
import { parseEmailJob } from './parse-email-job.ts'
import { RateLimiter, type RateLimiterClock } from './rate-limiter.ts'
import { redactUrlCredentials } from './redact-url.ts'

/**
 * The in-process email consumer: takes `EmailJob`s off the RabbitMQ queue the
 * instance publishes to (`deno-amqp-queue.ts`) and delivers them through the
 * provider the `SYSTEM_EMAIL` settings name. This used to be a separate
 * `turbopanel-mailer` binary and unit; the only reason for the split was an
 * unrestricted outbound `--allow-net` kept away from the instance, and the
 * instance binary carries that flag itself now (egress allowlist dropped
 * 2026-09-18), so it runs here beside the command consumer instead — one
 * process, one unit, one binary. The queue stays: a durable RabbitMQ queue is
 * still what makes a send survive a restart and what bounds a burst.
 *
 * Only `src/platform/deno/server.ts` may import this module. It pulls amqplib and the
 * nodemailer-backed SMTP sender into the graph, both of which the Workers
 * build shims out (`smtp-sender-shim.ts`); wire it from the Deno entrypoint,
 * never from `src/app.ts`.
 *
 * Lifecycle mirrors `commands/deno-consumer.ts`: the connection and channel
 * get `error`/`close` listeners before the first delivery (an unlistened
 * `error` on an amqplib EventEmitter is a thrown exception, which in-process
 * means the whole instance dies with the broker), a lost session is rebuilt
 * with backoff until {@link MailerConsumer.close} is called, and ack/nack on a
 * channel the broker already took away is swallowed — RabbitMQ redelivers
 * every unacknowledged message on the rebuilt session.
 */

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>
type AmqpMessage = Parameters<Parameters<AmqpChannel['consume']>[1]>[0]

export type StartMailerConsumerOpts = {
  db: Db | undefined
  amqpUrl: string
  /** Process env the settings resolver reads `TURBOPANEL_SYSTEM_EMAIL__*` from. */
  env: Record<string, string | undefined>
  /**
   * Data-encryption keyring so DB-backed email secrets (`MAILGUN_API_KEY`,
   * `SMTP_PASS`, sealed as `enc`) decrypt. Optional: without it those settings
   * resolve as unset and env-var settings keep working.
   */
  dataEncryptionSecrets?: DerivedSecretsConfig
  /** Settings cache TTL; the consumer re-resolves per delivery within it. */
  settingsTtlMs?: number
  /**
   * Test seam: build the sender for a provider. Production leaves it unset
   * and gets the real SMTP / Mailgun / Mailpit senders.
   */
  senderFactory?: (provider: EmailProvider) => MailerSender
  /**
   * Test seam: the clock the rate limiter refills against. Production leaves
   * it unset and gets `Date.now`.
   */
  rateLimiterClock?: RateLimiterClock
}

export type MailerConsumer = {
  close(): Promise<void>
}

const DEFAULT_SETTINGS_TTL_MS = 30_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const CONNECT_ATTEMPTS = 30

type AmqpEmitter = {
  on?: (event: string, listener: (arg?: unknown) => void) => unknown
}

type ConsumerSession = {
  connection: AmqpConnection
  channel: AmqpChannel
  consumerTag: string | undefined
  /** Set by the listeners when this session's broker went away. */
  lost: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Host-free: rate + burst from the resolved settings, defaults 60/rate. */
export function mailerRateAndBurst(settings: ResolvedEmailSettings): {
  rate: number
  burst: number
} {
  const rate = parsePositiveInt(settings.keys.RATE_LIMIT_PER_MINUTE?.value, 0) || 60
  const burst = parsePositiveInt(settings.keys.RATE_LIMIT_BURST?.value, 0) || rate
  return { rate, burst }
}

/** Host-free: AMQP prefetch from the resolved settings, default 1. */
export function mailerPrefetch(settings: ResolvedEmailSettings): number {
  return parsePositiveInt(settings.keys.QUEUE_PREFETCH?.value, 0) || 1
}

/**
 * Host-free: a limiter for the new rate/burst that keeps as many of the old
 * limiter's tokens as the new capacity allows, so a settings change never
 * hands out a fresh full bucket mid-burst.
 */
export function carryOverRateLimiter(
  previous: RateLimiter,
  rate: number,
  burst: number,
  now: RateLimiterClock = Date.now
): RateLimiter {
  const next = new RateLimiter(rate, burst, now)
  const oldTokens = (previous as unknown as { tokens?: number }).tokens ?? rate
  ;(next as unknown as { tokens: number }).tokens = Math.min(Math.max(0, oldTokens), burst)
  return next
}

async function connectAmqp(url: string): Promise<AmqpConnection> {
  const tryConnect = async (attempt: number): Promise<AmqpConnection> => {
    if (attempt > CONNECT_ATTEMPTS) {
      throw new Error('connectAmqp: unreachable')
    }
    try {
      return await amqplib.connect(url)
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error
      logWarn(
        'mailer',
        `AMQP connect failed (attempt ${attempt}/${CONNECT_ATTEMPTS}): ${errorMessage(error)}`
      )
      await sleep(1000)
    }
    return tryConnect(attempt + 1)
  }
  return tryConnect(1)
}

export async function startMailerConsumer(opts: StartMailerConsumerOpts): Promise<MailerConsumer> {
  const settingsTtlMs = opts.settingsTtlMs ?? DEFAULT_SETTINGS_TTL_MS

  let closed = false
  let reconnecting = false
  let session: ConsumerSession | undefined

  let cachedSettings: { value: ResolvedEmailSettings; fetchedAt: number } | undefined
  async function currentSettings(): Promise<ResolvedEmailSettings> {
    const now = Date.now()
    if (cachedSettings && now - cachedSettings.fetchedAt < settingsTtlMs) {
      return cachedSettings.value
    }
    const fresh = await resolveEmailSettings(opts.db, opts.env, opts.dataEncryptionSecrets)
    cachedSettings = { value: fresh, fetchedAt: now }
    return fresh
  }

  function createSender(provider: EmailProvider): MailerSender {
    if (opts.senderFactory) return opts.senderFactory(provider)
    const senderOpts = {
      db: opts.db,
      env: opts.env,
      dataEncryptionSecrets: opts.dataEncryptionSecrets,
    }
    if (provider === 'mailgun') return createMailerMailgunSender(senderOpts)
    if (provider === 'mailpit-api') {
      throw new Error('mailpit-api is only supported on Workers')
    }
    return createMailerSmtpSender(senderOpts)
  }

  // Hot-applied on every delivery: provider (swaps the sender), rate/burst
  // (swaps the limiter, carrying tokens over) and prefetch (re-applied on the
  // channel). FROM and transport credentials are re-resolved inside the
  // senders on each send.
  const initial = await currentSettings()
  const initialRateBurst = mailerRateAndBurst(initial)
  const limiterClock = opts.rateLimiterClock ?? Date.now
  let limiter = new RateLimiter(initialRateBurst.rate, initialRateBurst.burst, limiterClock)
  let appliedRate = initialRateBurst.rate
  let appliedBurst = initialRateBurst.burst
  let appliedProvider = initial.provider
  let appliedPrefetch = mailerPrefetch(initial)
  let sender = createSender(initial.provider)
  logInfo('mailer', `email provider: ${initial.provider}`)

  function watchForLoss(
    target: AmqpConnection | AmqpChannel,
    label: string,
    owner: ConsumerSession
  ): void {
    const emitter = target as AmqpEmitter
    if (typeof emitter.on !== 'function') return
    emitter.on('error', (error) => {
      owner.lost = true
      logWarn('mailer', `AMQP ${label} error: ${errorMessage(error)}`)
      void reopen(owner, `${label} error`)
    })
    emitter.on('close', () => {
      owner.lost = true
      void reopen(owner, `${label} closed`)
    })
  }

  async function consumeOn(owner: ConsumerSession): Promise<void> {
    if (owner.consumerTag) return
    const { consumerTag } = await owner.channel.consume(EMAIL_AMQP_QUEUE, (msg) => {
      void handleMessage(owner, msg)
    })
    owner.consumerTag = consumerTag
  }

  async function openSession(): Promise<ConsumerSession> {
    const connection = await connectAmqp(opts.amqpUrl)
    // `channel` is filled in below; the object has to exist first so the
    // connection's listeners can be attached before anything else awaits.
    const opened = {
      connection,
      consumerTag: undefined,
      lost: false,
    } as ConsumerSession
    // Before the first await on this connection: opening the channel, the
    // topology and the prefetch all wait on the broker, and a broker that goes
    // away in that window makes the connection emit `error` — with no
    // listener, a thrown exception that exits the process.
    watchForLoss(connection, 'connection', opened)
    try {
      const channel = await connection.createChannel()
      opened.channel = channel
      watchForLoss(channel, 'channel', opened)
      await assertEmailAmqpTopology(channel)
      await channel.prefetch(appliedPrefetch)
      await consumeOn(opened)
      return opened
    } catch (error) {
      await connection.close().catch(() => undefined)
      throw error
    }
  }

  async function discard(s: ConsumerSession): Promise<void> {
    await s.channel.close().catch(() => undefined)
    await s.connection.close().catch(() => undefined)
  }

  async function reopen(from: ConsumerSession, reason: string): Promise<void> {
    // `close` and `error` both fire for the same loss, and a replaced session
    // can still emit late; one rebuild per loss.
    if (closed || reconnecting || session !== from) return
    reconnecting = true
    session = undefined
    logWarn('mailer', `AMQP ${reason} — reconnecting`)

    const reconnectWithBackoff = async (delay: number): Promise<void> => {
      if (closed) return
      let finished = false
      try {
        const rebuilt = await openSession()
        if (closed) {
          await discard(rebuilt)
          finished = true
        } else if (rebuilt.lost) {
          logWarn('mailer', 'AMQP connection was lost again during reconnect — retrying')
          await discard(rebuilt)
          await sleep(delay)
        } else {
          session = rebuilt
          logWarn('mailer', 'AMQP reconnected, consuming again')
          finished = true
        }
      } catch (error) {
        logError('mailer', `AMQP reconnect failed: ${errorMessage(error)} — retrying in ${delay}ms`)
        await sleep(delay)
      }
      if (finished) return
      return reconnectWithBackoff(Math.min(delay * 2, RECONNECT_MAX_DELAY_MS))
    }
    await reconnectWithBackoff(RECONNECT_BASE_DELAY_MS)
    reconnecting = false
  }

  type Disposition = 'ack' | 'nack_requeue' | 'nack_dead'

  /**
   * ack/nack on a channel the broker already took away throws synchronously;
   * unguarded that escapes `handleMessage` as an unhandled rejection. The
   * message is not lost — RabbitMQ requeues every unacknowledged delivery when
   * a channel closes — so log and move on.
   */
  function disposeSafely(
    owner: ConsumerSession,
    msg: NonNullable<AmqpMessage>,
    disposition: Disposition
  ): void {
    try {
      if (disposition === 'ack') owner.channel.ack(msg)
      else owner.channel.nack(msg, false, disposition === 'nack_requeue')
    } catch (error) {
      logWarn(
        'mailer',
        `could not ${disposition} a delivery: ${errorMessage(
          error
        )} — the channel is gone; the broker will redeliver`
      )
    }
  }

  /**
   * A send failed for a reason that may pass. Put the job in the delay queue
   * its attempt count calls for (it returns to the tail of the send queue when
   * the delay ends), or in the dead-letter queue once the attempts are used.
   * Either way the original is acked, so one stubborn message never holds up
   * the ones behind it. `nack_requeue` only when the broker refuses the
   * republish, which keeps at-least-once.
   */
  function retryOrDeadLetter(
    owner: ConsumerSession,
    msg: NonNullable<AmqpMessage>,
    type: EmailJob['type'],
    reason: string
  ): Disposition {
    const headers = (msg.properties?.headers ?? {}) as Record<string, unknown>
    const failed = failedAttemptsFromHeaders(headers) + 1
    const decision = decideRetry(type, failed)
    try {
      if (decision.action === 'retry') {
        owner.channel.sendToQueue(emailRetryQueueName(decision.tier), msg.content, {
          persistent: true,
          expiration: String(decision.delayMs),
          headers: { ...headers, [EMAIL_ATTEMPT_HEADER]: failed },
        })
        logWarn(
          'mailer',
          `${type} failed (attempt ${failed}), retrying in ${decision.delayMs}ms: ${reason}`
        )
      } else {
        deadLetter(owner, msg, headers, `${type} gave up after ${failed} attempts: ${reason}`)
      }
      return 'ack'
    } catch (error) {
      logWarn('mailer', `could not schedule a retry: ${errorMessage(error)}`)
      return 'nack_requeue'
    }
  }

  function deadLetterPermanent(
    owner: ConsumerSession,
    msg: NonNullable<AmqpMessage>,
    type: EmailJob['type'],
    reason: string
  ): Disposition {
    try {
      const headers = (msg.properties?.headers ?? {}) as Record<string, unknown>
      deadLetter(owner, msg, headers, `${type} refused: ${reason}`)
      return 'ack'
    } catch (error) {
      logWarn('mailer', `could not dead-letter: ${errorMessage(error)}`)
      return 'nack_dead'
    }
  }

  function deadLetter(
    owner: ConsumerSession,
    msg: NonNullable<AmqpMessage>,
    headers: Record<string, unknown>,
    reason: string
  ): void {
    owner.channel.sendToQueue(EMAIL_AMQP_DEAD_QUEUE, msg.content, {
      persistent: true,
      headers: { ...headers, 'x-tp-dead-reason': reason.slice(0, 300) },
    })
    logError('mailer', `dead-lettered: ${reason}`)
  }

  /**
   * Rate limit exhausted: requeue the delivery, stop consuming for the
   * limiter's wait, then consume again on the same session. The pause is on
   * the consumer, not the process — nothing else in the instance waits.
   */
  async function pauseForRateLimit(
    owner: ConsumerSession,
    msg: NonNullable<AmqpMessage>,
    waitMs: number
  ): Promise<void> {
    const tag = owner.consumerTag
    if (tag) {
      owner.consumerTag = undefined
      await owner.channel.cancel(tag).catch((error: unknown) => {
        logWarn('mailer', `failed to pause consumer: ${errorMessage(error)}`)
      })
    }
    disposeSafely(owner, msg, 'nack_requeue')
    logWarn('mailer', `rate limit exhausted, requeueing and pausing for ${waitMs}ms`)
    await sleep(waitMs)
    if (closed || owner.lost || session !== owner) return
    await consumeOn(owner).catch((error: unknown) => {
      logError('mailer', `failed to resume consumer: ${errorMessage(error)}`)
    })
  }

  async function handleMessage(owner: ConsumerSession, msg: AmqpMessage): Promise<void> {
    if (!msg) {
      // Broker-initiated cancel (queue deleted, node failover): the
      // session's own listeners handle the loss.
      owner.consumerTag = undefined
      return
    }

    let disposition: Disposition
    let jobType: EmailJob['type'] | undefined
    try {
      let job: ReturnType<typeof parseEmailJob>
      try {
        job = parseEmailJob(JSON.parse(msg.content.toString()))
      } catch {
        logError('mailer', 'invalid JSON payload')
        disposeSafely(owner, msg, 'nack_dead')
        return
      }
      if (!job) {
        logError('mailer', 'unknown or invalid job type')
        disposeSafely(owner, msg, 'nack_dead')
        return
      }

      jobType = job.type
      const settings = await currentSettings()
      const { rate, burst } = mailerRateAndBurst(settings)
      if (rate !== appliedRate || burst !== appliedBurst) {
        limiter = carryOverRateLimiter(limiter, rate, burst, limiterClock)
        appliedRate = rate
        appliedBurst = burst
        logInfo('mailer', `rate limit updated: rate=${rate} burst=${burst}`)
      }
      if (settings.provider !== appliedProvider) {
        sender = createSender(settings.provider)
        appliedProvider = settings.provider
        logInfo('mailer', `email provider updated: ${settings.provider}`)
      }
      const prefetch = mailerPrefetch(settings)
      if (prefetch !== appliedPrefetch) {
        await owner.channel.prefetch(prefetch)
        appliedPrefetch = prefetch
        logInfo('mailer', `prefetch updated: ${prefetch}`)
      }

      if (!limiter.tryAcquire()) {
        await pauseForRateLimit(owner, msg, limiter.getWaitMs())
        return
      }

      const result = await sender.sendJob(job)
      if (result.success) {
        disposition = 'ack'
      } else if (result.permanent) {
        logError('mailer', `permanent error: ${result.error}`)
        disposition = deadLetterPermanent(owner, msg, job.type, result.error)
      } else {
        disposition = retryOrDeadLetter(owner, msg, job.type, result.error)
      }
    } catch (error) {
      logError('mailer', `handler error: ${errorMessage(error)}`)
      disposition =
        jobType === undefined
          ? 'nack_requeue'
          : retryOrDeadLetter(owner, msg, jobType, errorMessage(error))
    }
    disposeSafely(owner, msg, disposition)
  }

  session = await openSession()
  if (session.lost) {
    // The broker went away while the first session was being set up. Its
    // listeners fired before it was the live session, so nothing else will
    // rebuild it. `reopen` marks the rebuild in progress before its first
    // await, so the close events from discarding it are ignored.
    const dead = session
    void reopen(dead, 'connection lost during start')
    void discard(dead)
  }
  logInfo(
    'mailer',
    `consuming from ${EMAIL_AMQP_QUEUE} at ${redactUrlCredentials(
      opts.amqpUrl
    )} (prefetch=${appliedPrefetch})`
  )

  return {
    async close(): Promise<void> {
      closed = true
      const current = session
      session = undefined
      if (!current) return
      if (current.consumerTag) {
        await current.channel.cancel(current.consumerTag).catch(() => undefined)
      }
      await discard(current)
    },
  }
}
