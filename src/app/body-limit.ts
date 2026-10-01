/**
 * Global request-body size limit for the cookie-authenticated API surfaces.
 *
 * Runs before any handler parses JSON, on both runtimes: Hono's `bodyLimit`
 * answers from `Content-Length` when it is present and otherwise reads the
 * stream, aborting as soon as the budget is crossed (a chunked upload carries
 * no length). Oversized bodies get `413` with the stable code
 * `request_body_too_large`.
 *
 * Scope: the same four prefixes as the browser write gate (client, admin,
 * install, developer). The daemon REST surface (`/api/daemon/v1`, secrets
 * decrypt bodies reach 2 MiB), webhooks (`/webhook/*`, bounded by the webhook
 * gate) and health/docs are outside it and keep their own bounded readers.
 *
 * Handlers that already read with a smaller bound (auth routes, 2-8 KiB) keep
 * that bound; this is the ceiling, not the budget.
 */
import type { Context, MiddlewareHandler, Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  DEVELOPER_API_PREFIX,
  INSTALL_API_PREFIX,
} from './surfaces.ts'

export const REQUEST_BODY_TOO_LARGE_CODE = 'request_body_too_large'

/** Default ceiling for any body on a limited surface. */
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024

/** Ceiling for routes that carry whole compose documents / import payloads. */
export const LARGE_REQUEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const LIMITED_PREFIXES = [
  CLIENT_API_PREFIX,
  ADMIN_API_PREFIX,
  INSTALL_API_PREFIX,
  DEVELOPER_API_PREFIX,
] as const

/**
 * Per-route overrides, matched against the path under `CLIENT_API_PREFIX`.
 * Compose documents (project/environment create + save + deploy overlays) and
 * `docker run` import are the known large payloads.
 */
const CLIENT_LARGE_BODY_PATTERNS: readonly RegExp[] = [
  /^\/projects$/,
  /^\/projects\/[^/]+$/,
  /^\/projects\/[^/]+\/configure$/,
  /^\/environments$/,
  /^\/environments\/[^/]+$/,
  /^\/environments\/[^/]+\/deploy$/,
  /^\/docker-run\/import$/,
]

function isLimitedPath(pathname: string): boolean {
  return LIMITED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** Byte ceiling for a request path (the default unless a route is listed). */
export function requestBodyLimitFor(pathname: string): number {
  if (pathname.startsWith(`${CLIENT_API_PREFIX}/`)) {
    const rest = pathname.slice(CLIENT_API_PREFIX.length)
    if (CLIENT_LARGE_BODY_PATTERNS.some((pattern) => pattern.test(rest))) {
      return LARGE_REQUEST_BODY_LIMIT_BYTES
    }
  }
  return DEFAULT_REQUEST_BODY_LIMIT_BYTES
}

function tooLarge(c: Context): Response {
  return c.json(
    { ok: false, error: 'request body too large', code: REQUEST_BODY_TOO_LARGE_CODE },
    413
  )
}

export function createRequestBodyLimitMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!BODY_METHODS.has(c.req.method.toUpperCase())) return next()
    let pathname: string
    try {
      pathname = new URL(c.req.url).pathname
    } catch {
      return next()
    }
    if (!isLimitedPath(pathname)) return next()
    return bodyLimit({ maxSize: requestBodyLimitFor(pathname), onError: tooLarge })(c, next)
  }
}
