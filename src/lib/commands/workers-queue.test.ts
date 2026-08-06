import { assertEquals } from 'jsr:@std/assert'
import type { CommandType } from './types.ts'
import { createWorkersCommandQueue } from './workers-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('createWorkersCommandQueue forwards envelopes to the Workers Queue binding', async () => {
  const sent: unknown[] = []
  const queue = {
    send: async (body: unknown) => {
      sent.push(body)
    },
  } as Queue

  const commandQueue = createWorkersCommandQueue(queue)
  const envelope = {
    commandId: 'cmd-1',
    serverId: 'srv-1',
    type: 'daemon.ping' as CommandType,
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }

  await commandQueue.enqueue(envelope)
  assertEquals(sent, [envelope])
})
