/**
 * What a deploy asks of the folder table: which services and volumes need a
 * folder on the server, and putting the planned folder references on the
 * payload.
 *
 * A service needs a folder when the deploy runs it on the host (a site, a
 * native app, a Git-backed source). A volume needs one when it lives in a
 * site owner's tree (`path` provider with an owner). A container-only service
 * and a Docker named volume have none. The old fields on the payload stay
 * authoritative and are sent as before; `folder` rides beside them.
 */
import type {
  EnvironmentDeployHosting,
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
      (key.composeServiceName !== undefined && hosting.composeServiceName === key.composeServiceName)
    if (!matches) continue
    const name = hosting.hostnames.find((entry) => entry.length > 0)
    if (name !== undefined) return name
  }
  return null
}

/** The services of one server's deploy that run on the host, each once. */
export function servicesNeedingFolders(prepared: PreparedFolderInputs): PlanServiceInput[] {
  const byKey = new Map<string, PlanServiceInput>()
  const add = (entry: PlanServiceInput, key: string) => {
    const known = byKey.get(key)
    byKey.set(key, { ...known, ...entry, principalId: entry.principalId ?? known?.principalId })
  }
  for (const site of prepared.sites) {
    add(
      {
        composeServiceName: site.composeServiceName,
        ...(site.principal ? { principalId: site.principal.principalId } : {}),
        domain: firstHostname(prepared.hostings, { composeServiceName: site.composeServiceName }),
      },
      site.composeServiceName
    )
  }
  for (const app of prepared.nativeAppServices) {
    add(
      {
        composeServiceName: app.composeServiceName,
        serviceId: app.serviceId,
        domain: firstHostname(prepared.hostings, {
          serviceId: app.serviceId,
          composeServiceName: app.composeServiceName,
        }),
      },
      app.composeServiceName
    )
  }
  for (const source of prepared.sourceMaterial) {
    add(
      {
        composeServiceName: source.composeServiceName,
        ...(source.releaseServiceId ? { serviceId: source.releaseServiceId } : {}),
        domain: firstHostname(prepared.hostings, {
          composeServiceName: source.composeServiceName,
        }),
      },
      source.composeServiceName
    )
  }
  return [...byKey.values()].map((entry) =>
    entry.principalId === undefined ? stripPrincipal(entry) : entry
  )
}

function stripPrincipal(entry: PlanServiceInput): PlanServiceInput {
  const { principalId: _unused, ...rest } = entry
  return rest
}

/** Volumes of one server's deploy that live in a site owner's tree. */
export function volumesNeedingFolders(prepared: PreparedFolderInputs): string[] {
  return prepared.storageMaterial
    .filter((entry) => entry.provider === 'path' && typeof entry.principalId === 'string')
    .map((entry) => entry.storageId)
}

/** Add the planned folder reference beside the old fields of each owned volume. */
export function withVolumeFolders(
  material: readonly EnvironmentDeployStorageMaterial[],
  planned: PlannedFolders | undefined
): EnvironmentDeployStorageMaterial[] {
  if (planned === undefined || planned.volumes.size === 0) return [...material]
  return material.map((entry) => {
    const folder = planned.volumes.get(entry.storageId)
    return folder === undefined ? entry : { ...entry, folder }
  })
}
