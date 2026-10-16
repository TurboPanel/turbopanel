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
 * not an admin grant). On Postgres it is a member of each database's owner
 * role, so every listed database must have one; it is never read-only.
 */
export function evaluateDatabaseAdminGrant(
  engine: string,
  grant: {
    privileges: readonly string[]
    databases: readonly string[]
    connectionRole: OwnerRoleConnectionRole
    ownerRoleDatabases?: readonly string[]
  }
): { status: 400 | 422; error: string; message: string } | null {
  if (!grant.privileges.includes(DATABASE_ADMIN_PRIVILEGE)) return null
  if (grant.connectionRole === 'read-only') {
    return {
      status: 400,
      error: 'managed_admin_login_not_read_only',
      message:
        'A Database admin login changes things, so it cannot be read-only. Use connectionRole read-write.',
    }
  }
  if (engine === 'postgres') {
    const withRole = new Set(grant.ownerRoleDatabases ?? [])
    const missing = grant.databases.filter((name) => !withRole.has(name))
    if (missing.length > 0) {
      return {
        status: 422,
        error: 'managed_admin_needs_owner_role',
        message: `A Database admin login works through a database's owner role, and these databases do not have one: ${missing.join(
          ', '
        )}. Databases made before owner roles existed keep their current owner; create a new database to use a Database admin login (the server's TurboPanel daemon must be up to date, or the new database is made without an owner role).`,
      }
    }
  }
  return null
}

/**
 * Whether a new database is made with an owner role. Postgres only: the
 * default there is yes, unless the name is too long to fit
 * `tp_<name>_owner` in 63 characters (then the database is made without one,
 * unless it was asked for explicitly, which answers 400).
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
      message: 'ownerRole must be true or false.',
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
  if (name.length > OWNER_ROLE_MAX_DATABASE_NAME) {
    if (requested === true) {
      return {
        ok: false,
        error: 'managed_owner_role_name_too_long',
        message: `A database with an owner role can have a name of at most ${OWNER_ROLE_MAX_DATABASE_NAME} characters.`,
        status: 400,
      }
    }
    return { ok: true, ownerRole: false }
  }
  if (!daemonHonoursOwnerRole) {
    // An older daemon would ignore the flag and leave an ordinary database
    // that the panel believes has an owner role.
    if (requested === true) return ownerRoleNeedsDaemonUpdate()
    return { ok: true, ownerRole: false }
  }
  return { ok: true, ownerRole: requested !== false }
}

export const OWNER_ROLE_NEEDS_DAEMON_ERROR = 'managed_owner_role_needs_daemon_update'

const OWNER_ROLE_NEEDS_DAEMON_MESSAGE =
  "This server's TurboPanel daemon is too old to give a database an owner role or to set up a Database admin login. Update the server, then try again."

function ownerRoleNeedsDaemonUpdate(): OwnerRoleValidationError {
  return {
    ok: false,
    error: OWNER_ROLE_NEEDS_DAEMON_ERROR,
    message: OWNER_ROLE_NEEDS_DAEMON_MESSAGE,
    status: 409,
  }
}

/**
 * The refusal for a Database admin login on a Postgres primary whose daemon
 * lacks the owner-role feature, or `null` when the grant is fine.
 */
export function refuseAdminGrantOnOldDaemon(
  engine: string,
  privileges: readonly string[],
  daemonHonoursOwnerRole: boolean
): OwnerRoleValidationError | null {
  if (engine !== 'postgres' || daemonHonoursOwnerRole) return null
  if (!privileges.includes(DATABASE_ADMIN_PRIVILEGE)) return null
  return ownerRoleNeedsDaemonUpdate()
}

export const READWRITE_NEEDS_DAEMON_ERROR = 'managed_readwrite_needs_daemon_update'

const READWRITE_NEEDS_DAEMON_MESSAGE =
  "This server's TurboPanel daemon is too old to give a read/write login data changes only: it would still be able to create, change and drop tables. Update the server, then try again, or use a read-only login."

/** What a login holds, for the read/write daemon rule: its levels, databases and how it is managed. */
export type ReadWriteGrantState = {
  privileges: readonly string[]
  databases?: readonly string[]
  /** `self` logins are never written by the panel. */
  grantMode: string
}

function panelWritesReadWrite(state: ReadWriteGrantState): boolean {
  return state.grantMode !== 'self' && state.privileges.includes('read-write')
}

/**
 * Whether `after` asks an older daemon for something new: the level on a login
 * that did not hold it as panel-set, or a database the login did not reach.
 */
function addsReadWriteReach(before: ReadWriteGrantState, after: ReadWriteGrantState): boolean {
  if (!panelWritesReadWrite(before)) return true
  const had = new Set(before.databases ?? [])
  return (after.databases ?? []).some((name) => !had.has(name))
}

/**
 * The refusal for giving a MySQL or MariaDB login the read/write level (new,
 * or newly panel-managed) on a primary whose daemon lacks
 * `managed-data-only-readwrite-v1`, or `null` when fine. An older daemon would
 * leave the login able to create, change and drop tables, so the panel refuses
 * rather than saving a level it cannot deliver. A login that already holds the
 * level is left alone (nothing new is asked of the daemon).
 */
export function refuseReadWriteOnOldDaemon(
  engine: string,
  after: ReadWriteGrantState,
  before: ReadWriteGrantState | null,
  daemonGivesDataOnlyReadWrite: boolean
): OwnerRoleValidationError | null {
  if (engine !== 'mysql' && engine !== 'mariadb') return null
  if (daemonGivesDataOnlyReadWrite || !panelWritesReadWrite(after)) return null
  if (before && !addsReadWriteReach(before, after)) return null
  return {
    ok: false,
    error: READWRITE_NEEDS_DAEMON_ERROR,
    message: READWRITE_NEEDS_DAEMON_MESSAGE,
    status: 409,
  }
}
