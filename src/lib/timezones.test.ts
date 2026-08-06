import { assertEquals } from 'jsr:@std/assert'
import {
  TIMEZONE_MAX_LENGTH,
  TIMEZONE_RE,
  isAllowedTimezone,
  isValidTimezone,
  listTimezones,
} from './timezones.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('TIMEZONE_RE and max length match daemon parity constants', () => {
  assertEquals(TIMEZONE_MAX_LENGTH, 64)
  assertEquals(TIMEZONE_RE.test('America/Chicago'), true)
  assertEquals(TIMEZONE_RE.test('UTC'), true)
  assertEquals(TIMEZONE_RE.test('bad zone'), false)
})

test('isValidTimezone rejects non-strings, blanks, and shell metacharacters', () => {
  assertEquals(isValidTimezone(null), false)
  assertEquals(isValidTimezone(''), false)
  assertEquals(isValidTimezone('America/New York'), false)
  assertEquals(isValidTimezone('America/Chicago; rm -rf /'), false)
  assertEquals(isValidTimezone('a'.repeat(TIMEZONE_MAX_LENGTH + 1)), false)
})

test('isValidTimezone accepts well-formed IANA identifiers', () => {
  assertEquals(isValidTimezone('America/Chicago'), true)
  assertEquals(isValidTimezone('Europe/London'), true)
})

test('listTimezones returns a sorted non-empty list', () => {
  const zones = listTimezones()
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new TypeError('expected non-empty timezone list')
  }
  const sorted = [...zones].sort((a, b) => a.localeCompare(b))
  assertEquals(zones, sorted)
  assertEquals(zones.includes('America/Chicago'), true)
})

test('isAllowedTimezone requires shape validity and list membership', () => {
  assertEquals(isAllowedTimezone('not a timezone'), false)
  assertEquals(isAllowedTimezone('America/Chicago'), true)
  assertEquals(isAllowedTimezone(listTimezones()[0]), true)
})
