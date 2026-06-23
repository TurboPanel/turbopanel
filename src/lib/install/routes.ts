import { Hono, type Context } from 'hono'
import {
  buildSignedCookie,
  resolveRequestTls,
  SESSION_EXPIRES_IN_MS,
} from '../../client/authn/crypto.ts'
import { verifyInstallHostCredentials } from '../../client/authn/credentials.ts'
import { buildSessionResponse, type AuthRouteOpts } from '../../client/authn/http.ts'
import {
  completeInstanceInstall,
  isInstanceInstalled,
} from '../../client/authn/install-state.ts'
import { createSession, getSession } from '../../client/authn/session-store.ts'
import { getDb } from '../../db.ts'
import { INSTALL_API_PREFIX } from '../../surfaces.ts'

const DAEMON_INSTALL_SCRIPT = `#!/bin/sh
set -eu

tp_is_root() { [ "$(id -u)" = "0" ]; }
tp_user_in_sudo_group() {
	_groups="$(id -nG 2>/dev/null)" || return 1
	for _g in $_groups; do
		case "$_g" in
		sudo | wheel | admin) return 0 ;;
		esac
	done
	return 1
}
tp_sudo_installed() { command -v sudo >/dev/null 2>&1; }
tp_install_privilege_denied() {
	_script="$1"
	if tp_user_in_sudo_group; then
		echo "$_script: run as root (su -); sudo is not installed yet — the daemon installer will install it" >&2
	else
		echo "$_script: must run as root or as a user in the sudo group" >&2
	fi
	exit 1
}

LICENSE=""
HOST_URL=""
BINARY_URL=""

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
		--binary-url)
			if [ $# -lt 2 ]; then
				echo "daemon-install.sh: --binary-url requires an argument" >&2
				exit 1
			fi
			BINARY_URL="$2"
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

if [ -z "$HOST_URL" ]; then
	echo "daemon-install.sh: --host is required" >&2
	exit 1
fi

INSTALL_SCRIPT_URL="\${HOST_URL%/}/api/install/v1/daemon-install.sh"
if ! tp_is_root; then
	if tp_user_in_sudo_group && tp_sudo_installed; then
		if [ -n "$BINARY_URL" ]; then
			exec curl -fsSL "$INSTALL_SCRIPT_URL" | sudo sh -s -- \
				--license "$LICENSE" --host "$HOST_URL" --binary-url "$BINARY_URL"
		fi
		exec curl -fsSL "$INSTALL_SCRIPT_URL" | sudo sh -s -- \
			--license "$LICENSE" --host "$HOST_URL"
	fi
	tp_install_privilege_denied daemon-install.sh
fi

INSTALLER_URL="\${TURBOPANEL_INSTALLER_URL:-https://raw.githubusercontent.com/turbopanel/turbopanel-cdn/trunk/install.sh}"

if [ -n "$BINARY_URL" ]; then
	export TURBOPANEL_DAEMON_BINARY_URL="$BINARY_URL"
fi
curl -fsSL "$INSTALLER_URL" | sh -s -- --instance-url "$HOST_URL" --license "$LICENSE"
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
