import { and, eq, ne, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { normalizeDisplayNameKey } from '../lib/display-name-format.ts'
import { project, workspace } from '../lib/db/schema.ts'

export { normalizeDisplayNameKey }

export const PROJECT_NAME_IN_USE_ERROR = 'project_name_in_use'
export const WORKSPACE_NAME_IN_USE_ERROR = 'workspace_name_in_use'

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
 * reserved TurboPanel platform workspace named `TurboPanel Platform`. Null/blank names are never
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
