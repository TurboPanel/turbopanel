import { assertEquals } from '@std/assert'
import {
  DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID,
  daemonConnectRateLimitKey,
  daemonEnrollChallengeRateLimitKey,
  daemonMetricsRateLimitKey,
  daemonRestRateLimitKey,
} from './keys.ts'
import {
  createFailClosedRateLimiter,
  createNoopRateLimiter,
} from './contracts.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('daemon rate-limit keys are stable and id-scoped', () => {
  assertEquals(daemonConnectRateLimitKey('srv-1'), 'daemon:connect:srv-1')
  assertEquals(
    daemonRestRateLimitKey('lic-1', 'enroll'),
    'daemon:rest:enroll:lic-1',
  )
  assertEquals(daemonMetricsRateLimitKey('srv-1'), 'daemon:metrics:srv-1')
  assertEquals(
    daemonEnrollChallengeRateLimitKey(),
    `daemon:rest:auth-challenge:${DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID}`,
  )
})

test('noop limiter always allows and fail-closed always denies', async () => {
  assertEquals(
    await createNoopRateLimiter().limit({ key: 'any' }),
    { success: true },
  )
  assertEquals(
    await createFailClosedRateLimiter().limit({ key: 'any' }),
    { success: false },
  )
})
