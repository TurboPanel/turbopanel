/**
 * What a deploy asks of the folder table: which services and volumes need a
 * folder on the server, and putting the planned folder references on the
 * payload.
 *
 * A service needs a folder when the deploy runs it on the host (a site, a
 * native app, a Git-backed source). A volume needs one when it lives in a
 * site owner's tree (`path` provider with an owner). A container-only service
 * and a Docker named volume have none. The payload always carries the
 * planned folders.
 */
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployServiceFolder,
  EnvironmentDeployStorageMaterial,
} from '../../contracts/commands/schemas.ts'
import type { PlanServiceInput, PlannedFolders } from '../../features/folders/allocate.ts'
import type { PreparedDeployCompose } from './deploy-prepare.ts'

type PreparedFolderInputs = Pick<
  PreparedDeployCompose,
  'sites' | 'nativeAppServices' | 'sourceMaterial' | 'hostings' | 'storageMaterial'
>

function firstHostname(
  hostings: readonly EnvironmentDeployHosting[],
  key: { serviceId?: string; composeServiceName?: string }
): string | null {
  for (const hosting of hostings) {
    if (hosting.protocol === 'tcp' || hosting.protocol === 'udp') continue
    const matches =
      (key.serviceId !== undefined && hosting.serviceId === key.serviceId) ||
      (key.composeServiceName !== undefined &&
        hosting.composeServiceName === key.composeServiceName)
    if (!matches) continue
    const name = hosting.hostnames.find((entry) => entry.length > 0)
    if (name !== undefined) return name
  }
  return null
}

/** The services of one server's deploy that run on the host, each once. */
export function servicesNeedingFolders(prepared: PreparedFolderInputs): PlanServiceInput[] {
  const byKey = new Map<string, PlanServiceInput>()
  // The same service shows up as a site, a native app and a source; one entry keeps what each knows.
  const add = (key: string, entry: PlanServiceInput) => {
    const known = byKey.get(key)
    const principalId = entry.principalId ?? known?.principalId
    const domain = entry.domain ?? known?.domain
    byKey.set(key, {
      ...known,
      ...entry,
      ...(principalId === undefined ? {} : { principalId }),
      ...(domain == null ? {} : { domain }),
    })
  }
  for (const site of prepared.sites) {
    add(site.composeServiceName, {
      composeServiceName: site.composeServiceName,
      ...(site.principal ? { principalId: site.principal.principalId } : {}),
      domain: firstHostname(prepared.hostings, { composeServiceName: site.composeServiceName }),
    })
  }
  for (const app of prepared.nativeAppServices) {
    add(app.composeServiceName, {
      composeServiceName: app.composeServiceName,
      serviceId: app.serviceId,
      domain: firstHostname(prepared.hostings, {
        serviceId: app.serviceId,
        composeServiceName: app.composeServiceName,
      }),
    })
  }
  for (const source of prepared.sourceMaterial) {
    add(source.composeServiceName, {
      composeServiceName: source.composeServiceName,
      ...(source.releaseServiceId ? { serviceId: source.releaseServiceId } : {}),
      domain: firstHostname(prepared.hostings, { composeServiceName: source.composeServiceName }),
    })
  }
  return [...byKey.values()]
}

/** Volumes of one server's deploy that live in a site owner's tree. */
export function volumesNeedingFolders(prepared: PreparedFolderInputs): string[] {
  return prepared.storageMaterial
    .filter((entry) => entry.provider === 'path' && typeof entry.principalId === 'string')
    .map((entry) => entry.storageId)
}

/**
 * Add the planned folder reference to each owned volume. An owned path volume
 * with no planned folder is refused: the server has no other place for it.
 */
export function withVolumeFolders(
  material: readonly EnvironmentDeployStorageMaterial[],
  planned: PlannedFolders
): EnvironmentDeployStorageMaterial[] {
  return material.map((entry) => {
    const folder = planned.volumes.get(entry.storageId)
    if (folder !== undefined) return { ...entry, folder }
    if (entry.provider === 'path' && typeof entry.principalId === 'string') {
      throw new Error(`Volume ${entry.storageId} has no planned folder on its server`)
    }
    return entry
  })
}

/** The planned folder of each host-run service, by service id, for the deploy payload. */
export function serviceFoldersFor(planned: PlannedFolders): EnvironmentDeployServiceFolder[] {
  return [...planned.services].map(([serviceId, folder]) => {
    const composeServiceName = planned.serviceNames.get(serviceId)
    return { serviceId, ...(composeServiceName ? { composeServiceName } : {}), folder }
  })
}
