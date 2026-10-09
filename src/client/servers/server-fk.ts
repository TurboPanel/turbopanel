import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { container, deployment, ip, network, slot, storageCopy } from '../../db/schema.ts'

/**
 * Foreign keys to `server.id` (from migrations/meta/0021_snapshot.json).
 * Used for delete-forget coverage and actionable FK errors.
 */
export const SERVER_FOREIGN_KEY_REFERENCES: ReadonlyArray<{
  table: string
  column: string
  onDelete: 'restrict' | 'cascade' | 'set null'
}> = [
  { table: 'backup', column: 'server_id', onDelete: 'set null' },
  { table: 'bulwark', column: 'server_id', onDelete: 'cascade' },
  { table: 'capability', column: 'server_id', onDelete: 'cascade' },
  { table: 'command', column: 'server_id', onDelete: 'cascade' },
  { table: 'container', column: 'server_id', onDelete: 'restrict' },
  { table: 'copy', column: 'server_id', onDelete: 'restrict' },
  { table: 'deployment', column: 'server_id', onDelete: 'restrict' },
  { table: 'edict', column: 'server_id', onDelete: 'cascade' },
  { table: 'environment', column: 'server_id', onDelete: 'restrict' },
  { table: 'generation', column: 'server_id', onDelete: 'cascade' },
  { table: 'ip', column: 'server_id', onDelete: 'restrict' },
  { table: 'key', column: 'server_id', onDelete: 'cascade' },
  { table: 'label', column: 'server_id', onDelete: 'cascade' },
  { table: 'leaf', column: 'server_id', onDelete: 'cascade' },
  { table: 'license', column: 'server_id', onDelete: 'set null' },
  { table: 'managed', column: 'server_id', onDelete: 'restrict' },
  { table: 'marker', column: 'server_id', onDelete: 'cascade' },
  { table: 'monitor', column: 'server_id', onDelete: 'cascade' },
  { table: 'network', column: 'server_id', onDelete: 'restrict' },
  { table: 'relay', column: 'server_id', onDelete: 'restrict' },
  { table: 'replica', column: 'server_id', onDelete: 'restrict' },
  { table: 'slot', column: 'server_id', onDelete: 'restrict' },
  { table: 'snapshot', column: 'server_id', onDelete: 'cascade' },
  { table: 'stage', column: 'server_id', onDelete: 'cascade' },
  { table: 'subnet', column: 'server_id', onDelete: 'restrict' },
  { table: 'variable', column: 'server_id', onDelete: 'cascade' },
]

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
 * Remove RESTRICT rows keyed only by `server_id` that forget/system teardown may
 * have missed (for example system-workspace containers). Does not touch
 * environments, managed clusters, or replicas — those stay blockers.
 */
export async function purgeServerRestrictForeignKeys(tx: Db, serverId: string): Promise<void> {
  await tx.delete(deployment).where(eq(deployment.serverId, serverId))
  await tx.delete(slot).where(eq(slot.serverId, serverId))
  await tx.delete(storageCopy).where(eq(storageCopy.serverId, serverId))
  await tx.delete(container).where(eq(container.serverId, serverId))
  await tx.delete(ip).where(eq(ip.serverId, serverId))
  await tx.delete(network).where(eq(network.serverId, serverId))
}
