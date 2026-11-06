import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { settleFailedDelivery } from './delivery-failure.ts'
import {
  COMMAND_RETRY_DELAYS_SECONDS,
  decideRetry,
  QUEUE_RETRY_EXHAUSTED_CODE,
  SERVER_BUSY_DELAY_SECONDS,
  serverBusyDelaySeconds,
  ServerBusyError,
} from './delivery-retry.ts'
import type { CommandEnvelope } from './envelope.ts'
import type { CommandEnqueueOptions, CommandQueue } from './queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ENVELOPE: CommandEnvelope = {
  commandId: '00000000-0000-4000-8000-0000000000c1',
  serverId: '00000000-0000-4000-8000-0000000000b1',
  type: 'daemon.ping',
  attempt: 1,
  queuedAt: '2026-01-01T00:00:00.000Z',
}

const NO_DB = {} as Db

function recordingQueue(options: { reject?: boolean } = {}) {
  const sent: Array<{ envelope: CommandEnvelope; options?: CommandEnqueueOptions }> = []
  const queue: CommandQueue = {
    enqueue: (envelope, enqueueOptions) => {
      if (options.reject) return Promise.reject(new Error('broker down'))
      sent.push({ envelope, options: enqueueOptions })
      return Promise.resolve()
    },
  }
  return { queue, sent }
}

test('decideRetry waits 5 s, 30 s, 2 min and 10 min, then gives up', () => {
  const delays: number[] = []
  let envelope = ENVELOPE
  for (;;) {
    const decision = decideRetry(envelope, 'database unreachable')
    if (decision.kind === 'give_up') {
      assertEquals(
        decision.error,
        'The control plane could not process this command after 5 tries: database unreachable'
      )
      break
    }
    delays.push(decision.delaySeconds)
    assertEquals(decision.envelope.attempt, envelope.attempt + 1)
    envelope = decision.envelope
  }
  assertEquals(delays, [...COMMAND_RETRY_DELAYS_SECONDS])
})

test('a busy server puts the command back for a little later without counting an attempt', async () => {
  const { queue, sent } = recordingQueue()
  const fresh = { ...ENVELOPE, queuedAt: new Date().toISOString() }
  const outcome = await settleFailedDelivery({
    db: NO_DB,
    queue,
    envelope: fresh,
    error: new ServerBusyError(ENVELOPE.serverId),
  })
  assertEquals(outcome, 'ack')
  assertEquals(sent, [{ envelope: fresh, options: { delaySeconds: SERVER_BUSY_DELAY_SECONDS } }])
})

test('a command waiting longer looks again less often', () => {
  const queuedAt = '2026-01-01T00:00:00.000Z'
  const at = (ms: number) => Date.parse(queuedAt) + ms
  assertEquals(serverBusyDelaySeconds(queuedAt, at(0)), 10)
  assertEquals(serverBusyDelaySeconds(queuedAt, at(59_000)), 10)
  assertEquals(serverBusyDelaySeconds(queuedAt, at(2 * 60_000)), 30)
  assertEquals(serverBusyDelaySeconds(queuedAt, at(60 * 60_000)), 30)
  assertEquals(serverBusyDelaySeconds('not a time', at(60 * 60_000)), 10)
})

test('a passing failure is tried again after a wait with the attempt counted', async () => {
  const { queue, sent } = recordingQueue()
  const outcome = await settleFailedDelivery({
    db: NO_DB,
    queue,
    envelope: ENVELOPE,
    error: new Error('connection to the database timed out'),
  })
  assertEquals(outcome, 'ack')
  assertEquals(sent, [
    {
      envelope: { ...ENVELOPE, attempt: 2 },
      options: { delaySeconds: COMMAND_RETRY_DELAYS_SECONDS[0] },
    },
  ])
})

test('when the retry cannot be queued the message is handed back to the queue', async () => {
  const { queue } = recordingQueue({ reject: true })
  assertEquals(
    await settleFailedDelivery({
      db: NO_DB,
      queue,
      envelope: ENVELOPE,
      error: new Error('postgres connection reset'),
    }),
    'redeliver'
  )
  assertEquals(
    await settleFailedDelivery({
      db: NO_DB,
      queue: undefined,
      envelope: ENVELOPE,
      error: new ServerBusyError(ENVELOPE.serverId),
    }),
    'redeliver'
  )
})

test('after the last retry the command is failed with the reason and the message acked', async () => {
  const { queue, sent } = recordingQueue()
  const failed: Array<{ commandId: string; error: string }> = []
  const last = { ...ENVELOPE, attempt: COMMAND_RETRY_DELAYS_SECONDS.length + 1 }
  const outcome = await settleFailedDelivery({
    db: NO_DB,
    queue,
    envelope: last,
    error: new Error('redis connection refused'),
    failCommand: (_db, envelope, error) => {
      failed.push({ commandId: envelope.commandId, error })
      return Promise.resolve('failed' as const)
    },
  })
  assertEquals(outcome, 'ack')
  assertEquals(sent, [])
  assertEquals(failed, [
    {
      commandId: ENVELOPE.commandId,
      error:
        'The control plane could not process this command after 5 tries: redis connection refused',
    },
  ])
  assertEquals(QUEUE_RETRY_EXHAUSTED_CODE, 'queue_retry_exhausted')
})

test('when even failing the command does not work the message is dead-lettered', async () => {
  const outcome = await settleFailedDelivery({
    db: NO_DB,
    queue: recordingQueue().queue,
    envelope: { ...ENVELOPE, attempt: 9 },
    error: new Error('database unreachable'),
    failCommand: () => Promise.reject(new Error('database unreachable')),
  })
  assertEquals(outcome, 'dead_letter')
})

test('a broken message or a permanent error is dead-lettered at once', async () => {
  const { queue, sent } = recordingQueue()
  assertEquals(
    await settleFailedDelivery({
      db: NO_DB,
      queue,
      envelope: null,
      error: new Error('Invalid command envelope'),
    }),
    'dead_letter'
  )
  assertEquals(
    await settleFailedDelivery({
      db: NO_DB,
      queue,
      envelope: ENVELOPE,
      error: new Error('data integrity failure'),
    }),
    'dead_letter'
  )
  assertEquals(sent, [])
})
