import type { Env, Hono } from 'hono'

/**
 * Docs / Scalar CORS is read-oriented. Cookie-authenticated writes must go
 * same-origin (console UI behind Caddy) and are gated by
 * {@link createBrowserWriteProtectionMiddleware}; credentialed cross-origin
 * writes from configured website origins must not pass preflight.
 */
const CORS_METHODS = 'GET, HEAD, OPTIONS'
const CORS_HEADERS = 'Content-Type, Authorization, Cookie, Accept'

function parseCorsOrigins(raw: string | undefined): Set<string> {
  if (raw === undefined || raw.trim().length === 0) return new Set()
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
}

/** Reflects configured browser origins (e.g. local docs site → Caddy API). */
export function registerCorsMiddleware<E extends Env>(
  app: Hono<E>,
  corsOriginsEnv: string | undefined,
): void {
  const allowed = parseCorsOrigins(corsOriginsEnv)
  if (allowed.size === 0) return

  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin')
    // Always emit Vary when Origin is present so shared caches cannot mix
    // allowlisted and disallowed origin responses. Credentials headers stay
    // restricted to allowlisted origins only.
    if (origin !== undefined) {
      c.header('Vary', 'Origin')
    }
    const allowOrigin = origin !== undefined && allowed.has(origin)

    if (allowOrigin) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Access-Control-Allow-Credentials', 'true')
    }

    if (c.req.method === 'OPTIONS') {
      if (allowOrigin) {
        c.header('Access-Control-Allow-Methods', CORS_METHODS)
        c.header('Access-Control-Allow-Headers', CORS_HEADERS)
        c.header('Access-Control-Max-Age', '86400')
      }
      return c.body(null, 204)
    }

    await next()
  })
}
