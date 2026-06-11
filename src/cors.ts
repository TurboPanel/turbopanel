import type { Hono } from 'hono'

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD'
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
export function registerCorsMiddleware(
  app: Hono,
  corsOriginsEnv: string | undefined,
): void {
  const allowed = parseCorsOrigins(corsOriginsEnv)
  if (allowed.size === 0) return

  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin')
    const allowOrigin = origin !== undefined && allowed.has(origin)

    if (allowOrigin) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Access-Control-Allow-Credentials', 'true')
      c.header('Vary', 'Origin')
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
