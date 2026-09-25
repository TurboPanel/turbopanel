import { assertEquals } from '@std/assert'
import { stripLogInjection } from './log-compat.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('stripLogInjection neutralizes line breaks and tabs', () => {
  assertEquals(stripLogInjection('ok'), 'ok')
  assertEquals(stripLogInjection('a\nb\rc\td'), 'a_b_c_d')
})
