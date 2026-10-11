/**
 * Row cleanup shared by the managed delete paths (hard delete, forced delete,
 * and forgetting a database whose hosts are lost).
 */

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { container, managed, replica, service } from '../../db/schema.ts'

/**
 * Clear never-applied pending container rows for an environment so
 * deleteProjectCascade does not treat them as active after the managed row is
 * removed. Same predicate as the hard-delete path on DELETE …/managed.
 */
export async function clearPendingNullIdContainersForEnvironment(
  db: Db,
  environmentId: string
): Promise<void> {
  const envServices = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = envServices.map((s) => s.id)
  if (serviceIds.length > 0) {
    await db
      .delete(container)
      .where(
        and(
          inArray(container.serviceId, serviceIds),
          isNull(container.containerId),
          eq(container.status, 'pending')
        )
      )
  }
}

/**
 * Force-delete cleanup: remove the managed runtime's DB rows (service
 * container rows, member rows, and the managed row itself) so
 * `deleteProjectCascade` stops gating on them. Only for `?force=true` —
 * destroys are enqueued best-effort and sweeps mop up leftover containers.
 */
export async function deleteManagedRuntimeRows(
  db: Db,
  environmentId: string,
  managedId: string
): Promise<void> {
  const envServices = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = envServices.map((s) => s.id)
  if (serviceIds.length > 0) {
    await db
      .delete(container)
      .where(and(inArray(container.serviceId, serviceIds), eq(container.role, 'service')))
  }
  await db.delete(replica).where(eq(replica.managedId, managedId))
  await db.delete(managed).where(eq(managed.id, managedId))
}
