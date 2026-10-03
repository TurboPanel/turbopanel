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
 * Only paths under `/srv/users/` or that default root are backed up (the
 * daemon refuses anything else too): a backup of an arbitrary host path is a
 * copy of the host, not of a tenant's data. Remote providers (nfs, s3, …),
 * `file` / `object` storage and copies without a server are not targets.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { principal, storage, storageCopy } from '../../db/schema.ts'
import { type CopyBackupSource, isSafeCopyHostPath } from '../../contracts/commands/schemas.ts'
import {
  isValidDockerResourceName,
  principalVolumePath,
  resolveDockerVolumeName,
} from '../../lib/naming.ts'

/** Tenant directories live here (`principalVolumesDir`); the host's own storage root is the other allowed root. */
const PRINCIPAL_PATH_PREFIX = '/srv/users/'

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

/** The Docker volume deploy mounts for this copy. */
function dockerVolumeName(row: CopyTargetRow): string | null {
  const unmanaged = isPlainRecord(row.copyOptions) && row.copyOptions.managed === false
  const externalName = unmanaged ? readString(row.copyOptions, 'externalName') : null
  if (externalName) return isValidDockerResourceName(externalName) ? externalName : null
  try {
    return resolveDockerVolumeName({
      storageId: row.storageId,
      pinnedName: readString(row.storageMetadata, 'dockerVolumeName'),
    })
  } catch {
    return null
  }
}

function dockerSource(row: CopyTargetRow): CopySourceResult {
  const volumeName = dockerVolumeName(row)
  if (!volumeName) return { ok: false, error: 'the copy has no valid Docker volume name' }
  return { ok: true, source: { copyId: row.copyId, copyProvider: 'docker', volumeName } }
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
  if (!isSafeCopyHostPath(hostPath) || !hostPath.startsWith(PRINCIPAL_PATH_PREFIX)) {
    return {
      ok: false,
      error: 'only copies under /srv/users/ or the default storage directory can be backed up',
    }
  }
  return { ok: true, source: { copyId: row.copyId, copyProvider: 'path', hostPath } }
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
}

export async function loadCopyTarget(db: Db, copyId: string): Promise<CopyTargetRow | null> {
  const [row] = await db
    .select(COPY_TARGET_SELECT)
    .from(storageCopy)
    .innerJoin(storage, eq(storage.id, storageCopy.storageId))
    .leftJoin(principal, eq(principal.id, storage.principalId))
    .where(eq(storageCopy.id, copyId))
    .limit(1)
  return row ?? null
}
