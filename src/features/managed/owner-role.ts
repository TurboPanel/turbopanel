/**
 * Pure rules for the Postgres owner role per database and the Database admin
 * login. No imports from routes: login-patch and the route helpers both use it.
 */

export type OwnerRoleConnectionRole = 'read-write' | 'read-only'

export type OwnerRoleValidationError = {
  ok: false
  error: string
  message?: string
  status: 400 | 409 | 422
}

/** The privilege name of the Database admin login (a login for tools). */
export const DATABASE_ADMIN_PRIVILEGE = 'admin'

/**
 * Rules for the Database admin login, or `null` when the grant is fine (or is
 * not an admin grant). It is never read-only. Nothing about owner roles can
 * refuse it: on a database without an owner role it works the way the
 * daemon's fallback says (see `adminAccessNotes`), and the answer says so.
 */
export function evaluateDatabaseAdminGrant(
  _engine: string,
  grant: {
    privileges: readonly string[]
    connectionRole: OwnerRoleConnectionRole
  }
): { status: 400; error: string; message: string } | null {
  if (!grant.privileges.includes(DATABASE_ADMIN_PRIVILEGE)) return null
  if (grant.connectionRole === 'read-only') {
    return {
      status: 400,
      error: 'managed_admin_login_not_read_only',
      message:
        'A Database admin login changes things, so it cannot be read-only. Use connectionRole read-write.',
    }
  }
  return null
}

/** How much of the owner-role work the server's daemon can do. */
export type DaemonOwnerSupport = {
  /** Lists `managed-owner-role-v1`: owner roles and the Database admin login. */
  ownerRole: boolean
  /** Lists `managed-database-owner-v1`: chosen owners and the admin fallback. */
  databaseOwner: boolean
}

/**
 * Plain-words notes on what a Database admin login got, one line per thing
 * that is not the full admin rights. Empty when it got them (or the login is
 * not an admin login, or the engine is not Postgres). Never a refusal.
 */
export function adminAccessNotes(
  engine: string,
  grant: {
    privileges: readonly string[]
    databases: readonly string[]
    ownerRoleDatabases?: readonly string[]
  },
  daemon: DaemonOwnerSupport
): string[] {
  if (!grant.privileges.includes(DATABASE_ADMIN_PRIVILEGE)) return []
  if (engine !== 'postgres') {
    return daemon.ownerRole
      ? []
      : [
          "This server's TurboPanel daemon is older than the Database admin login, so the login was added with read and write access instead of all rights on its databases. Update the server and apply again to give it the full rights.",
        ]
  }
  if (!daemon.ownerRole) {
    return [
      "This server's TurboPanel daemon is older than owner roles, so the login was added with read and write access to the data instead of the full Database admin rights. Update the server and apply again to give it the full rights on databases that have an owner role.",
    ]
  }
  const withRole = new Set(grant.ownerRoleDatabases ?? [])
  const without = grant.databases.filter((name) => !withRole.has(name))
  if (without.length === 0) return []
  const access = daemon.databaseOwner
    ? 'read and write access to the data (no owner rights, and it cannot hand out access to others)'
    : "the right to connect only (this server's TurboPanel daemon is older; update it to give read and write access)"
  return [
    `These databases were made before owner roles, so they have no owner role for a Database admin login to work through: ${without.join(
      ', '
    )}. The login has ${access} there, and the full Database admin rights on every database that has an owner role. It is never the root login.`,
  ]
}

/**
 * Whether a new database is made with an owner role. Postgres only, and there
 * it is always yes: `ownerRole: false` is refused (`managed_owner_role_required`)
 * and so is a name too long to fit `tp_<name>_owner` in 63 characters
 * (`managed_owner_role_name_too_long`). The one exception is a daemon too old
 * to make owner roles: it keeps making databases without one (the safe
 * downgrade), and asking for `true` there answers 409.
 */
export const OWNER_ROLE_MAX_DATABASE_NAME = 54

export function resolveDatabaseOwnerRole(
  engine: string,
  name: string,
  requested: unknown,
  daemonHonoursOwnerRole = true
): { ok: true; ownerRole: boolean } | OwnerRoleValidationError {
  if (requested !== undefined && typeof requested !== 'boolean') {
    return {
      ok: false,
      error: 'Invalid request',
      message: 'ownerRole must be true, or left out.',
      status: 400,
    }
  }
  if (engine !== 'postgres') {
    if (requested === true) {
      return {
        ok: false,
        error: 'managed_owner_role_unsupported',
        message: 'Only Postgres databases can use an owner role.',
        status: 400,
      }
    }
    return { ok: true, ownerRole: false }
  }
  if (requested === false) {
    return {
      ok: false,
      error: 'managed_owner_role_required',
      message:
        'Every Postgres database is made with an owner role, so ownerRole: false is not allowed. Leave ownerRole out (or send true), and pick a login as the owner with ownerLoginId if you want one.',
      status: 400,
    }
  }
  if (name.length > OWNER_ROLE_MAX_DATABASE_NAME) {
    return {
      ok: false,
      error: 'managed_owner_role_name_too_long',
      message: `A Postgres database name can have at most ${OWNER_ROLE_MAX_DATABASE_NAME} characters, because every database gets an owner role named after it. Choose a shorter name.`,
      status: 400,
    }
  }
  if (!daemonHonoursOwnerRole) {
    // An older daemon would ignore the flag and leave an ordinary database
    // that the panel believes has an owner role.
    if (requested === true) return ownerRoleNeedsDaemonUpdate()
    return { ok: true, ownerRole: false }
  }
  return { ok: true, ownerRole: true }
}

export const OWNER_ROLE_NEEDS_DAEMON_ERROR = 'managed_owner_role_needs_daemon_update'

const OWNER_ROLE_NEEDS_DAEMON_MESSAGE =
  "This server's TurboPanel daemon is too old to give a database an owner role. Update the server, then try again."

function ownerRoleNeedsDaemonUpdate(): OwnerRoleValidationError {
  return {
    ok: false,
    error: OWNER_ROLE_NEEDS_DAEMON_ERROR,
    message: OWNER_ROLE_NEEDS_DAEMON_MESSAGE,
    status: 409,
  }
}

export const DATABASE_OWNER_NEEDS_DAEMON_ERROR = 'managed_database_owner_needs_daemon_update'

export const DATABASE_OWNER_NEEDS_DAEMON_MESSAGE =
  "This server's TurboPanel daemon is too old to give a database a login as its owner. Update the server, then try again, or leave the owner out to use the default owner role."

/**
 * Whether a login may own a Postgres database: a database login (not the root
 * or replication login) that writes, that is not the Database admin login and
 * that the panel manages. Returns the plain-words refusal, or `null`.
 */
export function evaluateOwnerLogin(login: {
  role: string
  privileges: readonly string[]
  connectionRole: OwnerRoleConnectionRole
  grantMode: string
}): OwnerRoleValidationError | null {
  const bad = (message: string): OwnerRoleValidationError => ({
    ok: false,
    error: 'managed_owner_login_invalid',
    message,
    status: 400,
  })
  if (login.role !== 'user') {
    return bad('Only a database login can own a database, not the root or replication login.')
  }
  if (login.privileges.includes(DATABASE_ADMIN_PRIVILEGE)) {
    return bad(
      'A Database admin login works through the owner role and cannot be the owner. Pick a migration or read/write login, or leave the owner out to use the default owner role.'
    )
  }
  if (
    login.connectionRole === 'read-only' ||
    !login.privileges.some((p) => p === 'owner' || p === 'read-write')
  ) {
    return bad(
      'The owner has to be a login that can change things: pick a migration or read/write login, or leave the owner out to use the default owner role.'
    )
  }
  if (login.grantMode === 'self') {
    return bad(
      'A login whose permissions you manage yourself cannot own a database. Pick another login, or leave the owner out to use the default owner role.'
    )
  }
  return null
}

/** The refusal for a request to change a database's owner after it was made. */
export const OWNER_CHANGE_NOT_AVAILABLE = {
  status: 409 as const,
  error: 'managed_database_owner_change_not_available',
  message:
    "Changing a database's owner after it was made is not available yet, because it has to move what the panel manages without touching anything you made yourself. Choose the owner when you create the database. To use a different owner now, create a new database and move your data across.",
}

/** The databases a login owns by choice (see `databaseOwners` in the options). */
export function databasesOwnedByLogin(
  owners: Readonly<Record<string, { loginId: string }>> | undefined,
  loginId: string
): string[] {
  return Object.entries(owners ?? {})
    .filter(([, owner]) => owner.loginId === loginId)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * A login that owns databases must stay a login that can own them. `null`
 * when the change keeps it so (or it owns nothing). Removing the login is a
 * separate path: the owner goes back to the default owner role.
 */
export function evaluateOwnedDatabasesKept(
  owned: readonly string[],
  after: {
    databases: readonly string[]
    privileges: readonly string[]
    connectionRole: OwnerRoleConnectionRole
    grantMode: string
  }
): { status: 409; error: string; message: string } | null {
  if (owned.length === 0) return null
  const stillListed = owned.every((name) => after.databases.includes(name))
  const stillOwner =
    evaluateOwnerLogin({
      role: 'user',
      privileges: after.privileges,
      connectionRole: after.connectionRole,
      grantMode: after.grantMode,
    }) === null
  if (stillListed && stillOwner) return null
  return {
    status: 409,
    error: 'managed_login_owns_databases',
    message: `This login owns ${owned.join(
      ', '
    )}. It has to stay listed on them and stay a migration or read/write login that the panel manages (not read-only, not a Database admin login), because changing a database's owner after it was made is not available yet.`,
  }
}
