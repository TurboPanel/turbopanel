import { assertEquals } from '@std/assert'
import {
  DEFAULT_AMQP_DEV_PORT,
  DEFAULT_AMQP_URL,
  buildDefaultAmqpUrl,
} from './amqp-default-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('buildDefaultAmqpUrl uses the guest/guest localhost shape', () => {
  assertEquals(
    buildDefaultAmqpUrl(),
    `amqp://guest:guest@localhost:${DEFAULT_AMQP_DEV_PORT}`,
  )
  assertEquals(buildDefaultAmqpUrl(5672), 'amqp://guest:guest@localhost:5672')
  assertEquals(DEFAULT_AMQP_URL, buildDefaultAmqpUrl())
})
