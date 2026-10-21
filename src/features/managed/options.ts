import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { login, managed, managedDatabase } from '../../db/schema.ts'
import type { ManagedEngineSpec } from './index.ts'
import { nameListSql } from './sql-name-list.ts'
import type { ManagedSettings } from './settings.ts'

/** A login the customer chose as a Postgres database's owner. */
export type DatabaseOwnerLogin = {
  /** The login's id (`loginId` in the users API). */
  loginId: string
  /** Its applied username on the engine; fixed for the life of the login. */
  username: string
}

/**
 * A cluster's settings and databases as the code reads them. `managed.options`
 * holds only the settings; the databases are `database` rows, assembled here
 * by {@link loadManagedOptions} and written back by {@link saveManagedOptions}.
 */
export type ManagedRowOptions = {
  settings: ManagedSettings
  databases: string[]
  /**
   * Postgres: databases made with an owner role (`tp_<db>_owner`, `_rw`,
   * `_ro`). Absent = none, which is every database made before this existed.
   * A subset of `databases`.
   */
  ownerRoleDatabases?: string[]
  /**
   * Postgres: databases whose owner is a login the customer chose, not the
   * default no-login owner role. A subset of `ownerRoleDatabases`; absent =
   * every owner-role database is owned by its default owner role.
   */
  databaseOwners?: Record<string, DatabaseOwnerLogin>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The settings stored in `managed.options`; `null` when absent or invalid for the engine. */
export function parseManagedSettings(
  spec: ManagedEngineSpec,
  value: unknown
): ManagedSettings | null {
  if (!isRecord(value)) return null
  return spec.parseSettings(value.settings)
}

/** What goes in `managed.options`: the settings only. */
export function writeManagedSettings(settings: ManagedSettings): Record<string, unknown> {
  return { settings }
}

/** SQL for the names of a cluster's databases in name order, for a select over `managed`. */
export function managedDatabaseNames() {
  // Qualified by hand: drizzle drops the table name from a column in a
  // single-table select, and an unqualified `id` would bind to the subquery.
  return nameListSql(
    sql`ARRAY(SELECT d."name" FROM ${managedDatabase} d WHERE d."managed_id" = "managed"."id" ORDER BY lower(d."name"), d."name")`
  )
}

/** The cluster's `database` rows in name order, as the lists the code reads. */
export async function loadManagedDatabases(
  db: Db,
  managedId: string
): Promise<Pick<ManagedRowOptions, 'databases' | 'ownerRoleDatabases' | 'databaseOwners'>> {
  const rows = await db
    .select({
      name: managedDatabase.name,
      isRoleOwned: managedDatabase.isRoleOwned,
      ownerLoginId: managedDatabase.ownerLoginId,
      ownerUsername: login.appliedUsername,
    })
    .from(managedDatabase)
    .leftJoin(login, eq(login.id, managedDatabase.ownerLoginId))
    .where(eq(managedDatabase.managedId, managedId))
    .orderBy(asc(sql`lower(${managedDatabase.name})`), asc(managedDatabase.name))
  const ownerRoleDatabases = rows.filter((row) => row.isRoleOwned).map((row) => row.name)
  const databaseOwners: Record<string, DatabaseOwnerLogin> = {}
  for (const row of rows) {
    if (row.isRoleOwned && row.ownerLoginId && row.ownerUsername) {
      databaseOwners[row.name] = { loginId: row.ownerLoginId, username: row.ownerUsername }
    }
  }
  return {
    databases: rows.map((row) => row.name),
    ...(ownerRoleDatabases.length > 0 ? { ownerRoleDatabases } : {}),
    ...(Object.keys(databaseOwners).length > 0 ? { databaseOwners } : {}),
  }
}

/** A managed row's settings plus its databases; `null` when the stored settings are invalid. */
export async function loadManagedOptions(
  db: Db,
  spec: ManagedEngineSpec,
  row: { id: string; options: unknown }
): Promise<ManagedRowOptions | null> {
  const settings = parseManagedSettings(spec, row.options)
  if (settings === null) return null
  return { settings, ...(await loadManagedDatabases(db, row.id)) }
}

/**
 * Write settings and databases back: `managed.options` gets the settings and
 * the `database` rows are made to match the lists (rows added, removed, and
 * their owner-role flag and chosen owner updated). Call inside the same
 * transaction as the rest of the change.
 */
export async function saveManagedOptions(
  db: Db,
  managedId: string,
  next: ManagedRowOptions
): Promise<void> {
  await db
    .update(managed)
    .set({ options: writeManagedSettings(next.settings), updatedAt: new Date().toISOString() })
    .where(eq(managed.id, managedId))
  await saveManagedDatabases(db, managedId, next)
}

/** Make the cluster's `database` rows match the lists of `next` (see {@link saveManagedOptions}). */
export async function saveManagedDatabases(
  db: Db,
  managedId: string,
  next: Pick<ManagedRowOptions, 'databases' | 'ownerRoleDatabases' | 'databaseOwners'>
): Promise<void> {
  const existing = await db
    .select({
      id: managedDatabase.id,
      name: managedDatabase.name,
      isRoleOwned: managedDatabase.isRoleOwned,
      ownerLoginId: managedDatabase.ownerLoginId,
    })
    .from(managedDatabase)
    .where(eq(managedDatabase.managedId, managedId))
  const wanted = new Set(next.databases)
  const staleIds = existing.filter((row) => !wanted.has(row.name)).map((row) => row.id)
  if (staleIds.length > 0) {
    await db
      .delete(managedDatabase)
      .where(and(eq(managedDatabase.managedId, managedId), inArray(managedDatabase.id, staleIds)))
  }
  const byName = new Map(existing.map((row) => [row.name, row]))
  const ownerRole = new Set(next.ownerRoleDatabases ?? [])
  const fields = (name: string) => {
    const isRoleOwned = ownerRole.has(name)
    return {
      isRoleOwned,
      ownerLoginId: isRoleOwned ? (next.databaseOwners?.[name]?.loginId ?? null) : null,
    }
  }
  const added = next.databases.filter((name) => !byName.has(name))
  if (added.length > 0) {
    // One statement, so the rows get their ids in the order given.
    await db
      .insert(managedDatabase)
      .values(added.map((name) => ({ managedId, name, ...fields(name) })))
  }
  const changed = existing.filter((row) => {
    if (!wanted.has(row.name)) return false
    const want = fields(row.name)
    return row.isRoleOwned !== want.isRoleOwned || row.ownerLoginId !== want.ownerLoginId
  })
  await forEachSequential(changed, async (row) => {
    await db
      .update(managedDatabase)
      .set({ ...fields(row.name), updatedAt: sql`now()` })
      .where(eq(managedDatabase.id, row.id))
  })
}
