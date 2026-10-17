import { and, eq, inArray, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { mount, storage } from '../../db/schema.ts'
import { markAssetFoldersRemoving } from '../folders/allocate.ts'

export type StorageRetentionScope = {
  workspaceIds?: readonly string[]
  projectIds?: readonly string[]
  environmentIds?: readonly string[]
  serviceIds?: readonly string[]
}

type RetentionTx = Pick<Db, 'delete' | 'select' | 'update'>

/**
 * Honor `storage.retention` when a parent is deleted:
 * drop mounts on deleted services (RESTRICT), then delete `retention='delete'`
 * rows in the cascade set. `retention='retain'` rows stay org-owned via SET NULL.
 */
export async function applyStorageRetentionOnParentDelete(
  tx: RetentionTx,
  scope: StorageRetentionScope
): Promise<void> {
  const serviceIds = scope.serviceIds ?? []
  if (serviceIds.length > 0) {
    await tx.delete(mount).where(inArray(mount.serviceId, serviceIds))
  }

  const doomedIds = await listStorageIdsDeletedWith(tx, scope)
  if (doomedIds.length === 0) return
  // The folder rows of a deleted volume stay, locked, until the host confirms
  // the folder is gone; they must be marked before the volume row goes.
  await markAssetFoldersRemoving(tx, { storageIds: doomedIds })
  await tx.delete(storage).where(inArray(storage.id, doomedIds))
}

/** Ids of the `retention = 'delete'` volumes that go when these parents are deleted. */
export async function listStorageIdsDeletedWith(
  tx: Pick<Db, 'select'>,
  scope: StorageRetentionScope
): Promise<string[]> {
  const serviceIds = scope.serviceIds ?? []
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
  if (predicates.length === 0) return []

  const rows = await tx
    .select({ id: storage.id })
    .from(storage)
    .where(and(eq(storage.retention, 'delete'), or(...predicates)))
  return rows.map((row) => row.id)
}
