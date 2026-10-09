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
  return undefined
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

const SERVER_RESTRICT_FK_MIGRATION_PATTERN =
  /ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]*server_id_server_id_fk" FOREIGN KEY \("server_id"\) REFERENCES "public"\."server"\("id"\) ON DELETE (restrict|no action)/gi

/** Last `ON DELETE` rule per table from shipped migration SQL (journal order). */
export function listServerRestrictForeignKeyTablesFromMigrationSql(
  migrationSqlChunks: readonly string[]
): string[] {
  const deleteRuleByTable = new Map<string, string>()
  for (const chunk of migrationSqlChunks) {
    for (const match of chunk.matchAll(SERVER_RESTRICT_FK_MIGRATION_PATTERN)) {
      const tableName = match[1]
      const rule = match[2].toLowerCase()
      deleteRuleByTable.set(tableName, rule)
    }
  }
  return [...deleteRuleByTable.entries()]
    .filter(([, rule]) => rule === 'restrict' || rule === 'no action')
    .map(([table]) => table)
    .sort((a, b) => a.localeCompare(b))
}

export function assertServerRestrictForeignKeyCoverage(tables: readonly string[]): void {
  const missing = tables.filter(
    (table) => SERVER_RESTRICT_FOREIGN_KEY_HANDLERS[table] === undefined
  )
  if (missing.length > 0) {
    throw new Error(
      `server delete: unhandled RESTRICT server_id FK on table(s): ${missing.join(', ')} — extend SERVER_RESTRICT_FOREIGN_KEY_HANDLERS and the purge/forget path`
    )
  }
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
