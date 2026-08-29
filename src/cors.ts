import type { Env, Hono } from 'hono'

/**
 * Docs / Scalar CORS is read-oriented. Cookie-authenticated writes must go
 * same-origin (console UI behind Caddy) and are gated by
 * {@link createBrowserWriteProtectionMiddleware}; credentialed cross-origin
 * writes from configured website origins must not pass preflight.
 */
const CORS_METHODS = 'GET, HEAD, OPTIONS'
const CORS_HEADERS = 'Content-Type, Authorization, Cookie, Accept'

function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return []
  return [...new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )]
}

/**
 * Return the allowlisted origin string, never the request header. Reflecting
 * `Origin` even after `Set.has` keeps the header tainted for S8348.
 */
function matchingAllowedOrigin(
  origin: string | undefined,
  allowed: readonly string[],
): string | undefined {
  if (origin === undefined) return undefined
  for (const candidate of allowed) {
    if (candidate === origin) return candidate
  }
  return undefined
}

/** Reflects configured browser origins (e.g. local docs site → Caddy API). */
export function registerCorsMiddleware<E extends Env>(
  app: Hono<E>,
  corsOriginsEnv: string | undefined,
): void {
  const allowed = parseCorsOrigins(corsOriginsEnv)
  if (allowed.length === 0) return

  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin')
    // Always emit Vary when Origin is present so shared caches cannot mix
    // allowlisted and disallowed origin responses. Credentials headers stay
    // restricted to allowlisted origins only.
    if (origin !== undefined) {
      c.header('Vary', 'Origin')
    }
    const allowOrigin = matchingAllowedOrigin(origin, allowed)

    if (allowOrigin !== undefined) {
      c.header('Access-Control-Allow-Origin', allowOrigin)
      c.header('Access-Control-Allow-Credentials', 'true')
    }

    if (c.req.method === 'OPTIONS') {
      if (allowOrigin !== undefined) {
        c.header('Access-Control-Allow-Methods', CORS_METHODS)
        c.header('Access-Control-Allow-Headers', CORS_HEADERS)
        c.header('Access-Control-Max-Age', '86400')
      }
      return c.body(null, 204)
    }

    await next()
  })
}
