import { Hono, type Context } from 'hono'
import {
  buildSignedCookie,
  resolveRequestTls,
  SESSION_EXPIRES_IN_MS,
} from '../authn/crypto.ts'
import { verifyInstallHostCredentials } from '../authn/credentials.ts'
import { buildSessionResponse, type AuthRouteOpts } from '../authn/http.ts'
import {
  completeInstanceInstall,
  getInstallStatus,
  isInstanceInstalled,
  isSignupEnabled,
} from '../authn/install-state.ts'
import { createSession, getSession } from '../authn/session-store.ts'
import { getDb } from '../db.ts'
import { INSTALL_API_PREFIX } from '../surfaces.ts'
import { compatLogInfo } from '../log-compat.ts'

const DAEMON_INSTALL_SCRIPT = `#!/bin/sh
set -eu

LICENSE=""
HOST_URL=""

while [ $# -gt 0 ]; do
	case "$1" in
		--license)
			if [ $# -lt 2 ]; then
				echo "daemon-install.sh: --license requires an argument" >&2
				exit 1
			fi
			LICENSE="$2"
			shift 2
			;;
		--host)
			if [ $# -lt 2 ]; then
				echo "daemon-install.sh: --host requires an argument" >&2
				exit 1
			fi
			HOST_URL="$2"
			shift 2
			;;
		*)
			echo "daemon-install.sh: unknown option: $1" >&2
			exit 1
			;;
	esac
done

if [ -z "$LICENSE" ]; then
	echo "daemon-install.sh: --license is required (id:token)" >&2
	exit 1
fi

LICENSE_ID="$(echo "$LICENSE" | cut -d: -f1)"
LICENSE_TOKEN="$(echo "$LICENSE" | cut -d: -f2-)"

if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
	echo "daemon-install.sh: invalid --license format; expected id:token" >&2
	exit 1
fi

# Stage outside the daemon checkout — git clone into turbopanel_daemon_dir fails
# when that path already contains files (see daemon-repo role).
STAGING_DIR="/opt/turbopanel/platform/config/daemon-license-staging"
mkdir -p "$STAGING_DIR"

printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"

INSTALLER_URL="\${TURBOPANEL_CDN_URL:-https://cdn.turbopanel.app/daemon/install.sh}"

if [ -n "$HOST_URL" ]; then
	curl -fsSL "$INSTALLER_URL" | sh -s -- --instance-url "$HOST_URL"
else
	curl -fsSL "$INSTALLER_URL" | sh
fi
`

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
  const { username, password, superadminEmail, superadminPassword } = record

  if (
    typeof username !== 'string' ||
    !username.trim() ||
    typeof password !== 'string' ||
    !password ||
    typeof superadminEmail !== 'string' ||
    typeof superadminPassword !== 'string'
  ) {
    return c.json({ ok: false, error: 'Invalid request' }, 400)
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
      ipAddress: c.req.header('X-Real-IP') ?? undefined,
      userAgent: c.req.header('User-Agent') ?? undefined,
      organizationId: result.organizationId,
    })
    const sessionCookie = await buildSignedCookie(token, opts.secrets)
    const tls = resolveRequestTls(c.req.url, c.req.header('x-forwarded-proto'))
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
    compatLogInfo('auth', `install/status ${elapsed}ms`)
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

  install.get('/daemon-install.sh', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8')
    return c.text(DAEMON_INSTALL_SCRIPT)
  })

  app.route(INSTALL_API_PREFIX, install)
  return app
}
