import type { EnvironmentDeployStorageMaterial } from '../../contracts/commands/schemas.ts'
import type { RegisteredComposeVolume } from '../../features/deploy/register-compose-volumes.ts'

/**
 * A docker storage row names a volume other than its own storage id (an old
 * `external` registration, or a pinned name). The host treats the name as
 * owned by the platform, so the deploy is refused instead of dropping the
 * row and every mount attached to it.
 */
export type DockerVolumeNameRefusal = {
  kind: 'docker_volume_name_unsupported'
  storageId: string
  storageName: string
}

export function isDockerVolumeNameRefusal(value: unknown): value is DockerVolumeNameRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'docker_volume_name_unsupported'
  )
}

export function dockerVolumeNameRefusal(
  storageId: string,
  storageName: string
): DockerVolumeNameRefusal {
  return { kind: 'docker_volume_name_unsupported', storageId, storageName }
}

export function appendUnseenRegisteredVolumes(
  material: EnvironmentDeployStorageMaterial[],
  seenStorageIds: ReadonlySet<string>,
  registeredVolumes: readonly RegisteredComposeVolume[],
  serverId: string
): DockerVolumeNameRefusal | null {
  for (const registered of registeredVolumes) {
    if (seenStorageIds.has(registered.storageId)) continue
    // `volumeName` must be the storage UUID the platform pinned; an old row
    // pinned to another name is refused rather than sent as an owned volume.
    if (registered.volumeName !== registered.storageId || !registered.managed) {
      return dockerVolumeNameRefusal(registered.storageId, registered.composeKey)
    }
    material.push({
      storageId: registered.storageId,
      locationId: registered.locationId,
      kind: 'volume',
      name: registered.composeKey,
      provider: 'docker',
      serverId,
      volumeName: registered.volumeName,
      managed: registered.managed,
      mounts: [],
    })
  }
  return null
}
