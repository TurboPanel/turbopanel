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
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { folder } from '../../db/schema.ts'
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

/** A compose service key the host can be asked to remove a site for. */
const REMOVABLE_SERVICE_NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * The service rows of the environment that its compose document no longer
 * names: the services that left. A row is listed only when the document's
 * services are known; an unreadable or empty `services` mapping lists nothing,
 * so a partial document can never read as "everything left". A key the host
 * would refuse (`.`, `..` or one with characters outside a compose service
 * name) is dropped, so one odd key never makes the host refuse the whole deploy.
 */
export function removedServiceRows<T extends { composeServiceName: string }>(
  serviceRows: readonly T[],
  documentServices: Record<string, unknown> | undefined
): T[] {
  if (documentServices === undefined) return []
  const names = Object.keys(documentServices)
  if (names.length === 0) return []
  const current = new Set(names)
  const seen = new Set<string>()
  return serviceRows
    .filter((row) => {
      const name = row.composeServiceName
      if (current.has(name) || seen.has(name)) return false
      if (name === '.' || name === '..' || !REMOVABLE_SERVICE_NAME_RE.test(name)) return false
      seen.add(name)
      return true
    })
    .sort((a, b) => a.composeServiceName.localeCompare(b.composeServiceName))
}

/**
 * Of the services that left the compose file, the ones whose site this server
 * may still hold: a service folder row of the environment on this server that
 * is still `present` or `planned`. The deploy that succeeds with the service
 * gone marks that row an orphan, so the name is not sent again on every later
 * deploy; a deploy that fails leaves it, and the next one asks again. A service
 * that never had a folder here (a container, or a site with no owner) is never
 * listed. Names come back sorted.
 */
export async function removedSitesOnServer(
  db: Pick<Db, 'select'>,
  params: {
    environmentId: string
    serverId: string
    removed: readonly { id: string; composeServiceName: string }[]
  }
): Promise<string[]> {
  if (params.removed.length === 0) return []
  const held = await db
    .select({ serviceId: folder.serviceId })
    .from(folder)
    .where(
      and(
        eq(folder.environmentId, params.environmentId),
        eq(folder.serverId, params.serverId),
        eq(folder.kind, 'service'),
        inArray(folder.state, ['present', 'planned']),
        inArray(
          folder.serviceId,
          params.removed.map((row) => row.id)
        )
      )
    )
  const ids = new Set(held.map((row) => row.serviceId))
  return params.removed
    .filter((row) => ids.has(row.id))
    .map((row) => row.composeServiceName)
    .sort((a, b) => a.localeCompare(b))
}
