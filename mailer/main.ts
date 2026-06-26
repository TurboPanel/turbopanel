import amqplib from 'amqplib'
import {
  assertEmailAmqpTopology,
  EMAIL_AMQP_QUEUE,
} from '../src/lib/email/smtp/amqp-topology.ts'
import {
  resolveEmailSettings,
  type EmailProvider,
  type ResolvedEmailSettings,
} from '../src/lib/settings/email-settings.ts'
import type { MailerSender } from '../src/lib/email/sender-types.ts'
import { createMailerDb } from './db.ts'
import { createMailerMailgunSender } from './mailgun-sender.ts'
import { RateLimiter } from './rate-limiter.ts'
import { createMailerSmtpSender } from '@turbopanel/email/smtp-sender'
import type { EmailJob, OtpType } from '../src/lib/email/types.ts'
import { logError, logInfo, logWarn } from '../src/logger.ts'

const DEFAULT_AMQP_URL = 'amqp://guest:guest@localhost:19828'
const QUEUE = EMAIL_AMQP_QUEUE

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>
type AmqpMessage = Parameters<Parameters<AmqpChannel['consume']>[1]>[0]

let channel: AmqpChannel | null = null
let connection: AmqpConnection | null = null
let consumerTag: string | null = null

const VALID_OTP_TYPES = new Set<OtpType>([
  'sign-in',
  'email-verification',
  'forget-password',
])

function parseEmailJob(raw: unknown): EmailJob | null {
  if (!raw || typeof raw !== 'object') return null
  const job = raw as Record<string, unknown>
  if (typeof job.to !== 'string' || typeof job.from !== 'string') return null

  if (job.type === 'signup-verification') {
    if (typeof job.verificationUrl !== 'string') return null
    return {
      type: 'signup-verification',
      to: job.to,
      from: job.from,
      verificationUrl: job.verificationUrl,
    }
  }

  if (job.type === 'email-otp') {
    if (typeof job.otp !== 'string') return null
    if (typeof job.otpType !== 'string' || !VALID_OTP_TYPES.has(job.otpType as OtpType)) {
      return null
    }
    return {
      type: 'email-otp',
      to: job.to,
      from: job.from,
      otp: job.otp,
      otpType: job.otpType as OtpType,
    }
  }

  return null
}

async function shutdown(): Promise<void> {
  if (channel) await channel.close().catch(() => undefined)
  if (connection) await connection.close().catch(() => undefined)
  Deno.exit(0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectAmqp(url: string): Promise<AmqpConnection> {
  const maxAttempts = 30
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await amqplib.connect(url)
    } catch (error) {
      if (attempt === maxAttempts) throw error
      const errMsg = error instanceof Error ? error.message : String(error)
      logWarn('mailer', `AMQP connect failed (attempt ${attempt}/${maxAttempts}): ${errMsg}`)
      await sleep(1000)
    }
  }
  throw new Error('connectAmqp: unreachable')
}

async function startConsumer(): Promise<void> {
  if (!channel || consumerTag) return
  const consumer = await channel.consume(QUEUE, handleMessage)
  consumerTag = consumer.consumerTag
}

async function pauseConsumptionForRateLimit(msg: NonNullable<AmqpMessage>, waitMs: number): Promise<void> {
  const activeChannel = channel
  if (!activeChannel) return

  const activeConsumerTag = consumerTag
  if (activeConsumerTag) {
    consumerTag = null
    await activeChannel.cancel(activeConsumerTag).catch((error: unknown) => {
      const errMsg = error instanceof Error ? error.message : String(error)
      logWarn('mailer', `failed to pause consumer: ${errMsg}`)
    })
  }

  activeChannel.nack(msg, false, true)
  logWarn('mailer', `rate limit exhausted, requeueing and pausing for ${waitMs}ms`)
  await sleep(waitMs)
  await startConsumer().catch((error: unknown) => {
    const errMsg = error instanceof Error ? error.message : String(error)
    logError('mailer', `failed to resume consumer: ${errMsg}`)
  })
}

const SETTINGS_TTL_MS = 30_000
let cachedSettings: { value: ResolvedEmailSettings; fetchedAt: number } | null = null
let lastAppliedRate = 60
let lastAppliedBurst = 60
let lastAppliedProvider: EmailProvider = 'smtp'
let lastAppliedPrefetch = 1

async function getCachedEmailSettings(): Promise<ResolvedEmailSettings> {
  const now = Date.now()
  if (cachedSettings && now - cachedSettings.fetchedAt < SETTINGS_TTL_MS) {
    return cachedSettings.value
  }
  const fresh = await resolveEmailSettings(db, mailerEnv)
  cachedSettings = { value: fresh, fetchedAt: now }
  return fresh
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function getRateAndBurst(settings: ResolvedEmailSettings): { rate: number; burst: number } {
  const rateRaw = settings.keys.RATE_LIMIT_PER_MINUTE?.value
  const burstRaw = settings.keys.RATE_LIMIT_BURST?.value
  const rateFromSettings = parsePositiveInt(rateRaw, 0)
  const rate = rateFromSettings > 0 ? rateFromSettings : 60
  const burstFromSettings = parsePositiveInt(burstRaw, 0)
  const burst = burstFromSettings > 0 ? burstFromSettings : rate
  return { rate, burst }
}

function getPrefetch(settings: ResolvedEmailSettings): number {
  const v = settings.keys.QUEUE_PREFETCH?.value
  const n = parsePositiveInt(v, 0)
  return n > 0 ? n : 1
}

const amqpUrl = Deno.env.get('TURBOPANEL_AMQP_URL') ?? DEFAULT_AMQP_URL

const mailerEnv = Deno.env.toObject()
const db = createMailerDb()

// Holder so we can swap the limiter on live setting changes without losing all state.
const limiterHolder: { current: RateLimiter } = { current: new RateLimiter() }

const initialSettings = await getCachedEmailSettings()
const { rate: initialRate, burst: initialBurst } = getRateAndBurst(initialSettings)
limiterHolder.current = new RateLimiter(initialRate, initialBurst)
lastAppliedRate = initialRate
lastAppliedBurst = initialBurst

function createSenderForProvider(provider: EmailProvider): MailerSender {
  return provider === 'mailgun'
    ? createMailerMailgunSender({ db, env: mailerEnv })
    : createMailerSmtpSender({ db, env: mailerEnv })
}

const senderHolder: { current: MailerSender } = {
  current: createSenderForProvider(initialSettings.provider),
}

lastAppliedProvider = initialSettings.provider

logInfo('mailer', `email provider: ${initialSettings.provider}`)

connection = await connectAmqp(amqpUrl)
channel = await connection.createChannel()

await assertEmailAmqpTopology(channel)
const initialPrefetch = getPrefetch(initialSettings)
lastAppliedPrefetch = initialPrefetch
await channel.prefetch(initialPrefetch)

logInfo('mailer', `consuming from ${QUEUE} at ${amqpUrl} (prefetch=${initialPrefetch})`)

async function handleMessage(msg: AmqpMessage): Promise<void> {
  if (!msg) {
    logInfo('mailer', 'consumer cancelled')
    consumerTag = null
    return
  }

  try {
    let job: EmailJob | null
    try {
      job = parseEmailJob(JSON.parse(msg.content.toString()))
    } catch {
      logError('mailer', 'invalid JSON payload')
      channel!.nack(msg, false, false)
      return
    }

    if (!job) {
      logError('mailer', 'unknown or invalid job type')
      channel!.nack(msg, false, false)
      return
    }

    // Re-resolve settings (TTL cached) so DB-driven config takes effect without restart.
    const currentSettings = await getCachedEmailSettings()
    const { rate, burst } = getRateAndBurst(currentSettings)
    const prefetch = getPrefetch(currentSettings)

    if (rate !== lastAppliedRate || burst !== lastAppliedBurst) {
      const oldTokens = (limiterHolder.current as unknown as { tokens?: number }).tokens ?? rate
      const newLimiter = new RateLimiter(rate, burst)
      ;(newLimiter as unknown as { tokens: number }).tokens = Math.min(
        Math.max(0, oldTokens),
        burst,
      )
      limiterHolder.current = newLimiter
      lastAppliedRate = rate
      lastAppliedBurst = burst
      logInfo('mailer', `rate limit updated: rate=${rate} burst=${burst}`)
    }

    if (currentSettings.provider !== lastAppliedProvider) {
      senderHolder.current = createSenderForProvider(currentSettings.provider)
      lastAppliedProvider = currentSettings.provider
      logInfo('mailer', `email provider updated: ${currentSettings.provider}`)
    }

    if (prefetch !== lastAppliedPrefetch && channel) {
      await channel.prefetch(prefetch)
      lastAppliedPrefetch = prefetch
      logInfo('mailer', `prefetch updated: ${prefetch}`)
    }

    if (!limiterHolder.current.tryAcquire()) {
      await pauseConsumptionForRateLimit(msg, limiterHolder.current.getWaitMs())
      return
    }

    const result = await senderHolder.current.sendJob(job)

    if (result.success) {
      channel!.ack(msg)
      return
    }

    if (result.permanent) {
      logError('mailer', `permanent error: ${result.error}`)
      channel!.nack(msg, false, false)
      return
    }

    logWarn('mailer', `transient send error, requeueing: ${result.error}`)
    channel!.nack(msg, false, true)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logError('mailer', `handler error: ${errMsg}`)
    channel!.nack(msg, false, true)
  }
}

await startConsumer()

Deno.addSignalListener('SIGINT', () => {
  void shutdown()
})
Deno.addSignalListener('SIGTERM', () => {
  void shutdown()
})
