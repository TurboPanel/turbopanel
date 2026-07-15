import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { createAuthRateLimiter } from './auth-rate-limit.ts'

describe('createAuthRateLimiter', () => {
  it('allows attempts up to the limit then blocks with retry-after', () => {
    let now = 1_000_000
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 3, windowMs: 60_000 },
      policies: {},
      now: () => now,
    })

    for (let i = 0; i < 3; i++) {
      const result = limiter.check('sign-in', 'user@example.com', '203.0.113.1')
      assertEquals(result.allowed, true)
    }

    const blocked = limiter.check('sign-in', 'user@example.com', '203.0.113.1')
    assertEquals(blocked.allowed, false)
    assertEquals(blocked.retryAfterSeconds > 0, true)
  })

  it('resets the window after windowMs elapses', () => {
    let now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.2').allowed, true)
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.2').allowed, false)

    now += 60_000
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.2').allowed, true)
  })

  it('keys separately by purpose, identity, and IP', () => {
    let now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.3').allowed, true)
    // Same identity, different IP — separate bucket.
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.4').allowed, true)
    // Same IP, different identity — separate bucket.
    assertEquals(limiter.check('sign-in', 'c@d.com', '203.0.113.3').allowed, true)
    // Same identity + IP, different purpose — separate bucket.
    assertEquals(limiter.check('send-otp', 'a@b.com', '203.0.113.3').allowed, true)
    // Exact same key now blocked.
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.3').allowed, false)
  })

  it('normalizes identity casing/whitespace and missing IP', () => {
    let now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals(
      limiter.check('sign-in', '  User@Example.com  ', null).allowed,
      true,
    )
    // Normalizes to the same key -> blocked.
    assertEquals(
      limiter.check('sign-in', 'user@example.com', undefined).allowed,
      false,
    )
  })

  it('reset clears all counters', () => {
    let now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.5').allowed, true)
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.5').allowed, false)
    limiter.reset()
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.5').allowed, true)
  })
})
