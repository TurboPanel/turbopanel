import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  container,
  environment,
  hosting,
  managed,
  project,
  service,
} from './schema.ts'
import { applyStorageRetentionOnParentDelete } from './storage-records.ts'
import { purgeEnvironmentsComposeNetworks } from './fabric-records.ts'

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
 * Cascade-delete a project and all child resources after verifying no active
 * containers remain and no managed-engine rows still exist. Order: container →
 * hosting → service → environment → project. Variables cascade via FK.
 * Managed host runtime must be torn down with `managed.destroy` first —
 * `managed.environment_id` is ON DELETE CASCADE, so a live row here would
 * otherwise drop the cluster without stopping Docker.
 */
export async function deleteProjectCascade(
  db: Db,
  projectId: string,
): Promise<ProjectDeleteResult> {
  const envRows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))

  const environmentIds = envRows.map((row) => row.id)

  if (environmentIds.length > 0) {
    const managedRows = await db
      .select({ id: managed.id })
      .from(managed)
      .where(inArray(managed.environmentId, environmentIds))
    if (managedRows.length > 0) {
      return { ok: false, error: MANAGED_RUNTIME_PRESENT_ERROR }
    }

    const serviceRows = await db
      .select({ id: service.id })
      .from(service)
      .where(inArray(service.environmentId, environmentIds))

    const serviceIds = serviceRows.map((row) => row.id)

    if (serviceIds.length > 0) {
      const containerRows = await db
        .select({
          id: container.id,
          status: container.status,
        })
        .from(container)
        .where(inArray(container.serviceId, serviceIds))

      for (const row of containerRows) {
        if (isActiveContainerStatus(row.status)) {
          return { ok: false, error: 'project_has_running_services' }
        }
      }

      const hostingRows = await db
        .select({ id: hosting.id })
        .from(hosting)
        .where(inArray(hosting.serviceId, serviceIds))
      const hostingIds = hostingRows.map((row) => row.id)

      await db.transaction(async (tx) => {
        await applyStorageRetentionOnParentDelete(tx, {
          projectIds: [projectId],
          environmentIds,
          serviceIds,
        })
        // `network.environment_id` has no FK, so compose rows are not covered by cascade.
        await purgeEnvironmentsComposeNetworks(tx, environmentIds)
        if (containerRows.length > 0) {
          await tx
            .delete(container)
            .where(inArray(container.id, containerRows.map((row) => row.id)))
        }
        if (hostingIds.length > 0) {
          await tx.delete(hosting).where(inArray(hosting.id, hostingIds))
        }
        await tx.delete(service).where(inArray(service.id, serviceIds))
        await tx
          .delete(environment)
          .where(inArray(environment.id, environmentIds))
        await tx.delete(project).where(eq(project.id, projectId))
      })
      return { ok: true }
    }

    await db.transaction(async (tx) => {
      await applyStorageRetentionOnParentDelete(tx, {
        projectIds: [projectId],
        environmentIds,
      })
      // `network.environment_id` has no FK, so compose rows are not covered by cascade.
      await purgeEnvironmentsComposeNetworks(tx, environmentIds)
      await tx
        .delete(environment)
        .where(inArray(environment.id, environmentIds))
      await tx.delete(project).where(eq(project.id, projectId))
    })
    return { ok: true }
  }

  await db.transaction(async (tx) => {
    await applyStorageRetentionOnParentDelete(tx, { projectIds: [projectId] })
    await tx.delete(project).where(eq(project.id, projectId))
  })
  return { ok: true }
}
