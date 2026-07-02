import { and, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  environment,
  project,
  service,
  variable,
  workspace,
} from '../../lib/db/schema.ts'

export type ResolvedVariableEntry = {
  value: string
  isSecret: boolean
}

export type ResolvedVariableMap = Map<string, ResolvedVariableEntry>

type VariableRow = {
  key: string
  value: string
  isSecret: boolean
}

function mergeVariables(
  target: ResolvedVariableMap,
  rows: VariableRow[],
): void {
  for (const row of rows) {
    target.set(row.key, { value: row.value, isSecret: row.isSecret })
  }
}

async function loadVariablesForParent(
  db: Db,
  column: 'organizationId' | 'workspaceId' | 'projectId' | 'environmentId' | 'serviceId',
  id: string,
): Promise<VariableRow[]> {
  const columnRef = variable[column]
  return db
    .select({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
    })
    .from(variable)
    .where(and(eq(columnRef, id), isNotNull(columnRef)))
}

/**
 * Resolve inherited variables for a service by walking the chain:
 * organization → workspace → project → environment → service (later overrides earlier).
 * Server-scoped variables are excluded.
 */
export async function resolveInheritedVariablesForService(
  db: Db,
  serviceId: string,
): Promise<ResolvedVariableMap> {
  const chainRows = await db
    .select({
      organizationId: workspace.organizationId,
      workspaceId: project.workspaceId,
      projectId: environment.projectId,
      environmentId: service.environmentId,
    })
    .from(service)
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(service.id, serviceId))
    .limit(1)

  const chain = chainRows[0]
  if (!chain) {
    return new Map()
  }

  const merged: ResolvedVariableMap = new Map()

  const orgRows = await loadVariablesForParent(db, 'organizationId', chain.organizationId)
  mergeVariables(merged, orgRows)

  const workspaceRows = await loadVariablesForParent(db, 'workspaceId', chain.workspaceId)
  mergeVariables(merged, workspaceRows)

  const projectRows = await loadVariablesForParent(db, 'projectId', chain.projectId)
  mergeVariables(merged, projectRows)

  const environmentRows = await loadVariablesForParent(db, 'environmentId', chain.environmentId)
  mergeVariables(merged, environmentRows)

  const serviceRows = await loadVariablesForParent(db, 'serviceId', serviceId)
  mergeVariables(merged, serviceRows)

  return merged
}

/**
 * Resolve inherited variables for an environment (excludes service-level overrides).
 */
export async function resolveInheritedVariablesForEnvironment(
  db: Db,
  environmentId: string,
): Promise<ResolvedVariableMap> {
  const chainRows = await db
    .select({
      organizationId: workspace.organizationId,
      workspaceId: project.workspaceId,
      projectId: environment.projectId,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(environment.id, environmentId))
    .limit(1)

  const chain = chainRows[0]
  if (!chain) {
    return new Map()
  }

  const merged: ResolvedVariableMap = new Map()

  mergeVariables(merged, await loadVariablesForParent(db, 'organizationId', chain.organizationId))
  mergeVariables(merged, await loadVariablesForParent(db, 'workspaceId', chain.workspaceId))
  mergeVariables(merged, await loadVariablesForParent(db, 'projectId', chain.projectId))
  mergeVariables(merged, await loadVariablesForParent(db, 'environmentId', environmentId))

  return merged
}

/**
 * Load server-scoped variables separately (not part of the inheritance chain).
 */
export async function resolveServerScopedVariables(
  db: Db,
  serverId: string,
): Promise<ResolvedVariableMap> {
  const rows = await db
    .select({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
    })
    .from(variable)
    .where(and(eq(variable.serverId, serverId), isNotNull(variable.serverId)))

  const merged: ResolvedVariableMap = new Map()
  mergeVariables(merged, rows)
  return merged
}
