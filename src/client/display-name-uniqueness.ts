import { and, eq, ne, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { normalizeDisplayNameKey } from '../lib/display-name-format.ts'
import { project, tag, task, workspace } from '../lib/db/schema.ts'

export { normalizeDisplayNameKey }

export const PROJECT_NAME_IN_USE_ERROR = 'project_name_in_use'
export const WORKSPACE_NAME_IN_USE_ERROR = 'workspace_name_in_use'
export const TAG_NAME_IN_USE_ERROR = 'tag_name_in_use'
export const TASK_NAME_IN_USE_ERROR = 'task_name_in_use'

/**
 * True when another project in the organization already uses this display name
 * (trimmed, case-insensitive). Null/blank names are never considered taken.
 */
export async function isProjectDisplayNameTaken(
  db: Db,
  organizationId: string,
  displayName: string | null | undefined,
  excludeProjectId?: string,
): Promise<boolean> {
  if (displayName == null) return false
  const key = normalizeDisplayNameKey(displayName)
  if (!key) return false

  const conditions = [
    eq(workspace.organizationId, organizationId),
    sql`lower(btrim(${project.name})) = ${key}`,
  ]
  if (excludeProjectId) {
    conditions.push(ne(project.id, excludeProjectId))
  }

  const rows = await db
    .select({ id: project.id })
    .from(project)
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}

/**
 * True when another workspace in the organization already uses this display name
 * (trimmed, case-insensitive), across all workspace kinds — including the
 * reserved TurboPanel workspace named `TurboPanel`. Null/blank names are never
 * considered taken.
 */
export async function isWorkspaceDisplayNameTaken(
  db: Db,
  organizationId: string,
  displayName: string | null | undefined,
  excludeWorkspaceId?: string,
): Promise<boolean> {
  if (displayName == null) return false
  const key = normalizeDisplayNameKey(displayName)
  if (!key) return false

  const conditions = [
    eq(workspace.organizationId, organizationId),
    sql`lower(btrim(${workspace.name})) = ${key}`,
  ]
  if (excludeWorkspaceId) {
    conditions.push(ne(workspace.id, excludeWorkspaceId))
  }

  const rows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}

/**
 * True when another tag in the organization already uses this display name
 * (trimmed, case-insensitive). Null/blank names are never considered taken.
 */
export async function isTagDisplayNameTaken(
  db: Db,
  organizationId: string,
  displayName: string | null | undefined,
  excludeTagId?: string,
): Promise<boolean> {
  if (displayName == null) return false
  const key = normalizeDisplayNameKey(displayName)
  if (!key) return false

  const conditions = [
    eq(tag.organizationId, organizationId),
    sql`lower(btrim(${tag.name})) = ${key}`,
  ]
  if (excludeTagId) {
    conditions.push(ne(tag.id, excludeTagId))
  }

  const rows = await db
    .select({ id: tag.id })
    .from(tag)
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}

/**
 * True when another task on the same service already uses this display name
 * (trimmed, case-insensitive). Null/blank names are never considered taken.
 * Scope is the service — `uniq_task_service_name` is the exact-match DB
 * backstop; trim + case-insensitive is what actually enforces the contract.
 */
export async function isTaskDisplayNameTaken(
  db: Db,
  serviceId: string,
  displayName: string | null | undefined,
  excludeTaskId?: string,
): Promise<boolean> {
  if (displayName == null) return false
  const key = normalizeDisplayNameKey(displayName)
  if (!key) return false

  const conditions = [
    eq(task.serviceId, serviceId),
    sql`lower(btrim(${task.name})) = ${key}`,
  ]
  if (excludeTaskId) {
    conditions.push(ne(task.id, excludeTaskId))
  }

  const rows = await db
    .select({ id: task.id })
    .from(task)
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}
