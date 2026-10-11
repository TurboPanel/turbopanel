/**
 * Host-free coverage for the in-process email consumer: the settings-derived
 * helpers and the AMQP open/consume/dispose/reconnect/close loop with the
 * broker stubbed and the sender injected.
 */

import { assertEquals, assertRejects } from '@std/assert'
import { stub } from '@std/testing/mock'
import amqplib from 'amqplib'
import type { MailerSender, MailerSendResult } from '../../../features/email/sender-types.ts'
import type { EmailJob } from '../../../features/email/types.ts'
import type {
  EmailProvider,
  ResolvedEmailSettings,
} from '../../../features/settings/email-settings.ts'
import {
  carryOverRateLimiter,
  mailerPrefetch,
  mailerRateAndBurst,
  startMailerConsumer,
} from './deno-mailer-consumer.ts'
import { RateLimiter } from './rate-limiter.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function settingsWith(keys: Partial<Record<string, string>>): ResolvedEmailSettings {
  const meta = (value: string) => ({
    value,
    source: 'env',
    isSecret: false,
    isOverridden: false,
  })
  return {
    provider: 'smtp',
    from: 'noreply@example.com',
    mailgunRegion: 'us',
    mailgunApiBase: 'https://api.mailgun.net',
    keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, meta(v ?? '')])),
  } as unknown as ResolvedEmailSettings
}

test('mailerRateAndBurst defaults to 60/rate and ignores junk', () => {
  assertEquals(mailerRateAndBurst(settingsWith({})), { rate: 60, burst: 60 })
  assertEquals(mailerRateAndBurst(settingsWith({ RATE_LIMIT_PER_MINUTE: '10' })), {
    rate: 10,
    burst: 10,
  })
  assertEquals(
    mailerRateAndBurst(settingsWith({ RATE_LIMIT_PER_MINUTE: '10', RATE_LIMIT_BURST: '3' })),
    { rate: 10, burst: 3 }
  )
  assertEquals(
    mailerRateAndBurst(settingsWith({ RATE_LIMIT_PER_MINUTE: 'lots', RATE_LIMIT_BURST: '-1' })),
    { rate: 60, burst: 60 }
  )
})

test('mailerPrefetch defaults to 1 and ignores junk', () => {
  assertEquals(mailerPrefetch(settingsWith({})), 1)
  assertEquals(mailerPrefetch(settingsWith({ QUEUE_PREFETCH: '4' })), 4)
  assertEquals(mailerPrefetch(settingsWith({ QUEUE_PREFETCH: '0' })), 1)
  assertEquals(mailerPrefetch(settingsWith({ QUEUE_PREFETCH: 'x' })), 1)
})

test('carryOverRateLimiter keeps tokens, clamped to the new burst', () => {
  const tokens = (l: RateLimiter) => (l as unknown as { tokens: number }).tokens
  // A stopped clock: on the real one a millisecond between the two acquires
  // refills a fraction of a token and the count is no longer exactly 58.
  const clock = () => 1_000
  const previous = new RateLimiter(60, 60, clock)
  previous.tryAcquire()
  previous.tryAcquire()
  assertEquals(tokens(previous), 58)

  // Shrinking the bucket clamps to the new capacity.
  assertEquals(tokens(carryOverRateLimiter(previous, 60, 5, clock)), 5)
  // Growing keeps what was there rather than refilling.
  assertEquals(tokens(carryOverRateLimiter(previous, 120, 120, clock)), 58)
  // A limiter with no readable token count falls back to the rate.
  const opaque = {} as unknown as RateLimiter
  assertEquals(tokens(carryOverRateLimiter(opaque, 7, 9, clock)), 7)
})

test('carryOverRateLimiter hands its clock to the new limiter', () => {
  let nowMs = 0
  const previous = new RateLimiter(60, 1, () => nowMs)
  assertEquals(previous.tryAcquire(), true)
  const next = carryOverRateLimiter(previous, 60, 1, () => nowMs)
  // Carried over empty, and the stopped clock refills nothing.
  assertEquals(next.tryAcquire(), false)
  assertEquals(next.getWaitMs(), 1_000)
  nowMs += 1_000
  assertEquals(next.tryAcquire(), true)
})

type ConsumeHandler = (
  msg: {
    content: { toString(): string }
    properties?: { headers?: Record<string, unknown> }
  } | null
) => void

type SentToQueue = { queue: string; options: Record<string, unknown> }

function createStubBroker(
  options: {
    consumerTag?: string
    cancel?: () => Promise<void>
    channelClose?: () => Promise<void>
    connectionClose?: () => Promise<void>
    /** Make ack/nack throw, the way a channel the broker took away does. */
    dispositionError?: Error
    /** Runs inside consume(), i.e. after the loss listeners are attached. */
    duringConsume?: () => void
    /** Runs inside prefetch(), i.e. while the session is still being set up. */
    duringPrefetch?: () => void
    /** Make channel setup fail after connect succeeded. */
    topologyError?: Error
    /**
     * Leave `on` off the connection/channel, covering watchForLoss's
     * non-EventEmitter branch.
     */
    omitEmitter?: boolean
  } = {}
) {
  const dispositions: Array<{ method: string; requeue?: boolean }> = []
  const sentToQueue: SentToQueue[] = []
  const prefetches: number[] = []
  const cancels: string[] = []
  let onMessage: ConsumeHandler | undefined
  let consumeCount = 0
  let channelCloseCount = 0
  let connectionCloseCount = 0
  const connectionEvents = createStubEmitter()
  const channelEvents = createStubEmitter()
  const channel = {
    ...(options.omitEmitter ? {} : channelEvents.part),
    assertExchange: async () => {
      if (options.topologyError) throw options.topologyError
    },
    assertQueue: async () => undefined,
    bindQueue: async () => undefined,
    prefetch: async (n: number) => {
      prefetches.push(n)
      options.duringPrefetch?.()
    },
    consume: async (_queue: string, handler: ConsumeHandler) => {
      onMessage = handler
      consumeCount++
      options.duringConsume?.()
      return { consumerTag: options.consumerTag ?? 'ctag-1' }
    },
    sendToQueue: (queue: string, _content: unknown, opts: Record<string, unknown>) => {
      sentToQueue.push({ queue, options: opts })
      return true
    },
    ack: () => {
      if (options.dispositionError) throw options.dispositionError
      dispositions.push({ method: 'ack' })
    },
    nack: (_msg: unknown, _allUpTo: boolean, requeue: boolean) => {
      if (options.dispositionError) throw options.dispositionError
      dispositions.push({ method: 'nack', requeue })
    },
    cancel:
      options.cancel ??
      (async (tag: string) => {
        cancels.push(tag)
      }),
    close: async () => {
      channelCloseCount++
      if (options.channelClose) await options.channelClose()
    },
  }
  const connection = {
    ...(options.omitEmitter ? {} : connectionEvents.part),
    createChannel: async () => channel,
    close: async () => {
      connectionCloseCount++
      if (options.connectionClose) await options.connectionClose()
    },
  }
  return {
    channel,
    connection,
    dispositions,
    sentToQueue,
    prefetches,
    cancels,
    consumeCount: () => consumeCount,
    channelCloseCount: () => channelCloseCount,
    connectionCloseCount: () => connectionCloseCount,
    emitConnection: connectionEvents.emit,
    emitChannel: channelEvents.emit,
    connectionListenerCount: connectionEvents.listenerCount,
    deliver: (msg: Parameters<ConsumeHandler>[0]) => {
      if (!onMessage) throw new TypeError('consume handler was not registered')
      onMessage(msg)
    },
  }
}

/**
 * The slice of EventEmitter amqplib exposes. Deliberately *not* a real
 * EventEmitter: a real one throws on an unhandled 'error', which is the very
 * failure under test, and would make the test crash instead of fail.
 */
function createStubEmitter() {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  return {
    part: {
      on(event: string, listener: (arg?: unknown) => void) {
        const bucket = listeners.get(event) ?? []
        bucket.push(listener)
        listeners.set(event, bucket)
      },
    },
    emit(event: string, arg?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(arg)
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length
    },
  }
}

/** A sender whose answers are scripted; records every job it saw. */
function scriptedSender(results: MailerSendResult[] | (() => MailerSendResult)) {
  const jobs: EmailJob[] = []
  const providers: EmailProvider[] = []
  const sender: MailerSender = {
    sendJob(job) {
      jobs.push(job)
      const next = typeof results === 'function' ? results() : results.shift()
      if (!next) throw new Error('scripted sender ran out of results')
      return Promise.resolve(next)
    },
  }
  return {
    jobs,
    providers,
    factory: (provider: EmailProvider) => {
      providers.push(provider)
      return sender
    },
  }
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new TypeError(`timed out waiting for ${what}`)
}

const OTP_JOB_JSON = JSON.stringify({
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  otp: '123456',
  otpType: 'sign-in',
})

/** Env-only settings: no db, so the resolver never touches Postgres. */
const baseEnv = (): Record<string, string | undefined> => ({
  TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit-smtp',
  TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@example.com',
})

test('startMailerConsumer applies prefetch, acks a delivered job, and cancels on close', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender([{ success: true }])
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: { ...baseEnv(), TURBOPANEL_SYSTEM_EMAIL__QUEUE_PREFETCH: '3' },
      senderFactory: sender.factory,
    })
    assertEquals(broker.prefetches, [3])
    assertEquals(sender.providers, ['mailpit-smtp'])
    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => broker.dispositions.length > 0, 'disposition')
    assertEquals(broker.dispositions, [{ method: 'ack' }])
    assertEquals(sender.jobs.length, 1)
    assertEquals(sender.jobs[0]?.type, 'email-otp')
    await handle.close()
    assertEquals(broker.cancels, ['ctag-1'])
  } finally {
    connectStub.restore()
  }
})

test('startMailerConsumer dead-letters invalid JSON and unknown job types', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender([])
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    broker.deliver({ content: { toString: () => '{not json' } })
    broker.deliver({
      content: { toString: () => JSON.stringify({ type: 'carrier-pigeon' }) },
    })
    await waitFor(() => broker.dispositions.length === 2, 'two dispositions')
    assertEquals(broker.dispositions, [
      { method: 'nack', requeue: false },
      { method: 'nack', requeue: false },
    ])
    assertEquals(sender.jobs.length, 0)
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startMailerConsumer maps permanent, transient and thrown send failures', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  let calls = 0
  const sender = scriptedSender(() => {
    calls++
    if (calls === 1) {
      return { success: false, error: 'bad address', permanent: true }
    }
    if (calls === 2) {
      return { success: false, error: 'relay busy', permanent: false }
    }
    throw new Error('sender exploded')
  })
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    for (let i = 0; i < 3; i++) {
      broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
      await waitFor(() => broker.dispositions.length === i + 1, `disposition ${i + 1}`)
    }
    // A permanent refusal goes to the dead-letter queue; a transient failure and
    // a thrown handler error go to a delay queue. All three are acked, so
    // none of them sits at the head of the send queue.
    assertEquals(broker.dispositions, [{ method: 'ack' }, { method: 'ack' }, { method: 'ack' }])
    assertEquals(
      broker.sentToQueue.map((sent) => sent.queue),
      ['turbopanel.email.dead', 'turbopanel.email.retry.30s', 'turbopanel.email.retry.30s']
    )
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startMailerConsumer hot-applies provider, rate/burst and prefetch from changed settings', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender(() => ({ success: true }))
  const env: Record<string, string | undefined> = {
    ...baseEnv(),
    TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '60',
  }
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env,
      settingsTtlMs: 0,
      senderFactory: sender.factory,
    })
    assertEquals(sender.providers, ['mailpit-smtp'])
    assertEquals(broker.prefetches, [1])

    // The env object is shared with the consumer; mutating it is what a
    // changed DB row looks like once the TTL expires.
    env.TURBOPANEL_SYSTEM_EMAIL__PROVIDER = 'mailgun'
    env.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY = 'key-x'
    env.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN = 'mg.example.com'
    env.TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE = '120'
    env.TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST = '7'
    env.TURBOPANEL_SYSTEM_EMAIL__QUEUE_PREFETCH = '5'
    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => broker.dispositions.length === 1, 'disposition')

    assertEquals(sender.providers, ['mailpit-smtp', 'mailgun'])
    assertEquals(broker.prefetches, [1, 5])
    assertEquals(broker.dispositions, [{ method: 'ack' }])

    // Unchanged settings on the next delivery swap nothing.
    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => broker.dispositions.length === 2, 'second disposition')
    assertEquals(sender.providers, ['mailpit-smtp', 'mailgun'])
    assertEquals(broker.prefetches, [1, 5])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('an exhausted rate limit requeues, pauses the consumer and resumes on the same session', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender(() => ({ success: true }))
  let handle: Awaited<ReturnType<typeof startMailerConsumer>> | undefined
  try {
    handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      // Burst of one: the second delivery has no token.
      env: {
        ...baseEnv(),
        TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '60000',
        TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST: '1',
      },
      senderFactory: sender.factory,
      // The limiter's clock never moves, so the bucket stays empty however
      // long the second handler takes to run. On the real clock 60000/min
      // refills a token every millisecond and a slow runner acked both.
      rateLimiterClock: () => 1_000,
    })
    assertEquals(broker.consumeCount(), 1)
    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => broker.dispositions.length === 2, 'two dispositions')
    assertEquals(broker.dispositions, [{ method: 'ack' }, { method: 'nack', requeue: true }])
    assertEquals(broker.cancels, ['ctag-1'])
    // The pause is the limiter's wait (1 ms at 60000/min); then the consumer
    // comes back on the same session.
    await waitFor(() => broker.consumeCount() === 2, 'resume')
    assertEquals(sender.jobs.length, 1)
  } finally {
    await handle?.close()
    connectStub.restore()
  }
})

test('startMailerConsumer close swallows cancel and connection errors', async () => {
  const broker = createStubBroker({
    cancel: () => Promise.reject(new Error('cancel failed')),
    channelClose: () => Promise.reject(new Error('channel close failed')),
    connectionClose: () => Promise.reject(new Error('connection close failed')),
  })
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: scriptedSender([]).factory,
    })
    await handle.close()
    // A second close is a no-op, not a second teardown.
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startMailerConsumer retries AMQP connect then succeeds', async () => {
  const broker = createStubBroker()
  let attempts = 0
  const connectStub = stub(amqplib, 'connect', () => {
    attempts++
    if (attempts === 1) return Promise.reject(new Error('ECONNREFUSED'))
    if (attempts === 2) return Promise.reject('broker not up' as never)
    return Promise.resolve(broker.connection as never)
  })
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: scriptedSender([]).factory,
    })
    assertEquals(attempts, 3)
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startMailerConsumer rejects when connect succeeds but channel setup fails', async () => {
  const broker = createStubBroker({
    topologyError: new Error('no such exchange'),
  })
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    await assertRejects(
      () =>
        startMailerConsumer({
          db: undefined,
          amqpUrl: 'amqp://test',
          env: baseEnv(),
          senderFactory: scriptedSender([]).factory,
        }),
      Error,
      'no such exchange'
    )
  } finally {
    connectStub.restore()
  }
})

test('startMailerConsumer survives the broker dropping an open connection and consumes again', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender(() => ({ success: true }))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    assertEquals(broker.consumeCount(), 1)

    // Exactly what amqplib does when the broker goes away mid-connection.
    broker.emitConnection('error', new Error('Unexpected close'))
    broker.emitConnection('close')
    await waitFor(() => broker.consumeCount() === 2, 'reconnect')
    // One rebuild, not two: `error` and `close` describe the same loss.
    assertEquals(broker.consumeCount(), 2)

    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => broker.dispositions.length > 0, 'disposition')
    assertEquals(broker.dispositions, [{ method: 'ack' }])

    // A channel-level loss reopens too.
    broker.emitChannel('close')
    await waitFor(() => broker.consumeCount() === 3, 'second reconnect')
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('the connection has its error listener before the session setup awaits the broker', async () => {
  // A listener attached only after channel/topology/prefetch left a window in
  // which a broker restart was an unhandled `error` — a process exit.
  const seen: number[] = []
  const broker = createStubBroker({
    duringPrefetch: () => seen.push(broker.connectionListenerCount('error')),
  })
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender(() => ({ success: true }))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    assertEquals(seen.length, 1)
    assertEquals(seen[0]! >= 1, true)
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('a broker that drops while the first session is set up is rebuilt, not kept dead', async () => {
  let dropOnce = true
  const broker = createStubBroker({
    duringPrefetch: () => {
      if (!dropOnce) return
      dropOnce = false
      broker.emitConnection('error', new Error('Unexpected close'))
      broker.emitConnection('close')
    },
  })
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender(() => ({ success: true }))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    await waitFor(() => broker.consumeCount() === 2, 'rebuild after start')
    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => broker.dispositions.length > 0, 'disposition')
    assertEquals(broker.dispositions, [{ method: 'ack' }])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('a broker event after close does not reopen the consumer', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: scriptedSender([]).factory,
    })
    await handle.close()
    broker.emitConnection('close')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assertEquals(broker.consumeCount(), 1)
  } finally {
    connectStub.restore()
  }
})

test('a delivery whose ack throws does not escape the message handler', async () => {
  const broker = createStubBroker({
    dispositionError: new Error('IllegalOperationError: Channel closed'),
  })
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender([{ success: true }])
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    broker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => sender.jobs.length === 1, 'send')
    // Let the handler finish its (throwing) ack without an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assertEquals(broker.dispositions, [])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('startMailerConsumer constructs the real mailpit-smtp, smtp and mailgun senders', async () => {
  const providers: EmailProvider[] = ['mailpit-smtp', 'smtp', 'mailgun']
  for (const provider of providers) {
    const broker = createStubBroker({
      // No EventEmitter: watchForLoss returns before attaching listeners.
      omitEmitter: true,
    })
    const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
    const env: Record<string, string | undefined> = {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: provider,
      TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@example.com',
    }
    if (provider === 'mailgun') {
      env.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY = 'key-x'
      env.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN = 'mg.example.com'
    }
    try {
      const handle = await startMailerConsumer({
        db: undefined,
        amqpUrl: 'amqp://test',
        env,
      })
      await handle.close()
    } finally {
      connectStub.restore()
    }
  }
})

test('startMailerConsumer reconnects after a topology error on the rebuilt session', async () => {
  let sessions = 0
  const firstBroker = createStubBroker()
  const thirdBroker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => {
    sessions++
    if (sessions === 1) return Promise.resolve(firstBroker.connection as never)
    if (sessions === 2) {
      return Promise.resolve(
        createStubBroker({ topologyError: new Error('channel closed') }).connection as never
      )
    }
    return Promise.resolve(thirdBroker.connection as never)
  })
  let handle: Awaited<ReturnType<typeof startMailerConsumer>> | undefined
  try {
    handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: scriptedSender(() => ({ success: true })).factory,
    })
    firstBroker.emitConnection('error', new Error('heartbeat timeout'))
    await waitFor(() => thirdBroker.consumeCount() === 1, 'third session after topology fail', 4000)
    assertEquals(sessions, 3)
  } finally {
    await handle?.close()
    connectStub.restore()
  }
})

test('a null delivery (broker cancel) clears the consumer tag and does not throw', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: scriptedSender([]).factory,
    })
    broker.deliver(null)
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('close during reconnect discards the rebuilt session instead of installing it', async () => {
  let sessions = 0
  const firstBroker = createStubBroker()
  const secondBroker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => {
    sessions++
    if (sessions === 1) return Promise.resolve(firstBroker.connection as never)
    return new Promise((resolve) => {
      setTimeout(() => resolve(secondBroker.connection as never), 40)
    })
  })
  let handle: Awaited<ReturnType<typeof startMailerConsumer>> | undefined
  try {
    handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: scriptedSender([]).factory,
    })
    firstBroker.emitConnection('close')
    await handle.close()
    await waitFor(() => sessions >= 2, 'reconnect connect')
    await waitFor(() => secondBroker.channelCloseCount() >= 1, 'rebuilt session discarded', 2000)
  } finally {
    await handle?.close()
    connectStub.restore()
  }
})

test('a broker that dies during the reconnect handshake is retried, not installed dead', async () => {
  let sessions = 0
  let secondBroker: ReturnType<typeof createStubBroker> | undefined
  const firstBroker = createStubBroker()
  const thirdBroker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => {
    sessions++
    if (sessions === 1) return Promise.resolve(firstBroker.connection as never)
    if (sessions === 2) {
      secondBroker = createStubBroker({
        duringConsume: () => secondBroker?.emitConnection('close'),
      })
      return Promise.resolve(secondBroker.connection as never)
    }
    return Promise.resolve(thirdBroker.connection as never)
  })
  let handle: Awaited<ReturnType<typeof startMailerConsumer>> | undefined
  try {
    handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: scriptedSender(() => ({ success: true })).factory,
    })
    firstBroker.emitConnection('close')
    await waitFor(() => thirdBroker.consumeCount() === 1, 'third session', 4000)
    assertEquals(sessions, 3)
    thirdBroker.deliver({ content: { toString: () => OTP_JOB_JSON } })
    await waitFor(() => thirdBroker.dispositions.length > 0, 'disposition on third')
    assertEquals(thirdBroker.dispositions, [{ method: 'ack' }])
  } finally {
    await handle?.close()
    connectStub.restore()
  }
})

function otpDelivery(failedAttempts?: number) {
  return {
    content: { toString: () => OTP_JOB_JSON },
    properties: {
      headers: failedAttempts === undefined ? {} : { 'x-tp-attempt': failedAttempts },
    },
  }
}

test('a failing sign-in code is retried later with a growing delay, then dead-lettered', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender(() => ({ success: false, error: 'mailbox full', permanent: false }))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    for (const failed of [undefined, 1, 2, 3, 4, 5]) {
      broker.deliver(otpDelivery(failed))
      const expected = broker.dispositions.length + 1
      await waitFor(() => broker.dispositions.length === expected, `disposition ${expected}`)
    }
    const queues = broker.sentToQueue.map((sent) => sent.queue)
    assertEquals(queues, [
      'turbopanel.email.retry.30s',
      'turbopanel.email.retry.60s',
      'turbopanel.email.retry.120s',
      'turbopanel.email.retry.300s',
      'turbopanel.email.retry.300s',
      'turbopanel.email.dead',
    ])
    // Each retry carries the new failed-attempt count and its own delay.
    const headers = broker.sentToQueue
      .slice(0, 5)
      .map((sent) => (sent.options.headers as Record<string, unknown>)['x-tp-attempt'])
    assertEquals(headers, [1, 2, 3, 4, 5])
    for (const sent of broker.sentToQueue.slice(0, 5)) {
      assertEquals(Number(sent.options.expiration) > 0, true)
    }
    // The dead letter carries what the replay tool lists: an id, when, and why.
    const dead = broker.sentToQueue[5]!.options
    assertEquals(typeof dead.messageId, 'string')
    const deadHeaders = dead.headers as Record<string, unknown>
    assertEquals(Number.isNaN(Date.parse(String(deadHeaders['x-tp-dead-at']))), false)
    assertEquals(String(deadHeaders['x-tp-dead-reason']).includes('gave up'), true)
    assertEquals(
      broker.dispositions.every((d) => d.method === 'ack'),
      true
    )
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('a message the provider keeps refusing does not hold up the one behind it', async () => {
  const broker = createStubBroker()
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const results: MailerSendResult[] = [
    { success: false, error: 'greylisted', permanent: false },
    { success: true },
  ]
  const sender = scriptedSender(results)
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    broker.deliver(otpDelivery())
    broker.deliver(otpDelivery())
    await waitFor(() => broker.dispositions.length === 2, 'both dispositions')
    // The first went to a delay queue, the second was sent and acked.
    assertEquals(sender.jobs.length, 2)
    assertEquals(broker.sentToQueue.length, 1)
    assertEquals(broker.dispositions, [{ method: 'ack' }, { method: 'ack' }])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})

test('when the broker refuses the retry publish the job is requeued, not lost', async () => {
  const broker = createStubBroker()
  broker.channel.sendToQueue = () => {
    throw new Error('channel closed')
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(broker.connection as never))
  const sender = scriptedSender(() => ({ success: false, error: 'busy', permanent: false }))
  try {
    const handle = await startMailerConsumer({
      db: undefined,
      amqpUrl: 'amqp://test',
      env: baseEnv(),
      senderFactory: sender.factory,
    })
    broker.deliver(otpDelivery())
    await waitFor(() => broker.dispositions.length === 1, 'disposition')
    assertEquals(broker.dispositions, [{ method: 'nack', requeue: true }])
    await handle.close()
  } finally {
    connectStub.restore()
  }
})
