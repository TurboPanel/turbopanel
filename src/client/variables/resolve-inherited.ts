import { and, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  environment,
  hosting,
  project,
  service,
  variable,
  workspace,
} from '../../lib/db/schema.ts'

export type ResolvedVariableEntry = {
  value: string
  isSecret: boolean
  isLiteral: boolean
  forBuild: boolean
  forRuntime: boolean
}

export type ResolvedVariableMap = Map<string, ResolvedVariableEntry>

type VariableRow = {
  key: string
  value: string
  isSecret: boolean
  isLiteral: boolean
  forBuild: boolean
  forRuntime: boolean
}

type VariableParentColumn =
  | 'organizationId'
  | 'workspaceId'
  | 'projectId'
  | 'environmentId'
  | 'serviceId'
  | 'hostingId'

function mergeVariables(
  target: ResolvedVariableMap,
  rows: VariableRow[],
): void {
  for (const row of rows) {
    target.set(row.key, {
      value: row.value,
      isSecret: row.isSecret,
      isLiteral: row.isLiteral,
      forBuild: row.forBuild,
      forRuntime: row.forRuntime,
    })
  }
}

async function loadVariablesForParent(
  db: Db,
  column: VariableParentColumn,
  id: string,
): Promise<VariableRow[]> {
  const columnRef = variable[column]
  return db
    .select({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
      isLiteral: variable.isLiteral,
      forBuild: variable.forBuild,
      forRuntime: variable.forRuntime,
    })
    .from(variable)
    .where(and(eq(columnRef, id), isNotNull(columnRef)))
}

async function mergeOrganizationChain(
  db: Db,
  chain: {
    organizationId: string
    workspaceId: string
    projectId: string
    environmentId: string
  },
  merged: ResolvedVariableMap,
): Promise<void> {
  mergeVariables(merged, await loadVariablesForParent(db, 'organizationId', chain.organizationId))
  mergeVariables(merged, await loadVariablesForParent(db, 'workspaceId', chain.workspaceId))
  mergeVariables(merged, await loadVariablesForParent(db, 'projectId', chain.projectId))
  mergeVariables(merged, await loadVariablesForParent(db, 'environmentId', chain.environmentId))
}

/**
 * Load hosting-scoped variables for every hosting under a service and merge
 * them into `target` (later overrides earlier). Hosting ids are sorted so
 * multi-hosting key conflicts are deterministic.
 *
 * Used at deploy so hostname-scoped overrides reach compose injection even
 * though Docker applies env at the service level (not per-vhost).
 */
export async function mergeHostingVariablesForService(
  db: Db,
  serviceId: string,
  target: ResolvedVariableMap,
): Promise<void> {
  const hostingRows = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(eq(hosting.serviceId, serviceId))

  const hostingIds = hostingRows
    .map((row) => row.id)
    .sort((a, b) => a.localeCompare(b))

  for (const hostingId of hostingIds) {
    mergeVariables(target, await loadVariablesForParent(db, 'hostingId', hostingId))
  }
}

/**
 * Resolve inherited variables for a service by walking the chain:
 * organization → workspace → project → environment → service (later overrides earlier).
 * Server-scoped variables are excluded. Hosting-scoped overrides are not included —
 * call {@link mergeHostingVariablesForService} when compose deploy needs them.
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
  await mergeOrganizationChain(db, chain, merged)
  mergeVariables(merged, await loadVariablesForParent(db, 'serviceId', serviceId))
  return merged
}

/**
 * Resolve inherited variables for a hosting by walking the chain:
 * organization → workspace → project → environment → service → hosting.
 */
export async function resolveInheritedVariablesForHosting(
  db: Db,
  hostingId: string,
): Promise<ResolvedVariableMap> {
  const chainRows = await db
    .select({
      organizationId: workspace.organizationId,
      workspaceId: project.workspaceId,
      projectId: environment.projectId,
      environmentId: service.environmentId,
      serviceId: hosting.serviceId,
    })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(hosting.id, hostingId))
    .limit(1)

  const chain = chainRows[0]
  if (!chain) {
    return new Map()
  }

  const merged: ResolvedVariableMap = new Map()
  await mergeOrganizationChain(db, chain, merged)
  mergeVariables(merged, await loadVariablesForParent(db, 'serviceId', chain.serviceId))
  mergeVariables(merged, await loadVariablesForParent(db, 'hostingId', hostingId))
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
      isLiteral: variable.isLiteral,
      forBuild: variable.forBuild,
      forRuntime: variable.forRuntime,
    })
    .from(variable)
    .where(and(eq(variable.serverId, serverId), isNotNull(variable.serverId)))

  const merged: ResolvedVariableMap = new Map()
  mergeVariables(merged, rows)
  return merged
}
