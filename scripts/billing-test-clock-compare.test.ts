import { assertEquals } from '@std/assert'
import { LEASE_BUSY_ERROR, retryWhileLeaseBusy, sameValue } from './billing-test-clock-compare.ts'

const test = Deno.test.bind(Deno)

test('sameValue: a pg timestamp and an ISO string for one instant are equal', () => {
  assertEquals(sameValue('2031-02-01 00:00:00+00', '2031-02-01T00:00:00.000Z'), true)
  assertEquals(sameValue('2031-02-01 02:00:00+02', '2031-02-01T00:00:00.000Z'), true)
  assertEquals(sameValue('2031-02-01T00:00:00Z', '2031-02-01 00:00:00.000+00'), true)
})

test('sameValue: different instants, non-timestamps and null stay unequal', () => {
  assertEquals(sameValue('2031-02-01 00:00:00+00', '2031-02-01T00:00:01.000Z'), false)
  assertEquals(sameValue('active', 'past_due'), false)
  assertEquals(sameValue(null, '2031-02-01T00:00:00.000Z'), false)
  assertEquals(sameValue('active', 'active'), true)
  assertEquals(sameValue(3, 3), true)
})

test('sameValue: arrays and plain objects compare deeply', () => {
  assertEquals(sameValue(['price_1'], ['price_1']), true)
  assertEquals(sameValue(['a', 'b'], ['a', 'b']), true)
  assertEquals(sameValue(['a', 'b'], ['b', 'a']), false)
  assertEquals(sameValue(['a'], ['a', 'b']), false)
  assertEquals(sameValue({ a: 1, b: ['x'] }, { b: ['x'], a: 1 }), true)
  assertEquals(sameValue({ a: 1 }, { a: 2 }), false)
  assertEquals(sameValue({ a: 1 }, { b: 1 }), false)
  assertEquals(sameValue(['2031-02-01 00:00:00+00'], ['2031-02-01T00:00:00Z']), true)
  assertEquals(sameValue([], {}), false)
})

const busy = { ok: false, status: 409, body: { error: LEASE_BUSY_ERROR } } as const

test('retryWhileLeaseBusy: retries the lease code, then returns the success', async () => {
  const outcomes = [busy, busy, { ok: true, status: 200, body: {} }]
  let calls = 0
  const sleeps: number[] = []
  const out = await retryWhileLeaseBusy(() => Promise.resolve(outcomes[calls++]!), {
    delayMs: 5,
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  })
  assertEquals(out.ok, true)
  assertEquals(calls, 3)
  assertEquals(sleeps, [5, 5])
})

test('retryWhileLeaseBusy: other refusals are returned at once, and it gives up after the cap', async () => {
  let calls = 0
  const other = await retryWhileLeaseBusy(() => {
    calls += 1
    return Promise.resolve({ ok: false, status: 409, body: { error: 'subscription_past_due' } })
  })
  assertEquals(calls, 1)
  assertEquals(other.ok, false)

  calls = 0
  const stuck = await retryWhileLeaseBusy(
    () => {
      calls += 1
      return Promise.resolve(busy)
    },
    { attempts: 3, sleep: () => Promise.resolve() }
  )
  assertEquals(calls, 3)
  assertEquals(stuck.ok, false)
})
