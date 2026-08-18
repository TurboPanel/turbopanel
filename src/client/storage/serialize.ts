import { principalVolumePath } from '../../lib/naming.ts'
import type { location, mount, storage } from '../../lib/db/schema.ts'

type StorageRow = typeof storage.$inferSelect
type LocationRow = typeof location.$inferSelect
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

export type LocationSelectRow = Pick<
  LocationRow,
  | 'id'
  | 'storageId'
  | 'serverId'
  | 'credentialId'
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

export type SerializedLocation = LocationSelectRow & {
  /**
   * Read-only host path: explicit `path` when set, else the canonical
   * principal volume path for principal-owned path locations, else null.
   * Never persisted.
   */
  resolvedSourcePath: string | null
}

export type SerializedMount = MountSelectRow // NOSONAR typescript:S6564 — public API alias parallel to SerializedLocation

export type SerializedStorage = Omit<StorageSelectRow, 'principalUsername'> & {
  locations: SerializedLocation[]
  mounts: SerializedMount[]
}

function resolveLocationPath(
  loc: LocationSelectRow,
  storageId: string,
  principalUsername: string | null,
): string | null {
  if (typeof loc.path === 'string' && loc.path.length > 0) {
    return loc.path
  }
  if (
    loc.provider === 'path' &&
    typeof principalUsername === 'string' &&
    principalUsername.length > 0
  ) {
    return principalVolumePath(principalUsername, storageId)
  }
  return null
}

export function serializeLocation(
  loc: LocationSelectRow,
  storageId: string,
  principalUsername: string | null,
): SerializedLocation {
  return {
    ...loc,
    resolvedSourcePath: resolveLocationPath(loc, storageId, principalUsername),
  }
}

export function serializeMount(row: MountSelectRow): SerializedMount {
  return { ...row }
}

export function serializeStorage(
  row: StorageSelectRow,
  locations: LocationSelectRow[] = [],
  mounts: MountSelectRow[] = [],
): SerializedStorage {
  const serializedLocations = locations.map((loc) =>
    serializeLocation(loc, row.id, row.principalUsername),
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
    locations: serializedLocations,
    mounts: mounts.map(serializeMount),
  }
}
