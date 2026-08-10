/**
 * Host-free coverage gaps for license create body parsing.
 */

import { assertEquals } from 'jsr:@std/assert'
import { parseLicenseCreateFields } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseLicenseCreateFields accepts partial string fields and ignores extras', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: 'Edge node' })),
    { name: 'Edge node' },
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      installBaseUrl: 'https://panel.example.com',
      extra: 'ignored',
    })),
    { installBaseUrl: 'https://panel.example.com' },
  )
})

test('parseLicenseCreateFields accepts empty string name values', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: '' })),
    { name: '' },
  )
})

test('parseLicenseCreateFields rejects numeric field types', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ installBaseUrl: 8443 })),
    'invalid',
  )
})
