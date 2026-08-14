import { assertEquals } from 'jsr:@std/assert'
import { resolveSelfHostedGeo } from './self-hosted-geo-provider.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveSelfHostedGeo is a stub that always returns null', () => {
  assertEquals(resolveSelfHostedGeo(null), null)
  assertEquals(resolveSelfHostedGeo(undefined), null)
  assertEquals(resolveSelfHostedGeo('203.0.113.10'), null)
  assertEquals(resolveSelfHostedGeo('__direct__'), null)
})
