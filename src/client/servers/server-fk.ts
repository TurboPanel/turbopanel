import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  container,
  deployment,
  ip,
  network,
  relay,
  slot,
  storageCopy,
  subnet,
} from '../../db/schema.ts'

const CONSTRAINT_TABLE_PATTERN = /^([a-z_]+)_server_id_server_id_fk$/

/** Map a Postgres FK constraint name to the referring table when `table_name` is absent. */
export function referringTableFromConstraintName(constraintName: string): string | undefined {
  const match = CONSTRAINT_TABLE_PATTERN.exec(constraintName)
  if (match) return match[1]
  if (constraintName.endsWith('_server_id_server_id_fk')) {
    return constraintName.replace(/_server_id_server_id_fk$/, '')
  }
  const environmentMatch = /^([a-z_]+)_environment_id_environment_id_fk$/.exec(constraintName)
  if (environmentMatch) return environmentMatch[1]
  if (constraintName.endsWith('_environment_id_environment_id_fk')) {
    return constraintName.replace(/_environment_id_environment_id_fk$/, '')
  }
  return undefined
}

const SERVER_FK_MIGRATION_PATTERN =
  /ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]*" FOREIGN KEY \("([^"]+)"\) REFERENCES "public"\."server"\("id"\) ON DELETE ([^;]+)/gi

const ENVIRONMENT_FK_MIGRATION_PATTERN =
  /ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]*" FOREIGN KEY \("([^"]+)"\) REFERENCES "public"\."environment"\("id"\) ON DELETE ([^;]+)/gi

export type ForeignKeyMigrationRow = {
  table: string
  column: string
  onDelete: string
}

function normalizeOnDelete(rule: string): string {
  return rule
    .replace(/\s+ON UPDATE.*$/i, '')
    .trim()
    .toLowerCase()
}

function collectForeignKeysFromMigrationSql(
  migrationSqlChunks: readonly string[],
  pattern: RegExp
): ForeignKeyMigrationRow[] {
  const byKey = new Map<string, ForeignKeyMigrationRow>()
  for (const chunk of migrationSqlChunks) {
    for (const match of chunk.matchAll(pattern)) {
      const table = match[1]
      const column = match[2]
      const onDelete = normalizeOnDelete(match[3])
      byKey.set(`${table}.${column}`, { table, column, onDelete })
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column)
  )
}

/** Last `ON DELETE` rule per (table, column) from shipped migration SQL (journal order). */
export function listServerForeignKeysFromMigrationSql(
  migrationSqlChunks: readonly string[]
): ForeignKeyMigrationRow[] {
  return collectForeignKeysFromMigrationSql(migrationSqlChunks, SERVER_FK_MIGRATION_PATTERN)
}

export function listEnvironmentForeignKeysFromMigrationSql(
  migrationSqlChunks: readonly string[]
): ForeignKeyMigrationRow[] {
  return collectForeignKeysFromMigrationSql(migrationSqlChunks, ENVIRONMENT_FK_MIGRATION_PATTERN)
}

export function listServerRestrictForeignKeyTablesFromMigrationSql(
  migrationSqlChunks: readonly string[]
): string[] {
  return listServerForeignKeysFromMigrationSql(migrationSqlChunks)
    .filter((row) => row.onDelete === 'restrict' || row.onDelete === 'no action')
    .map((row) => row.table)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Every physical table with `server_id` → `server.id` and `ON DELETE RESTRICT`
 * (or NO ACTION). A new restrict FK must be cleared on server delete/forget or
 * listed here with a documented handler — guarded by
 * `server-delete-fk-coverage.hostfree.test.ts`.
 */
export const SERVER_RESTRICT_FOREIGN_KEY_HANDLERS: Readonly<
  Record<string, 'purge' | 'fabric' | 'forget-or-block'>
> = {
  container: 'purge',
  copy: 'purge',
  deployment: 'purge',
  environment: 'forget-or-block',
  ip: 'purge',
  managed: 'forget-or-block',
  network: 'purge',
  relay: 'fabric',
  replica: 'forget-or-block',
  slot: 'purge',
  subnet: 'fabric',
}

/**
 * Tables referencing `environment.id` that the forget subtree must clear (or
 * that CASCADE/SET NULL when the environment row is deleted).
 */
export const ENVIRONMENT_FORGET_FOREIGN_KEY_HANDLERS: Readonly<
  Record<string, 'drop-subtree' | 'cascade-on-environment' | 'set-null-on-environment'>
> = {
  deployment: 'drop-subtree',
  managed: 'cascade-on-environment',
  marker: 'cascade-on-environment',
  network: 'set-null-on-environment',
  service: 'drop-subtree',
  slot: 'drop-subtree',
  storage: 'set-null-on-environment',
  variable: 'cascade-on-environment',
}

function assertForeignKeyHandlerCoverage(
  tables: readonly string[],
  handlers: Readonly<Record<string, string>>,
  context: string
): void {
  const missing = tables.filter((table) => handlers[table] === undefined)
  if (missing.length > 0) {
    throw new Error(`${context}: unhandled FK on table(s): ${missing.join(', ')}`)
  }
}

export function assertServerRestrictForeignKeyCoverage(tables: readonly string[]): void {
  assertForeignKeyHandlerCoverage(
    tables,
    SERVER_RESTRICT_FOREIGN_KEY_HANDLERS,
    'server delete — extend SERVER_RESTRICT_FOREIGN_KEY_HANDLERS and the purge/forget path'
  )
}

export function assertEnvironmentForgetForeignKeyCoverage(tables: readonly string[]): void {
  assertForeignKeyHandlerCoverage(
    tables,
    ENVIRONMENT_FORGET_FOREIGN_KEY_HANDLERS,
    'server forget — extend ENVIRONMENT_FORGET_FOREIGN_KEY_HANDLERS and dropEnvironmentSubtree'
  )
}

/** TurboFabric rows keyed only by this host (`subnet` before `relay` — independent FKs). */
export async function purgeServerFabricForeignKeys(tx: Db, serverId: string): Promise<void> {
  await tx.delete(subnet).where(eq(subnet.serverId, serverId))
  await tx.delete(relay).where(eq(relay.serverId, serverId))
}

/**
 * Remove RESTRICT rows keyed only by `server_id` that forget/system teardown may
 * have missed (for example system-workspace containers). Does not touch
 * environments, managed clusters, or replicas — those stay blockers unless forget
 * dropped them earlier in the same transaction.
 */
export async function purgeServerRestrictForeignKeys(tx: Db, serverId: string): Promise<void> {
  await tx.delete(deployment).where(eq(deployment.serverId, serverId))
  await tx.delete(slot).where(eq(slot.serverId, serverId))
  await tx.delete(storageCopy).where(eq(storageCopy.serverId, serverId))
  await tx.delete(container).where(eq(container.serverId, serverId))
  await tx.delete(ip).where(eq(ip.serverId, serverId))
  await tx.delete(network).where(eq(network.serverId, serverId))
}

/** Final sweep before `DELETE FROM server` (fabric membership + leftover restrict rows). */
export async function purgeServerForeignKeysForDelete(tx: Db, serverId: string): Promise<void> {
  await purgeServerFabricForeignKeys(tx, serverId)
  await purgeServerRestrictForeignKeys(tx, serverId)
}
