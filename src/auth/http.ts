import { getCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
import {
  buildSignedCookie,
  SESSION_COOKIE_NAME,
  SESSION_EXPIRES_IN_MS,
  verifySignedCookie,
} from './crypto.ts'
import { PAM_ROOT_USERNAME, verifyCredentials, verifyInstallHostCredentials } from './credentials.ts'
import {
  completeInstanceInstall,
  getInstallStatus,
  getUserOrganizationId,
  isInstanceInstalled,
} from './install-state.ts'
import { createSession, deleteSession, getSession } from './session-store.ts'
import { getDb } from '../db.ts'
import type { Db } from '../db.ts'

export type AuthRouteOpts = {
  sessionSecret: string
  runtime: 'deno' | 'workers'
}

export type SessionResponse = {
  ok: true
  userId: string | null
  username: string | null
  email: string | null
  role: string | null
  needsInstall: boolean
  organizationId: string | null
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

async function buildSessionResponse(
  db: Db | undefined,
  runtime: AuthRouteOpts['runtime'],
  sessionData: {
    userId: string
    username: string | null
    email: string
    role: string
  },
): Promise<SessionResponse> {
  const base: SessionResponse = {
    ok: true,
    userId: sessionData.userId,
    username: sessionData.username,
    email: sessionData.email,
    role: sessionData.role,
    needsInstall: false,
    organizationId: null,
  }

  if (runtime !== 'deno' || db === undefined) {
    return base
  }

  const needsInstall = !(await isInstanceInstalled(db))
  if (needsInstall) {
    return { ...base, needsInstall: true }
  }

  const organizationId = await getUserOrganizationId(db, sessionData.userId)
  return {
    ...base,
    needsInstall: false,
    organizationId,
  }
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

    if (
      opts.runtime === 'deno' &&
      username === PAM_ROOT_USERNAME &&
      db &&
      !(await isInstanceInstalled(db))
    ) {
      return c.json(
        {
          ok: false,
          error: 'Complete initial setup on the install page with your host credentials',
        },
        403,
      )
    }

    const result = await verifyCredentials(username, password, opts.runtime, db)
    if (!result.ok) {
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    if (result.isRoot) {
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    const { token } = await createSession(db, result.userId, {
      ipAddress: c.req.header('X-Real-IP') ?? undefined,
      userAgent: c.req.header('User-Agent') ?? undefined,
    })
    const cookieValue = await buildSignedCookie(token, opts.sessionSecret)
    const isHttps = isHttpsRequest(c)

    const sessionData = await getSession(db, token)
    if (!sessionData) {
      throw new Error('Session creation failed')
    }

    const payload = await buildSessionResponse(db, opts.runtime, sessionData)

    return c.json(
      payload,
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

    const payload = await buildSessionResponse(db, opts.runtime, sessionData)
    return c.json(payload)
  })

  const install = new Hono()

  install.get('/status', async (c) => {
    if (opts.runtime !== 'deno') {
      return c.json({ ok: true, needsInstall: false })
    }

    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const status = await getInstallStatus(db)
    return c.json({ ok: true, ...status })
  })

  install.post('/bootstrap', async (c) => {
    if (opts.runtime !== 'deno') {
      return c.json({ ok: false, error: 'Not available' }, 404)
    }

    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    if (await isInstanceInstalled(db)) {
      return c.json({ ok: false, error: 'Instance is already configured' }, 409)
    }

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
      !username.trim() ||
      typeof password !== 'string' ||
      !password
    ) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const ok = await verifyInstallHostCredentials(
      username.trim(),
      password,
      opts.runtime,
      db,
    )
    if (!ok) {
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    return c.json({ ok: true })
  })

  install.post('/', async (c) => {
    if (opts.runtime !== 'deno') {
      return c.json({ ok: false, error: 'Not available' }, 404)
    }

    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    if (await isInstanceInstalled(db)) {
      return c.json({ ok: false, error: 'Instance is already configured' }, 409)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const {
      hostUsername,
      hostPassword,
      superadminEmail,
      superadminPassword,
    } = body as {
      hostUsername?: unknown
      hostPassword?: unknown
      superadminEmail?: unknown
      superadminPassword?: unknown
    }

    if (
      typeof hostUsername !== 'string' ||
      !hostUsername.trim() ||
      typeof hostPassword !== 'string' ||
      !hostPassword ||
      typeof superadminEmail !== 'string' ||
      typeof superadminPassword !== 'string'
    ) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const hostOk = await verifyInstallHostCredentials(
      hostUsername.trim(),
      hostPassword,
      opts.runtime,
      db,
    )
    if (!hostOk) {
      return c.json({ ok: false, error: 'Invalid host credentials' }, 401)
    }

    try {
      const result = await completeInstanceInstall(db, {
        superadminEmail,
        superadminPassword,
      })

      const { token } = await createSession(db, result.userId, {
          ipAddress: c.req.header('X-Real-IP') ?? undefined,
          userAgent: c.req.header('User-Agent') ?? undefined,
        })
      const sessionCookie = await buildSignedCookie(token, opts.sessionSecret)
      const isHttps = isHttpsRequest(c)

      const sessionData = await getSession(db, token)
      if (!sessionData) {
        throw new Error('Session creation failed')
      }

      const payload = await buildSessionResponse(db, opts.runtime, sessionData)

      return c.json(
        {
          ...payload,
          organizationId: result.organizationId,
          needsInstall: false,
        },
        200,
        {
          'Set-Cookie': buildCookieHeader(
            sessionCookie,
            SESSION_EXPIRES_IN_MS / 1000,
            isHttps,
          ),
        },
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Install failed'
      if (message === 'Instance is already configured') {
        return c.json({ ok: false, error: message }, 409)
      }
      return c.json({ ok: false, error: message }, 400)
    }
  })

  app.route('/auth', auth)
  app.route('/install', install)
  return app
}
