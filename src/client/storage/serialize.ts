import { principalVolumePath } from '../../lib/naming.ts'
import type { storageCopy, mount, storage } from '../../lib/db/schema.ts'

type StorageRow = typeof storage.$inferSelect
type CopyRow = typeof storageCopy.$inferSelect
type MountRow = typeof mount.$inferSelect

/** Subset of storage columns returned by list/get handlers. */
export type StorageSelectRow = Pick<
  StorageRow,
  | 'id'
  | 'organizationId'
  | 'workspaceId'
  | 'projectId'
  | 'environmentId'
  | 'serviceId'
  | 'kind'
  | 'name'
  | 'accessMode'
  | 'retention'
  | 'generation'
  | 'principalId'
  | 'metadata'
  | 'options'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** Owning principal username (join input only — never in the JSON body). */
  principalUsername: string | null
}

export type CopySelectRow = Pick<
  CopyRow,
  | 'id'
  | 'storageId'
  | 'serverId'
  | 'secretId'
  | 'provider'
  | 'role'
  | 'state'
  | 'path'
  | 'endpoint'
  | 'generation'
  | 'metadata'
  | 'options'
  | 'createdAt'
  | 'updatedAt'
>

export type MountSelectRow = Pick<
  MountRow,
  | 'id'
  | 'storageId'
  | 'serviceId'
  | 'destinationPath'
  | 'subpath'
  | 'metadata'
  | 'options'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** Explicit API mapping from `mount.is_read_only`. */
  readOnly: boolean
}

export type SerializedCopy = CopySelectRow & {
  /**
   * Read-only host path: explicit `path` when set, else the canonical
   * principal volume path for principal-owned path copies, else null.
   * Never persisted.
   */
  resolvedSourcePath: string | null
}

export type SerializedMount = MountSelectRow // NOSONAR typescript:S6564 — public API alias parallel to SerializedCopy

export type SerializedStorage = Omit<StorageSelectRow, 'principalUsername'> & {
  copies: SerializedCopy[]
  mounts: SerializedMount[]
}

function resolveCopyPath(
  copy: CopySelectRow,
  storageId: string,
  principalUsername: string | null,
): string | null {
  if (typeof copy.path === 'string' && copy.path.length > 0) {
    return copy.path
  }
  if (
    copy.provider === 'path' &&
    typeof principalUsername === 'string' &&
    principalUsername.length > 0
  ) {
    return principalVolumePath(principalUsername, storageId)
  }
  return null
}

export function serializeCopy(
  copy: CopySelectRow,
  storageId: string,
  principalUsername: string | null,
): SerializedCopy {
  return {
    ...copy,
    resolvedSourcePath: resolveCopyPath(copy, storageId, principalUsername),
  }
}

export function serializeMount(row: MountSelectRow): SerializedMount {
  return { ...row }
}

export function serializeStorage(
  row: StorageSelectRow,
  copies: CopySelectRow[] = [],
  mounts: MountSelectRow[] = [],
): SerializedStorage {
  const serializedCopies = copies.map((copy) =>
    serializeCopy(copy, row.id, row.principalUsername),
  )
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    kind: row.kind,
    name: row.name,
    accessMode: row.accessMode,
    retention: row.retention,
    generation: row.generation,
    principalId: row.principalId,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    copies: serializedCopies,
    mounts: mounts.map(serializeMount),
  }
}
