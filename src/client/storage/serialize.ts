import { principalVolumePath } from '../../lib/naming.ts'
import type { storage } from '../../lib/db/schema.ts'

type StorageRow = typeof storage.$inferSelect

/** Subset of storage columns returned by list/get handlers. */
export type StorageSelectRow = Pick<
  StorageRow,
  | 'id'
  | 'organizationId'
  | 'projectId'
  | 'environmentId'
  | 'serviceId'
  | 'serverId'
  | 'kind'
  | 'name'
  | 'sourcePath'
  | 'destinationPath'
  | 'principalId'
  | 'metadata'
  | 'options'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** Owning principal username (join input only — never in the JSON body). */
  principalUsername: string | null
}

export type SerializedStorage = Omit<StorageSelectRow, 'principalUsername'> & {
  /**
   * Read-only host path: explicit `sourcePath` when set, else the canonical
   * principal volume path for principal-owned bind mounts, else null.
   * Never persisted.
   */
  resolvedSourcePath: string | null
}

function resolveSourcePath(row: StorageSelectRow): string | null {
  if (typeof row.sourcePath === 'string' && row.sourcePath.length > 0) {
    return row.sourcePath
  }
  if (
    row.kind === 'bind_mount' &&
    typeof row.principalId === 'string' &&
    row.principalId.length > 0 &&
    typeof row.principalUsername === 'string' &&
    row.principalUsername.length > 0
  ) {
    return principalVolumePath(row.principalUsername, row.id)
  }
  return null
}

export function serializeStorage(row: StorageSelectRow): SerializedStorage {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    serverId: row.serverId,
    kind: row.kind,
    name: row.name,
    sourcePath: row.sourcePath,
    destinationPath: row.destinationPath,
    principalId: row.principalId,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedSourcePath: resolveSourcePath(row),
  }
}
