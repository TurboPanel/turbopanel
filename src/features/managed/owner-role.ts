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
        )}. Databases made before owner roles existed keep their current owner; create a new database to use a Database admin login.`,
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
  requested: unknown
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
  return { ok: true, ownerRole: requested !== false }
}
