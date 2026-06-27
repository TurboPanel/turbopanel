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
# Legacy self-hosted shim — delegates to run.sh with the same contract.
set -eu

tp_is_root() { [ "$(id -u)" = "0" ]; }
tp_is_interactive() {
	if [ -t 0 ]; then
		return 0
	fi
	[ -r /dev/tty ] && [ -w /dev/tty ] 2>/dev/null
}
tp_sudo_installed() { command -v sudo >/dev/null 2>&1; }
tp_validate_sudo() {
	if ! tp_sudo_installed; then
		return 2
	fi
	if sudo -n true 2>/dev/null; then
		return 0
	fi
	if tp_is_interactive; then
		if sudo -v 2>/dev/null; then
			return 0
		fi
	fi
	return 1
}
tp_install_privilege_denied() {
	_reason="\${1:-}"
	case "\$_reason" in
	no_sudo)
		echo "daemon-install.sh: run as root (su -); sudo is not installed yet — the daemon installer will install it" >&2
		;;
	sudo_failed)
		echo "daemon-install.sh: sudo validation failed — run as root or enter a valid sudo password" >&2
		;;
	*)
		echo "daemon-install.sh: must run as root or have sudo privileges" >&2
		;;
	esac
	exit 1
}

LICENSE=""
HOST_URL=""
INSECURE_TLS=false

while [ \$# -gt 0 ]; do
	case "\$1" in
		--license)
			[ \$# -ge 2 ] || { echo "daemon-install.sh: --license requires an argument" >&2; exit 1; }
			LICENSE="\$2"; shift 2 ;;
		--host)
			[ \$# -ge 2 ] || { echo "daemon-install.sh: --host requires an argument" >&2; exit 1; }
			HOST_URL="\$2"; shift 2 ;;
		--insecure-tls)
			INSECURE_TLS=true; shift ;;
		*)
			echo "daemon-install.sh: unknown option: \$1" >&2
			exit 1
			;;
	esac
done

if [ -z "\$LICENSE" ]; then
	echo "daemon-install.sh: --license is required (base64url-encoded id:token)" >&2
	exit 1
fi

_padded="\$LICENSE"
while [ \$(( \${#_padded} % 4 )) -ne 0 ]; do
	_padded="\${_padded}="
done
_decoded="\$(printf '%s' "\$_padded" | tr -- '-_' '+/' | base64 -d 2>/dev/null)" || {
	echo "daemon-install.sh: invalid --license format; expected base64url-encoded id:token" >&2
	exit 1
}
LICENSE_ID="\$(echo "\$_decoded" | cut -d: -f1)"
LICENSE_TOKEN="\$(echo "\$_decoded" | cut -d: -f2-)"
if [ -z "\$LICENSE_ID" ] || [ -z "\$LICENSE_TOKEN" ]; then
	echo "daemon-install.sh: invalid --license format; expected base64url-encoded id:token" >&2
	exit 1
fi

if [ -n "\$HOST_URL" ]; then
	RUN_SCRIPT_URL="\${HOST_URL%/}/run.sh"
else
	RUN_SCRIPT_URL="https://trbp.nl/run.sh"
fi

_curl="curl -fsSL"
[ "\$INSECURE_TLS" = true ] && _curl="curl -fsSLk"

set -- --license "\$LICENSE"
[ -n "\$HOST_URL" ] && set -- "\$@" --host "\$HOST_URL"
[ "\$INSECURE_TLS" = true ] && set -- "\$@" --insecure-tls

if ! tp_is_root; then
	_sudo_rc=0
	tp_validate_sudo || _sudo_rc=\$?
	if [ "\$_sudo_rc" -eq 2 ]; then
		tp_install_privilege_denied no_sudo
	fi
	if [ "\$_sudo_rc" -ne 0 ]; then
		tp_install_privilege_denied sudo_failed
	fi
	# shellcheck disable=SC2086
	exec \$_curl "\$RUN_SCRIPT_URL" | sudo sh -s -- "\$@"
fi

# shellcheck disable=SC2086
exec \$_curl "\$RUN_SCRIPT_URL" | sh -s -- "\$@"
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
 * Self-hosted install wizard surface (Deno only). Mounted under
 * {@link INSTALL_API_PREFIX} (`/api/install/v1`).
 *
 * Cloudflare Workers has no install wizard — first-user bootstrap uses public
 * sign-up (`POST /api/client/v1/auth/sign-up` or OTP auto-registration).
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
