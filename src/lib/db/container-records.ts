import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { EnvironmentDeployContainer } from '../commands/schemas.ts'
import { container, service } from './schema.ts'

/** Matches `service_display_name_format_check` in schema. */
const SERVICE_DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]+$/

type ServiceRow = {
  id: string
  displayName: string | null
  composeServiceName: string | null
}

/** Prefer the dedicated column; fall back to displayName then id. */
function resolveServiceComposeName(row: ServiceRow): string {
  if (typeof row.composeServiceName === 'string' && row.composeServiceName.length > 0) {
    return row.composeServiceName
  }
  return row.displayName ?? row.id
}

function buildServiceComposeIndex(serviceRows: ServiceRow[]): {
  serviceIds: Set<string>
  serviceIdByComposeName: Map<string, string>
} {
  const serviceIds = new Set(serviceRows.map((row) => row.id))
  const serviceIdByComposeName = new Map<string, string>()
  for (const row of serviceRows) {
    serviceIdByComposeName.set(resolveServiceComposeName(row), row.id)
  }
  return { serviceIds, serviceIdByComposeName }
}

/**
 * Deploy creates containers before hostings/services are configured in the UI.
 * Upsert missing `service` rows for reported compose names so container FKs can
 * resolve without requiring a prior hostname save.
 */
async function ensureServicesForReportedContainers(
  db: Db,
  environmentId: string,
  containers: EnvironmentDeployContainer[],
  serviceRows: ServiceRow[],
): Promise<ServiceRow[]> {
  const { serviceIds, serviceIdByComposeName } = buildServiceComposeIndex(serviceRows)

  const missingNames = new Set<string>()
  for (const reported of containers) {
    if (
      reported.serviceId !== undefined &&
      serviceIds.has(reported.serviceId)
    ) {
      continue
    }
    if (serviceIdByComposeName.has(reported.composeServiceName)) continue
    if (!SERVICE_DISPLAY_NAME_RE.test(reported.composeServiceName)) continue
    if (reported.composeServiceName.length < 1 || reported.composeServiceName.length > 255) {
      continue
    }
    missingNames.add(reported.composeServiceName)
  }

  if (missingNames.size === 0) return serviceRows

  const names = [...missingNames].sort((a, b) => a.localeCompare(b))
  const inserted = await db
    .insert(service)
    .values(
      names.map((composeServiceName) => ({
        environmentId,
        displayName: composeServiceName,
        composeServiceName,
      })),
    )
    .returning({
      id: service.id,
      displayName: service.displayName,
      composeServiceName: service.composeServiceName,
    })

  return [...serviceRows, ...inserted]
}

export type ReconcileEnvironmentContainersParams = {
  serverId: string
  environmentId: string
  containers: EnvironmentDeployContainer[]
}

/**
 * Replace container rows for all services in an environment on a server after a
 * successful deploy that included an authoritative `containers` report.
 *
 * Deletes every existing row for the environment's services on the target
 * server, then inserts the matched report (which may be empty). Idempotent on
 * redeploy; supports 1:N (multiple containers per compose service). Stores
 * ids/status only — no logs or blobs.
 *
 * When the report names compose services that have no `service` row yet
 * (common when deploy runs before hostname config), those rows are created
 * so containers can be pinned.
 */
export async function reconcileEnvironmentContainers(
  db: Db,
  params: ReconcileEnvironmentContainersParams,
): Promise<void> {
  const { serverId, environmentId, containers } = params

  let serviceRows = await db
    .select({
      id: service.id,
      displayName: service.displayName,
      composeServiceName: service.composeServiceName,
    })
    .from(service)
    .where(eq(service.environmentId, environmentId))

  // Empty authoritative report with no services: nothing to clear or insert.
  if (serviceRows.length === 0 && containers.length === 0) {
    return
  }

  serviceRows = await ensureServicesForReportedContainers(
    db,
    environmentId,
    containers,
    serviceRows,
  )

  if (serviceRows.length === 0) return

  const { serviceIds, serviceIdByComposeName } = buildServiceComposeIndex(serviceRows)

  const matched: Array<{
    serviceId: string
    containerId: string
    containerName: string
    status: string
    composeServiceName: string
  }> = []

  for (const reported of containers) {
    let serviceId: string | undefined
    if (reported.serviceId !== undefined && serviceIds.has(reported.serviceId)) {
      serviceId = reported.serviceId
    } else {
      serviceId = serviceIdByComposeName.get(reported.composeServiceName)
    }
    if (serviceId === undefined) continue

    matched.push({
      serviceId,
      containerId: reported.containerId,
      containerName: reported.containerName,
      status: reported.status,
      composeServiceName: reported.composeServiceName,
    })
  }

  const allServiceIdList = serviceRows.map((row) => row.id)

  await db.transaction(async (tx) => {
    await tx
      .delete(container)
      .where(
        and(
          eq(container.serverId, serverId),
          inArray(container.serviceId, allServiceIdList),
        ),
      )

    if (matched.length === 0) return

    await tx.insert(container).values(
      matched.map((row) => ({
        serviceId: row.serviceId,
        serverId,
        containerId: row.containerId,
        containerName: row.containerName,
        status: row.status,
        composeServiceName: row.composeServiceName,
      })),
    )
  })
}
