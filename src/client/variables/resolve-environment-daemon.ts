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
  hosting,
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
  hostingId?: string | null
  serverId?: string | null
}

type ChainMetadata = {
  envMetadata: unknown
  projectMetadata: unknown
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

async function tryMetadataThenFallback(
  db: Db,
  organizationId: string,
  metadata: unknown,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  const serverId = parseMetadataServerId(metadata)
  if (serverId) {
    const recipient = await loadActiveRecipient(db, serverId, organizationId)
    if (recipient) return recipient
  }
  return resolveOrgColocatedFallback(db, organizationId, registry)
}

async function tryEnvThenProjectThenFallback(
  db: Db,
  organizationId: string,
  chain: ChainMetadata,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  const envServerId = parseMetadataServerId(chain.envMetadata)
  if (envServerId) {
    const recipient = await loadActiveRecipient(db, envServerId, organizationId)
    if (recipient) return recipient
  }

  const projectServerId = parseMetadataServerId(chain.projectMetadata)
  if (projectServerId) {
    const recipient = await loadActiveRecipient(db, projectServerId, organizationId)
    if (recipient) return recipient
  }

  return resolveOrgColocatedFallback(db, organizationId, registry)
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
  if (!envRow) return null

  return tryEnvThenProjectThenFallback(db, organizationId, envRow, registry)
}

async function resolveFromHostingId(
  db: Db,
  hostingId: string,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  const hostingRows = await db
    .select({
      envMetadata: environment.metadata,
      projectMetadata: project.metadata,
    })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(and(
      eq(hosting.id, hostingId),
      eq(workspace.organizationId, organizationId),
    ))
    .limit(1)

  const row = hostingRows[0]
  if (!row) return null

  return tryEnvThenProjectThenFallback(db, organizationId, row, registry)
}

async function resolveFromServiceId(
  db: Db,
  serviceId: string,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
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
      eq(service.id, serviceId),
      eq(workspace.organizationId, organizationId),
    ))
    .limit(1)

  const row = serviceRows[0]
  if (!row) return null

  return tryEnvThenProjectThenFallback(db, organizationId, row, registry)
}

async function resolveFromProjectId(
  db: Db,
  projectId: string,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  const projectRows = await db
    .select({ metadata: project.metadata })
    .from(project)
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(and(
      eq(project.id, projectId),
      eq(workspace.organizationId, organizationId),
    ))
    .limit(1)

  const projectRow = projectRows[0]
  if (!projectRow) return null

  return tryMetadataThenFallback(db, organizationId, projectRow.metadata, registry)
}

async function resolveFromWorkspaceId(
  db: Db,
  workspaceId: string,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  const workspaceRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(and(
      eq(workspace.id, workspaceId),
      eq(workspace.organizationId, organizationId),
    ))
    .limit(1)

  if (workspaceRows.length === 0) return null
  return resolveOrgColocatedFallback(db, organizationId, registry)
}

async function resolveFromOrganizationId(
  db: Db,
  parentOrganizationId: string,
  organizationId: string,
  registry?: DaemonCellRegistry,
): Promise<DaemonSecretRecipient | null> {
  if (parentOrganizationId !== organizationId) return null
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
  if (parent.hostingId) {
    return resolveFromHostingId(db, parent.hostingId, organizationId, registry)
  }
  if (parent.serviceId) {
    return resolveFromServiceId(db, parent.serviceId, organizationId, registry)
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
    return resolveFromProjectId(db, parent.projectId, organizationId, registry)
  }
  if (parent.workspaceId) {
    return resolveFromWorkspaceId(db, parent.workspaceId, organizationId, registry)
  }
  if (parent.organizationId) {
    return resolveFromOrganizationId(
      db,
      parent.organizationId,
      organizationId,
      registry,
    )
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
