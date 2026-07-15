/**
 * Shared, timer-free in-memory rate limiter for credential / PAM install / OTP
 * auth endpoints. Keeps abuse throttling identical across the routes registered
 * in `http.ts`, `otp-http.ts`, and `lib/install/routes.ts`.
 *
 * Keys combine the route purpose, a normalized email/username identity, and the
 * client IP so a single attacker cannot rotate one dimension to bypass the cap.
 * This is a per-process fixed-window counter — it does not need Redis/DO because
 * auth abuse throttling is best-effort defense-in-depth, not a billing control.
 */

export type AuthRateLimitPurpose =
  | 'sign-in'
  | 'sign-up'
  | 'send-otp'
  | 'verify-otp'
  | 'sign-in-otp'
  | 'verify-email-otp'
  | 'reset-password-request'
  | 'reset-password'
  | 'install-bootstrap'
  | 'install-complete'

export type AuthRateLimitResult = {
  allowed: boolean
  /** Seconds until the current window resets (only meaningful when blocked). */
  retryAfterSeconds: number
}

export type AuthRateLimitPolicy = {
  /** Max attempts per window for a single key. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

export type AuthRateLimiterOptions = {
  defaultPolicy?: AuthRateLimitPolicy
  policies?: Partial<Record<AuthRateLimitPurpose, AuthRateLimitPolicy>>
  now?: () => number
}

const DEFAULT_POLICY: AuthRateLimitPolicy = { limit: 10, windowMs: 60_000 }

/**
 * Per-purpose defaults applied to the process-wide shared limiter. Not baked
 * into {@link createAuthRateLimiter} so callers (and tests) that pass an
 * explicit `defaultPolicy`/`policies` get exactly what they configure.
 */
const SHARED_POLICIES: Partial<Record<AuthRateLimitPurpose, AuthRateLimitPolicy>> = {
  'sign-in': { limit: 10, windowMs: 60_000 },
  'sign-up': { limit: 5, windowMs: 60_000 },
  'send-otp': { limit: 5, windowMs: 60_000 },
  'verify-otp': { limit: 10, windowMs: 60_000 },
  'sign-in-otp': { limit: 10, windowMs: 60_000 },
  'verify-email-otp': { limit: 10, windowMs: 60_000 },
  'reset-password-request': { limit: 5, windowMs: 60_000 },
  'reset-password': { limit: 10, windowMs: 60_000 },
  'install-bootstrap': { limit: 10, windowMs: 60_000 },
  'install-complete': { limit: 10, windowMs: 60_000 },
}

export interface AuthRateLimiter {
  /**
   * Record and evaluate a single attempt. Returns `allowed: false` once the key
   * exceeds its window budget.
   */
  check(
    purpose: AuthRateLimitPurpose,
    identity: string | null | undefined,
    ip: string | null | undefined,
  ): AuthRateLimitResult
  /** Clears all counters (test isolation). */
  reset(): void
}

type WindowEntry = { windowStartMs: number; count: number }

function normalizeIdentity(identity: string | null | undefined): string {
  const trimmed = (identity ?? '').trim().toLowerCase()
  return trimmed || 'anonymous'
}

function normalizeIp(ip: string | null | undefined): string {
  const trimmed = (ip ?? '').trim()
  return trimmed || 'unknown'
}

export function createAuthRateLimiter(
  options: AuthRateLimiterOptions = {},
): AuthRateLimiter {
  const defaultPolicy = options.defaultPolicy ?? DEFAULT_POLICY
  const policies = { ...options.policies }
  const now = options.now ?? Date.now
  const windows = new Map<string, WindowEntry>()

  function policyFor(purpose: AuthRateLimitPurpose): AuthRateLimitPolicy {
    return policies[purpose] ?? defaultPolicy
  }

  return {
    check(purpose, identity, ip): AuthRateLimitResult {
      const policy = policyFor(purpose)
      const key = `${purpose}:${normalizeIdentity(identity)}:${normalizeIp(ip)}`
      const current = now()
      const existing = windows.get(key)

      if (!existing || current - existing.windowStartMs >= policy.windowMs) {
        windows.set(key, { windowStartMs: current, count: 1 })
        return { allowed: true, retryAfterSeconds: 0 }
      }

      existing.count += 1
      if (existing.count > policy.limit) {
        const elapsed = current - existing.windowStartMs
        const remainingMs = Math.max(0, policy.windowMs - elapsed)
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(remainingMs / 1000),
        }
      }
      return { allowed: true, retryAfterSeconds: 0 }
    },
    reset(): void {
      windows.clear()
    },
  }
}

let sharedLimiter: AuthRateLimiter | undefined

/** Process-wide singleton shared by all auth route registrations. */
export function getSharedAuthRateLimiter(): AuthRateLimiter {
  sharedLimiter ??= createAuthRateLimiter({ policies: SHARED_POLICIES })
  return sharedLimiter
}

/** Test-only override / reset of the shared singleton. */
export function setSharedAuthRateLimiterForTests(
  limiter: AuthRateLimiter | undefined,
): void {
  sharedLimiter = limiter
}
