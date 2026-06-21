import amqplib from 'amqplib'
import {
  assertEmailAmqpTopology,
  EMAIL_AMQP_QUEUE,
} from '../src/lib/email/smtp/amqp-topology.ts'
import { createMailerDb } from './db.ts'
import { RateLimiter } from './rate-limiter.ts'
import { createMailerSmtpSender } from './smtp-sender.ts'
import type { EmailJob } from '../src/lib/email/types.ts'
import { logError, logInfo, logWarn } from '../src/logger.ts'

const DEFAULT_AMQP_URL = 'amqp://guest:guest@localhost:19828'
const QUEUE = EMAIL_AMQP_QUEUE

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>
type AmqpMessage = Parameters<Parameters<AmqpChannel['consume']>[1]>[0]

let channel: AmqpChannel | null = null
let connection: AmqpConnection | null = null
let consumerTag: string | null = null

function parseEmailJob(raw: unknown): EmailJob | null {
  if (!raw || typeof raw !== 'object') return null
  const job = raw as Record<string, unknown>
  if (job.type !== 'signup-verification') return null
  if (typeof job.to !== 'string' || typeof job.from !== 'string') return null
  if (typeof job.verificationUrl !== 'string') return null
  return {
    type: 'signup-verification',
    to: job.to,
    from: job.from,
    verificationUrl: job.verificationUrl,
  }
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

    if (!rateLimiter.tryAcquire()) {
      await pauseConsumptionForRateLimit(msg, rateLimiter.getWaitMs())
      return
    }

    const result = await sender.sendJob(job)

    if (result.success) {
      channel!.ack(msg)
      return
    }

    if (result.permanent) {
      logError('mailer', `permanent error: ${result.error}`)
      channel!.nack(msg, false, false)
      return
    }

    logWarn('mailer', `transient SMTP error, requeueing: ${result.error}`)
    channel!.nack(msg, false, true)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logError('mailer', `handler error: ${errMsg}`)
    channel!.nack(msg, false, true)
  }
}

const amqpUrl = Deno.env.get('TURBOPANEL_AMQP_URL') ?? DEFAULT_AMQP_URL

const db = createMailerDb()
const sender = createMailerSmtpSender({ db })
const rateLimiter = new RateLimiter()

connection = await connectAmqp(amqpUrl)
channel = await connection.createChannel()

await assertEmailAmqpTopology(channel)
await channel.prefetch(1)

logInfo('mailer', `consuming from ${QUEUE} at ${amqpUrl}`)

await startConsumer()

Deno.addSignalListener('SIGINT', () => {
  void shutdown()
})
Deno.addSignalListener('SIGTERM', () => {
  void shutdown()
})
