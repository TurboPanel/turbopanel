/**
 * Windowed idempotency keys — a retry inside the window replays, a retry
 * after it is a new request.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import { IDEMPOTENCY_WINDOW_MS, idempotencyWindow, windowedIdempotencyKey } from './idempotency.ts'

const test = Deno.test.bind(Deno)

const START = 1_000 * IDEMPOTENCY_WINDOW_MS // exactly on a window boundary

test('the window is five minutes', () => {
  assertEquals(IDEMPOTENCY_WINDOW_MS, 300_000)
})

test('every instant inside one window maps to the same key', () => {
  const key = windowedIdempotencyKey('checkout:org:tier:1', START)
  assertEquals(key, 'checkout:org:tier:1:w1000')
  assertEquals(windowedIdempotencyKey('checkout:org:tier:1', START + 1), key)
  assertEquals(
    windowedIdempotencyKey('checkout:org:tier:1', START + IDEMPOTENCY_WINDOW_MS - 1),
    key
  )
})

test('the first instant of the next window is a new key, so a saved refusal is not replayed', () => {
  assertEquals(idempotencyWindow(START + IDEMPOTENCY_WINDOW_MS - 1), 1000)
  assertEquals(idempotencyWindow(START + IDEMPOTENCY_WINDOW_MS), 1001)
  assertNotEquals(
    windowedIdempotencyKey('customer:org', START + IDEMPOTENCY_WINDOW_MS),
    windowedIdempotencyKey('customer:org', START)
  )
})

test('different request shapes never share a key within a window', () => {
  assertNotEquals(
    windowedIdempotencyKey('checkout:org:tier:1', START),
    windowedIdempotencyKey('checkout:org:tier:2', START)
  )
})
