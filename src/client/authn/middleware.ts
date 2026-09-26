import { getCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { getDb } from '../../db/connection.ts'
import {
  buildSignedCookie,
  SESSION_EXPIRES_IN_MS,
  verifySignedCookie,
} from './crypto.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { verifyLocalConsoleAuthorization } from '../../developer/local-console-auth.ts'
import {
  getSession,
  isAdminRole,
  isSuperadminRole,
  type SessionData,
} from './session-store.ts'
import { buildCookieHeader, requestTls } from './request-context.ts'

function isSuperadmin(sessionData: SessionData): boolean {
  return isSuperadminRole(sessionData.role)
}

function isAdmin(sessionData: SessionData): boolean {
  return isAdminRole(sessionData.role)
}

export type { SessionData }

export type ResolvedSession = {
  data: SessionData
  rotated: boolean
  token: string
}

/**
 * Resolve the runtime from context (set by `createApp`). Unknown values fall
 * back to the secure URL-derived path (`'workers'`), so a missing signal never
 * results in trusting a client-supplied `X-Forwarded-Proto`.
 */
export function resolveRuntime(c: Context): 'deno' | 'workers' {
  return c.get('runtime') === 'deno' ? 'deno' : 'workers'
}

function sessionCookieHeader(cookieValue: string, c: Context): string {
  const tls = requestTls(c, resolveRuntime(c))
  return buildCookieHeader(
    cookieValue,
    SESSION_EXPIRES_IN_MS / 1000,
    tls.cookieName,
    tls.isHttps,
  )
}

async function applyRotatedCookie(
  c: Context,
  token: string,
  secrets: DerivedSecretsConfig,
): Promise<void> {
  const cookieValue = await buildSignedCookie(token, secrets)
  c.header('Set-Cookie', sessionCookieHeader(cookieValue, c))
}

export async function resolveSession(
  c: Context,
  secrets: DerivedSecretsConfig,
  db?: Db,
): Promise<ResolvedSession | null> {
  const tls = requestTls(c, resolveRuntime(c))
  const cookieValue = getCookie(c, tls.cookieName)
  const result = cookieValue
    ? await verifySignedCookie(cookieValue, secrets)
    : null

  if (!result) return null

  const data = await getSession(db, result.token)
  if (!data) return null

  if (result.rotated) {
    await applyRotatedCookie(c, result.token, secrets)
  }

  return { data, rotated: result.rotated, token: result.token }
}

export async function resolveRootSession(
  c: Context,
  secrets: DerivedSecretsConfig,
  db?: Db,
): Promise<SessionData | null> {
  const resolved = await resolveSession(c, secrets, db)
  if (!resolved || !isSuperadmin(resolved.data)) return null
  return resolved.data
}

export function createSessionMiddleware(
  secrets: DerivedSecretsConfig,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resolved = await resolveSession(c, secrets, getDb(c))
    if (!resolved) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }

    c.set('session', resolved.data)
    await next()
  }
}

export function createRootOnlyMiddleware(
  secrets: DerivedSecretsConfig,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resolved = await resolveSession(c, secrets, getDb(c))
    if (!resolved) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }

    if (!isSuperadmin(resolved.data)) {
      return c.json({ ok: false, error: 'Forbidden' }, 403)
    }

    c.set('session', resolved.data)
    await next()
  }
}

/**
 * Developer-surface auth: superadmin session cookie, or HMAC local-console auth
 * on co-located dev hosts (terminal console over the Unix socket only).
 */
export function createDeveloperAccessMiddleware(
  secrets: DerivedSecretsConfig,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resolved = await resolveSession(c, secrets, getDb(c))
    if (resolved && isSuperadmin(resolved.data)) {
      c.set('session', resolved.data)
      return next()
    }

    if (await verifyLocalConsoleAuthorization(c)) {
      return next()
    }

    if (!resolved) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }

    return c.json({ ok: false, error: 'Forbidden' }, 403)
  }
}

export function createAdminAccessMiddleware(
  secrets: DerivedSecretsConfig,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resolved = await resolveSession(c, secrets, getDb(c))
    if (!resolved) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }

    if (!isAdmin(resolved.data)) {
      return c.json({ ok: false, error: 'Forbidden' }, 403)
    }

    c.set('session', resolved.data)
    await next()
  }
}
