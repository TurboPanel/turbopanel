import { assert, assertEquals } from '@std/assert'
import {
  backoffMs,
  isRateLimitReason,
  MAX_ATTEMPTS_PER_HOUR,
  mayStartAttempt,
  pruneAttempts,
} from './attempts.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = new Date('2026-11-01T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

test('the wait grows 10 minutes, 30 minutes, 1 hour, 2 hours, then doubles up to a day', () => {
  const minutes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n) / 60_000)
  assertEquals(minutes, [10, 30, 60, 120, 240, 480, 960, 1440])
  assertEquals(backoffMs(0), 0)
})

test('a first attempt is allowed at once', () => {
  assertEquals(mayStartAttempt({ attemptTimes: [], nextAttemptAt: null }, NOW), { ok: true })
})

test('the stored wait holds the next attempt back', () => {
  const next = new Date(NOW.getTime() + 600_000)
  const verdict = mayStartAttempt({ attemptTimes: [], nextAttemptAt: next.toISOString() }, NOW)
  assertEquals(verdict, { ok: false, notBefore: next })
})

test('three attempts in a rolling hour stop a fourth until the oldest is an hour old', () => {
  const times = [ago(50), ago(30), ago(10)]
  assertEquals(times.length, MAX_ATTEMPTS_PER_HOUR)
  const verdict = mayStartAttempt({ attemptTimes: times, nextAttemptAt: null }, NOW)
  assert(!verdict.ok)
  assertEquals(
    verdict.notBefore.toISOString(),
    new Date(Date.parse(times[0]) + 3_600_000).toISOString()
  )
  assertEquals(
    mayStartAttempt({ attemptTimes: [ago(70), ago(30), ago(10)], nextAttemptAt: null }, NOW),
    { ok: true }
  )
})

test('attempts older than a week are forgotten', () => {
  const old = new Date(NOW.getTime() - 8 * 86_400_000).toISOString()
  assertEquals(pruneAttempts([old, ago(5)], NOW), [ago(5)])
})

test('the authority rate-limit answer is recognised', () => {
  assert(isRateLimitReason('urn:ietf:params:acme:error:rateLimited: too many certificates'))
  assert(isRateLimitReason('Rate limit reached'))
  assert(!isRateLimitReason('Connection refused'))
})
