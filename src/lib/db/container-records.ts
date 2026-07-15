import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { EnvironmentDeployContainer } from '../commands/schemas.ts'
import { container, service } from './schema.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Same resolution as deploy-routes: metadata.composeServiceName → displayName → id. */
function readComposeServiceName(metadata: unknown, fallback: string): string {
  if (isPlainObject(metadata) && typeof metadata.composeServiceName === 'string') {
    return metadata.composeServiceName
  }
  return fallback
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
 */
export async function reconcileEnvironmentContainers(
  db: Db,
  params: ReconcileEnvironmentContainersParams,
): Promise<void> {
  const { serverId, environmentId, containers } = params

  const serviceRows = await db
    .select({
      id: service.id,
      displayName: service.displayName,
      metadata: service.metadata,
    })
    .from(service)
    .where(eq(service.environmentId, environmentId))

  if (serviceRows.length === 0) return

  const serviceIds = new Set(serviceRows.map((row) => row.id))
  const serviceIdByComposeName = new Map<string, string>()
  for (const row of serviceRows) {
    const composeName = readComposeServiceName(row.metadata, row.displayName ?? row.id)
    serviceIdByComposeName.set(composeName, row.id)
  }

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
        metadata: {
          containerId: row.containerId,
          containerName: row.containerName,
          status: row.status,
          composeServiceName: row.composeServiceName,
        },
      })),
    )
  })
}
