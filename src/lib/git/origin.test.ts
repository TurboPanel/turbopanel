import { assertEquals } from '@std/assert'
import { normalizeOrigin, stripTrailingSlashes } from './origin.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('stripTrailingSlashes drops every trailing slash and nothing else', () => {
  assertEquals(stripTrailingSlashes('https://github.com'), 'https://github.com')
  assertEquals(stripTrailingSlashes('https://github.com/'), 'https://github.com')
  assertEquals(stripTrailingSlashes('https://github.com//'), 'https://github.com')
  assertEquals(stripTrailingSlashes('https://github.com///'), 'https://github.com')
  // Mid-string slashes stay; only the suffix is dropped.
  assertEquals(stripTrailingSlashes('https://github.com/path/'), 'https://github.com/path')
  assertEquals(stripTrailingSlashes(''), '')
  assertEquals(stripTrailingSlashes('///'), '')
  assertEquals(stripTrailingSlashes('/'), '')
})

test('normalizeOrigin trims then strips trailing slashes', () => {
  assertEquals(normalizeOrigin('  https://github.com///  '), 'https://github.com')
  assertEquals(normalizeOrigin('https://github.acme.test/'), 'https://github.acme.test')
  assertEquals(normalizeOrigin('   '), '')
})
