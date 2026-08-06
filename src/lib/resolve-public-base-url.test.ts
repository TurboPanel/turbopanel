import { assertEquals } from 'jsr:@std/assert'
import { parseInstallBaseUrl } from './resolve-public-base-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseInstallBaseUrl accepts https origins in production', () => {
  assertEquals(parseInstallBaseUrl('https://panel.example.com'), 'https://panel.example.com')
})

test('parseInstallBaseUrl rejects plaintext http without dev allowance', () => {
  assertEquals(parseInstallBaseUrl('http://panel.example.com'), null)
})

test('parseInstallBaseUrl allows plaintext http with dev allowance', () => {
  assertEquals(
    parseInstallBaseUrl('http://dev.example.com:8880', { allowHttp: true }),
    'http://dev.example.com:8880',
  )
})

test('parseInstallBaseUrl rejects paths, query strings, and shell metacharacters', () => {
  assertEquals(parseInstallBaseUrl('https://panel.example.com; curl http://evil'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com/path'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com?x=$(id)'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com/`whoami`'), null)
})
