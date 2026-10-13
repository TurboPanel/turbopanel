/**
 * Database logins: the `login` table, one engine role on one managed cluster.
 *
 * Expand step of the login split (migration `0030_login_table`). Every
 * cluster login lives here; the legacy `principal` rows with
 * `kind = 'database'` stay and are written in step (same password, same
 * applied name) until a later contract migration retires them. Readers use
 * this table; {@link syncLegacyLogins} re-runs the migration's backfill for
 * one cluster so a row written by the previous release during a deploy
 * window (a principal without a login, a binding without `login_id`) is
 * picked up instead of lost.
 */

import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { binding, login, principal, replica, server } from '../../db/schema.ts'
import { generateSealedSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { PrincipalNameScheme } from '../../lib/principal-name-scheme.ts'

/** Pinned to `login_role_check` by `src/db/enum-checks.test.ts`. */
export const DATABASE_LOGIN_ROLES = ['root', 'replication', 'user'] as const
export type DatabaseLoginRole = (typeof DATABASE_LOGIN_ROLES)[number]

export type ManagedLoginRow = {
  /** The login row id. */
  id: string
  /** Identity the login belongs to; `null` for the cluster's root and replication logins. */
  principalId: string | null
  managedId: string
  role: DatabaseLoginRole
  /** Display name: the principal's typed name, or the applied name for a cluster login. */
  username: string
  appliedUsername: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export type ManagedLoginCredentialRow = ManagedLoginRow & { password: string | null }

const LOGIN_SELECT = {
  id: login.id,
  principalId: login.principalId,
  managedId: login.managedId,
  role: login.role,
  username: sql<string>`coalesce(${principal.username}, ${login.appliedUsername})`,
  appliedUsername: login.appliedUsername,
  metadata: login.metadata,
  options: login.options,
  createdAt: login.createdAt,
  updatedAt: login.updatedAt,
  password: login.password,
}

/** Role a legacy principal row's metadata implies. */
export function loginRoleFromMetadata(metadata: unknown): DatabaseLoginRole {
  if (!isRecord(metadata)) return 'user'
  if (metadata.managedRoot === true) return 'root'
  if (metadata.managedReplication === true) return 'replication'
  return 'user'
}

/** Old `principal` row a root or replication login is kept in step with. */
export function legacyPrincipalIdOf(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null
  const id = metadata.legacyPrincipalId
  return typeof id === 'string' && id.length > 0 ? id : null
}

function toRole(value: string): DatabaseLoginRole {
  return (DATABASE_LOGIN_ROLES as readonly string[]).includes(value)
    ? (value as DatabaseLoginRole)
    : 'user'
}

/**
 * The migration backfill, scoped to one cluster and idempotent: a login for
 * every `kind = 'database'` principal of the cluster that has none yet, then
 * `binding.login_id` for the cluster's bindings that still lack it. Cheap
 * when there is nothing to do (one indexed anti-join each).
 */
export async function syncLegacyLogins(db: Db, managedId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${login} ("created_at", "updated_at", "metadata", "options", "managed_id", "principal_id", "role", "applied_username", "password")
    SELECT
      p."created_at",
      p."updated_at",
      CASE WHEN c.cluster_login THEN COALESCE(p."metadata", '{}'::jsonb) || jsonb_build_object('legacyPrincipalId', p."id") ELSE p."metadata" END,
      p."options",
      p."managed_id",
      CASE WHEN c.cluster_login THEN NULL ELSE p."id" END,
      CASE
        WHEN COALESCE(p."metadata", '{}'::jsonb) ->> 'managedRoot' = 'true' THEN 'root'
        WHEN COALESCE(p."metadata", '{}'::jsonb) ->> 'managedReplication' = 'true' THEN 'replication'
        ELSE 'user'
      END,
      p."applied_username",
      p."password"
    FROM ${principal} p
    CROSS JOIN LATERAL (
      SELECT (COALESCE(p."metadata", '{}'::jsonb) ->> 'managedRoot' = 'true'
        OR COALESCE(p."metadata", '{}'::jsonb) ->> 'managedReplication' = 'true') AS cluster_login
    ) c
    WHERE p."managed_id" = ${managedId}
      AND p."kind" = 'database'
      AND NOT EXISTS (
        SELECT 1 FROM ${login} l
        WHERE l."principal_id" = p."id"
          OR (l."managed_id" = p."managed_id" AND l."metadata" ->> 'legacyPrincipalId' = p."id"::text)
      )
    ORDER BY p."created_at", p."id"
    ON CONFLICT DO NOTHING
  `)
  await db.execute(sql`
    UPDATE ${binding} b
    SET "login_id" = l."id"
    FROM ${login} l, ${principal} p
    WHERE p."id" = b."principal_id"
      AND l."managed_id" = ${managedId}
      AND b."login_id" IS NULL
      AND (
        (l."principal_id" = p."id" AND l."managed_id" = p."managed_id")
        OR (l."principal_id" IS NULL AND l."metadata" ->> 'legacyPrincipalId' = p."id"::text)
      )
  `)
}

async function selectLogins(
  db: Db,
  where: ReturnType<typeof and>
): Promise<ManagedLoginCredentialRow[]> {
  const rows = await db
    .select(LOGIN_SELECT)
    .from(login)
    .leftJoin(principal, eq(principal.id, login.principalId))
    .where(where)
    .orderBy(asc(sql`coalesce(${principal.username}, ${login.appliedUsername})`), asc(login.id))
  return rows.map((row) => ({ ...row, role: toRole(row.role) }))
}

/** Every login of a cluster, passwords included — for credential delivery only. */
export async function listManagedLoginCredentials(
  db: Db,
  managedId: string
): Promise<ManagedLoginCredentialRow[]> {
  await syncLegacyLogins(db, managedId)
  return selectLogins(db, eq(login.managedId, managedId))
}

/** Every login of a cluster, never the password. */
export async function listManagedLogins(db: Db, managedId: string): Promise<ManagedLoginRow[]> {
  return (await listManagedLoginCredentials(db, managedId)).map(withoutPassword)
}

/**
 * One login of a cluster by its own id, by its principal's id (the API keeps
 * naming a user by its principal) or by the legacy principal id of a root or
 * replication login. Compared as text so a value that is not a uuid is simply
 * not found instead of a cast error.
 */
export async function findManagedLogin(
  db: Db,
  managedId: string,
  ref: string
): Promise<ManagedLoginCredentialRow | undefined> {
  await syncLegacyLogins(db, managedId)
  const rows = await selectLogins(
    db,
    and(
      eq(login.managedId, managedId),
      or(
        sql`${login.id}::text = ${ref}`,
        sql`${login.principalId}::text = ${ref}`,
        sql`${login.metadata} ->> 'legacyPrincipalId' = ${ref}`
      )
    )
  )
  return rows.find(
    (row) => row.id === ref || row.principalId === ref || legacyPrincipalIdOf(row.metadata) === ref
  )
}

/** The cluster's login with a given role (root and replication exist at most once). */
export async function findManagedLoginByRole(
  db: Db,
  managedId: string,
  role: DatabaseLoginRole
): Promise<ManagedLoginCredentialRow | undefined> {
  await syncLegacyLogins(db, managedId)
  const rows = await selectLogins(db, and(eq(login.managedId, managedId), eq(login.role, role)))
  return rows.find((row) => row.role === role)
}

export function withoutPassword(row: ManagedLoginCredentialRow): ManagedLoginRow {
  const { password: _password, ...rest } = row
  return rest
}

export type InsertLoginInput = {
  managedId: string
  principalId: string | null
  role: DatabaseLoginRole
  appliedUsername: string
  /** Sealed `tpsecret` envelope. */
  password: string | null
  metadata?: Record<string, unknown> | null
  nameScheme?: PrincipalNameScheme
}

/** Insert one login row; the caller owns the principal side. */
export async function insertLogin(db: Db, input: InsertLoginInput): Promise<string> {
  const [inserted] = await db
    .insert(login)
    .values({
      managedId: input.managedId,
      principalId: input.principalId,
      role: input.role,
      appliedUsername: input.appliedUsername,
      password: input.password,
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
      ...(input.nameScheme ? { options: { nameScheme: input.nameScheme } } : {}),
    })
    .returning({ id: login.id })
  return inserted.id
}

/**
 * A `user` login for an existing principal: the engine role takes the
 * principal's applied name (the one allowed overlap in the organization's
 * name pool) and a fresh sealed password. Returns the show-once plaintext.
 */
export async function createLoginForPrincipal(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: {
    managedId: string
    principalId: string
    appliedUsername: string
    metadata: Record<string, unknown>
    nameScheme?: PrincipalNameScheme
  }
): Promise<{ loginId: string; password: string }> {
  const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets)
  const loginId = await insertLogin(db, {
    managedId: input.managedId,
    principalId: input.principalId,
    role: 'user',
    appliedUsername: input.appliedUsername,
    password: sealed,
    metadata: input.metadata,
    nameScheme: input.nameScheme,
  })
  return { loginId, password: plaintext }
}

/**
 * The legacy principal row written in step with a login: the principal the
 * login was created with on this cluster, or the old root/replication row
 * named in `metadata.legacyPrincipalId`. `null` for a login attached to a
 * principal that lives elsewhere (a system user, a login on another cluster).
 */
async function legacyTwinPrincipalId(
  db: Db,
  row: { principalId: string | null; managedId: string; metadata: unknown }
): Promise<string | null> {
  if (row.principalId) {
    const [twin] = await db
      .select({ id: principal.id })
      .from(principal)
      .where(
        and(
          eq(principal.id, row.principalId),
          eq(principal.kind, 'database'),
          eq(principal.managedId, row.managedId)
        )
      )
      .limit(1)
    return twin?.id ?? null
  }
  return legacyPrincipalIdOf(row.metadata)
}

/** Store a sealed password on the login and on its legacy twin, if any. */
export async function setLoginPassword(db: Db, loginId: string, sealed: string): Promise<void> {
  const now = new Date().toISOString()
  const [row] = await db
    .update(login)
    .set({ password: sealed, updatedAt: now })
    .where(eq(login.id, loginId))
    .returning({
      principalId: login.principalId,
      managedId: login.managedId,
      metadata: login.metadata,
    })
  if (!row) throw new TypeError('Login not found')
  const twinId = await legacyTwinPrincipalId(db, row)
  if (twinId) {
    await db
      .update(principal)
      .set({ password: sealed, updatedAt: now })
      .where(eq(principal.id, twinId))
  }
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
type PrincipalRecord = typeof principal.$inferSelect

export type RemovedLogin = {
  login: LoginRecord
  /** The kept principal row pointed at this cluster before it moved to another login's cluster. */
  repointedPrincipal?: { id: string; managedId: string }
  /** The principal row deleted with the login, when it existed only for it. */
  principal: PrincipalRecord | null
}

/**
 * Delete a login row. The principal goes too only when it was created for
 * this login (a `kind = 'database'` row on the same cluster) and nothing else
 * uses it: no other login and no binding. (Placements do not exist yet, and
 * a database principal has no tenancy.) An identity shared with another login
 * is kept and its legacy row follows the remaining login's cluster, so that
 * removing the last login finds the row and `syncLegacyLogins` never revives
 * the login that was just removed.
 */
export async function removeManagedLogin(db: Db, loginId: string): Promise<RemovedLogin | null> {
  const [row] = await db.select().from(login).where(eq(login.id, loginId)).limit(1)
  if (!row) return null
  const twinId = row.principalId ? await legacyTwinPrincipalId(db, row) : null

  await db.delete(login).where(eq(login.id, loginId))
  if (!twinId) return { login: row, principal: null }

  const [otherLogin] = await db
    .select({ id: login.id })
    .from(login)
    .where(and(eq(login.principalId, twinId), ne(login.id, loginId)))
    .limit(1)
  if (otherLogin) {
    const [remaining] = await db
      .select({ managedId: login.managedId })
      .from(login)
      .where(eq(login.id, otherLogin.id))
      .limit(1)
    if (!remaining) return { login: row, principal: null }
    await db
      .update(principal)
      .set({ managedId: remaining.managedId })
      .where(eq(principal.id, twinId))
    return {
      login: row,
      principal: null,
      repointedPrincipal: { id: twinId, managedId: row.managedId },
    }
  }
  const [bound] = await db
    .select({ id: binding.id })
    .from(binding)
    .where(eq(binding.principalId, twinId))
    .limit(1)
  if (bound) return { login: row, principal: null }

  const [removedPrincipal] = await db.delete(principal).where(eq(principal.id, twinId)).returning()
  return { login: row, principal: removedPrincipal ?? null }
}

/** Put back what {@link removeManagedLogin} deleted, same ids, after a failed enqueue. */
export async function restoreManagedLogin(db: Db, removed: RemovedLogin): Promise<void> {
  await db.transaction(async (tx) => {
    if (removed.principal) {
      await tx.insert(principal).values(removed.principal)
    }
    if (removed.repointedPrincipal) {
      await tx
        .update(principal)
        .set({ managedId: removed.repointedPrincipal.managedId })
        .where(eq(principal.id, removed.repointedPrincipal.id))
    }
    await tx.insert(login).values(removed.login)
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
 * Bindings join their login by `login_id`. A binding the previous release
 * wrote without one reaches the login of its principal on the principal's
 * own cluster, or the cluster login whose legacy row it names.
 */
export function bindingLoginJoin() {
  const principalCluster = sql`(SELECT "managed_id" FROM ${principal} WHERE "id" = ${binding.principalId})`
  return or(
    eq(binding.loginId, login.id),
    and(
      isNull(binding.loginId),
      eq(login.principalId, binding.principalId),
      eq(login.managedId, principalCluster)
    ),
    and(
      isNull(binding.loginId),
      isNull(login.principalId),
      sql`${login.metadata} ->> 'legacyPrincipalId' = ${binding.principalId}::text`
    )
  )
}

/**
 * The cluster a binding reaches, for readers that left-join `login` through
 * {@link bindingLoginJoin} and `principal` on `binding.principal_id`: the
 * login's cluster, or the legacy principal's while its login row does not
 * exist yet (a row the previous release wrote during the deploy window).
 */
export const bindingManagedId = sql<string>`coalesce(${login.managedId}, ${principal.managedId})`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
