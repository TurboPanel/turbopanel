import { assertEquals } from '@std/assert'
import { redactUrlCredentials } from './redact-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('redactUrlCredentials keeps the user and host, hides the password', () => {
  assertEquals(
    redactUrlCredentials('amqp://turbopanel:s3cret@127.0.0.1:5672/'),
    'amqp://turbopanel:***@127.0.0.1:5672/',
  )
  assertEquals(redactUrlCredentials('amqp://localhost:5672/'), 'amqp://localhost:5672/')
  assertEquals(redactUrlCredentials('not a url with user:pw@host'), 'not a url with user:pw@host')
  assertEquals(redactUrlCredentials('amqp://u:p@h'), 'amqp://u:***@h')
})
