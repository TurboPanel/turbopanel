/**
 * The data volumes a Destroy may delete, when the person ticks "Also Delete the
 * Data Volumes".
 *
 * A Destroy runs `compose down --volumes`, but every volume the control plane
 * registered is mounted `external: true`, so Compose keeps it. Deleting data is
 * therefore an explicit list: the registered Docker volumes that belong to this
 * environment and to nothing else. One function decides that list, and both the
 * dialog's read endpoint and the stop route call it; the stop never takes
 * volume names from the request.
 *
 * A volume is removable only when all of these hold:
 * - its storage row belongs to this environment, or to one of its services;
 * - it is a Docker volume the control plane created, named by its storage id
 *   (a pinned name that is anything else is kept: `metadata` is free-form);
 * - it is not an external volume the compose file names (`external: true`),
 *   which the person made and may use elsewhere;
 * - it is not a common (shared) volume, no other environment uses it through a
 *   `share` row, and no service of another environment mounts it.
 *
 * Everything else is listed as kept, with the reason. Volumes are removed on
 * every server the stop goes to (a registered volume is created on each server
 * the environment deploys to); a server without it reports `absent`. A Docker
 * copy recorded on a server the stop does not go to (the environment moved
 * away from it) stays there; `copyServerIds` lets the caller say so.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { mount, service, share, storage, storageCopy } from '../../db/schema.ts'

/** Why a registered volume stays when the data is deleted. */
export type KeptVolumeReason = 'common' | 'shared' | 'external' | 'renamed'

export type NamedDataVolume = {
  storageId: string
  /** The name the person knows: the compose volume key or the name given in the web interface. */
  name: string
}

export type RemovableDataVolume = NamedDataVolume & {
  /** Servers with a Docker copy of it on record, sorted. */
  copyServerIds: string[]
}

export type KeptDataVolume = NamedDataVolume & {
  reason: KeptVolumeReason
  /** The reason in plain words, for the dialog. */
  message: string
}

export type EnvironmentDataVolumes = {
  volumes: RemovableDataVolume[]
  kept: KeptDataVolume[]
}

/** One Docker copy of a storage row of this environment, with what classification needs. */
export type DataVolumeCandidate = {
  storageId: string
  name: string
  isCommon: boolean
  metadata: unknown
  copyOptions: unknown
  copyServerId: string | null
  /** Another environment uses it (a `share` row or a mount from one of its services). */
  usedElsewhere: boolean
}

const KEPT_MESSAGES: Record<KeptVolumeReason, string> = {
  common: 'A shared volume other environments can use. Deleting data never removes it.',
  shared: 'Another environment uses this volume too.',
  external: 'An external volume your compose file names. TurboPanel did not create it.',
  renamed: 'Its Docker name is not the one TurboPanel gave it, so it is left alone.',
}

/** The shape the daemon accepts as a volume name: a lowercase storage id. */
const STORAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pinnedName(metadata: unknown): string | null {
  if (!isRecord(metadata) || typeof metadata.dockerVolumeName !== 'string') return null
  return metadata.dockerVolumeName.length > 0 ? metadata.dockerVolumeName : null
}

function keptReason(candidate: DataVolumeCandidate): KeptVolumeReason | null {
  if (candidate.isCommon) return 'common'
  if (candidate.usedElsewhere) return 'shared'
  if (isRecord(candidate.copyOptions) && candidate.copyOptions.managed === false) {
    return 'external'
  }
  const pinned = pinnedName(candidate.metadata)
  if (pinned !== null && pinned !== candidate.storageId) return 'renamed'
  if (!STORAGE_ID_RE.test(candidate.storageId)) return 'renamed'
  return null
}

/**
 * Split candidates into removable and kept, one entry per storage row (a row
 * with several copies is kept when any copy says so), sorted by name.
 */
export function classifyDataVolumes(
  candidates: readonly DataVolumeCandidate[]
): EnvironmentDataVolumes {
  type Seen = { name: string; reason: KeptVolumeReason | null; servers: Set<string> }
  const byStorage = new Map<string, Seen>()
  for (const candidate of candidates) {
    const reason = keptReason(candidate)
    let seen = byStorage.get(candidate.storageId)
    if (seen === undefined) {
      seen = { name: candidate.name, reason, servers: new Set() }
      byStorage.set(candidate.storageId, seen)
    } else if (seen.reason === null && reason !== null) {
      seen.reason = reason
    }
    if (candidate.copyServerId !== null) seen.servers.add(candidate.copyServerId)
  }
  const volumes: RemovableDataVolume[] = []
  const kept: KeptDataVolume[] = []
  for (const [storageId, entry] of byStorage) {
    if (entry.reason === null) {
      const copyServerIds = [...entry.servers]
      copyServerIds.sort((a, b) => a.localeCompare(b))
      volumes.push({ storageId, name: entry.name, copyServerIds })
    } else {
      kept.push({
        storageId,
        name: entry.name,
        reason: entry.reason,
        message: KEPT_MESSAGES[entry.reason],
      })
    }
  }
  const byName = (a: NamedDataVolume, b: NamedDataVolume) =>
    a.name.localeCompare(b.name) || a.storageId.localeCompare(b.storageId)
  volumes.sort(byName)
  kept.sort(byName)
  return { volumes, kept }
}

/** The storage ids, among `storageIds`, that another environment uses. */
async function usedByOtherEnvironments(
  db: Pick<Db, 'select'>,
  environmentId: string,
  storageIds: readonly string[]
): Promise<Set<string>> {
  if (storageIds.length === 0) return new Set()
  const [shares, mounts] = await Promise.all([
    db
      .select({ storageId: share.storageId })
      .from(share)
      .where(
        and(inArray(share.storageId, [...storageIds]), ne(share.environmentId, environmentId))
      ),
    db
      .select({ storageId: mount.storageId })
      .from(mount)
      .innerJoin(service, eq(service.id, mount.serviceId))
      .where(
        and(inArray(mount.storageId, [...storageIds]), ne(service.environmentId, environmentId))
      ),
  ])
  const used = new Set<string>()
  for (const row of [...shares, ...mounts]) {
    if (typeof row.storageId === 'string') used.add(row.storageId)
  }
  return used
}

/** The registered Docker volumes of an environment, split into removable and kept. */
export async function listEnvironmentDataVolumes(
  db: Pick<Db, 'select'>,
  environmentId: string
): Promise<EnvironmentDataVolumes> {
  const serviceRows = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = serviceRows.map((row) => row.id)
  const rows = await db
    .select({
      storageId: storage.id,
      name: storage.name,
      isCommon: storage.isCommon,
      metadata: storage.metadata,
      copyOptions: storageCopy.options,
      copyServerId: storageCopy.serverId,
    })
    .from(storage)
    .innerJoin(storageCopy, eq(storageCopy.storageId, storage.id))
    .where(
      and(
        eq(storage.kind, 'volume'),
        eq(storageCopy.provider, 'docker'),
        or(
          eq(storage.environmentId, environmentId),
          serviceIds.length > 0 ? inArray(storage.serviceId, serviceIds) : undefined
        )
      )
    )
  const used = await usedByOtherEnvironments(db, environmentId, [
    ...new Set(rows.map((row) => row.storageId)),
  ])
  return classifyDataVolumes(
    rows.map((row) => ({ ...row, usedElsewhere: used.has(row.storageId) }))
  )
}
