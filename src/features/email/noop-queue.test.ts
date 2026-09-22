import { assertEquals } from '@std/assert'
import { createNoopQueue, isNoopEmailQueue } from './noop-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('createNoopQueue enqueue is a no-op', async () => {
  const queue = createNoopQueue()
  await queue.enqueue({
    type: 'email-otp',
    to: 'ops@example.com',
    from: 'noreply@example.com',
    otp: '123456',
    otpType: 'sign-in',
  })
})

test('isNoopEmailQueue detects noop and undefined queues', () => {
  assertEquals(isNoopEmailQueue(undefined), true)
  assertEquals(isNoopEmailQueue(createNoopQueue()), true)
  assertEquals(
    isNoopEmailQueue({
      enqueue: async () => {},
    }),
    false,
  )
})
