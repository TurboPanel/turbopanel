import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  binding,
  container,
  deployment,
  environment,
  hosting,
  managed,
  project,
  service,
  tenancy,
} from '../../db/schema.ts'
import { applyStorageRetentionOnParentDelete } from '../storage/storage-records.ts'
import { purgeEnvironmentsComposeNetworks } from '../fabric/fabric-records.ts'

/** Docker Compose states that are considered fully stopped (safe to cascade-delete). */
const STOPPED_CONTAINER_STATUSES = new Set(['exited', 'dead', 'removing'])

export const PROJECT_HAS_RUNNING_SERVICES_ERROR = 'project_has_running_services'
export const MANAGED_RUNTIME_PRESENT_ERROR = 'managed_runtime_present'

/**
 * True when a container still needs an environment.stop before project delete.
 * Stopped statuses (`exited` / `dead` / `removing`) are allowed; missing/unknown
 * statuses are treated as active so we never cascade over live stacks.
 */
export function isActiveContainerStatus(status: string | undefined): boolean {
  if (status === undefined || status.length === 0) return true
  return !STOPPED_CONTAINER_STATUSES.has(status)
}

export type ProjectDeleteResult =
  | { ok: true }
  | {
      ok: false
      error: 'project_has_running_services' | 'managed_runtime_present'
    }

/**
 * Only tenant `service` containers gate deletion. Platform components
 * recorded against the environment (`ingress` ProxySQL, `ha` Orchestrator)
 * are shared per-server infrastructure whose lifecycle is server-scoped
 * ("does this server still front anything?") — the destroy fan-out and the
 * orphan sweep own their teardown, and a project must never be held hostage
 * by them.
 */
function hasActiveServiceContainer(
  rows: ReadonlyArray<{ status: string | null; role: string | null }>
): boolean {
  return rows.some(
    (row) => row.role === 'service' && isActiveContainerStatus(row.status ?? undefined)
  )
}

/** Deployment statuses that mean an apply is queued or running (or draining). */
const IN_PROGRESS_DEPLOYMENT_STATUSES = ['pending', 'applying', 'draining']

export const ENVIRONMENT_RUNNING_ERROR = 'environment_running'

type EnvironmentRowSet = {
  environmentIds: string[]
  serviceIds: string[]
  containerIds: string[]
  hostingIds: string[]
  /** Set when the whole project goes too (storage retention is scoped by it). */
  projectId?: string
}

/**
 * Drop the rows under the given environments, in FK-safe order: container ->
 * hosting -> tenancy -> binding -> service -> environment. Variables cascade
 * via FK. `tenancy.service_id` and `binding.service_id` are RESTRICT (safety
 * net on a direct service delete), so those edges go before services.
 * Shared by project delete and environment delete; run inside a transaction.
 */
async function dropEnvironmentRows(tx: Db, rows: EnvironmentRowSet): Promise<void> {
  const { environmentIds, serviceIds, containerIds, hostingIds } = rows
  await applyStorageRetentionOnParentDelete(tx, {
    ...(rows.projectId ? { projectIds: [rows.projectId] } : {}),
    environmentIds,
    ...(serviceIds.length > 0 ? { serviceIds } : {}),
  })
  // `network.environment_id` has no FK, so compose rows are not covered by cascade.
  await purgeEnvironmentsComposeNetworks(tx, environmentIds)
  if (containerIds.length > 0) {
    await tx.delete(container).where(inArray(container.id, containerIds))
  }
  if (hostingIds.length > 0) {
    await tx.delete(hosting).where(inArray(hosting.id, hostingIds))
  }
  if (serviceIds.length > 0) {
    await tx.delete(tenancy).where(inArray(tenancy.serviceId, serviceIds))
    await tx.delete(binding).where(inArray(binding.serviceId, serviceIds))
    await tx.delete(service).where(inArray(service.id, serviceIds))
  }
  await tx.delete(environment).where(inArray(environment.id, environmentIds))
}

type EnvironmentChildren = {
  serviceIds: string[]
  containerRows: Array<{ id: string; status: string | null; role: string | null }>
  hostingIds: string[]
}

async function loadEnvironmentChildren(
  db: Db,
  environmentIds: string[]
): Promise<EnvironmentChildren> {
  const serviceRows = await db
    .select({ id: service.id })
    .from(service)
    .where(inArray(service.environmentId, environmentIds))
  const serviceIds = serviceRows.map((row) => row.id)
  if (serviceIds.length === 0) {
    return { serviceIds, containerRows: [], hostingIds: [] }
  }
  const containerRows = await db
    .select({ id: container.id, status: container.status, role: container.role })
    .from(container)
    .where(inArray(container.serviceId, serviceIds))
  const hostingRows = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(inArray(hosting.serviceId, serviceIds))
  return { serviceIds, containerRows, hostingIds: hostingRows.map((row) => row.id) }
}

/**
 * Cascade-delete a project and all child resources after verifying no active
 * containers remain and no managed-engine rows still exist. Managed host
 * runtime must be torn down with `managed.destroy` first —
 * `managed.environment_id` is ON DELETE CASCADE, so a live row here would
 * otherwise drop the cluster without stopping Docker.
 */
export async function deleteProjectCascade(
  db: Db,
  projectId: string
): Promise<ProjectDeleteResult> {
  const envRows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))

  const environmentIds = envRows.map((row) => row.id)

  if (environmentIds.length === 0) {
    await db.transaction(async (tx) => {
      await applyStorageRetentionOnParentDelete(tx, { projectIds: [projectId] })
      await tx.delete(project).where(eq(project.id, projectId))
    })
    return { ok: true }
  }

  const managedRows = await db
    .select({ id: managed.id })
    .from(managed)
    .where(inArray(managed.environmentId, environmentIds))
  if (managedRows.length > 0) {
    return { ok: false, error: MANAGED_RUNTIME_PRESENT_ERROR }
  }

  const children = await loadEnvironmentChildren(db, environmentIds)
  if (hasActiveServiceContainer(children.containerRows)) {
    return { ok: false, error: 'project_has_running_services' }
  }

  await db.transaction(async (tx) => {
    await dropEnvironmentRows(tx, {
      projectId,
      environmentIds,
      serviceIds: children.serviceIds,
      containerIds: children.containerRows.map((row) => row.id),
      hostingIds: children.hostingIds,
    })
    await tx.delete(project).where(eq(project.id, projectId))
  })
  return { ok: true }
}

export type EnvironmentDeleteRefusal =
  typeof ENVIRONMENT_RUNNING_ERROR | typeof MANAGED_RUNTIME_PRESENT_ERROR

export type EnvironmentDeleteResult = { ok: true } | { ok: false; error: EnvironmentDeleteRefusal }

async function hasInProgressDeployment(db: Db, environmentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: deployment.id })
    .from(deployment)
    .where(
      and(
        eq(deployment.environmentId, environmentId),
        inArray(deployment.status, IN_PROGRESS_DEPLOYMENT_STATUSES)
      )
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Cascade-delete one environment and its services, hostings, containers,
 * tenancy, bindings and variables (the same rows, in the same order, as a
 * project delete). Refused with `environment_running` while a tenant container
 * is still active or a deploy is queued/applying/draining: the user must Stop
 * the environment first. `deployment` rows go with it (FK cascade).
 */
export async function deleteEnvironmentCascade(
  db: Db,
  environmentId: string
): Promise<EnvironmentDeleteResult> {
  const managedRows = await db
    .select({ id: managed.id })
    .from(managed)
    .where(eq(managed.environmentId, environmentId))
    .limit(1)
  if (managedRows.length > 0) {
    return { ok: false, error: MANAGED_RUNTIME_PRESENT_ERROR }
  }

  const children = await loadEnvironmentChildren(db, [environmentId])
  if (
    hasActiveServiceContainer(children.containerRows) ||
    (await hasInProgressDeployment(db, environmentId))
  ) {
    return { ok: false, error: ENVIRONMENT_RUNNING_ERROR }
  }

  await db.transaction((tx) =>
    dropEnvironmentRows(tx, {
      environmentIds: [environmentId],
      serviceIds: children.serviceIds,
      containerIds: children.containerRows.map((row) => row.id),
      hostingIds: children.hostingIds,
    })
  )
  return { ok: true }
}
