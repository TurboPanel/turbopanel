import { assertEquals } from '@std/assert'
import { aboutWait, utcMoment } from './plain-time.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MINUTE = 60_000
const HOUR = 60 * MINUTE

test('a wait reads in the nearest minutes, hours or days', () => {
  assertEquals(aboutWait(20_000), 'less than a minute')
  assertEquals(aboutWait(MINUTE), 'about a minute')
  assertEquals(aboutWait(20 * MINUTE + 10_000), 'about 20 minutes')
  assertEquals(aboutWait(89 * MINUTE), 'about 89 minutes')
  assertEquals(aboutWait(90 * MINUTE), 'about 2 hours')
  assertEquals(aboutWait(65 * MINUTE), 'about 65 minutes')
  assertEquals(aboutWait(4 * HOUR), 'about 4 hours')
  assertEquals(aboutWait(36 * HOUR), 'about 2 days')
  assertEquals(aboutWait(7 * 24 * HOUR), 'about 7 days')
})

test('a moment reads as a UTC date and time to the minute', () => {
  assertEquals(utcMoment(new Date('2026-11-01T14:05:59.000Z')), 'Nov 1, 2026, 14:05 UTC')
  assertEquals(utcMoment(new Date('2027-01-09T03:00:00.000Z')), 'Jan 9, 2027, 03:00 UTC')
})
