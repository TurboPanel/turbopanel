import { assertEquals, assertRejects } from '@std/assert'
import type { CommandType } from './types.ts'
import {
  createNoopCommandQueue,
  isNoopCommandQueue,
} from './noop-command-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('createNoopCommandQueue rejects enqueue', async () => {
  const queue = createNoopCommandQueue()
  await assertRejects(
    () =>
      queue.enqueue({
        commandId: 'cmd-1',
        serverId: 'srv-1',
        type: 'daemon.ping' as CommandType,
        attempt: 1,
        queuedAt: '2020-01-01T00:00:00.000Z',
      }),
    Error,
    'Command queue unavailable',
  )
})

test('isNoopCommandQueue detects noop and undefined queues', () => {
  assertEquals(isNoopCommandQueue(undefined), true)
  assertEquals(isNoopCommandQueue(createNoopCommandQueue()), true)
  assertEquals(
    isNoopCommandQueue({
      enqueue: async () => {},
    }),
    false,
  )
})
