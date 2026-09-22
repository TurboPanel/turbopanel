import { assertEquals } from '@std/assert'
import { stringifyGithubAppId } from './github-app-id.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('stringifyGithubAppId accepts a finite number or non-empty string', () => {
  assertEquals(stringifyGithubAppId(88), '88')
  assertEquals(stringifyGithubAppId(0), '0')
  assertEquals(stringifyGithubAppId('9'), '9')
  assertEquals(stringifyGithubAppId(1n), '1')
})

test('stringifyGithubAppId rejects objects and other non-ids', () => {
  assertEquals(stringifyGithubAppId(undefined), null)
  assertEquals(stringifyGithubAppId(null), null)
  assertEquals(stringifyGithubAppId(''), null)
  assertEquals(stringifyGithubAppId(Number.NaN), null)
  assertEquals(stringifyGithubAppId(Number.POSITIVE_INFINITY), null)
  assertEquals(stringifyGithubAppId({ id: 88 }), null)
  assertEquals(stringifyGithubAppId([88]), null)
  assertEquals(stringifyGithubAppId(true), null)
})
