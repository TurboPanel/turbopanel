/**
 * Pluggable, async rate limiter for credential / PAM install / OTP auth
 * endpoints. Keeps abuse throttling identical across the routes registered in
 * `http.ts`, `otp-http.ts`, and `lib/install/routes.ts`.
 *
 * Each attempt is counted in **two independent buckets** (identity and IP) for
 * the route purpose. Both checks must pass — rotating IP cannot bypass the
 * account-level cap, and rotating identity cannot bypass the IP-level cap.
 *
 * The interface is async so callers can back it with a **durable, globally
 * shared** counter (Cloudflare `RateLimit` binding on Workers, Redis on Deno).
 * A per-process in-memory limiter is still available as a Deno/dev/test
 * fallback — but Workers must never silently rely on it, because each isolate
 * keeps its own counters and abuse could rotate across isolates. Production
 * Workers wiring (`src/workers.ts`) injects a durable limiter or a fail-closed
 * limiter when the binding is missing (see {@link createFailClosedAuthRateLimiter}).
 */

import type { RateLimiter } from '../../daemon/rate-limit/contracts.ts'

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
 * Retry-After (and window) applied by durable backends that only report
 * `success`/`fail` without a precise reset time (`RateLimit` binding, Redis
 * token bucket). Matches the 60s window used by {@link SHARED_POLICIES}.
 */
export const DEFAULT_DURABLE_AUTH_WINDOW_SECONDS = 60

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
   * Record and evaluate a single attempt. Resolves `allowed: false` once the
   * key exceeds its window budget.
   */
  check(
    purpose: AuthRateLimitPurpose,
    identity: string | null | undefined,
    ip: string | null | undefined,
  ): Promise<AuthRateLimitResult>
  /** Clears all counters (in-memory limiter test isolation; noop for durable backends). */
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

/**
 * Build the two independent bucket keys (identity + IP) for a purpose. Shared
 * by the in-memory and durable backends so they key identically.
 */
export function authRateLimitKeys(
  purpose: AuthRateLimitPurpose,
  identity: string | null | undefined,
  ip: string | null | undefined,
): { identityKey: string; ipKey: string } {
  return {
    identityKey: `${purpose}:id:${normalizeIdentity(identity)}`,
    ipKey: `${purpose}:ip:${normalizeIp(ip)}`,
  }
}

/**
 * Per-process fixed-window limiter. Acceptable on Deno (single process) and in
 * tests; never the sole limiter on Workers (see module docs).
 */
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

  function record(key: string, policy: AuthRateLimitPolicy): AuthRateLimitResult {
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
  }

  return {
    // deno-lint-ignore require-await
    async check(purpose, identity, ip): Promise<AuthRateLimitResult> {
      const policy = policyFor(purpose)
      const { identityKey, ipKey } = authRateLimitKeys(purpose, identity, ip)
      // Independent buckets — both must pass.
      const identityResult = record(identityKey, policy)
      const ipResult = record(ipKey, policy)
      if (identityResult.allowed && ipResult.allowed) {
        return { allowed: true, retryAfterSeconds: 0 }
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          identityResult.retryAfterSeconds,
          ipResult.retryAfterSeconds,
        ),
      }
    },
    reset(): void {
      windows.clear()
    },
  }
}

/**
 * Compose an {@link AuthRateLimiter} over a durable {@link RateLimiter} (the
 * Cloudflare `RateLimit` binding via `createWorkersRateLimiter`, or the Deno
 * Redis token bucket via `createRedisRateLimiter`). Counters are globally
 * shared across isolates/processes; identity and IP are keyed separately so the
 * two-bucket guarantee holds. The backend reports only success/failure, so
 * Retry-After falls back to the fixed window length.
 */
export function createDurableAuthRateLimiter(
  rateLimiter: RateLimiter,
  options: { windowSeconds?: number } = {},
): AuthRateLimiter {
  const retryAfterSeconds = options.windowSeconds ?? DEFAULT_DURABLE_AUTH_WINDOW_SECONDS
  return {
    async check(purpose, identity, ip): Promise<AuthRateLimitResult> {
      const { identityKey, ipKey } = authRateLimitKeys(purpose, identity, ip)
      // Independent buckets — both must pass. Prefix keeps auth counters from
      // colliding with daemon rate-limit keys in a shared backend namespace.
      const [identityOutcome, ipOutcome] = await Promise.all([
        rateLimiter.limit({ key: `auth:${identityKey}` }),
        rateLimiter.limit({ key: `auth:${ipKey}` }),
      ])
      const allowed = identityOutcome.success && ipOutcome.success
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : retryAfterSeconds,
      }
    },
    reset(): void {},
  }
}

/**
 * Deny-all limiter. Used as the Workers production safety net when the durable
 * `RateLimit` binding is missing — auth endpoints fail closed (429) rather than
 * silently degrading to a bypassable per-isolate limiter.
 */
export function createFailClosedAuthRateLimiter(
  options: { windowSeconds?: number } = {},
): AuthRateLimiter {
  const retryAfterSeconds = options.windowSeconds ?? DEFAULT_DURABLE_AUTH_WINDOW_SECONDS
  return {
    // deno-lint-ignore require-await
    async check(): Promise<AuthRateLimitResult> {
      return { allowed: false, retryAfterSeconds }
    },
    reset(): void {},
  }
}

let sharedLimiter: AuthRateLimiter | undefined

/**
 * Process-local shared limiter. Deno/dev/test fallback only — Workers inject a
 * durable limiter through the request context (`authRateLimiter`) and must not
 * reach this per-isolate instance in production.
 */
export function getSharedAuthRateLimiter(): AuthRateLimiter {
  sharedLimiter ??= createAuthRateLimiter({ policies: SHARED_POLICIES })
  return sharedLimiter
}

/** Test-only override / reset of the shared fallback limiter. */
export function setSharedAuthRateLimiterForTests(
  limiter: AuthRateLimiter | undefined,
): void {
  sharedLimiter = limiter
}
