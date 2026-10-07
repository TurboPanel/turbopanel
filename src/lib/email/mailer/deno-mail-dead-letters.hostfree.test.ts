import { assertEquals, assertRejects } from '@std/assert'
import {
  EMAIL_AMQP_DEAD_QUEUE,
  EMAIL_AMQP_EXCHANGE,
  EMAIL_AMQP_ROUTING_KEY,
} from '../../../features/email/smtp/amqp-topology.ts'
import { MailQueueUnavailableError } from '../../../features/email/smtp/dead-letter-replay.ts'
import { createAmqpMailDeadLetterStore, type DeadLetterChannel } from './deno-mail-dead-letters.ts'

const test = Deno.test.bind(Deno)

type Delivery = {
  content: Uint8Array
  properties: { messageId?: string; headers: Record<string, unknown> }
}
type Published = { exchange: string; key: string; options: Record<string, unknown> }

function job(type: string, to: string, extra: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ type, to, from: 'noreply@panel.test', ...extra })
  )
}

function dead(id: string, to: string, otp = '111111'): Delivery {
  return {
    content: job('email-otp', to, { otp, otpType: 'sign-in' }),
    properties: {
      messageId: id,
      headers: {
        'x-tp-attempt': 5,
        'x-tp-dead-reason': 'email-otp gave up after 5 attempts: greylisted',
        'x-tp-dead-at': '2026-10-05T12:00:00.000Z',
      },
    },
  }
}

/** An in-memory dead queue: `get` hands out unacked messages, nack(requeue) returns them. */
function fakeBroker(initial: Delivery[], opts: { failPublishFor?: string } = {}) {
  const queue = [...initial]
  const order = new Map(initial.map((message, index) => [message, index]))
  const inFlight = new Set<Delivery>()
  const published: Published[] = []
  const closed = { channel: 0, connection: 0 }
  const channel: DeadLetterChannel = {
    assertExchange: () => Promise.resolve(),
    assertQueue: () => Promise.resolve({}),
    bindQueue: () => Promise.resolve(),
    checkQueue: () => Promise.resolve({ messageCount: queue.length + inFlight.size }),
    get: () => {
      const next = queue.shift()
      if (!next) return Promise.resolve(false)
      inFlight.add(next)
      return Promise.resolve(next as never)
    },
    ack: (message) => {
      inFlight.delete(message as Delivery)
    },
    nack: (message, _all, requeue) => {
      inFlight.delete(message as Delivery)
      // RabbitMQ puts a requeued message back at its original position.
      if (requeue) queue.push(message as Delivery)
      queue.sort((a, b) => order.get(a)! - order.get(b)!)
    },
    publish: (exchange, key, _content, options, callback) => {
      if (opts.failPublishFor && options.messageId === opts.failPublishFor) {
        callback(new Error('broker refused'))
        return false
      }
      published.push({ exchange, key, options })
      callback(null)
      return true
    },
    close: () => {
      closed.channel++
      return Promise.resolve()
    },
  }
  const connect = () =>
    Promise.resolve({
      channel,
      close: () => {
        closed.connection++
        return Promise.resolve()
      },
    })
  return { queue, published, closed, connect, inFlight }
}

const NOW = new Date('2026-10-05T13:00:00.000Z')
const storeFor = (broker: ReturnType<typeof fakeBroker>) =>
  createAmqpMailDeadLetterStore({ amqpUrl: 'amqp://test', connect: broker.connect, now: () => NOW })

test('list shows a page without removing anything, and masks the recipient', async () => {
  const broker = fakeBroker([
    dead('m-1', 'jane.doe@example.com'),
    dead('m-2', 'bob@example.com'),
    dead('m-3', 'cy@example.com'),
  ])
  const out = await storeFor(broker).list(2)
  assertEquals(out.total, 3)
  assertEquals(
    out.items.map((item) => item.id),
    ['m-1', 'm-2']
  )
  assertEquals(out.items[0]!.to, 'j***@example.com')
  assertEquals(JSON.stringify(out).includes('111111'), false)
  assertEquals(broker.queue.length, 3)
  assertEquals(broker.inFlight.size, 0)
  assertEquals(broker.published.length, 0)
  assertEquals(broker.closed, { channel: 1, connection: 1 })
})

test('list on an empty queue is an empty page', async () => {
  const broker = fakeBroker([])
  assertEquals(await storeFor(broker).list(50), { total: 0, items: [] })
})

test('replay one republishes only that job with a fresh attempt count and removes it', async () => {
  const broker = fakeBroker([
    dead('m-1', 'a@x.test'),
    dead('m-2', 'b@x.test'),
    dead('m-3', 'c@x.test'),
  ])
  const result = await storeFor(broker).replayOne('m-2')
  assertEquals(result, { replayed: true })
  assertEquals(broker.published.length, 1)
  const sent = broker.published[0]!
  assertEquals([sent.exchange, sent.key], [EMAIL_AMQP_EXCHANGE, EMAIL_AMQP_ROUTING_KEY])
  assertEquals(sent.options.persistent, true)
  assertEquals(sent.options.headers, { 'x-tp-replayed-at': NOW.toISOString() })
  assertEquals(
    broker.queue.map((m) => m.properties.messageId),
    ['m-1', 'm-3']
  )
  assertEquals(broker.inFlight.size, 0)
})

test('replay one with an unknown id changes nothing', async () => {
  const broker = fakeBroker([dead('m-1', 'a@x.test')])
  assertEquals(await storeFor(broker).replayOne('nope'), { replayed: false })
  assertEquals(broker.published.length, 0)
  assertEquals(broker.queue.length, 1)
})

test('a job whose republish fails stays in the queue', async () => {
  const broker = fakeBroker([dead('m-1', 'a@x.test')], { failPublishFor: 'm-1' })
  await assertRejects(() => storeFor(broker).replayOne('m-1'), MailQueueUnavailableError)
  assertEquals(broker.queue.length, 1)
  assertEquals(broker.inFlight.size, 0)
})

test('replay all moves every job, up to the limit, oldest first', async () => {
  const broker = fakeBroker([
    dead('m-1', 'a@x.test'),
    dead('m-2', 'b@x.test'),
    dead('m-3', 'c@x.test'),
  ])
  const result = await storeFor(broker).replayAll(2)
  assertEquals(result, { replayed: 2, failed: 0, remaining: 1 })
  assertEquals(
    broker.published.map((p) => p.options.messageId),
    ['m-1', 'm-2']
  )
  assertEquals(
    broker.queue.map((m) => m.properties.messageId),
    ['m-3']
  )
})

test('replay all counts a refused job as failed and leaves it queued', async () => {
  const broker = fakeBroker(
    [dead('m-1', 'a@x.test'), dead('m-2', 'b@x.test'), dead('m-3', 'c@x.test')],
    { failPublishFor: 'm-2' }
  )
  const result = await storeFor(broker).replayAll(1000)
  assertEquals(result, { replayed: 2, failed: 1, remaining: 1 })
  assertEquals(
    broker.queue.map((m) => m.properties.messageId),
    ['m-2']
  )
  assertEquals(broker.inFlight.size, 0)
})

test('replay all on an empty queue is a no-op', async () => {
  const broker = fakeBroker([])
  assertEquals(await storeFor(broker).replayAll(1000), { replayed: 0, failed: 0, remaining: 0 })
})

test('a broker that cannot be reached is reported as the mail queue being unavailable', async () => {
  const store = createAmqpMailDeadLetterStore({
    amqpUrl: 'amqp://test',
    connect: () => Promise.reject(new Error('ECONNREFUSED')),
  })
  await assertRejects(() => store.list(10), MailQueueUnavailableError)
  await assertRejects(() => store.replayOne('x'), MailQueueUnavailableError)
  await assertRejects(() => store.replayAll(10), MailQueueUnavailableError)
})

test('the dead queue name the tool reads is the one the consumer writes', () => {
  assertEquals(EMAIL_AMQP_DEAD_QUEUE, 'turbopanel.email.dead')
})
