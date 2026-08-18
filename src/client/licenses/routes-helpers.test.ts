import { assertEquals } from 'jsr:@std/assert'
import { DISPLAY_NAME_MAX_LENGTH } from '../../lib/display-name-format.ts'
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
      name: 'Edge node',
      installBaseUrl: 'https://panel.example.com',
    })),
    {
      name: 'Edge node',
      installBaseUrl: 'https://panel.example.com',
    },
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      displayName: 'Rack 2',
    })),
    { name: 'Rack 2' },
  )
})

test('parseLicenseCreateFields rejects invalid JSON and shapes', () => {
  assertEquals(parseLicenseCreateFields('{'), 'invalid')
  assertEquals(parseLicenseCreateFields('[]'), 'invalid')
  assertEquals(parseLicenseCreateFields('null'), 'invalid')
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: 1 })),
    'invalid',
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ displayName: false })),
    'invalid',
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ installBaseUrl: false })),
    'invalid',
  )
})

test('parseLicenseCreateFields normalizes Unicode, smart quotes, and trimming', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ displayName: 'Café 东京' })),
    { name: 'Café 东京' },
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ displayName: '  O\u2019Reilly  ' })),
    { name: "O'Reilly" },
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: '  Edge node  ' })),
    { name: 'Edge node' },
  )
})

test('parseLicenseCreateFields omits absent and whitespace-only optional names', () => {
  assertEquals(parseLicenseCreateFields(JSON.stringify({ name: '' })), {})
  assertEquals(parseLicenseCreateFields(JSON.stringify({ displayName: '   ' })), {})
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      displayName: '  ',
      name: 'Legacy',
      installBaseUrl: 'https://panel.example.com',
    })),
    { installBaseUrl: 'https://panel.example.com' },
  )
})

test('parseLicenseCreateFields rejects control characters and over-length names', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ displayName: 'bad\nname' })),
    'invalid',
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      name: 'a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    })),
    'invalid',
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      displayName: '😀'.repeat(DISPLAY_NAME_MAX_LENGTH),
    })),
    { name: '😀'.repeat(DISPLAY_NAME_MAX_LENGTH) },
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      displayName: '😀'.repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    })),
    'invalid',
  )
})
