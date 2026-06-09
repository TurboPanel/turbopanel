import { getCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
import {
  buildSignedCookie,
  SESSION_COOKIE_NAME,
  SESSION_EXPIRES_IN_MS,
  verifySignedCookie,
} from './crypto.ts'
import { verifyCredentials } from './credentials.ts'
import { ensureRootProvisioned } from './root-provisioning.ts'
import { createSession, deleteSession, getSession } from './session-store.ts'
import { getDb } from '../db.ts'

export type AuthRouteOpts = {
  sessionSecret: string
  runtime: 'deno' | 'workers'
}

function readSessionCookie(c: Context): string | null {
  return getCookie(c, SESSION_COOKIE_NAME) ?? null
}

function buildCookieHeader(
  cookieValue: string,
  maxAge: number,
  isHttps: boolean,
): string {
  let header =
    `${SESSION_COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  if (isHttps) {
    header += '; Secure'
  }
  return header
}

function isHttpsRequest(c: Context): boolean {
  return c.req.url.startsWith('https://')
}

export function registerAuthRoutes(app: Hono, opts: AuthRouteOpts) {
  const auth = new Hono()

  auth.post('/sign-in', async (c) => {
    const db = getDb(c)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const { username, password } = body as {
      username?: unknown
      password?: unknown
    }

    if (
      typeof username !== 'string' ||
      !username ||
      typeof password !== 'string' ||
      !password
    ) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const result = await verifyCredentials(username, password, opts.runtime)
    if (!result.ok) {
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    if (result.isRoot && db !== undefined) {
      await ensureRootProvisioned(db)
    }

    const { token } = await createSession(db, result.userId, result.username, {
      ipAddress: c.req.header('X-Real-IP') ?? undefined,
      userAgent: c.req.header('User-Agent') ?? undefined,
    })
    const cookieValue = await buildSignedCookie(token, opts.sessionSecret)
    const isHttps = isHttpsRequest(c)

    return c.json(
      { ok: true, username: result.username },
      200,
      {
        'Set-Cookie': buildCookieHeader(
          cookieValue,
          SESSION_EXPIRES_IN_MS / 1000,
          isHttps,
        ),
      },
    )
  })

  auth.post('/sign-out', async (c) => {
    const db = getDb(c)
    const cookieValue = readSessionCookie(c)

    if (cookieValue) {
      const token = await verifySignedCookie(cookieValue, opts.sessionSecret)
      if (token) {
        await deleteSession(db, token)
      }
    }

    return c.json(
      { ok: true },
      200,
      {
        'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`,
      },
    )
  })

  auth.get('/session', async (c) => {
    const db = getDb(c)
    const cookieValue = readSessionCookie(c)
    if (!cookieValue) {
      return c.json({ ok: false }, 401)
    }

    const token = await verifySignedCookie(cookieValue, opts.sessionSecret)
    if (!token) {
      return c.json({ ok: false }, 401)
    }

    const sessionData = await getSession(db, token)
    if (!sessionData) {
      return c.json({ ok: false }, 401)
    }

    return c.json({
      ok: true,
      userId: sessionData.userId,
      username: sessionData.username,
    })
  })

  app.route('/auth', auth)
  return app
}
