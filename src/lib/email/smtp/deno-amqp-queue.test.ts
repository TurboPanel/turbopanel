import { assertEquals } from 'jsr:@std/assert'
import { stub } from '@std/testing/mock'
import amqplib from 'amqplib'
import {
  assertEmailAmqpTopology,
  EMAIL_AMQP_EXCHANGE,
  EMAIL_AMQP_QUEUE,
  EMAIL_AMQP_ROUTING_KEY,
} from './amqp-topology.ts'
import {
  createDenoAmqpQueue,
  probeAmqpBrokerReachable,
} from './deno-amqp-queue.ts'
import type { EmailJob } from '../types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type RecordedCall = { method: string; args: unknown[] }

function createRecordingChannel() {
  const calls: RecordedCall[] = []
  return {
    calls,
    assertExchange: async (...args: unknown[]) => {
      calls.push({ method: 'assertExchange', args })
    },
    assertQueue: async (...args: unknown[]) => {
      calls.push({ method: 'assertQueue', args })
    },
    bindQueue: async (...args: unknown[]) => {
      calls.push({ method: 'bindQueue', args })
    },
    publish: (
      exchange: string,
      routingKey: string,
      content: Uint8Array,
      options: unknown,
      cb: (error?: Error | null) => void,
    ) => {
      calls.push({
        method: 'publish',
        args: [exchange, routingKey, content, options],
      })
      cb(null)
    },
    close: async () => undefined,
  }
}

const sampleJob: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  otp: '123456',
  otpType: 'sign-in',
}

test('assertEmailAmqpTopology declares exchange queue and binding', async () => {
  const channel = createRecordingChannel()
  await assertEmailAmqpTopology(channel)
  assertEquals(channel.calls[0], {
    method: 'assertExchange',
    args: [EMAIL_AMQP_EXCHANGE, 'topic', { durable: true }],
  })
  assertEquals(channel.calls[1], {
    method: 'assertQueue',
    args: [EMAIL_AMQP_QUEUE, { durable: true }],
  })
  assertEquals(channel.calls[2], {
    method: 'bindQueue',
    args: [EMAIL_AMQP_QUEUE, EMAIL_AMQP_EXCHANGE, EMAIL_AMQP_ROUTING_KEY],
  })
})

test('createDenoAmqpQueue publishes persistent mandatory jobs', async () => {
  const channel = createRecordingChannel()
  const fakeConnection = {
    createConfirmChannel: async () => channel,
    close: async () => undefined,
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(fakeConnection as never))

  try {
    const queue = createDenoAmqpQueue({ amqpUrl: 'amqp://test' })
    await queue.enqueue(sampleJob)

    const publishCall = channel.calls.find((call) => call.method === 'publish')
    assertEquals(publishCall?.args[0], EMAIL_AMQP_EXCHANGE)
    assertEquals(publishCall?.args[1], EMAIL_AMQP_ROUTING_KEY)
    assertEquals(publishCall?.args[3], { persistent: true, mandatory: true })

    const decoded = JSON.parse(
      new TextDecoder().decode(publishCall?.args[2] as Uint8Array),
    )
    assertEquals(decoded, sampleJob)
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpQueue enqueue is a no-op when broker connection fails', async () => {
  const connectStub = stub(
    amqplib,
    'connect',
    () => Promise.reject(new Error('ECONNREFUSED')),
  )
  try {
    const queue = createDenoAmqpQueue({ amqpUrl: 'amqp://down' })
    await queue.enqueue(sampleJob)
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpQueue close is safe when never connected', async () => {
  const queue = createDenoAmqpQueue({ amqpUrl: 'amqp://unused' })
  await queue.close()
})

test('createDenoAmqpQueue swallows publish confirm failures', async () => {
  const channel = createRecordingChannel()
  channel.publish = (
    _exchange: string,
    _routingKey: string,
    _content: Uint8Array,
    _options: unknown,
    cb: (error?: Error | null) => void,
  ) => {
    cb(new Error('publish failed'))
  }

  const fakeConnection = {
    createConfirmChannel: async () => channel,
    close: async () => undefined,
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(fakeConnection as never))

  try {
    const queue = createDenoAmqpQueue({ amqpUrl: 'amqp://test' })
    await queue.enqueue(sampleJob)
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpQueue close closes an open channel and connection', async () => {
  const channel = createRecordingChannel()
  let connectionClosed = false
  const fakeConnection = {
    createConfirmChannel: async () => channel,
    close: async () => {
      connectionClosed = true
    },
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(fakeConnection as never))

  try {
    const queue = createDenoAmqpQueue({ amqpUrl: 'amqp://test' })
    await queue.enqueue(sampleJob)
    await queue.close()
    assertEquals(connectionClosed, true)
  } finally {
    connectStub.restore()
  }
})

test('probeAmqpBrokerReachable returns false when connect fails', async () => {
  const connectStub = stub(
    amqplib,
    'connect',
    () => Promise.reject(new Error('down')),
  )
  try {
    assertEquals(await probeAmqpBrokerReachable('amqp://down'), false)
  } finally {
    connectStub.restore()
  }
})

test('probeAmqpBrokerReachable returns true when connect succeeds', async () => {
  const connectStub = stub(amqplib, 'connect', () =>
    Promise.resolve({ close: async () => undefined } as never))
  try {
    assertEquals(await probeAmqpBrokerReachable('amqp://ok'), true)
  } finally {
    connectStub.restore()
  }
})
