import { assertEquals } from 'jsr:@std/assert'
import {
  DAEMON_CHALLENGE_TTL_MS,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
  isDaemonChallengeFresh,
  issueDaemonChallenge,
} from './challenge.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('issueDaemonChallenge stamps issuedAtMs and ISO at', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const challenge = issueDaemonChallenge(now)
  assertEquals(challenge.issuedAtMs, now)
  assertEquals(challenge.at, new Date(now).toISOString())
  assertEquals(challenge.id.length > 0, true)
  assertEquals(challenge.nonce.length > 0, true)
})

test('isDaemonChallengeFresh honors default and custom maxAgeMs', () => {
  const now = 1_000_000
  const challenge = issueDaemonChallenge(now)
  assertEquals(isDaemonChallengeFresh(challenge, now), true)
  assertEquals(
    isDaemonChallengeFresh(challenge, now + DAEMON_CHALLENGE_TTL_MS),
    true,
  )
  assertEquals(
    isDaemonChallengeFresh(challenge, now + DAEMON_CHALLENGE_TTL_MS + 1),
    false,
  )
  assertEquals(
    isDaemonChallengeFresh(challenge, now + 4_999, 5_000),
    true,
  )
  assertEquals(
    isDaemonChallengeFresh(challenge, now + 5_000, 5_000),
    true,
  )
  assertEquals(
    isDaemonChallengeFresh(challenge, now + 5_001, 5_000),
    false,
  )
})

test('DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS matches auth/challenge contract', () => {
  assertEquals(DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS, 60_000)
})
