/**
 * Storage copies as backup targets: which copies can be backed up, and where
 * each one's bytes live on its host ({@link CopyBackupSource}).
 *
 * The resolution mirrors what deploy materializes and mounts
 * (`client/environments/deploy-prepare.ts`, `features/deploy/register-compose-volumes.ts`):
 *
 * - a `docker` copy is a named Docker volume: the unmanaged compose volume's
 *   `externalName`, else the storage's pinned `dockerVolumeName`, else the
 *   storage id;
 * - a `path` copy of a `directory` storage is a host directory: the copy's own
 *   `path`, else the principal's `/srv/users/<user>/volumes/<storageId>`, else
 *   the host's default `<stateDir>/storage/<org>/<storage>/<copy>/data`.
 *
 * Only the site owner's own directories are backed up: a path copy must be the storage's own directory `/srv/users/<its Linux user>/volumes/<storage id>`
 * (or the host's default root, which has no path), and a Docker volume must be the storage's
 * own (its id, as deploy names it) or an external one the project's compose
 * project labels. Another owner's directory or another project's volume is
 * refused here and again on the host, which receives the owner and project
 * with the source. Remote providers (nfs, s3, …),
 * `file` / `object` storage and copies without a server are not targets.
 */

import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, principal, storage, storageCopy } from '../../db/schema.ts'
import { type CopyBackupSource, isSafeCopyHostPath } from '../../contracts/commands/schemas.ts'
import {
  isValidDockerResourceName,
  principalVolumePath,
  resolveDockerVolumeName,
} from '../../lib/naming.ts'

/** What a copy target needs from its copy, storage and principal rows. */
export type CopyTargetRow = {
  copyId: string
  serverId: string | null
  provider: string
  copyPath: string | null
  copyOptions: unknown
  storageId: string
  organizationId: string
  storageKind: string
  storageMetadata: unknown
  principalUsername: string | null
  /** The storage's project (its own, else its environment's): the compose project name. */
  projectId?: string | null
}

export type CopySourceResult = { ok: true; source: CopyBackupSource } | { ok: false; error: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: unknown, key: string): string | null {
  if (!isPlainRecord(record)) return null
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The Docker volume deploy mounts for this copy: an external volume the
 * project's compose file names (the host checks its compose-project label),
 * else the storage's own volume, which is named by the storage id. A pinned
 * name that is anything else is refused.
 */
function dockerVolumeName(row: CopyTargetRow): { name: string; external: boolean } | null {
  const unmanaged = isPlainRecord(row.copyOptions) && row.copyOptions.managed === false
  const externalName = unmanaged ? readString(row.copyOptions, 'externalName') : null
  if (externalName) {
    return isValidDockerResourceName(externalName) ? { name: externalName, external: true } : null
  }
  try {
    const name = resolveDockerVolumeName({
      storageId: row.storageId,
      pinnedName: readString(row.storageMetadata, 'dockerVolumeName'),
    })
    return name === row.storageId ? { name, external: false } : null
  } catch {
    return null
  }
}

function dockerSource(row: CopyTargetRow): CopySourceResult {
  const volume = dockerVolumeName(row)
  if (!volume) {
    return { ok: false, error: "the copy is not one of this storage's own Docker volumes" }
  }
  if (volume.external && !row.projectId) {
    return {
      ok: false,
      error: 'an external Docker volume needs the storage to belong to a project',
    }
  }
  const source: CopyBackupSource = {
    copyId: row.copyId,
    copyProvider: 'docker',
    volumeName: volume.name,
    storageId: row.storageId,
  }
  if (row.projectId) source.composeProject = row.projectId
  return { ok: true, source }
}

/** Why a copy's options may not be written through the API (an external volume is recorded by deploy only); null when fine. */
export function copyOptionsError(options: unknown): string | null {
  if (!isPlainRecord(options)) return null
  if ('externalName' in options || options.managed === false) {
    return 'A copy cannot name an external Docker volume'
  }
  return null
}

/**
 * Whether `hostPath` is exactly the storage's own directory under its site
 * owner's volumes (`/srv/users/<user>/volumes/<storageId>`). Returns the reason
 * when it is not. Exact, not a prefix: a storage can be handed to another
 * site owner, and that must never reach a directory named after someone
 * else's storage. `storageId` is null while the storage is being created (no
 * path can match yet). Shared by the copy routes and by command building.
 */
export function copyHostPathError(
  username: string | null,
  storageId: string | null,
  hostPath: string
): string | null {
  if (!isSafeCopyHostPath(hostPath)) return 'the copy path is not a safe absolute path'
  if (!username) {
    return 'a copy path needs a storage assigned to a site owner; otherwise leave the path empty'
  }
  let ownPath: string | null = null
  try {
    ownPath = storageId ? principalVolumePath(username, storageId) : null
  } catch {
    return "the storage's site owner has no valid Linux user"
  }
  if (hostPath !== ownPath) {
    return "the copy path can only be the storage's own directory under its site owner's volumes"
  }
  return null
}

function pathSource(row: CopyTargetRow): CopySourceResult {
  if (row.storageKind !== 'directory') {
    return { ok: false, error: `a path copy of ${row.storageKind} storage cannot be backed up` }
  }
  let hostPath: string | null = row.copyPath && row.copyPath.length > 0 ? row.copyPath : null
  if (!hostPath && row.principalUsername) {
    hostPath = principalVolumePath(row.principalUsername, row.storageId)
  }
  if (!hostPath) {
    return {
      ok: true,
      source: {
        copyId: row.copyId,
        copyProvider: 'path',
        organizationId: row.organizationId,
        storageId: row.storageId,
      },
    }
  }
  const pathError = copyHostPathError(row.principalUsername, row.storageId, hostPath)
  if (pathError || !row.principalUsername) {
    return { ok: false, error: pathError ?? 'the copy has no site owner' }
  }
  return {
    ok: true,
    source: {
      copyId: row.copyId,
      copyProvider: 'path',
      hostPath,
      ownerUsername: row.principalUsername,
    },
  }
}

/** Whether (and from where) this copy can be backed up. */
export function resolveCopyBackupSource(row: CopyTargetRow): CopySourceResult {
  if (!row.serverId) return { ok: false, error: 'the copy is not placed on a server' }
  if (row.storageKind !== 'volume' && row.storageKind !== 'directory') {
    return { ok: false, error: `${row.storageKind} storage cannot be backed up` }
  }
  if (row.provider === 'docker') return dockerSource(row)
  if (row.provider === 'path') return pathSource(row)
  return { ok: false, error: `a ${row.provider} copy cannot be backed up` }
}

/** The columns {@link CopyTargetRow} reads, for callers that join copies themselves. */
export const COPY_TARGET_SELECT = {
  copyId: storageCopy.id,
  serverId: storageCopy.serverId,
  provider: storageCopy.provider,
  copyPath: storageCopy.path,
  copyOptions: storageCopy.options,
  storageId: storage.id,
  organizationId: storage.organizationId,
  storageKind: storage.kind,
  storageMetadata: storage.metadata,
  principalUsername: principal.appliedUsername,
  projectId: sql<string | null>`coalesce(${storage.projectId}, ${environment.projectId})`,
}

export async function loadCopyTarget(db: Db, copyId: string): Promise<CopyTargetRow | null> {
  const [row] = await db
    .select(COPY_TARGET_SELECT)
    .from(storageCopy)
    .innerJoin(storage, eq(storage.id, storageCopy.storageId))
    .leftJoin(principal, eq(principal.id, storage.principalId))
    .leftJoin(environment, eq(environment.id, storage.environmentId))
    .where(eq(storageCopy.id, copyId))
    .limit(1)
  return row ?? null
}
