import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app.ts'
import type { Db } from '../db.ts'
import { getDb } from '../db.ts'
import { SESSION_COOKIE_NAME, verifySignedCookie } from './crypto.ts'
import {
  getSession,
  SUPERUSER_ROLE,
  type SessionData,
} from './session-store.ts'

function isSuperuser(sessionData: SessionData): boolean {
  return sessionData.role === SUPERUSER_ROLE
}

export type { SessionData }

export async function resolveSession(
  c: Context,
  sessionSecret: string,
  db?: Db,
): Promise<SessionData | null> {
  const cookieValue = getCookie(c, SESSION_COOKIE_NAME)
  const token = cookieValue
    ? await verifySignedCookie(cookieValue, sessionSecret)
    : null

  if (!token) return null

  return (await getSession(db, token)) ?? null
}

export async function resolveRootSession(
  c: Context,
  sessionSecret: string,
  db?: Db,
): Promise<SessionData | null> {
  const sessionData = await resolveSession(c, sessionSecret, db)
  if (!sessionData || !isSuperuser(sessionData)) return null
  return sessionData
}

export function createSessionMiddleware(
  sessionSecret: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sessionData = await resolveSession(c, sessionSecret, getDb(c))
    if (!sessionData) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }

    c.set('session', sessionData)
    await next()
  }
}

export function createRootOnlyMiddleware(
  sessionSecret: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sessionData = await resolveSession(c, sessionSecret, getDb(c))
    if (!sessionData) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }

    if (!isSuperuser(sessionData)) {
      return c.json({ ok: false, error: 'Forbidden' }, 403)
    }

    c.set('session', sessionData)
    await next()
  }
}
