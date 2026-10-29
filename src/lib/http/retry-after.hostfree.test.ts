/** Reading `Retry-After`: seconds, dates, junk, and the cap. */
import { assertEquals } from '@std/assert'
import { isThrottleStatus, parseRetryAfterMs, throttleWaitMs } from './retry-after.ts'

const test = Deno.test.bind(Deno)

test('seconds and dates become milliseconds, capped at a day', () => {
  assertEquals(parseRetryAfterMs('120'), 120_000)
  assertEquals(parseRetryAfterMs('999999'), 86_400_000)
  const now = Date.parse('2026-01-01T00:00:00Z')
  assertEquals(parseRetryAfterMs('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000)
  assertEquals(parseRetryAfterMs('Wed, 31 Dec 2025 00:00:00 GMT', now), 0)
})

test('an absent or unreadable header is null', () => {
  assertEquals(parseRetryAfterMs(null), null)
  assertEquals(parseRetryAfterMs(''), null)
  assertEquals(parseRetryAfterMs('soon'), null)
})

test('only 429 and 503 count as a request to slow down', () => {
  assertEquals([429, 503, 500, 200].map(isThrottleStatus), [true, true, false, false])
  const slow = new Response(null, { status: 503, headers: { 'Retry-After': '30' } })
  assertEquals(throttleWaitMs(slow), 30_000)
  const fine = new Response(null, { status: 500, headers: { 'Retry-After': '30' } })
  assertEquals(throttleWaitMs(fine), null)
})
