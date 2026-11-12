import { assertEquals } from '@std/assert'
import { lockAddSkipsSite } from './route-facts.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('the lock add skips a site with an automatic certificate or HTTPS-only turned off', () => {
  // Defaults: HTTPS-only on, no pinned certificate: the daemon can reshape the block.
  assertEquals(lockAddSkipsSite(null, null), false)
  assertEquals(lockAddSkipsSite({}, undefined), false)
  assertEquals(lockAddSkipsSite({ proxy: { forceHttps: true } }, 'ready'), false)
  assertEquals(lockAddSkipsSite({ proxy: { forceHttps: false } }, null), true)
  assertEquals(lockAddSkipsSite({}, 'automatic'), true)
})
