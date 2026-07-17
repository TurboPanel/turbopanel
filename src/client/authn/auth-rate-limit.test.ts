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

  it('enforces independent identity and IP buckets (both must pass)', () => {
    let now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.3').allowed, true)
    // Same identity, different IP — identity bucket already spent.
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.4').allowed, false)

    limiter.reset()
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.3').allowed, true)
    // Same IP, different identity — IP bucket already spent.
    assertEquals(limiter.check('sign-in', 'c@d.com', '203.0.113.3').allowed, false)

    limiter.reset()
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.3').allowed, true)
    // Same identity + IP, different purpose — separate purpose buckets.
    assertEquals(limiter.check('send-otp', 'a@b.com', '203.0.113.3').allowed, true)
    // Exact same purpose/identity/IP now blocked on both dimensions.
    assertEquals(limiter.check('sign-in', 'a@b.com', '203.0.113.3').allowed, false)
  })

  it('same-account attempts from different IPs cannot bypass the account cap', () => {
    let now = 0
    const limiter = createAuthRateLimiter({
      defaultPolicy: { limit: 2, windowMs: 60_000 },
      now: () => now,
    })

    assertEquals(
      limiter.check('sign-in', 'victim@example.com', '203.0.113.10').allowed,
      true,
    )
    assertEquals(
      limiter.check('sign-in', 'victim@example.com', '203.0.113.11').allowed,
      true,
    )
    // Third attempt from yet another IP — identity bucket exhausted.
    assertEquals(
      limiter.check('sign-in', 'victim@example.com', '203.0.113.12').allowed,
      false,
    )
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
    // Normalizes to the same identity key -> blocked.
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
