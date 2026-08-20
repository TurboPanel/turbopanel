import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  buildSignedCookie,
  resolveRequestTls,
  SESSION_EXPIRES_IN_MS,
} from '../../client/authn/crypto.ts'
import { verifyInstallHostCredentials } from '../../client/authn/credentials.ts'
import {
  buildSessionResponse,
  enforceAuthRateLimit,
  resolveClientIp,
  type AuthRouteOpts,
} from '../../client/authn/http.ts'
import {
  completeInstanceInstall,
  isInstanceInstalled,
} from '../../client/authn/install-state.ts'
import { createSession, getSession } from '../../client/authn/session-store.ts'
import { getDb } from '../../db.ts'
import {
  parseCompleteInstallBodyRaw,
  parseInstallHostCredentialsBody,
} from './parse-body.ts'
import { INSTALL_API_PREFIX } from '../../surfaces.ts'

async function parseCompleteInstallBody(
  c: Context,
): Promise<
  | {
    username: string
    password: string
    superadminEmail: string
    superadminPassword: string
  }
  | { response: Response }
> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { response: c.json({ ok: false, error: 'Invalid request' }, 400) }
  }

  const parsed = parseCompleteInstallBodyRaw(body)
  if (!parsed.ok) {
    return { response: c.json({ ok: false, error: parsed.error }, 400) }
  }

  return parsed.value
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

  const parsed = await parseCompleteInstallBody(c)
  if ('response' in parsed) {
    return parsed.response
  }
  const { username, password, superadminEmail, superadminPassword } = parsed

  const limited = await enforceAuthRateLimit(
    c,
    'install-complete',
    username.trim(),
    opts.runtime,
  )
  if (limited) {
    return limited
  }

  const hostOk = await verifyInstallHostCredentials(
    username.trim(),
    password,
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
      ipAddress: resolveClientIp(c, opts.runtime) ?? undefined,
      userAgent: c.req.header('User-Agent') ?? undefined,
    })
    const sessionCookie = await buildSignedCookie(token, opts.secrets)
    const tls = resolveRequestTls({
      requestUrl: c.req.url,
      runtime: opts.runtime,
      forwardedProto: c.req.header('x-forwarded-proto'),
    })
    let setCookie =
      `${tls.cookieName}=${sessionCookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_EXPIRES_IN_MS / 1000}`
    if (tls.isHttps) {
      setCookie += '; Secure'
    }

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
 * Self-hosted install wizard surface (Deno only). Mounted under
 * {@link INSTALL_API_PREFIX} (`/api/install/v1`).
 *
 * Cloudflare Workers has no install wizard — first-user bootstrap uses public
 * sign-up (`POST /api/client/v1/auth/sign-up` or OTP auto-registration).
 */
export function registerInstallRoutes(app: Hono<AppEnv>, opts: AuthRouteOpts) {
  const install = new Hono({ strict: false })

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

    const parsed = parseInstallHostCredentialsBody(body)
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400)
    }
    const { username, password } = parsed.value

    const limited = await enforceAuthRateLimit(
      c,
      'install-bootstrap',
      username.trim(),
      opts.runtime,
    )
    if (limited) {
      return limited
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
