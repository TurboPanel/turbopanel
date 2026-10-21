/**
 * The owner a Postgres database was given by choice, and how it is shown.
 * MySQL and MariaDB have no database owner, so nothing here applies to them.
 */

import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { daemonOwnerSupport } from './login-limit-fields.ts'
import {
  applySettingsPatch,
  findManagedLogin,
  type LoginSettings,
  type LoginSettingsPatch,
  patchLogin,
  type ManagedLoginCredentialRow,
} from './logins.ts'
import type { ManagedRowOptions } from './options.ts'
import {
  adminAccessNotes,
  type DaemonOwnerSupport,
  DATABASE_OWNER_NEEDS_DAEMON_ERROR,
  databasesOwnedByLogin,
  evaluateOwnedDatabasesKept,
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
    privileges: found.privileges,
    connectionRole: found.connectionRole,
    grantMode: found.grantMode,
  })
  if (invalid) return refuse(invalid.error, invalid.message ?? '', 400)
  if (!/^[A-Za-z_]\w{0,62}$/.test(found.appliedUsername)) {
    return refuse(
      'managed_owner_login_invalid',
      "This login's name has characters a database owner cannot have. Pick another login, or leave the owner out to use the default owner role.",
      400
    )
  }
  if (!(await daemonOwnerSupport(db, serverId)).databaseOwner) {
    return refuse(DATABASE_OWNER_NEEDS_DAEMON_ERROR, DATABASE_OWNER_NEEDS_DAEMON_MESSAGE, 409)
  }
  return { login: found }
}

/** A login's database list with `name` added (once). */
export function withDatabaseListed(
  login: Pick<LoginSettings, 'databases'>,
  name: string
): string[] {
  return [...new Set([...login.databases, name])]
}

/** A login's database list without `name`. */
export function withoutDatabaseListed(
  login: Pick<LoginSettings, 'databases'>,
  name: string
): string[] {
  return login.databases.filter((entry) => entry !== name)
}

/** `databaseOwners` without the entries of one login. */
export function ownersWithoutLogin(
  owners: ManagedRowOptions['databaseOwners'],
  loginId: string
): NonNullable<ManagedRowOptions['databaseOwners']> {
  return Object.fromEntries(Object.entries(owners ?? {}).filter(([, o]) => o.loginId !== loginId))
}

/** `databaseOwners` without one database. */
export function ownersWithoutDatabase(
  owners: ManagedRowOptions['databaseOwners'],
  database: string
): NonNullable<ManagedRowOptions['databaseOwners']> {
  return Object.fromEntries(Object.entries(owners ?? {}).filter(([name]) => name !== database))
}

/**
 * Whether a login PATCH keeps a login able to own the databases it owns:
 * the refusal, or `null`. `after` is the login's settings with the change
 * applied.
 */
export function ownedDatabasesRefusal(
  options: Pick<ManagedRowOptions, 'databaseOwners'>,
  loginId: string,
  after: Pick<LoginSettings, 'databases' | 'privileges' | 'connectionRole'>,
  grantMode: string
): { status: 409; error: string; message: string } | null {
  return evaluateOwnedDatabasesKept(databasesOwnedByLogin(options.databaseOwners, loginId), {
    databases: after.databases,
    privileges: after.privileges,
    connectionRole: after.connectionRole,
    grantMode,
  })
}

/**
 * List a login on a database for the length of one request: `restore` puts
 * the previous list back (call it on any failure, including a thrown error).
 */
export async function listLoginOnDatabase(
  db: Db,
  login: { id: string; databases: string[] } | undefined,
  name: string
): Promise<{ restore: () => Promise<void> }> {
  if (!login) return { restore: () => Promise.resolve() }
  const before = login.databases
  await patchLogin(db, login.id, { databases: withDatabaseListed(login, name) })
  return { restore: () => patchLogin(db, login.id, { databases: before }) }
}

/** The opposite: take a login off a database, with a `restore`. */
export async function unlistLoginFromDatabase(
  db: Db,
  login: { id: string; databases: string[] },
  name: string
): Promise<{ restore: () => Promise<void> }> {
  const before = login.databases
  await patchLogin(db, login.id, { databases: withoutDatabaseListed(login, name) })
  return { restore: () => patchLogin(db, login.id, { databases: before }) }
}

/**
 * Run `fn`; when it answers a Response (a refusal) or throws, run `restore`
 * first, so a half-made change never stays behind.
 */
export async function restoringOnFailure<T>(
  restore: () => Promise<void>,
  fn: () => Promise<T>
): Promise<T> {
  let result: T
  try {
    result = await fn()
  } catch (error) {
    await restore()
    throw error
  }
  if (result instanceof Response) await restore()
  return result
}

/** The `notes` field for a login delete that handed databases back to their owner role. */
export function handedBackNotes(databases: readonly string[]): { notes?: string[] } {
  if (databases.length === 0) return {}
  return {
    notes: [
      `The login owned ${databases.join(', ')}. Each of those databases goes back to its default owner role as the apply runs.`,
    ],
  }
}

/** Refuse a create that names a login owner but declines the owner role. */
export function ownerChoiceConflict(
  chosen: unknown,
  ownerRole: boolean
): { error: string; message: string } | null {
  if (!chosen || ownerRole) return null
  return {
    error: 'Invalid request',
    message:
      'A database with a login as its owner has an owner role: leave ownerRole out or set it to true.',
  }
}

/** `databaseOwners` after a create that may have picked an owner login. */
export function ownersAfterCreate(
  owners: ManagedRowOptions['databaseOwners'],
  name: string,
  chosen: { login: { id: string; appliedUsername: string } } | null
): ManagedRowOptions['databaseOwners'] {
  if (!chosen) return owners
  return { ...owners, [name]: { loginId: chosen.login.id, username: chosen.login.appliedUsername } }
}

/**
 * What a login PATCH must check around owner state: the refusal when it
 * would stop the login owning its databases, and the notes on what a
 * Database admin login gets.
 */
export function loginPatchOwnerChecks(
  engine: string,
  options: Pick<ManagedRowOptions, 'databaseOwners' | 'ownerRoleDatabases'>,
  target: LoginSettings & { id: string },
  plan: { patch: LoginSettingsPatch; grantMode: string },
  support: DaemonOwnerSupport
): { refusal: ReturnType<typeof ownedDatabasesRefusal>; notes: string[] } {
  const after = applySettingsPatch(target, plan.patch)
  return {
    refusal: ownedDatabasesRefusal(options, target.id, after, plan.grantMode),
    notes: adminAccessNotes(
      engine,
      {
        privileges: after.privileges,
        databases: after.databases,
        ownerRoleDatabases: options.ownerRoleDatabases,
      },
      support
    ),
  }
}

/** The `notes` field of an answer, left out when there is nothing to say. */
export function notesField(notes: readonly string[]): { notes?: string[] } {
  return notes.length > 0 ? { notes: [...notes] } : {}
}
