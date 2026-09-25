import { assertEquals, assertRejects } from '@std/assert'
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

const envelope = {
  commandId: '019535f0-0000-7000-8000-000000000001',
  serverId: '019535f0-0000-7000-8000-000000000002',
  type: 'daemon.ping' as const,
  attempt: 1,
  queuedAt: '2026-01-01T00:00:00.000Z',
}

test('createNoopCommandQueue rejects enqueue with a clear error', async () => {
  const queue = createNoopCommandQueue()
  await assertRejects(
    () => queue.enqueue(envelope),
    Error,
    'Command queue unavailable',
  )
})

test('isNoopCommandQueue recognizes undefined and the noop implementation', () => {
  assertEquals(isNoopCommandQueue(undefined), true)
  assertEquals(isNoopCommandQueue(createNoopCommandQueue()), true)
  assertEquals(
    isNoopCommandQueue({ enqueue: async () => {} }),
    false,
  )
})
