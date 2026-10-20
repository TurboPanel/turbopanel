/**
 * Database logins: the `login` table, one engine role on one managed cluster.
 *
 * A login is not a principal. A principal is only a site owner's Linux user;
 * a login optionally shares that user's name (`principalId`). The permission
 * settings are real columns and the databases a login may use are `scope`
 * rows pointing at `database` rows.
 */

import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { nameListSql } from './sql-name-list.ts'
import type { Db } from '../../db/connection.ts'
import { login, managed, managedDatabase, replica, scope, server } from '../../db/schema.ts'
import { generateSealedSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { PrincipalNameScheme } from '../../lib/principal-name-scheme.ts'

/** Pinned to `login_role_check` by `src/db/enum-checks.test.ts`. */
export const DATABASE_LOGIN_ROLES = ['root', 'replication', 'user'] as const
export type DatabaseLoginRole = (typeof DATABASE_LOGIN_ROLES)[number]

/**
 * How reconcile treats a login's permissions. `preset` is today's behaviour
 * and is what a login made before modes reads as. `recipe` is the panel-built
 * permission set (new logins start here). `self` means the owner manages
 * permissions by hand and reconcile never resets them. Pinned to
 * `login_grant_mode_check` by `src/db/enum-checks.test.ts`.
 */
export const LOGIN_GRANT_MODES = ['preset', 'recipe', 'self'] as const
export type LoginGrantMode = (typeof LOGIN_GRANT_MODES)[number]

/** Pinned to `login_access_check` by `src/db/enum-checks.test.ts`. */
export const LOGIN_CONNECTION_ROLES = ['read-write', 'read-only'] as const
export type LoginConnectionRole = (typeof LOGIN_CONNECTION_ROLES)[number]

export function isLoginGrantMode(value: unknown): value is LoginGrantMode {
  return typeof value === 'string' && (LOGIN_GRANT_MODES as readonly string[]).includes(value)
}

/** What a login may do and where it may connect from: the permission columns, API-named. */
export type LoginSettings = {
  grantMode: LoginGrantMode
  /** A database-tool login routes everything to the primary (no read/write split). */
  tool: boolean
  /** Names of the databases the login may use (its `scope` rows). */
  databases: string[]
  privileges: string[]
  connectionRole: LoginConnectionRole
  /** Places the login may connect from; `undefined` means anywhere. */
  allowedSources: string[] | undefined
  /** Per-login connection cap; `undefined` means no cap. */
  maxConnections: number | undefined
}

/** A change to {@link LoginSettings}; `null` clears `allowedSources` / `maxConnections`. */
export type LoginSettingsPatch = {
  grantMode?: LoginGrantMode
  tool?: boolean
  databases?: string[]
  privileges?: string[]
  connectionRole?: LoginConnectionRole
  allowedSources?: string[] | null
  maxConnections?: number | null
}

export type ManagedLoginRow = LoginSettings & {
  /** The login row id; the users routes address a login by it. */
  id: string
  /** Site owner's Linux user the login shares its name with; `null` otherwise. */
  principalId: string | null
  managedId: string
  role: DatabaseLoginRole
  /** The name the customer typed (the applied name for a cluster login). */
  username: string
  appliedUsername: string
  nameScheme: PrincipalNameScheme
  createdAt: string
  updatedAt: string
}

export type ManagedLoginCredentialRow = ManagedLoginRow & {
  password: string | null
}

/** SQL for the names of the databases a login may use, for a select over `login`. */
export const loginDatabaseNames = nameListSql(
  sql`ARRAY(SELECT d."name" FROM ${scope} s JOIN ${managedDatabase} d ON d."id" = s."database_id" WHERE s."login_id" = "login"."id" ORDER BY s."id")`
)

const LOGIN_SELECT = {
  id: login.id,
  principalId: login.principalId,
  managedId: login.managedId,
  role: login.role,
  username: login.username,
  appliedUsername: login.appliedUsername,
  nameScheme: login.nameScheme,
  grantMode: login.grantMode,
  isTool: login.isTool,
  databases: loginDatabaseNames,
  privileges: login.privileges,
  access: login.access,
  allowedSources: login.allowedSources,
  maxConnections: login.maxConnections,
  createdAt: login.createdAt,
  updatedAt: login.updatedAt,
  password: login.password,
}

function toRole(value: string): DatabaseLoginRole {
  return (DATABASE_LOGIN_ROLES as readonly string[]).includes(value)
    ? (value as DatabaseLoginRole)
    : 'user'
}

function toNameScheme(value: string): PrincipalNameScheme {
  return value === 'partial' || value === 'random' ? value : 'plain'
}

/** The permission settings of a stored row (`allowed_sources` empty reads as anywhere). */
function toLoginRow(row: {
  id: string
  principalId: string | null
  managedId: string
  role: string
  username: string
  appliedUsername: string
  nameScheme: string
  grantMode: string
  isTool: boolean
  databases: string[]
  privileges: string[]
  access: string
  allowedSources: string[] | null
  maxConnections: number | null
  createdAt: string
  updatedAt: string
  password: string | null
}): ManagedLoginCredentialRow {
  return {
    id: row.id,
    principalId: row.principalId,
    managedId: row.managedId,
    role: toRole(row.role),
    username: row.username,
    appliedUsername: row.appliedUsername,
    nameScheme: toNameScheme(row.nameScheme),
    grantMode: isLoginGrantMode(row.grantMode) ? row.grantMode : 'preset',
    tool: row.isTool,
    databases: row.databases ?? [],
    privileges: row.privileges ?? [],
    connectionRole: row.access === 'read-only' ? 'read-only' : 'read-write',
    allowedSources:
      row.allowedSources && row.allowedSources.length > 0 ? row.allowedSources : undefined,
    maxConnections: row.maxConnections ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    password: row.password,
  }
}

async function selectLogins(
  db: Db,
  where: ReturnType<typeof and>
): Promise<ManagedLoginCredentialRow[]> {
  const rows = await db
    .select(LOGIN_SELECT)
    .from(login)
    .where(where)
    .orderBy(asc(sql`lower(${login.username})`), asc(login.id))
  return rows.map(toLoginRow)
}

/** Every login of a cluster, passwords included — for credential delivery only. */
export async function listManagedLoginCredentials(
  db: Db,
  managedId: string
): Promise<ManagedLoginCredentialRow[]> {
  return selectLogins(db, eq(login.managedId, managedId))
}

/** Every login of a cluster, never the password. */
export async function listManagedLogins(db: Db, managedId: string): Promise<ManagedLoginRow[]> {
  return (await listManagedLoginCredentials(db, managedId)).map(withoutPassword)
}

/**
 * One login of a cluster by its own id. Compared as text so a value that is
 * not a uuid is simply not found instead of a cast error.
 */
export async function findManagedLogin(
  db: Db,
  managedId: string,
  loginId: string
): Promise<ManagedLoginCredentialRow | undefined> {
  const rows = await selectLogins(
    db,
    and(eq(login.managedId, managedId), sql`${login.id}::text = ${loginId}`)
  )
  return rows.find((row) => row.id === loginId)
}

/** The cluster's login with a given role (root and replication exist at most once). */
export async function findManagedLoginByRole(
  db: Db,
  managedId: string,
  role: DatabaseLoginRole
): Promise<ManagedLoginCredentialRow | undefined> {
  const rows = await selectLogins(db, and(eq(login.managedId, managedId), eq(login.role, role)))
  return rows.find((row) => row.role === role)
}

export function withoutPassword(row: ManagedLoginCredentialRow): ManagedLoginRow {
  const { password: _password, ...rest } = row
  return rest
}

/** Point a login's `scope` rows at exactly these databases of its cluster (the order given is kept for new rows). */
export async function setLoginDatabases(
  db: Db,
  target: { id: string; managedId: string },
  names: readonly string[]
): Promise<void> {
  const wanted = [...new Set(names)]
  const found =
    wanted.length === 0
      ? []
      : await db
          .select({ id: managedDatabase.id, name: managedDatabase.name })
          .from(managedDatabase)
          .where(
            and(
              eq(managedDatabase.managedId, target.managedId),
              inArray(
                sql`lower(${managedDatabase.name})`,
                wanted.map((name) => name.toLowerCase())
              )
            )
          )
  const idByName = new Map(found.map((row) => [row.name.toLowerCase(), row.id]))
  const missing = wanted.filter((name) => !idByName.has(name.toLowerCase()))
  if (missing.length > 0) {
    throw new TypeError(`Database not found on this cluster: ${missing.join(', ')}`)
  }
  const wantedIds = wanted.map((name) => idByName.get(name.toLowerCase())!)
  const current = await db
    .select({ databaseId: scope.databaseId })
    .from(scope)
    .where(eq(scope.loginId, target.id))
  const currentIds = new Set(current.map((row) => row.databaseId))
  const stale = [...currentIds].filter((id) => !wantedIds.includes(id))
  if (stale.length > 0) {
    await db
      .delete(scope)
      .where(and(eq(scope.loginId, target.id), inArray(scope.databaseId, stale)))
  }
  const added = wantedIds.filter((id) => !currentIds.has(id))
  if (added.length > 0) {
    await db.insert(scope).values(added.map((databaseId) => ({ loginId: target.id, databaseId })))
  }
}

/** A login's settings after a patch (what the row will read as). */
export function applySettingsPatch(
  settings: LoginSettings,
  patch: LoginSettingsPatch
): LoginSettings {
  return {
    grantMode: patch.grantMode ?? settings.grantMode,
    tool: patch.tool ?? settings.tool,
    databases: patch.databases ?? settings.databases,
    privileges: patch.privileges ?? settings.privileges,
    connectionRole: patch.connectionRole ?? settings.connectionRole,
    allowedSources:
      patch.allowedSources === undefined
        ? settings.allowedSources
        : (patch.allowedSources ?? undefined),
    maxConnections:
      patch.maxConnections === undefined
        ? settings.maxConnections
        : (patch.maxConnections ?? undefined),
  }
}

function settingsColumns(patch: LoginSettingsPatch) {
  return {
    ...(patch.grantMode !== undefined ? { grantMode: patch.grantMode } : {}),
    ...(patch.tool !== undefined ? { isTool: patch.tool } : {}),
    ...(patch.privileges !== undefined ? { privileges: patch.privileges } : {}),
    ...(patch.connectionRole !== undefined ? { access: patch.connectionRole } : {}),
    ...(patch.allowedSources !== undefined ? { allowedSources: patch.allowedSources } : {}),
    ...(patch.maxConnections !== undefined ? { maxConnections: patch.maxConnections } : {}),
  }
}

/** Change a login's permission settings (keys not in `patch` are kept). */
export async function patchLogin(
  db: Db,
  loginId: string,
  patch: LoginSettingsPatch
): Promise<void> {
  const [row] = await db
    .select({ id: login.id, managedId: login.managedId })
    .from(login)
    .where(eq(login.id, loginId))
    .limit(1)
  if (!row) throw new TypeError('Login not found')
  await db
    .update(login)
    .set({ ...settingsColumns(patch), updatedAt: new Date().toISOString() })
    .where(eq(login.id, loginId))
  if (patch.databases !== undefined) await setLoginDatabases(db, row, patch.databases)
}

export type InsertLoginInput = LoginSettingsPatch & {
  managedId: string
  principalId: string | null
  role: DatabaseLoginRole
  /** Name the customer typed; defaults to the applied name. */
  username?: string
  appliedUsername: string
  /** Sealed `tpsecret` envelope. */
  password: string | null
  nameScheme?: PrincipalNameScheme
}

/** Insert one login row (and its `scope` rows); the caller owns the principal side. */
export async function insertLogin(db: Db, input: InsertLoginInput): Promise<string> {
  const [inserted] = await db
    .insert(login)
    .values({
      managedId: input.managedId,
      principalId: input.principalId,
      role: input.role,
      username: input.username ?? input.appliedUsername,
      appliedUsername: input.appliedUsername,
      password: input.password,
      ...(input.nameScheme ? { nameScheme: input.nameScheme } : {}),
      ...settingsColumns(input),
    })
    .returning({ id: login.id })
  if (input.databases !== undefined && input.databases.length > 0) {
    await setLoginDatabases(db, { id: inserted.id, managedId: input.managedId }, input.databases)
  }
  return inserted.id
}

const LOGIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Insert a login with a freshly generated sealed password (a `user` login by
 * default; the cluster's own root and replication logins pass their `role`).
 * Returns the show-once plaintext; no later code path returns a stored
 * password. `principalId` is set only for a login that shares a site owner's
 * Linux user name.
 */
export async function createManagedLogin(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: LoginSettingsPatch & {
    managedId: string
    role?: DatabaseLoginRole
    /** The name the customer typed. */
    username: string
    /** Applied engine login (short name + optional random suffix); defaults to `username`. */
    appliedUsername?: string
    principalId?: string | null
    nameScheme?: PrincipalNameScheme
    /**
     * Override the generated password length. Replication logins use
     * `REPLICATION_PASSWORD_LENGTH`: MySQL caps `SOURCE_PASSWORD` in
     * `CHANGE REPLICATION SOURCE` at 32 chars (error 3056).
     */
    passwordLength?: number
  }
): Promise<{ loginId: string; password: string }> {
  if (!LOGIN_NAME_RE.test(input.username)) throw new TypeError('invalid username')
  const appliedUsername = input.appliedUsername ?? input.username
  if (!LOGIN_NAME_RE.test(appliedUsername)) throw new TypeError('invalid applied username')
  const { plaintext, sealed } = await generateSealedSecret(
    dataEncryptionSecrets,
    input.passwordLength !== undefined ? { length: input.passwordLength } : undefined
  )
  const { role, passwordLength: _length, principalId, ...rest } = input
  const loginId = await insertLogin(db, {
    ...rest,
    managedId: input.managedId,
    principalId: principalId ?? null,
    role: role ?? 'user',
    appliedUsername,
    password: sealed,
  })
  return { loginId, password: plaintext }
}

/**
 * A `user` login that shares a site owner's Linux user name: the engine role
 * takes the principal's applied name (the one allowed overlap in the
 * organization's name pool) and a fresh sealed password. Returns the
 * show-once plaintext.
 */
export async function createLoginForPrincipal(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: LoginSettingsPatch & {
    managedId: string
    principalId: string
    appliedUsername: string
    username?: string
    nameScheme?: PrincipalNameScheme
  }
): Promise<{ loginId: string; password: string }> {
  const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets)
  const { principalId, ...rest } = input
  const loginId = await insertLogin(db, {
    ...rest,
    principalId,
    role: 'user',
    password: sealed,
  })
  return { loginId, password: plaintext }
}

/** Store a sealed password on the login. */
export async function setLoginPassword(db: Db, loginId: string, sealed: string): Promise<void> {
  const [row] = await db
    .update(login)
    .set({ password: sealed, updatedAt: new Date().toISOString() })
    .where(eq(login.id, loginId))
    .returning({ id: login.id })
  if (!row) throw new TypeError('Login not found')
}

/** Rotate a login password; returns the show-once plaintext and the sealed value it replaced. */
export async function rotateLoginPassword(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  loginId: string
): Promise<{ plaintext: string; previousPassword: string | null }> {
  const [previous] = await db
    .select({ password: login.password })
    .from(login)
    .where(eq(login.id, loginId))
    .limit(1)
  if (!previous) throw new TypeError('Login not found')
  const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets)
  await setLoginPassword(db, loginId, sealed)
  return { plaintext, previousPassword: previous.password }
}

type LoginRecord = typeof login.$inferSelect

export type RemovedLogin = {
  login: LoginRecord
  /** The `scope` rows the login had, so a failed enqueue can put them back. */
  databaseIds: string[]
  /** Databases the login owned by choice (their owner is cleared with the login). */
  ownedDatabaseIds: string[]
}

/** Delete a login row; its scope rows and bindings go with it. */
export async function removeManagedLogin(db: Db, loginId: string): Promise<RemovedLogin | null> {
  const [row] = await db.select().from(login).where(eq(login.id, loginId)).limit(1)
  if (!row) return null
  const scopes = await db
    .select({ databaseId: scope.databaseId })
    .from(scope)
    .where(eq(scope.loginId, loginId))
    .orderBy(asc(scope.id))
  const owned = await db
    .select({ id: managedDatabase.id })
    .from(managedDatabase)
    .where(eq(managedDatabase.ownerLoginId, loginId))
  await db.delete(login).where(eq(login.id, loginId))
  return {
    login: row,
    databaseIds: scopes.map((entry) => entry.databaseId),
    ownedDatabaseIds: owned.map((entry) => entry.id),
  }
}

/** Put back what {@link removeManagedLogin} deleted, same ids, after a failed enqueue. */
export async function restoreManagedLogin(db: Db, removed: RemovedLogin): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(login).values(removed.login)
    if (removed.databaseIds.length > 0) {
      await tx
        .insert(scope)
        .values(
          removed.databaseIds.map((databaseId) => ({ loginId: removed.login.id, databaseId }))
        )
    }
    if (removed.ownedDatabaseIds.length > 0) {
      await tx
        .update(managedDatabase)
        .set({ ownerLoginId: removed.login.id })
        .where(inArray(managedDatabase.id, removed.ownedDatabaseIds))
    }
  })
}

/**
 * True when a login on any cluster whose member servers belong to one of the
 * owning organizations already uses this engine role name (trimmed,
 * case-insensitive): those clusters share a ProxySQL frontend, where names
 * are one namespace. The login-table twin of `isManagedUsernameTaken`,
 * needed for logins that belong to a principal of another form (no legacy
 * `principal` row carries their name). `excludeManagedId` leaves one
 * cluster's own logins out; `excludePrincipalId` leaves one principal's own
 * logins out (its name is the allowed overlap).
 */
export async function isManagedLoginNameTaken(
  db: Db,
  owningOrganizationIds: readonly string[],
  name: string,
  excludeManagedId?: string,
  excludePrincipalId?: string
): Promise<boolean> {
  const key = name.trim().toLowerCase()
  if (!key || owningOrganizationIds.length === 0) return false
  const conditions = [
    inArray(server.organizationId, [...owningOrganizationIds]),
    sql`lower(btrim(${login.appliedUsername})) = ${key}`,
  ]
  if (excludeManagedId) conditions.push(ne(login.managedId, excludeManagedId))
  if (excludePrincipalId) {
    conditions.push(sql`${login.principalId} IS DISTINCT FROM ${excludePrincipalId}::uuid`)
  }
  const rows = await db
    .select({ id: login.id })
    .from(login)
    .innerJoin(replica, eq(login.managedId, replica.managedId))
    .innerJoin(server, eq(replica.serverId, server.id))
    .where(and(...conditions))
    .limit(1)
  return rows.length > 0
}

/**
 * Engines whose logins share one ProxySQL frontend listener: MySQL and MariaDB
 * speak one protocol family and share a listener, Postgres has its own.
 * Redis and ClickHouse never reach the frontend (no family).
 */
export function managedProtocolFamilyEngines(engine: string): readonly string[] {
  if (engine === 'mysql' || engine === 'mariadb') return ['mysql', 'mariadb']
  if (engine === 'postgres') return ['postgres']
  return []
}

/**
 * True when another cluster of the same protocol family that shares a server
 * with `managedId` already has a login with this name (even the same
 * principal's): ProxySQL keeps one user table per family per server, so such a
 * pair would fail every ingress reconcile. A cluster of another family is not
 * a clash (separate user tables). Same-cluster names are checked elsewhere.
 */
export async function isManagedLoginNameTakenInFamily(
  db: Db,
  managedId: string,
  engine: string,
  name: string
): Promise<boolean> {
  const key = name.trim().toLowerCase()
  const engines = managedProtocolFamilyEngines(engine)
  if (!key || engines.length === 0) return false
  const mine = db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(eq(replica.managedId, managedId))
  const rows = await db
    .select({ id: login.id })
    .from(login)
    .innerJoin(managed, eq(login.managedId, managed.id))
    .innerJoin(replica, eq(login.managedId, replica.managedId))
    .where(
      and(
        ne(login.managedId, managedId),
        inArray(managed.engine, [...engines]),
        inArray(replica.serverId, mine),
        sql`lower(btrim(${login.appliedUsername})) = ${key}`
      )
    )
    .limit(1)
  return rows.length > 0
}
