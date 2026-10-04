/**
 * Generic per-session / per-IP rate limit for mutating requests.
 *
 * `authRateLimiter` only covers credential endpoints. This is the abuse cap
 * for everything else a signed-in (or anonymous) caller can write: invites,
 * API keys, secret reveal, command dispatch, deploys. It is generous on
 * purpose (default 120 writes / 60 s) — a pacing wall for scripts gone wrong,
 * never a throttle a human or the UI can reach.
 *
 * - Backend: the shared {@link RateLimiter} seam (Workers `RateLimit` binding
 *   `CLIENT_WRITE_RATE_LIMITER`, Deno Redis token bucket), injected through
 *   the request context as `writeRateLimiter`. Nothing injected means no
 *   limit (unit tests, `wrangler dev` without the binding).
 * - Key: a validly **signed** session cookie is the identity (one bucket per
 *   session token, digested; no database read). Anything else — no cookie, a
 *   forged or stale-keyed cookie, a native client with no cookie — is
 *   anonymous and is keyed on the client IP. When the IP cannot be resolved
 *   the request is **not** limited: collapsing every unknown caller into one
 *   shared bucket would let one noisy client lock everybody out.
 * - Fail open: a limiter error (Redis down, binding hiccup) lets the write
 *   through and logs one warning per process. Unlike credential throttling,
 *   this limiter must never become an outage.
 * - Scope: the same four prefixes as the browser write gate; daemon REST/WS
 *   and `/webhook/*` have their own limiters and are untouched. `GET`, `HEAD`
 *   and `OPTIONS` are never counted.
 */
import { getCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler, Next } from 'hono'
import type { AppEnv } from './app.ts'
import { resolveClientIp } from '../client/authn/http.ts'
import { verifySignedCookie } from '../client/authn/crypto.ts'
import { requestTls } from '../client/authn/request-context.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { logWarn } from '../lib/logger.ts'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  DEVELOPER_API_PREFIX,
  INSTALL_API_PREFIX,
} from './surfaces.ts'

export const WRITE_RATE_LIMITED_CODE = 'rate_limited'

/** Matches the Wrangler binding / Redis bucket period. */
export const DEFAULT_WRITE_RATE_PERIOD_SECONDS = 60
export const DEFAULT_WRITE_RATE_LIMIT = 120

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const LIMITED_PREFIXES = [
  CLIENT_API_PREFIX,
  ADMIN_API_PREFIX,
  INSTALL_API_PREFIX,
  DEVELOPER_API_PREFIX,
] as const

function isLimitedPath(pathname: string): boolean {
  return LIMITED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

async function digest(kind: 'session' | 'ip', value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${value}`))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function verifiedSessionToken(
  c: Context,
  runtime: 'deno' | 'workers',
  secrets: DerivedSecretsConfig | undefined
): Promise<string | null> {
  if (!secrets) return null
  const cookieValue = getCookie(c, requestTls(c, runtime).cookieName)
  if (!cookieValue) return null
  const verified = await verifySignedCookie(cookieValue, secrets)
  return verified?.token ?? null
}

/**
 * Bucket key for a write: the verified session, else the client IP, else
 * `null` (do not limit). Exported for tests.
 */
export async function writeRateLimitKey(
  c: Context,
  runtime: 'deno' | 'workers',
  secrets: DerivedSecretsConfig | undefined
): Promise<string | null> {
  const token = await verifiedSessionToken(c, runtime, secrets)
  if (token) return `write:session:${await digest('session', token)}`
  const ip = resolveClientIp(c, runtime)
  if (!ip) return null
  return `write:ip:${await digest('ip', ip)}`
}

let failOpenWarned = false

function warnFailOpenOnce(error: unknown): void {
  if (failOpenWarned) return
  failOpenWarned = true
  logWarn('write-rate-limit', 'limiter unavailable; allowing writes', error)
}

/** @internal Reset the one-shot warning flag — tests only. */
export function resetWriteRateLimitWarningForTests(): void {
  failOpenWarned = false
}

async function isWithinBudget(
  limiter: NonNullable<AppEnv['Variables']['writeRateLimiter']>,
  key: string
): Promise<boolean> {
  try {
    const outcome = await limiter.limit({ key })
    return outcome.success
  } catch (error) {
    warnFailOpenOnce(error)
    return true
  }
}

export function createWriteRateLimitMiddleware(options: {
  runtime: 'deno' | 'workers'
  secrets?: DerivedSecretsConfig
  retryAfterSeconds?: number
}): MiddlewareHandler<AppEnv> {
  const retryAfter = String(options.retryAfterSeconds ?? DEFAULT_WRITE_RATE_PERIOD_SECONDS)
  return async (c: Context<AppEnv>, next: Next) => {
    const limiter = c.get('writeRateLimiter')
    if (!limiter || !WRITE_METHODS.has(c.req.method.toUpperCase())) return next()
    let pathname: string
    try {
      pathname = new URL(c.req.url).pathname
    } catch {
      return next()
    }
    if (!isLimitedPath(pathname)) return next()
    const key = await writeRateLimitKey(c, options.runtime, options.secrets)
    if (key === null || (await isWithinBudget(limiter, key))) return next()
    return c.json({ ok: false, error: 'Too many requests', code: WRITE_RATE_LIMITED_CODE }, 429, {
      'Retry-After': retryAfter,
    })
  }
}
