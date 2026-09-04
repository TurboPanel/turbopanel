import { assertEquals, assertRejects } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import type { RateLimiter } from '../../daemon/rate-limit/contracts.ts'
import {
  AUTH_RATE_LIMIT_PURPOSE_TIERS,
  type AuthRateLimitPurpose,
  authRateLimitKeys,
  createAuthRateLimiter,
  createDurableAuthRateLimiter,
  createFailClosedAuthRateLimiter,
} from './auth-rate-limit.ts'

describe('authRateLimitKeys', () => {
  it('uses fixed-size digests and never embeds the raw email or IP', async () => {
    const keys = await authRateLimitKeys(
      'sign-in',
      'user@example.com',
      '203.0.113.1',
    )
    assertEquals(keys.identityKey.startsWith('sign-in:id:'), true)
    assertEquals(keys.ipKey.startsWith('sign-in:ip:'), true)
    assertEquals(keys.identityKey.includes('user@example.com'), false)
    assertEquals(keys.ipKey.includes('203.0.113.1'), false)
    // SHA-256 hex = 64 chars after the purpose:id: / purpose:ip: prefix.
    assertEquals(keys.identityKey.slice('sign-in:id:'.length).length, 64)
    assertEquals(keys.ipKey.slice('sign-in:ip:'.length).length, 64)
  })

  it('normalizes identity casing and caps excessive input before hashing', async () => {
    const a = await authRateLimitKeys('sign-in', '  User@Example.com  ', null)
    const b = await authRateLimitKeys('sign-in', 'user@example.com', undefined)
    assertEquals(a.identityKey, b.identityKey)

    const huge = 'a'.repeat(10_000) + '@example.com'
    const capped = await authRateLimitKeys('sign-in', huge, '203.0.113.9')
    assertEquals(capped.identityKey.includes('@example.com'), false)
    assertEquals(capped.identityKey.slice('sign-in:id:'.length).length, 64)
  })
})

describe('createAuthRateLimiter', () => {
  it('allows attempts up to the limit then blocks with retry-after', async () => {
    const now = 1_000_000
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 3, windowMs: 60_000 },
      policies: {},
      now: () => now,
    })

    for (let i = 0; i < 3; i++) {
      const result = await limiter.check('sign-in', 'user@example.com', '203.0.113.1')
      assertEquals(result.allowed, true)
    }

    const blocked = await limiter.check('sign-in', 'user@example.com', '203.0.113.1')
    assertEquals(blocked.allowed, false)
    assertEquals(blocked.retryAfterSeconds > 0, true)
  })

  it('resets the window after windowMs elapses', async () => {
    let now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.2')).allowed, true)
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.2')).allowed, false)

    now += 60_000
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.2')).allowed, true)
  })

  it('enforces independent identity and IP buckets (both must pass)', async () => {
    const now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.3')).allowed, true)
    // Same identity, different IP — identity bucket already spent.
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.4')).allowed, false)

    limiter.reset()
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.3')).allowed, true)
    // Same IP, different identity — IP bucket already spent.
    assertEquals((await limiter.check('sign-in', 'c@d.com', '203.0.113.3')).allowed, false)

    limiter.reset()
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.3')).allowed, true)
    // Same identity + IP, different purpose — separate purpose buckets.
    assertEquals((await limiter.check('send-otp', 'a@b.com', '203.0.113.3')).allowed, true)
    // Exact same purpose/identity/IP now blocked on both dimensions.
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.3')).allowed, false)
  })

  it('same-account attempts from different IPs cannot bypass the account cap', async () => {
    const now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 2, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals(
      (await limiter.check('sign-in', 'victim@example.com', '203.0.113.10')).allowed,
      true,
    )
    assertEquals(
      (await limiter.check('sign-in', 'victim@example.com', '203.0.113.11')).allowed,
      true,
    )
    // Third attempt from yet another IP — identity bucket exhausted.
    assertEquals(
      (await limiter.check('sign-in', 'victim@example.com', '203.0.113.12')).allowed,
      false,
    )
  })

  it('normalizes identity casing/whitespace and missing IP', async () => {
    const now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals(
      (await limiter.check('sign-in', '  User@Example.com  ', null)).allowed,
      true,
    )
    // Normalizes to the same identity key -> blocked.
    assertEquals(
      (await limiter.check('sign-in', 'user@example.com', undefined)).allowed,
      false,
    )
  })

  it('reset clears all counters', async () => {
    const now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.5')).allowed, true)
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.5')).allowed, false)
    limiter.reset()
    assertEquals((await limiter.check('sign-in', 'a@b.com', '203.0.113.5')).allowed, true)
  })
})

/**
 * Fake durable {@link RateLimiter}: fixed-window counter shared across all
 * `check` calls (stands in for the Cloudflare `RateLimit` binding / Redis token
 * bucket that back the durable auth limiter in production).
 */
function createFakeDurableRateLimiter(limit: number): RateLimiter {
  const counts = new Map<string, number>()
  return {
    // deno-lint-ignore require-await
    async limit({ key }: { key: string }): Promise<{ success: boolean }> {
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return { success: next <= limit }
    },
  }
}

describe('createDurableAuthRateLimiter', () => {
  it('blocks the identity bucket even when the IP rotates', async () => {
    const limiter = createDurableAuthRateLimiter(createFakeDurableRateLimiter(1))

    assertEquals(
      (await limiter.check('sign-in', 'victim@example.com', '203.0.113.10')).allowed,
      true,
    )
    // Different IP, same identity -> identity bucket in the durable backend is spent.
    const blocked = await limiter.check('sign-in', 'victim@example.com', '203.0.113.11')
    assertEquals(blocked.allowed, false)
    assertEquals(blocked.retryAfterSeconds > 0, true)
  })

  it('blocks the IP bucket even when the identity rotates', async () => {
    const limiter = createDurableAuthRateLimiter(createFakeDurableRateLimiter(1))

    assertEquals(
      (await limiter.check('sign-in', 'a@example.com', '203.0.113.20')).allowed,
      true,
    )
    // Same IP, different identity -> IP bucket in the durable backend is spent.
    assertEquals(
      (await limiter.check('sign-in', 'b@example.com', '203.0.113.20')).allowed,
      false,
    )
  })

  it('keeps purposes independent in the shared backend', async () => {
    const limiter = createDurableAuthRateLimiter(createFakeDurableRateLimiter(1))
    const purposes: AuthRateLimitPurpose[] = ['sign-in', 'send-otp']

    for (const purpose of purposes) {
      assertEquals(
        (await limiter.check(purpose, 'a@example.com', '203.0.113.30')).allowed,
        true,
      )
    }
    // Re-hitting the first purpose is now blocked (its buckets are spent).
    assertEquals(
      (await limiter.check('sign-in', 'a@example.com', '203.0.113.30')).allowed,
      false,
    )
  })
})

describe('createDurableAuthRateLimiter tiering', () => {
  it('routes strict-tier purposes to the strict backend and default-tier to the default backend', async () => {
    const defaultLimiter = createFakeDurableRateLimiter(10)
    const strictLimiter = createFakeDurableRateLimiter(5)
    const limiter = createDurableAuthRateLimiter({
      default: defaultLimiter,
      strict: strictLimiter,
    })

    // 'sign-up' is strict (limit 5) — blocks at attempt 6.
    for (let i = 0; i < 5; i++) {
      assertEquals(
        (await limiter.check('sign-up', 'victim@example.com', '203.0.113.50')).allowed,
        true,
      )
    }
    assertEquals(
      (await limiter.check('sign-up', 'victim@example.com', '203.0.113.50')).allowed,
      false,
    )

    // 'sign-in' is default (limit 10) — still allowed at attempt 6, same
    // identity/IP as the now-blocked strict purpose above (independent
    // backend instances, independent buckets).
    for (let i = 0; i < 6; i++) {
      assertEquals(
        (await limiter.check('sign-in', 'victim@example.com', '203.0.113.50')).allowed,
        true,
      )
    }
  })

  it('every strict-tier purpose in AUTH_RATE_LIMIT_PURPOSE_TIERS blocks at 5 against a limit-5 backend', async () => {
    const strictPurposes = (Object.keys(AUTH_RATE_LIMIT_PURPOSE_TIERS) as AuthRateLimitPurpose[])
      .filter((p) => AUTH_RATE_LIMIT_PURPOSE_TIERS[p] === 'strict')
    // Sanity: the purposes this comment names are actually tagged strict.
    assertEquals(strictPurposes.includes('sign-up'), true)
    assertEquals(strictPurposes.includes('send-otp'), true)
    assertEquals(strictPurposes.includes('reset-password-request'), true)

    for (const purpose of strictPurposes) {
      const limiter = createDurableAuthRateLimiter({
        default: createFakeDurableRateLimiter(10),
        strict: createFakeDurableRateLimiter(5),
      })
      for (let i = 0; i < 5; i++) {
        assertEquals(
          (await limiter.check(purpose, 'a@example.com', '203.0.113.51')).allowed,
          true,
          `${purpose} attempt ${i + 1} should be allowed`,
        )
      }
      assertEquals(
        (await limiter.check(purpose, 'a@example.com', '203.0.113.51')).allowed,
        false,
        `${purpose} attempt 6 should be blocked`,
      )
    }
  })

  it('falls back to whichever tier backend is present when the other is missing', async () => {
    const onlyDefault = createDurableAuthRateLimiter({
      default: createFakeDurableRateLimiter(1),
    })
    // 'sign-up' is strict, but only the default backend was supplied.
    assertEquals(
      (await onlyDefault.check('sign-up', 'a@example.com', '203.0.113.52')).allowed,
      true,
    )
    assertEquals(
      (await onlyDefault.check('sign-up', 'a@example.com', '203.0.113.52')).allowed,
      false,
    )
  })

  it('a single RateLimiter (no tiering) still works for every purpose — back-compat', async () => {
    const limiter = createDurableAuthRateLimiter(createFakeDurableRateLimiter(1))
    assertEquals(
      (await limiter.check('sign-up', 'a@example.com', '203.0.113.53')).allowed,
      true,
    )
    assertEquals(
      (await limiter.check('sign-in', 'b@example.com', '203.0.113.54')).allowed,
      true,
    )
  })

  it('rejects when neither tier backend is supplied', async () => {
    const limiter = createDurableAuthRateLimiter({})
    await assertRejects(() => limiter.check('sign-up', 'a@example.com', '203.0.113.55'))
  })
})

describe('createFailClosedAuthRateLimiter', () => {
  it('denies every attempt with a positive retry-after', async () => {
    const limiter = createFailClosedAuthRateLimiter()
    const result = await limiter.check('sign-in', 'a@example.com', '203.0.113.40')
    assertEquals(result.allowed, false)
    assertEquals(result.retryAfterSeconds > 0, true)
  })
})
