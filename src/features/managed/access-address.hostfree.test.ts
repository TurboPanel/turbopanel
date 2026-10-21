import { assertEquals } from '@std/assert'
import { ALL_INTERFACES_BIND, LOOPBACK_BIND } from './access-address.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('bind constants stay loopback and all-interfaces wildcards', () => {
  assertEquals(LOOPBACK_BIND, '127.0.0.1')
  assertEquals(ALL_INTERFACES_BIND, '0.0.0.0')
})
