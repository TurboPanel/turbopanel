import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { account, user } from '../../lib/db/schema.ts'
import { isInstanceInstalled } from './install-state.ts'
import { verifyPassword } from './password.ts'
import { compatLogWarn } from '../../log-compat.ts'

export const PAM_ROOT_USERNAME = 'root'

const HOST_USERNAME_RE = /^[a-zA-Z0-9._-]+$/
const INSTALL_SUDO_GROUPS = ['sudo', 'wheel', 'admin']

export type AuthRuntime = 'deno' | 'workers'

/** Hyperdrive caches SELECTs; auth reads after verify must not serve stale rows. */
function bypassHyperdriveQueryCache() {
  return sql`random() >= 0`
}

export type VerifyResult =
  | { ok: true; username: string; isRoot: true }
  | { ok: true; userId: string; username: string | null; email: string; isRoot: false }
  | { ok: false; reason?: 'email_not_verified' }

async function verifyPamLogin(username: string, password: string): Promise<boolean> {
  if (!HOST_USERNAME_RE.test(username)) return false

  try {
    const result = await new Deno.Command('/bin/sh', {
      args: [
        '-c',
        'printf \'%s\\n\' "$TP_PAM_PASSWORD" | sudo -n /usr/bin/pamtester login "$TP_PAM_USERNAME" authenticate',
      ],
      env: {
        ...Deno.env.toObject(),
        TP_PAM_USERNAME: username,
        TP_PAM_PASSWORD: password,
      },
      stdout: 'null',
      stderr: 'null',
    }).output()

    return result.success
  } catch {
    return false
  }
}

async function userHasInstallSudo(username: string): Promise<boolean> {
  if (!HOST_USERNAME_RE.test(username)) return false

  try {
    const result = await new Deno.Command('/bin/sh', {
      args: [
        '-c',
        'groups=$(id -nG "$TP_PAM_USERNAME" 2>/dev/null) || exit 1; for g in sudo wheel admin; do echo "$groups" | tr " " "\\n" | grep -qx "$g" && exit 0; done; exit 1',
      ],
      env: { ...Deno.env.toObject(), TP_PAM_USERNAME: username },
      stdout: 'null',
      stderr: 'null',
    }).output()

    return result.success
  } catch {
    return false
  }
}

/** Dev-only: bypass PAM password verification, keep group-membership check. */
function isDevHostAuthMode(): boolean {
  return Deno.env.get('TURBOPANEL_DEV_HOST_AUTH') === 'group-only'
}

/** PAM root or a sudo-capable host user — install wizard only, never issues a session. */
export async function verifyInstallHostCredentials(
  username: string,
  password: string,
  runtime: AuthRuntime,
  db?: Db,
): Promise<boolean> {
  if (runtime !== 'deno') return false
  if (db && await isInstanceInstalled(db)) return false

  const trimmed = username.trim()
  if (!HOST_USERNAME_RE.test(trimmed) || !password) return false

  if (isDevHostAuthMode()) {
    compatLogWarn(
      'dev',
      'TURBOPANEL_DEV_HOST_AUTH=group-only — PAM password verification is disabled; verifying group membership only',
    )
    if (trimmed === PAM_ROOT_USERNAME) return true
    return await userHasInstallSudo(trimmed)
  }

  const pamOk = await verifyPamLogin(trimmed, password)
  if (!pamOk) return false

  if (trimmed === PAM_ROOT_USERNAME) return true

  return await userHasInstallSudo(trimmed)
}

async function verifyDbUserCredentials(
  db: Db,
  login: string,
  password: string,
): Promise<VerifyResult> {
  const trimmed = login.trim()
  const byEmail = trimmed.includes('@')

  const rows = await db
    .select({
      userId: user.id,
      username: user.username,
      email: user.email,
      password: account.password,
      isDisabled: user.isDisabled,
      isEmailVerified: user.isEmailVerified,
    })
    .from(user)
    .innerJoin(
      account,
      and(eq(account.userId, user.id), eq(account.providerId, 'credential')),
    )
    .where(
      and(
        byEmail
          ? eq(user.email, trimmed.toLowerCase())
          : eq(user.username, trimmed),
        bypassHyperdriveQueryCache(),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row?.password || row.isDisabled) {
    return { ok: false }
  }

  const valid = await verifyPassword(password, row.password)
  if (!valid) {
    return { ok: false }
  }

  if (!row.isEmailVerified) {
    return { ok: false, reason: 'email_not_verified' }
  }

  return {
    ok: true,
    userId: row.userId,
    username: row.username,
    email: row.email,
    isRoot: false,
  }
}

export async function verifyCredentials(
  username: string,
  password: string,
  runtime: AuthRuntime,
  db?: Db,
): Promise<VerifyResult> {
  if (runtime === 'deno' && username === PAM_ROOT_USERNAME) {
    if (db && await isInstanceInstalled(db)) {
      return { ok: false }
    }
    const ok = await verifyInstallHostCredentials(
      PAM_ROOT_USERNAME,
      password,
      runtime,
      db,
    )
    if (ok) {
      return {
        ok: true,
        username: PAM_ROOT_USERNAME,
        isRoot: true,
      }
    }
    return { ok: false }
  }

  if (db === undefined) {
    return { ok: false }
  }

  return await verifyDbUserCredentials(db, username, password)
}
