import { assertEquals } from '@std/assert'
import { TunnelProviderError } from './errors.ts'
import {
  nextOriginRetry,
  ORIGIN_RETRY_ASKED_MAX_MS,
  ORIGIN_RETRY_MAX_MS,
} from './origin-certificate-retry.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias so analysis sees real tests. */
const test = Deno.test.bind(Deno)

const NOW = new Date('2030-01-01T00:00:00.000Z')
const HOUR = 3_600_000

function throttled(ms: number | null): TunnelProviderError {
  return new TunnelProviderError('rate_limited', 'slow down', 429, [], ms)
}

test('the provider own wait is used as asked', () => {
  const next = nextOriginRetry({ attempts: 2, nextTryAt: null }, throttled(10 * 60_000), NOW)
  assertEquals(next.attempts, 2)
  assertEquals(next.nextTryAt, new Date(NOW.getTime() + 10 * 60_000).toISOString())
})

test('a wait the provider asks for that is far off is capped', () => {
  const week = nextOriginRetry({ attempts: 1, nextTryAt: null }, throttled(7 * 24 * HOUR), NOW)
  assertEquals(week.nextTryAt, new Date(NOW.getTime() + ORIGIN_RETRY_ASKED_MAX_MS).toISOString())
  assertEquals(ORIGIN_RETRY_ASKED_MAX_MS, 6 * HOUR)
})

test('a wait of zero still pauses a minute', () => {
  const next = nextOriginRetry({ attempts: 0, nextTryAt: null }, throttled(0), NOW)
  assertEquals(next.nextTryAt, new Date(NOW.getTime() + 60_000).toISOString())
})

test('other failures back off an hour, doubling to a day', () => {
  const err = new Error('boom')
  const first = nextOriginRetry({ attempts: 0, nextTryAt: null }, err, NOW)
  assertEquals(first.nextTryAt, new Date(NOW.getTime() + HOUR).toISOString())
  const late = nextOriginRetry({ attempts: 20, nextTryAt: null }, err, NOW)
  assertEquals(late.nextTryAt, new Date(NOW.getTime() + ORIGIN_RETRY_MAX_MS).toISOString())
})
