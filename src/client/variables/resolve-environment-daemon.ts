import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { DaemonSecretRecipient } from '../authn/data-encryption.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import { resolveColocatedServerId } from '../authn/install-state.ts'
import { resolveColocatedServerIdSet } from '../servers/colocated.ts'
import {
  environment,
  project,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'

export type { DaemonSecretRecipient } from '../authn/data-encryption.ts'

export type VariableParentRefs = {
  organizationId?: string | null
  workspaceId?: string | null
  projectId?: string | null
  environmentId?: string | null
  serviceId?: string | null
  serverId?: string | null
}

function parseMetadataServerId(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }
  const serverId = (metadata as Record<string, unknown>).serverId
  if (typeof serverId !== 'string' || serverId.length === 0) {
    return null
  }
  return serverId
}

async function loadActiveRecipient(
  db: Db,
  serverId: string,
  organizationId: string,
): Promise<DaemonSecretRecipient | null> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  if (!state || !isDaemonKeyActive(state.key)) {
    return null
  }

  const rows = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  const rowOrgId = rows[0]?.organizationId
  if (rowOrgId !== organizationId) {
    return null
  }

  return { serverId, keyId: state.key.id }
}

async function resolveOrgColocatedFallback(
  db: Db,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  const orgServerRows = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.organizationId, organizationId))

  const orgServerIds = orgServerRows.map((row) => row.id)
  if (orgServerIds.length > 0) {
    const colocatedIds = await resolveColocatedServerIdSet(
      db,
      registry,
      orgServerIds,
      { orgScoped: true },
    )
    for (const id of colocatedIds) {
      const recipient = await loadActiveRecipient(db, id, organizationId)
      if (recipient) return recipient
    }
  }

  const unassignedColocatedId = await resolveColocatedServerId(db, registry)
  if (unassignedColocatedId) {
    return loadActiveRecipient(db, unassignedColocatedId, organizationId)
  }

  return null
}

async function resolveFromEnvironmentChain(
  db: Db,
  environmentId: string,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  const envRows = await db
    .select({
      envMetadata: environment.metadata,
      projectMetadata: project.metadata,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(and(
      eq(environment.id, environmentId),
      eq(workspace.organizationId, organizationId),
    ))
    .limit(1)

  const envRow = envRows[0]
  if (!envRow) {
    return null
  }

  const envServerId = parseMetadataServerId(envRow.envMetadata)
  if (envServerId) {
    const recipient = await loadActiveRecipient(db, envServerId, organizationId)
    if (recipient) return recipient
  }

  const projectServerId = parseMetadataServerId(envRow.projectMetadata)
  if (projectServerId) {
    const recipient = await loadActiveRecipient(db, projectServerId, organizationId)
    if (recipient) return recipient
  }

  return resolveOrgColocatedFallback(db, organizationId, registry)
}

/**
 * Resolve the daemon that should receive sealed variable secrets for a variable parent.
 */
export async function resolveVariableDaemonRecipient(
  db: Db,
  parent: VariableParentRefs,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  if (parent.serverId) {
    return loadActiveRecipient(db, parent.serverId, organizationId)
  }

  if (parent.serviceId) {
    const serviceRows = await db
      .select({
        envMetadata: environment.metadata,
        projectMetadata: project.metadata,
      })
      .from(service)
      .innerJoin(environment, eq(environment.id, service.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(
        eq(service.id, parent.serviceId),
        eq(workspace.organizationId, organizationId),
      ))
      .limit(1)

    const row = serviceRows[0]
    if (!row) return null

    const envServerId = parseMetadataServerId(row.envMetadata)
    if (envServerId) {
      const recipient = await loadActiveRecipient(db, envServerId, organizationId)
      if (recipient) return recipient
    }

    const projectServerId = parseMetadataServerId(row.projectMetadata)
    if (projectServerId) {
      const recipient = await loadActiveRecipient(db, projectServerId, organizationId)
      if (recipient) return recipient
    }

    return resolveOrgColocatedFallback(db, organizationId, registry)
  }

  if (parent.environmentId) {
    return resolveFromEnvironmentChain(
      db,
      parent.environmentId,
      organizationId,
      registry,
    )
  }

  if (parent.projectId) {
    const projectRows = await db
      .select({ metadata: project.metadata })
      .from(project)
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(and(
        eq(project.id, parent.projectId),
        eq(workspace.organizationId, organizationId),
      ))
      .limit(1)

    const projectRow = projectRows[0]
    if (!projectRow) return null

    const projectServerId = parseMetadataServerId(projectRow.metadata)
    if (projectServerId) {
      const recipient = await loadActiveRecipient(db, projectServerId, organizationId)
      if (recipient) return recipient
    }

    return resolveOrgColocatedFallback(db, organizationId, registry)
  }

  if (parent.workspaceId) {
    const workspaceRows = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(
        eq(workspace.id, parent.workspaceId),
        eq(workspace.organizationId, organizationId),
      ))
      .limit(1)

    if (workspaceRows.length === 0) return null
    return resolveOrgColocatedFallback(db, organizationId, registry)
  }

  if (parent.organizationId) {
    if (parent.organizationId !== organizationId) return null
    return resolveOrgColocatedFallback(db, organizationId, registry)
  }

  return null
}

/**
 * Resolve the daemon that should receive sealed variable secrets for an environment.
 * Order: environment.metadata.serverId → project.metadata.serverId → org co-located fallback.
 */
export async function resolveEnvironmentDaemonRecipient(
  db: Db,
  environmentId: string,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  return resolveVariableDaemonRecipient(
    db,
    { environmentId },
    organizationId,
    registry,
  )
}
