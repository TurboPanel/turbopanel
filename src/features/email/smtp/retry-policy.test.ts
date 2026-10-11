import { assertEquals } from '@std/assert'
import {
  decideRetry,
  EMAIL_RETRY_TIER_DELAYS_MS,
  failedAttemptsFromHeaders,
} from './retry-policy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('sign-in mail retries soon and gets one more attempt than the rest', () => {
  const tiers = [1, 2, 3, 4, 5].map((n) => {
    const d = decideRetry('email-otp', n, () => 1)
    return d.action === 'retry' ? d.delayMs : 'dead'
  })
  assertEquals(tiers, [30_000, 60_000, 120_000, 300_000, 300_000])
  assertEquals(decideRetry('email-otp', 6).action, 'dead_letter')
  assertEquals(decideRetry('password-reset', 6).action, 'dead_letter')
})

test('other mail backs off further and gives up after fewer attempts', () => {
  const delays = [1, 2, 3, 4].map((n) => {
    const d = decideRetry('notification', n, () => 1)
    return d.action === 'retry' ? d.delayMs : 'dead'
  })
  assertEquals(delays, [60_000, 300_000, 900_000, 3_600_000])
  assertEquals(decideRetry('notification', 5).action, 'dead_letter')
})

test('jitter shortens a delay to between half and all of its tier', () => {
  for (const random of [0, 0.25, 0.999]) {
    const d = decideRetry('notification', 2, () => random)
    if (d.action !== 'retry') throw new TypeError('expected a retry')
    const base = EMAIL_RETRY_TIER_DELAYS_MS[d.tier]!
    assertEquals(d.delayMs >= base / 2 && d.delayMs <= base, true)
  }
})

test('a delivery with no or a junk attempt header counts as the first', () => {
  assertEquals(failedAttemptsFromHeaders(undefined), 0)
  assertEquals(failedAttemptsFromHeaders({ 'x-tp-attempt': 'x' }), 0)
  assertEquals(failedAttemptsFromHeaders({ 'x-tp-attempt': -2 }), 0)
  assertEquals(failedAttemptsFromHeaders({ 'x-tp-attempt': 3 }), 3)
})
