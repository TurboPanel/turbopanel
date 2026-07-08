import { assertEquals } from 'jsr:@std/assert'
import { createNoopRateLimiter } from './contracts.ts'
import { createWorkersRateLimiter } from './workers-rate-limiter.ts'
import {
  DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID,
  daemonConnectRateLimitKey,
  daemonEnrollChallengeRateLimitKey,
  daemonRestRateLimitKey,
} from './keys.ts'

Deno.test('createNoopRateLimiter always returns success', async () => {
  const limiter = createNoopRateLimiter()
  const first = await limiter.limit({ key: 'any' })
  const second = await limiter.limit({ key: 'other' })
  assertEquals(first, { success: true })
  assertEquals(second, { success: true })
})

Deno.test('createWorkersRateLimiter delegates to binding.limit with key', async () => {
  const seen: string[] = []
  const binding = {
    limit: (options: { key: string }) => {
      seen.push(options.key)
      return Promise.resolve({ success: options.key !== 'deny' })
    },
  }

  const limiter = createWorkersRateLimiter(binding)
  assertEquals(await limiter.limit({ key: 'allow' }), { success: true })
  assertEquals(await limiter.limit({ key: 'deny' }), { success: false })
  assertEquals(seen, ['allow', 'deny'])
})

Deno.test('daemon rate-limit keys are stable and include id + route', () => {
  assertEquals(
    daemonConnectRateLimitKey('srv-1'),
    'daemon:connect:srv-1',
  )
  assertEquals(
    daemonRestRateLimitKey('srv-1', 'commands-lease'),
    'daemon:rest:commands-lease:srv-1',
  )
  assertEquals(
    daemonRestRateLimitKey('lic-9', 'enroll'),
    'daemon:rest:enroll:lic-9',
  )
  assertEquals(
    daemonEnrollChallengeRateLimitKey(),
    `daemon:rest:auth-challenge:${DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID}`,
  )
})
