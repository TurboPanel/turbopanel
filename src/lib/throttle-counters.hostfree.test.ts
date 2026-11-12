/** Counting 429 and 503 answers by who sent them. */
import { assertEquals } from '@std/assert'
import { addThrottleCounters, countThrottle, emptyThrottleCounters } from './throttle-counters.ts'

const test = Deno.test.bind(Deno)

test('only 429 and 503 are counted, by kind, and counters add up', () => {
  const a = emptyThrottleCounters()
  countThrottle(a, 'authority', 429)
  countThrottle(a, 'authority', 503)
  countThrottle(a, 'cloudflare', 503)
  countThrottle(a, 'cloudflare', 500)
  countThrottle(a, 'cloudflare', null)
  countThrottle(undefined, 'authority', 429)
  assertEquals(a, { authority429: 1, authority503: 1, cloudflare429: 0, cloudflare503: 1 })
  const total = emptyThrottleCounters()
  addThrottleCounters(total, a)
  addThrottleCounters(total, a)
  assertEquals(total.authority429, 2)
})
