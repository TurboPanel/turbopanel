import { assertEquals } from 'jsr:@std/assert'
import { parseLicenseCreateFields } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseLicenseCreateFields accepts empty body', () => {
  assertEquals(parseLicenseCreateFields(''), {})
  assertEquals(parseLicenseCreateFields('   '), {})
})

test('parseLicenseCreateFields parses optional string fields', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      displayName: 'Edge node',
      installBaseUrl: 'https://panel.example.com',
    })),
    {
      displayName: 'Edge node',
      installBaseUrl: 'https://panel.example.com',
    },
  )
})

test('parseLicenseCreateFields rejects invalid JSON and shapes', () => {
  assertEquals(parseLicenseCreateFields('{'), 'invalid')
  assertEquals(parseLicenseCreateFields('[]'), 'invalid')
  assertEquals(parseLicenseCreateFields('null'), 'invalid')
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ displayName: 1 })),
    'invalid',
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ installBaseUrl: false })),
    'invalid',
  )
})
