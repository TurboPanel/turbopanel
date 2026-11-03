import { assertEquals, assertRejects } from '@std/assert'
import { stub } from '@std/testing/mock'
import amqplib from 'amqplib'
import {
  assertCommandAmqpTopology,
  COMMAND_AMQP_DLQ,
  COMMAND_AMQP_DLX,
  COMMAND_AMQP_EXCHANGE,
  COMMAND_AMQP_QUEUE,
  COMMAND_AMQP_ROUTING_KEY,
} from '../../../features/commands/command-amqp-topology.ts'
import { createDenoAmqpCommandQueue, probeCommandAmqpBrokerReachable } from './deno-amqp-queue.ts'
import type { CommandEnvelope } from '../../../features/commands/envelope.ts'

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
      cb: (error?: Error) => void
    ) => {
      calls.push({
        method: 'publish',
        args: [exchange, routingKey, content, options],
      })
      cb()
    },
    close: async () => undefined,
  }
}

test('assertCommandAmqpTopology declares DLX, DLQ, exchange, and main queue', async () => {
  const channel = createRecordingChannel()
  await assertCommandAmqpTopology(channel)

  assertEquals(channel.calls[0], {
    method: 'assertExchange',
    args: [COMMAND_AMQP_DLX, 'topic', { durable: true }],
  })
  assertEquals(channel.calls[1], {
    method: 'assertQueue',
    args: [COMMAND_AMQP_DLQ, { durable: true }],
  })
  assertEquals(channel.calls[2], {
    method: 'bindQueue',
    args: [COMMAND_AMQP_DLQ, COMMAND_AMQP_DLX, COMMAND_AMQP_ROUTING_KEY],
  })
  assertEquals(channel.calls[3], {
    method: 'assertExchange',
    args: [COMMAND_AMQP_EXCHANGE, 'topic', { durable: true }],
  })
  assertEquals(channel.calls[4], {
    method: 'assertQueue',
    args: [
      COMMAND_AMQP_QUEUE,
      {
        durable: true,
        arguments: { 'x-dead-letter-exchange': COMMAND_AMQP_DLX },
      },
    ],
  })
  assertEquals(channel.calls[5], {
    method: 'bindQueue',
    args: [COMMAND_AMQP_QUEUE, COMMAND_AMQP_EXCHANGE, COMMAND_AMQP_ROUTING_KEY],
  })
})

test('createDenoAmqpCommandQueue publishes persistent mandatory envelopes', async () => {
  const channel = createRecordingChannel()
  const fakeConnection = {
    createConfirmChannel: async () => channel,
    close: async () => undefined,
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(fakeConnection as never))

  const envelope: CommandEnvelope = {
    commandId: 'cmd-1',
    serverId: 'srv-1',
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }

  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://test' })
    await queue.enqueue(envelope)

    const publishCall = channel.calls.find((call) => call.method === 'publish')
    assertEquals(publishCall?.args[0], COMMAND_AMQP_EXCHANGE)
    assertEquals(publishCall?.args[1], COMMAND_AMQP_ROUTING_KEY)
    assertEquals(publishCall?.args[3], { persistent: true, mandatory: true })

    const decoded = JSON.parse(new TextDecoder().decode(publishCall?.args[2] as Uint8Array))
    assertEquals(decoded, envelope)
    // Production path wraps with Buffer.from for amqplib; recording channel
    // still receives a byte view we can decode.
    assertEquals(typeof Buffer !== 'undefined' && Buffer.isBuffer(publishCall?.args[2]), true)
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpCommandQueue rejects when broker connection fails', async () => {
  const connectStub = stub(amqplib, 'connect', () => Promise.reject(new Error('ECONNREFUSED')))

  const envelope: CommandEnvelope = {
    commandId: 'cmd-3',
    serverId: 'srv-1',
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }

  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://down' })
    await assertRejects(() => queue.enqueue(envelope), Error, 'Command queue unavailable')
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpCommandQueue close is safe when never connected', async () => {
  const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://unused' })
  if (!queue.close) throw new TypeError('expected a closable command queue')
  await queue.close()
})

test('createDenoAmqpCommandQueue reuses a live channel and closes it', async () => {
  const channel = createRecordingChannel()
  const fakeConnection = {
    createConfirmChannel: async () => channel,
    close: async () => undefined,
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(fakeConnection as never))
  const envelope: CommandEnvelope = {
    commandId: 'cmd-reuse',
    serverId: 'srv-1',
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }
  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://test' })
    await queue.enqueue(envelope)
    await queue.enqueue(envelope)
    if (!queue.close) throw new TypeError('expected a closable command queue')
    await queue.close()
    assertEquals(channel.calls.filter((call) => call.method === 'publish').length, 2)
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpCommandQueue close swallows channel and connection errors', async () => {
  const channel = createRecordingChannel()
  channel.close = async () => {
    throw new Error('channel close failed')
  }
  const fakeConnection = {
    createConfirmChannel: async () => channel,
    close: async () => {
      throw new Error('connection close failed')
    },
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(fakeConnection as never))
  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://test' })
    await queue.enqueue({
      commandId: 'cmd-close',
      serverId: 'srv-1',
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: '2020-01-01T00:00:00.000Z',
    })
    if (!queue.close) throw new TypeError('expected a closable command queue')
    await queue.close()
  } finally {
    connectStub.restore()
  }
})

test('probeCommandAmqpBrokerReachable returns false when connect fails', async () => {
  const connectStub = stub(amqplib, 'connect', () => Promise.reject(new Error('down')))
  try {
    assertEquals(await probeCommandAmqpBrokerReachable('amqp://down'), false)
  } finally {
    connectStub.restore()
  }
})

test('probeCommandAmqpBrokerReachable returns true when connect succeeds', async () => {
  const connectStub = stub(amqplib, 'connect', () =>
    Promise.resolve({ close: async () => undefined } as never)
  )
  try {
    assertEquals(await probeCommandAmqpBrokerReachable('amqp://ok'), true)
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpCommandQueue rejects when confirm callback fails', async () => {
  const channel = createRecordingChannel()
  channel.publish = (
    _exchange: string,
    _routingKey: string,
    _content: Uint8Array,
    _options: unknown,
    cb: (error?: Error) => void
  ) => {
    cb(new Error('publish failed'))
  }

  const fakeConnection = {
    createConfirmChannel: async () => channel,
    close: async () => undefined,
  }
  const connectStub = stub(amqplib, 'connect', () => Promise.resolve(fakeConnection as never))

  const envelope: CommandEnvelope = {
    commandId: 'cmd-2',
    serverId: 'srv-1',
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }

  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://test' })
    await assertRejects(() => queue.enqueue(envelope), Error, 'publish failed')
  } finally {
    connectStub.restore()
  }
})

function createEmitter() {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  return {
    on(event: string, listener: (arg?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event: string, arg?: unknown) {
      const bucket = listeners.get(event)
      // Mirrors EventEmitter: an 'error' with no listener is a thrown exception.
      if (event === 'error' && !bucket?.length) throw arg
      for (const listener of bucket ?? []) listener(arg)
    },
  }
}

const LOSS_ENVELOPE: CommandEnvelope = {
  commandId: 'cmd-loss',
  serverId: 'srv-1',
  type: 'daemon.ping',
  attempt: 1,
  queuedAt: '2020-01-01T00:00:00.000Z',
}

test('createDenoAmqpCommandQueue survives the broker dropping the connection and reconnects', async () => {
  const sessions: Array<{
    events: ReturnType<typeof createEmitter>
    channel: ReturnType<typeof createRecordingChannel>
  }> = []
  const connectStub = stub(amqplib, 'connect', () => {
    const events = createEmitter()
    const channel = createRecordingChannel()
    sessions.push({ events, channel })
    return Promise.resolve({
      on: events.on,
      createConfirmChannel: async () => channel,
      close: async () => undefined,
    } as never)
  })
  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://test' })
    await queue.enqueue(LOSS_ENVELOPE)
    // The broker goes away: this used to be an unhandled 'error' event,
    // which exits the process.
    sessions[0].events.emit('error', new Error('Unexpected close'))
    sessions[0].events.emit('close')
    await queue.enqueue(LOSS_ENVELOPE)
    assertEquals(sessions.length, 2)
    assertEquals(sessions[1].channel.calls.filter((call) => call.method === 'publish').length, 1)
    await queue.close?.()
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpCommandQueue drops a channel that throws on publish and reconnects next time', async () => {
  let connects = 0
  const connectStub = stub(amqplib, 'connect', () => {
    connects += 1
    const channel = createRecordingChannel()
    if (connects === 1) {
      channel.publish = () => {
        throw new Error('Channel closed')
      }
    }
    return Promise.resolve({
      createConfirmChannel: async () => channel,
      close: async () => undefined,
    } as never)
  })
  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://test' })
    await assertRejects(() => queue.enqueue(LOSS_ENVELOPE), Error, 'Channel closed')
    await queue.enqueue(LOSS_ENVELOPE)
    assertEquals(connects, 2)
  } finally {
    connectStub.restore()
  }
})

test('createDenoAmqpCommandQueue never keeps a connection that finished opening after close', async () => {
  let release: (() => void) | undefined
  let closedConnections = 0
  const connectStub = stub(amqplib, 'connect', async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      createConfirmChannel: async () => createRecordingChannel(),
      close: async () => {
        closedConnections += 1
      },
    } as never
  })
  try {
    const queue = createDenoAmqpCommandQueue({ amqpUrl: 'amqp://slow' })
    const pending = queue.enqueue(LOSS_ENVELOPE)
    await queue.close?.()
    release?.()
    await assertRejects(() => pending, Error, 'Command queue unavailable')
    assertEquals(closedConnections, 1)
    await assertRejects(() => queue.enqueue(LOSS_ENVELOPE), Error, 'Command queue unavailable')
  } finally {
    connectStub.restore()
  }
})
