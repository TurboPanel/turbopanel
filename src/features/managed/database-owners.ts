/**
 * The owner a Postgres database was given by choice, and how it is shown.
 * MySQL and MariaDB have no database owner, so nothing here applies to them.
 */

import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { daemonOwnerSupport } from './login-limit-fields.ts'
import { findManagedLogin, loginGrantMode, type ManagedLoginCredentialRow } from './logins.ts'
import { storedConnectionRole, storedStrings } from './login-patch.ts'
import type { ManagedRowOptions } from './options.ts'
import {
  DATABASE_OWNER_NEEDS_DAEMON_ERROR,
  DATABASE_OWNER_NEEDS_DAEMON_MESSAGE,
  evaluateOwnerLogin,
  OWNER_ROLE_MAX_DATABASE_NAME,
} from './owner-role.ts'

/** Who owns a database that has an owner role. */
export type DatabaseOwnerView =
  { kind: 'role'; role: string } | { kind: 'login'; loginId: string; username: string }

/**
 * The owner of each database that has an owner role. A database made before
 * owner roles has no entry: its owner is whatever it was, not recorded here.
 */
export function describeDatabaseOwners(
  options: Pick<ManagedRowOptions, 'databases' | 'ownerRoleDatabases' | 'databaseOwners'>
): Record<string, DatabaseOwnerView> {
  const owners: Record<string, DatabaseOwnerView> = {}
  for (const name of options.ownerRoleDatabases ?? []) {
    if (!options.databases.includes(name)) continue
    const chosen = options.databaseOwners?.[name]
    owners[name] = chosen
      ? { kind: 'login', loginId: chosen.loginId, username: chosen.username }
      : { kind: 'role', role: `tp_${name}_owner` }
  }
  return owners
}

/**
 * The login a create request picked as the database's owner (`ownerLoginId`,
 * a login id or principal id), or `null` when it picked none. Answers with a
 * plain-words refusal when the pick cannot work.
 */
export async function resolveChosenOwnerLogin(
  c: Context,
  db: Db,
  engine: string,
  managedId: string,
  body: Record<string, unknown>,
  name: string,
  serverId: string
): Promise<Response | { login: ManagedLoginCredentialRow } | null> {
  const ref = body.ownerLoginId
  if (ref === undefined || ref === null) return null
  const refuse = (error: string, message: string, status: 400 | 409) =>
    c.json({ error, message }, status)
  if (typeof ref !== 'string' || ref.length === 0) {
    return refuse('Invalid request', 'ownerLoginId must be the id of a login.', 400)
  }
  if (engine !== 'postgres') {
    return refuse(
      'managed_owner_login_unsupported',
      'Only Postgres databases have an owner. On MySQL and MariaDB a login gets rights on a database, not ownership.',
      400
    )
  }
  if (name.length > OWNER_ROLE_MAX_DATABASE_NAME) {
    return refuse(
      'managed_owner_role_name_too_long',
      `A database with an owner can have a name of at most ${OWNER_ROLE_MAX_DATABASE_NAME} characters.`,
      400
    )
  }
  const found = await findManagedLogin(db, managedId, ref)
  if (!found) {
    return refuse(
      'managed_owner_login_invalid',
      'No login with that id on this database server.',
      400
    )
  }
  const invalid = evaluateOwnerLogin({
    role: found.role,
    privileges: storedStrings(found.metadata, 'privileges'),
    connectionRole: storedConnectionRole(found.metadata),
    grantMode: loginGrantMode(found.metadata),
  })
  if (invalid) return refuse(invalid.error, invalid.message ?? '', 400)
  if (!(await daemonOwnerSupport(db, serverId)).databaseOwner) {
    return refuse(DATABASE_OWNER_NEEDS_DAEMON_ERROR, DATABASE_OWNER_NEEDS_DAEMON_MESSAGE, 409)
  }
  return { login: found }
}
