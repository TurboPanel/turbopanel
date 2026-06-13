import { Hono, type Context } from 'hono'
import {
  buildSignedCookie,
  resolveRequestTls,
  SESSION_EXPIRES_IN_MS,
} from './auth/crypto.ts'
import { verifyInstallHostCredentials } from './auth/credentials.ts'
import { buildSessionResponse, type AuthRouteOpts } from './auth/http.ts'
import {
  completeInstanceInstall,
  getInstallStatus,
  isInstanceInstalled,
  isSignupEnabled,
} from './auth/install-state.ts'
import { createSession, getSession } from './auth/session-store.ts'
import { debugLog } from './debug-log.ts'
import { getDb } from './db.ts'
import { INSTALL_API_PREFIX } from './surfaces.ts'

/** Accept `username`/`password` or legacy `hostUsername`/`hostPassword`. */
function normalizeHostCredentials(body: Record<string, unknown>): {
  username: string
  password: string
} | null {
  const username = body.username ?? body.hostUsername
  const password = body.password ?? body.hostPassword

  if (
    typeof username !== 'string' ||
    !username.trim() ||
    typeof password !== 'string' ||
    !password
  ) {
    return null
  }

  return { username: username.trim(), password }
}

async function completeInstallHandler(c: Context, opts: AuthRouteOpts) {
  if (opts.runtime !== 'deno') {
    return c.json({ ok: false, error: 'Not available' }, 404)
  }

  if (!opts.secrets) {
    return c.json({ ok: false, error: 'Not configured' }, 503)
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

  const record = body as Record<string, unknown>
  const hostCredentials = normalizeHostCredentials(record)
  const { superadminEmail, superadminPassword } = record

  if (
    hostCredentials === null ||
    typeof superadminEmail !== 'string' ||
    typeof superadminPassword !== 'string'
  ) {
    return c.json({ ok: false, error: 'Invalid request' }, 400)
  }

  const hostOk = await verifyInstallHostCredentials(
    hostCredentials.username,
    hostCredentials.password,
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
    const sessionCookie = await buildSignedCookie(token, opts.secrets)
    const tls = resolveRequestTls(c.req.url, c.req.header('x-forwarded-proto'))
    let setCookie =
      `${tls.cookieName}=${sessionCookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_EXPIRES_IN_MS / 1000}`
    if (tls.isHttps) {
      setCookie += '; Secure'
    }
    // #region agent log
    await debugLog('install-routes.ts:install', 'install session cookie built', {
      userId: result.userId,
      reqUrl: c.req.url,
      forwardedProto: c.req.header('x-forwarded-proto') ?? null,
      cookieName: tls.cookieName,
      isHttps: tls.isHttps,
      setCookieHasSecure: setCookie.includes('; Secure'),
    }, 'E')
    // #endregion

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
        'Set-Cookie': setCookie,
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Install failed'
    if (message === 'Instance is already configured') {
      return c.json({ ok: false, error: message }, 409)
    }
    return c.json({ ok: false, error: message }, 400)
  }
}

/**
 * Self-hosted install wizard surface. Mounted under {@link INSTALL_API_PREFIX}
 * (`/api/install/v1`).
 */
export function registerInstallRoutes(app: Hono, opts: AuthRouteOpts) {
  const install = new Hono({ strict: false })

  install.get('/status', async (c) => {
    const startedAt = performance.now()
    const db = getDb(c)
    if (db === undefined) {
      if (opts.runtime === 'workers') {
        return c.json({
          ok: true,
          needsInstall: false,
          isInstallMode: false,
          isSignupEnabled: false,
        })
      }
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    if (opts.runtime === 'workers') {
      const signupEnabled = await isSignupEnabled(db, opts.signupEnvOverride)
      return c.json({
        ok: true,
        needsInstall: false,
        isInstallMode: false,
        isSignupEnabled: signupEnabled,
      })
    }

    const status = await getInstallStatus(db, opts.signupEnvOverride)
    const elapsed = (performance.now() - startedAt).toFixed(1)
    console.log(
      `[auth] install/status ${elapsed}ms`,
    )
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

  install.post('/', (c) => completeInstallHandler(c, opts))
  app.post(`${INSTALL_API_PREFIX}/`, (c) => completeInstallHandler(c, opts))

  app.route(INSTALL_API_PREFIX, install)
  return app
}
