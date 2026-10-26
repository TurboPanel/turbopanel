/**
 * App logins: the three logins an app usually needs on one database, made in
 * one step. `<prefix>_migrate` owns the database (the Database admin login),
 * `<prefix>_rw` reads and changes rows, `<prefix>_ro` only reads. Each one is
 * granted on that database only. The levels are the existing ones, so the
 * daemon gives them exactly what a single login with that level gets:
 *
 * - PostgreSQL: `_migrate` is a member of the database's owner role, so what
 *   it creates belongs to the owner role and it can hand out access; `_rw` and
 *   `_ro` join the database's read/write and read-only groups.
 * - MySQL and MariaDB have no database owner: `_migrate` gets every right on
 *   the database and may grant them to others; `_rw` changes rows only; `_ro`
 *   only reads.
 */

import type { ManagedConnectionRole } from '../../contracts/commands/schemas.ts'
import { DATABASE_ADMIN_PRIVILEGE } from './owner-role.ts'

export type AppLoginKind = {
  suffix: 'migrate' | 'rw' | 'ro'
  privileges: readonly string[]
  connectionRole: ManagedConnectionRole
}

export const APP_LOGIN_KINDS: readonly AppLoginKind[] = [
  { suffix: 'migrate', privileges: [DATABASE_ADMIN_PRIVILEGE], connectionRole: 'read-write' },
  { suffix: 'rw', privileges: ['read-write'], connectionRole: 'read-write' },
  { suffix: 'ro', privileges: ['read-only'], connectionRole: 'read-only' },
]

/** App logins always get the names exactly as written. */
export const APP_LOGIN_NAME_SCHEME = 'plain'

const PREFIX_RE = /^[A-Za-z_]\w*$/
const LONGEST_SUFFIX = Math.max(...APP_LOGIN_KINDS.map((kind) => kind.suffix.length + 1))

export type AppLoginPrefixRefusal = {
  ok: false
  error: 'managed_app_login_prefix_invalid' | 'managed_app_login_prefix_too_long'
  message: string
  status: 400
}

/**
 * The prefix the three names start with: the request's `prefix`, or the
 * database name when it is left out or empty. Plain-words 400 when it is not
 * a name the engine takes or when the longest name would not fit.
 */
export function parseAppLoginPrefix(
  requested: unknown,
  databaseName: string,
  maxLength: number
): { ok: true; prefix: string } | AppLoginPrefixRefusal {
  if (requested !== undefined && requested !== null && typeof requested !== 'string') {
    return {
      ok: false,
      error: 'managed_app_login_prefix_invalid',
      message: 'prefix must be text, or left out to use the database name.',
      status: 400,
    }
  }
  const prefix = requested?.trim() || databaseName
  if (!PREFIX_RE.test(prefix)) {
    return {
      ok: false,
      error: 'managed_app_login_prefix_invalid',
      message:
        'The prefix must start with a letter or an underscore and use only letters, numbers and underscores.',
      status: 400,
    }
  }
  const longest = maxLength - LONGEST_SUFFIX
  if (prefix.length > longest) {
    return {
      ok: false,
      error: 'managed_app_login_prefix_too_long',
      message: `The prefix can be at most ${longest} characters, so that ${prefix.slice(0, longest)}_migrate still fits this engine's ${maxLength}-character limit for login names.`,
      status: 400,
    }
  }
  return { ok: true, prefix }
}

/** One create body per login, in the shape the single-login create takes. */
export function appLoginRequests(
  prefix: string,
  databaseName: string
): Array<{ kind: AppLoginKind; body: Record<string, unknown> }> {
  return APP_LOGIN_KINDS.map((kind) => ({
    kind,
    body: {
      username: `${prefix}_${kind.suffix}`,
      databases: [databaseName],
      privileges: [...kind.privileges],
      connectionRole: kind.connectionRole,
    },
  }))
}

/** Thrown inside the create transaction so none of the three logins is kept. */
export class AppLoginConflict extends Error {
  constructor(
    readonly error: string,
    readonly username: string
  ) {
    super(`${error}: ${username}`)
  }
}
