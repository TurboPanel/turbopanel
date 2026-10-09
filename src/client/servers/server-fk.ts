import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { container, deployment, ip, network, slot, storageCopy } from '../../db/schema.ts'

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
