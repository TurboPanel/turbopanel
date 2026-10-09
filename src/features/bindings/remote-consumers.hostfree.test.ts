import { assertEquals } from '@std/assert'
import { hasRemoteConsumerServers } from './remote-consumers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('hasRemoteConsumerServers is true only when a consumer is off the member hosts', () => {
  assertEquals(hasRemoteConsumerServers(['srv-db'], ['srv-db']), false)
  assertEquals(hasRemoteConsumerServers(['srv-db'], ['srv-db', 'srv-app']), true)
  assertEquals(hasRemoteConsumerServers(['srv-db'], []), false)
  assertEquals(hasRemoteConsumerServers(['srv-db'], ['']), false)
})
