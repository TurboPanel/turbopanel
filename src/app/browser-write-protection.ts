/**
 * Browser write protection for cookie-authenticated surfaces.
 *
 * Credentialed CORS origins (docs Scalar, etc.) must not forge cross-origin
 * `POST`/`PUT`/`PATCH`/`DELETE` against session cookies. Daemon bearer/JWT
 * routes stay outside this gate.
 *
 * A write under `CLIENT_API_PREFIX` / `ADMIN_API_PREFIX` / `INSTALL_API_PREFIX`
 * / `DEVELOPER_API_PREFIX` is allowed when:
 * 1. `Origin` matches the expected browser origin (same-site browser), or
 * 2. `Origin` is absent and `Referer` matches the expected origin, or
 * 3. both `Origin` and `Referer` are absent (non-browser clients: curl, scripts,
 *    the native apps and the installer, which send no `Sec-Fetch-*` either).
 *
 * `Sec-Fetch-Site` (sent by every current browser, never forgeable from page
 * script) only ever tightens those rules: `cross-site` is refused outright,
 * and with no `Origin` / `Referer` a browser-asserted value other than
 * `same-origin` / `none` is refused too. `same-site` is deliberately NOT a
 * pass: customer sites can live on sibling subdomains of the panel host, so
 * only the exact-origin match above authorises a browser write. A missing
 * `Sec-Fetch-Site` stays allowed (native apps, CLI, Local-Console HMAC calls).
 *
 * Outside this gate by prefix: `/api/daemon/v1` (JWT/bearer), `/webhook/*`
 * (provider signatures), `/api/health`, and docs/static routes. `GET` /
 * `HEAD` / `OPTIONS` are never gated.
 *
 * Expected origin is runtime-aware (see {@link resolveExpectedBrowserOrigin}):
 * Deno trusts Caddy's `X-Forwarded-Proto` + `Host`; Workers uses the URL only.
 *
 * Pair with read-oriented CORS methods in `cors.ts` so preflight cannot
 * authorize credentialed browser writes from configured docs origins either.
 */
import type { Context, MiddlewareHandler, Next } from 'hono'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  DEVELOPER_API_PREFIX,
  INSTALL_API_PREFIX,
} from './surfaces.ts'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const SAFE_FETCH_SITES = new Set(['same-origin', 'none'])

const PROTECTED_PREFIXES = [
  CLIENT_API_PREFIX,
  ADMIN_API_PREFIX,
  INSTALL_API_PREFIX,
  DEVELOPER_API_PREFIX,
] as const

function isProtectedWritePath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

function tryParseOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function requestUrlOrigin(c: Context): string | null {
  try {
    return new URL(c.req.url).origin
  } catch {
    return null
  }
}

/**
 * Browser-facing origin for same-origin write checks.
 *
 * - **Deno** (Caddy → Unix socket): reconstruct from trusted
 *   `X-Forwarded-Proto` + `Host`. The request URL is the socket/internal
 *   origin and must not be compared to the browser `Origin`.
 * - **Workers**: URL-derived only — ignore client-controlled forwarded-proto.
 */
export function resolveExpectedBrowserOrigin(
  c: Context,
  runtime: 'deno' | 'workers'
): string | null {
  if (runtime === 'deno') {
    const forwardedProto = c.req.header('X-Forwarded-Proto')?.trim().toLowerCase()
    const host = c.req.header('Host')?.trim()
    if ((forwardedProto === 'https' || forwardedProto === 'http') && host && host.length > 0) {
      return `${forwardedProto}://${host}`
    }
  }
  return requestUrlOrigin(c)
}

/**
 * True when the browser-supplied `Origin` / `Referer` matches the request
 * origin, or when no browser origin signal is present (non-browser client).
 */
export function isSameOriginBrowserWrite(
  originHeader: string | undefined,
  refererHeader: string | undefined,
  expectedOrigin: string | null,
  secFetchSite?: string | undefined
): boolean {
  if (expectedOrigin === null) return false

  const fetchSite = secFetchSite?.trim().toLowerCase()
  if (fetchSite === 'cross-site') return false

  const origin = originHeader?.trim()
  if (origin) {
    return tryParseOrigin(origin) === expectedOrigin
  }

  const referer = refererHeader?.trim()
  if (referer) {
    return tryParseOrigin(referer) === expectedOrigin
  }

  // No Origin and no Referer. A browser-asserted Sec-Fetch-Site that is not
  // same-origin / none (same-site, unknown values) is refused; an absent
  // header is a non-browser client (curl, scripts, native apps).
  return fetchSite === undefined || fetchSite === '' || SAFE_FETCH_SITES.has(fetchSite)
}

export function createBrowserWriteProtectionMiddleware(
  runtime: 'deno' | 'workers' = 'workers'
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase()
    if (!WRITE_METHODS.has(method)) {
      return await next()
    }

    let pathname: string
    try {
      pathname = new URL(c.req.url).pathname
    } catch {
      return c.json({ ok: false, error: 'Forbidden' }, 403)
    }

    if (!isProtectedWritePath(pathname)) {
      return await next()
    }

    const expected = resolveExpectedBrowserOrigin(c, runtime)
    if (
      isSameOriginBrowserWrite(
        c.req.header('Origin'),
        c.req.header('Referer'),
        expected,
        c.req.header('Sec-Fetch-Site')
      )
    ) {
      return await next()
    }

    return c.json({ ok: false, error: 'Forbidden' }, 403)
  }
}
