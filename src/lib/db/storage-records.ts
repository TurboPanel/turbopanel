import { and, eq, inArray, or } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { mount, storage } from './schema.ts'

export type StorageRetentionScope = {
  workspaceIds?: readonly string[]
  projectIds?: readonly string[]
  environmentIds?: readonly string[]
  serviceIds?: readonly string[]
}

type RetentionTx = Pick<Db, 'delete'>

/**
 * Honor `storage.retention` when a parent is deleted:
 * drop mounts on deleted services (RESTRICT), then delete `retention='delete'`
 * rows in the cascade set. `retention='retain'` rows stay org-owned via SET NULL.
 */
export async function applyStorageRetentionOnParentDelete(
  tx: RetentionTx,
  scope: StorageRetentionScope,
): Promise<void> {
  const serviceIds = scope.serviceIds ?? []
  if (serviceIds.length > 0) {
    await tx.delete(mount).where(inArray(mount.serviceId, serviceIds))
  }

  const predicates = []
  if (scope.workspaceIds && scope.workspaceIds.length > 0) {
    predicates.push(inArray(storage.workspaceId, [...scope.workspaceIds]))
  }
  if (scope.projectIds && scope.projectIds.length > 0) {
    predicates.push(inArray(storage.projectId, [...scope.projectIds]))
  }
  if (scope.environmentIds && scope.environmentIds.length > 0) {
    predicates.push(inArray(storage.environmentId, [...scope.environmentIds]))
  }
  if (serviceIds.length > 0) {
    predicates.push(inArray(storage.serviceId, [...serviceIds]))
  }
  if (predicates.length === 0) return

  await tx
    .delete(storage)
    .where(and(eq(storage.retention, 'delete'), or(...predicates)))
}
