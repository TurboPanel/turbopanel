import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  container,
  environment,
  hosting,
  project,
  service,
} from './schema.ts'

/** Docker Compose states that are considered fully stopped (safe to cascade-delete). */
const STOPPED_CONTAINER_STATUSES = new Set(['exited', 'dead', 'removing'])

export const PROJECT_HAS_RUNNING_SERVICES_ERROR = 'project_has_running_services'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readContainerStatus(metadata: unknown): string | undefined {
  if (!isPlainObject(metadata)) return undefined
  return typeof metadata.status === 'string' ? metadata.status : undefined
}

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
  | { ok: false; error: 'project_has_running_services' }

/**
 * Cascade-delete a project and all child resources after verifying no active
 * containers remain. Order: container → hosting → service → environment → project.
 * Variables and managed rows cascade via FK (project-scoped managed from project;
 * environment-scoped managed when environments are deleted).
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
    const serviceRows = await db
      .select({ id: service.id })
      .from(service)
      .where(inArray(service.environmentId, environmentIds))

    const serviceIds = serviceRows.map((row) => row.id)

    if (serviceIds.length > 0) {
      const containerRows = await db
        .select({
          id: container.id,
          metadata: container.metadata,
        })
        .from(container)
        .where(inArray(container.serviceId, serviceIds))

      for (const row of containerRows) {
        if (isActiveContainerStatus(readContainerStatus(row.metadata))) {
          return { ok: false, error: 'project_has_running_services' }
        }
      }

      const hostingRows = await db
        .select({ id: hosting.id })
        .from(hosting)
        .where(inArray(hosting.serviceId, serviceIds))
      const hostingIds = hostingRows.map((row) => row.id)

      await db.transaction(async (tx) => {
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
      await tx
        .delete(environment)
        .where(inArray(environment.id, environmentIds))
      await tx.delete(project).where(eq(project.id, projectId))
    })
    return { ok: true }
  }

  await db.delete(project).where(eq(project.id, projectId))
  return { ok: true }
}
