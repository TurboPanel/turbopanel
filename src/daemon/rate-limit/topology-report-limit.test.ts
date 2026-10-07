import { assertEquals } from '@std/assert'
import { createFailClosedRateLimiter, createNoopRateLimiter } from './contracts.ts'
import { daemonTopologyRateLimitKey } from './keys.ts'
import { createLocalTokenBucketLimiter } from './redis-rate-limiter.ts'
import { TOPOLOGY_REPORT_RATE, topologyReportAllowed } from './topology-report-limit.ts'
import { createWorkersRateLimiter } from './workers-rate-limiter.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '11111111-2222-4333-8444-555555555555'

/** A stand-in for the Workers `RateLimit` binding that records the keys it was asked about. */
function fakeBinding(success: boolean) {
  const keys: string[] = []
  return {
    keys,
    binding: {
      limit: ({ key }: { key: string }) => {
        keys.push(key)
        return Promise.resolve({ success })
      },
    },
  }
}

test('the key is per server, so one server cannot spend another’s budget', () => {
  assertEquals(daemonTopologyRateLimitKey(SERVER), `daemon:topology:${SERVER}`)
})

test('an allowed report goes through the binding with the server key', async () => {
  const { binding, keys } = fakeBinding(true)
  assertEquals(await topologyReportAllowed(createWorkersRateLimiter(binding), SERVER), true)
  assertEquals(keys, [`daemon:topology:${SERVER}`])
})

test('a limited report is refused', async () => {
  const { binding } = fakeBinding(false)
  assertEquals(await topologyReportAllowed(createWorkersRateLimiter(binding), SERVER), false)
  assertEquals(await topologyReportAllowed(createFailClosedRateLimiter(), SERVER), false)
})

test('a limiter that throws lets the report through and says so (the exact cooldown still bounds the write)', async () => {
  const errors: unknown[] = []
  const allowed = await topologyReportAllowed(
    { limit: () => Promise.reject(new Error('binding down')) },
    SERVER,
    (err) => errors.push(err)
  )
  assertEquals(allowed, true)
  assertEquals(errors.length, 1)
})

test('with no binding (self-hosted) the in-process bucket allows a normal daemon and stops a flood', async () => {
  const limiter = createLocalTokenBucketLimiter(TOPOLOGY_REPORT_RATE)
  let allowed = 0
  for (let i = 0; i < 50; i++) {
    if (await topologyReportAllowed(limiter, SERVER)) allowed++
  }
  // A burst of the limit, and a trickle of refill during the loop at most.
  assertEquals(
    allowed >= TOPOLOGY_REPORT_RATE.limit && allowed <= TOPOLOGY_REPORT_RATE.limit + 1,
    true
  )
  // Another server has its own bucket.
  assertEquals(await topologyReportAllowed(limiter, 'other-server'), true)
})

test('a normal daemon, one report a minute, is never limited', async () => {
  const limiter = createLocalTokenBucketLimiter(TOPOLOGY_REPORT_RATE)
  for (let i = 0; i < 4; i++) assertEquals(await topologyReportAllowed(limiter, SERVER), true)
  assertEquals(await topologyReportAllowed(createNoopRateLimiter(), SERVER), true)
})
