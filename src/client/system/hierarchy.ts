/**
 * System hierarchy provisioning for per-server hosting ingress, managed
 * (ProxySQL) ingress, and the co-located self-host stack (`turbopanel`
 * component: database/queue).
 *
 * Identity contract (do not store org/server ids in project/service/container
 * metadata — these keys are the source of truth):
 *
 * - `workspace.kind = 'turbopanel'` — one machine workspace per organization
 * - `project.metadata.type = 'system'` (`SYSTEM_PROJECT_METADATA_TYPE`) — shared
 *   platform stamp on all four projects; presentation-only, never an
 *   authorization source
 * - `project.metadata.component = 'hosting-ingress'` — shared Traefik project
 * - `project.metadata.component = 'managed-ingress'` — shared ProxySQL project
 * - `environment.server_id` under that project — one environment per enrolled
 *   server (identity is `project_id` + `server_id`, never
 *   `environment.metadata.component`)
 * - `service.composeServiceName = 'traefik'` — hosting ingress service
 * - `project.metadata.component = 'managed-ha'` — shared Orchestrator project
 * - `service.composeServiceName = 'proxysql'` — managed ingress service
 * - `service.composeServiceName = 'orchestrator'` — managed HA service
 * - hosting container via `ensureServiceIngressContainerAllocation` (`role='ingress'`,
 *   name `<serviceId>-in`)
 * - managed-ingress container via `ensureServiceIngressContainerAllocation` (`role='ingress'`,
 *   name `<serviceId>-in`)
 * - managed-ha container via `allocateEnvironmentContainers` (`role='turbopanel'`,
 *   name `<serviceId>-ha`)
 *
 * Self-host stack (co-located instance only):
 *
 * - `project.metadata.component = 'turbopanel'` — shared self-host project
 * - `environment.server_id` under that project — one environment on the
 *   colocated server
 * - `service.composeServiceName` in `database` / `queue`
 * - `container` via `allocateEnvironmentContainers` (`role='turbopanel'`, uuid naming)
 *
 * The TurboPanel workspace (`kind='turbopanel'`) is provisioned at
 * self-hosted install time (`completeInstanceInstall`), before any server
 * enrolls. Hierarchy functions below only *ensure* it (race-safe upsert) for
 * Workers/HA orgs and pre-existing installs. Full project/environment/service
 * rows still wait on server enrollment / enable-hosting (`server-registry`,
 * `PATCH /servers/:id`) and self-host bootstrap (`authn/install-state.ts`,
 * including daemon-connect assign). Must never be reached from public
 * workspace/project routes.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  container,
  environment,
  project,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../lib/db/workspace-kind.ts'
import {
  allocateEnvironmentContainers,
  type ContainerServiceSpec,
  ensureServiceIngressContainerAllocation,
} from '../environments/allocate-containers.ts'
import { managedHaContainerNameFromService } from '../../lib/naming.ts'

/**
 * Platform-owned project metadata type — never accepted by `POST /projects` or
 * `…/configure`; not an authorization source.
 */
export const SYSTEM_PROJECT_METADATA_TYPE = 'system'

export const SYSTEM_HOSTING_INGRESS_COMPONENT = 'hosting-ingress'
export const SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME = 'traefik'
export const SYSTEM_WORKSPACE_DISPLAY_NAME = 'TurboPanel'
export const SYSTEM_PROJECT_DISPLAY_NAME = 'HTTP/HTTPS Ingress'

/** Per-server ProxySQL shared frontend (managed engine ingress). */
export const SYSTEM_MANAGED_INGRESS_COMPONENT = 'managed-ingress'
export const SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME = 'proxysql'
export const SYSTEM_MANAGED_INGRESS_PROJECT_DISPLAY_NAME = 'Database Ingress'

/** Per-org Orchestrator Raft group (managed SQL HA). */
export const SYSTEM_MANAGED_HA_COMPONENT = 'managed-ha'
export const SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME = 'orchestrator'
export const SYSTEM_MANAGED_HA_PROJECT_DISPLAY_NAME = 'Database High-Availability'

/** Self-host project/environment identity key — not a wire `SystemComponentKey`. */
export const SYSTEM_SELF_HOST_COMPONENT = 'turbopanel'
export const SYSTEM_SELF_HOST_PROJECT_DISPLAY_NAME = 'Self Hosted TurboPanel Instance'
export const SYSTEM_SELF_HOST_ENVIRONMENT_DISPLAY_NAME = 'Production'

export const SYSTEM_SELF_HOST_DATABASE_COMPOSE_SERVICE_NAME = 'database'
export const SYSTEM_SELF_HOST_QUEUE_COMPOSE_SERVICE_NAME = 'queue'

/** Ordered so `ensureSelfHostSystemHierarchy` provisions deterministically. */
export const SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES = [
  SYSTEM_SELF_HOST_DATABASE_COMPOSE_SERVICE_NAME,
  SYSTEM_SELF_HOST_QUEUE_COMPOSE_SERVICE_NAME,
] as const

export type SystemSelfHostComposeServiceName =
  (typeof SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES)[number]

/** Wire `SystemComponentKey` for a self-host service is its compose service name. */
export function isSystemSelfHostComposeServiceName(
  value: string,
): value is SystemSelfHostComposeServiceName {
  return (SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES as readonly string[]).includes(value)
}

export type SystemHierarchyIds = {
  workspaceId: string
  projectId: string
  environmentId: string
  serviceId: string
  containerRowId: string
  containerName: string
}

export type SelfHostServiceAllocation = {
  composeServiceName: SystemSelfHostComposeServiceName
  serviceId: string
  containerRowId: string
  containerName: string
}

export type SelfHostSystemHierarchyIds = {
  workspaceId: string
  projectId: string
  environmentId: string
  services: SelfHostServiceAllocation[]
}

/**
 * Locate a system-workspace environment pinned to this server, if any.
 * Component identity comes from `project.metadata.component` — never from
 * `environment.metadata.component`.
 *
 * A server can now carry up to three system environments — hosting-ingress
 * (any enrolled server), managed-ingress / ProxySQL (when managed members
 * exist), and self-host `turbopanel` (colocated server only).
 * Pass `component` to disambiguate; omitting it returns the first match and
 * should only be used where at most one system environment can exist for the
 * server in question (e.g. non-colocated hosting-ingress delete-blocking).
 */
export async function findSystemEnvironmentForServer(
  db: Db,
  serverId: string,
  component?: string,
): Promise<string | null> {
  const rows = await (component === undefined
    ? db.execute<{ id: string }>(sql`
        SELECT e.id
        FROM environment e
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE e.server_id = ${serverId}::uuid
          AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
        LIMIT 1
      `)
    : db.execute<{ id: string }>(sql`
        SELECT e.id
        FROM environment e
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE e.server_id = ${serverId}::uuid
          AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
          AND p.metadata->>'component' = ${component}
        LIMIT 1
      `))
  return rows[0]?.id ?? null
}

/**
 * Race-safe upsert of the single system workspace per organization.
 * Shared by install (`completeInstanceInstall`) and hierarchy ensure paths.
 */
export async function ensureSystemWorkspace(
  tx: Db,
  organizationId: string,
): Promise<string> {
  // Partial unique index `uniq_workspace_organization_turbopanel` — Drizzle's
  // onConflictDoNothing cannot express `WHERE kind = 'turbopanel'`, so use raw SQL.
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO workspace (organization_id, name, kind)
    VALUES (
      ${organizationId}::uuid,
      ${SYSTEM_WORKSPACE_DISPLAY_NAME},
      ${WORKSPACE_KIND_TURBOPANEL}
    )
    ON CONFLICT (organization_id) WHERE kind = 'turbopanel' DO NOTHING
    RETURNING id
  `)
  if (inserted[0]?.id) return inserted[0].id

  const [existing] = await tx
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        eq(workspace.kind, WORKSPACE_KIND_TURBOPANEL),
      ),
    )
    .limit(1)

  if (!existing) {
    throw new Error(
      `system workspace missing after insert race (organization=${organizationId})`,
    )
  }
  if (existing.name !== SYSTEM_WORKSPACE_DISPLAY_NAME) {
    await tx
      .update(workspace)
      .set({
        name: SYSTEM_WORKSPACE_DISPLAY_NAME,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspace.id, existing.id))
  }
  return existing.id
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectMetadataRecord(value: unknown): Record<string, unknown> {
  return isMetadataRecord(value) ? { ...value } : {}
}

type ExistingSystemProjectRow = {
  id: string
  name: string | null
  metadata: unknown
}

type SystemComponentProjectParams = {
  workspaceId: string
  component: string
  displayName: string
  missingLabel: string
}

/**
 * Normalize a reused system project: current display name + reserved
 * `metadata.type`, preserving `component` and any other existing keys.
 */
async function normalizeExistingSystemProject(
  tx: Db,
  existing: ExistingSystemProjectRow,
  displayName: string,
): Promise<void> {
  const metadata = projectMetadataRecord(existing.metadata)
  const nameStale = existing.name !== displayName
  const typeStale = metadata.type !== SYSTEM_PROJECT_METADATA_TYPE
  if (!nameStale && !typeStale) return

  const patch: {
    name?: string
    metadata?: Record<string, unknown>
    updatedAt: string
  } = { updatedAt: new Date().toISOString() }
  if (nameStale) patch.name = displayName
  if (typeStale) {
    patch.metadata = { ...metadata, type: SYSTEM_PROJECT_METADATA_TYPE }
  }

  await tx
    .update(project)
    .set(patch)
    .where(eq(project.id, existing.id))
}

async function reuseExistingSystemProject(
  tx: Db,
  params: SystemComponentProjectParams,
): Promise<string> {
  const rows = await tx.execute<ExistingSystemProjectRow>(sql`
    SELECT id, name, metadata
    FROM project
    WHERE workspace_id = ${params.workspaceId}::uuid
      AND metadata->>'component' = ${params.component}
    LIMIT 1
  `)
  const existing = rows[0]
  if (!existing) {
    throw new Error(
      `${params.missingLabel} project missing after insert race (workspace=${params.workspaceId})`,
    )
  }
  await normalizeExistingSystemProject(tx, existing, params.displayName)
  return existing.id
}

async function ensureSystemComponentProject(
  tx: Db,
  params: SystemComponentProjectParams,
): Promise<string> {
  const metadataJson = JSON.stringify({
    type: SYSTEM_PROJECT_METADATA_TYPE,
    component: params.component,
  })

  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO project (workspace_id, name, metadata)
    VALUES (
      ${params.workspaceId}::uuid,
      ${params.displayName},
      ${metadataJson}::jsonb
    )
    ON CONFLICT (workspace_id, (metadata->>'component'))
      WHERE (metadata->>'component') IS NOT NULL
    DO NOTHING
    RETURNING id
  `)
  if (inserted[0]?.id) return inserted[0].id

  return await reuseExistingSystemProject(tx, params)
}

/**
 * Shared hosting-ingress project under the system workspace.
 *
 * Race-safe via partial unique `uniq_project_workspace_system_component`.
 */
async function ensureHostingIngressProject(
  tx: Db,
  workspaceId: string,
): Promise<string> {
  return await ensureSystemComponentProject(tx, {
    workspaceId,
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    displayName: SYSTEM_PROJECT_DISPLAY_NAME,
    missingLabel: 'hosting-ingress',
  })
}

/**
 * Per-server system environment under a known system project.
 *
 * Identity is `(project_id, server_id)` — never `environment.metadata.component`.
 * Race-safe via a row lock on the system project inside the caller transaction.
 */
async function ensureServerEnvironment(
  tx: Db,
  projectId: string,
  serverId: string,
  displayName: string,
): Promise<string> {
  // Serialize concurrent provisioners for this system project so two
  // callers cannot both observe "missing" and insert duplicate envs.
  await tx.execute(sql`
    SELECT id FROM project WHERE id = ${projectId}::uuid FOR UPDATE
  `)

  const [existing] = await tx
    .select({ id: environment.id })
    .from(environment)
    .where(
      and(
        eq(environment.projectId, projectId),
        eq(environment.serverId, serverId),
      ),
    )
    .limit(1)
  if (existing) return existing.id

  const [inserted] = await tx
    .insert(environment)
    .values({
      projectId,
      serverId,
      name: displayName,
    })
    .returning({ id: environment.id })

  if (!inserted) {
    throw new Error(
      `system environment insert failed (project=${projectId} server=${serverId})`,
    )
  }
  return inserted.id
}

/**
 * Idempotent service upsert under a system environment, keyed on the existing
 * `(environment_id, compose_service_name)` unique target. Shared by the
 * hosting-ingress traefik service and the self-host database/queue
 * services — display `name` defaults to the compose service name in both cases.
 */
async function ensureComposeService(
  tx: Db,
  environmentId: string,
  composeServiceName: string,
): Promise<string> {
  await tx
    .insert(service)
    .values({
      environmentId,
      name: composeServiceName,
      composeServiceName,
    })
    .onConflictDoNothing({
      target: [service.environmentId, service.composeServiceName],
    })

  const [row] = await tx
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.environmentId, environmentId),
        eq(service.composeServiceName, composeServiceName),
      ),
    )
    .limit(1)

  if (!row) {
    throw new Error(
      `compose service missing after upsert (environment=${environmentId} composeServiceName=${composeServiceName})`,
    )
  }
  return row.id
}

/**
 * Idempotently ensure workspace(kind=system) → project(hosting-ingress) →
 * environment(server) → service(traefik) → container(role=ingress).
 *
 * The full hierarchy runs in one transaction so concurrent callers observe
 * committed rows (or wait on the same serialization scope) rather than racing
 * past a half-built tree. Partial unique indexes back the workspace / project
 * identity keys; environment identity is `(project_id, server_id)` with a
 * project row lock; service and ingress container use existing unique targets
 * with `ON CONFLICT DO NOTHING`.
 */
async function ensureSystemHierarchyImpl(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SystemHierarchyIds> {
  return await db.transaction(async (tx) => {
    const workspaceId = await ensureSystemWorkspace(tx, params.organizationId)
    const projectId = await ensureHostingIngressProject(tx, workspaceId)
    const [serverRow] = await tx
      .select({ name: server.name })
      .from(server)
      .where(eq(server.id, params.serverId))
      .limit(1)
    const environmentDisplayName =
      serverRow?.name?.trim() || SYSTEM_PROJECT_DISPLAY_NAME
    const environmentId = await ensureServerEnvironment(
      tx,
      projectId,
      params.serverId,
      environmentDisplayName,
    )
    const serviceId = await ensureComposeService(
      tx,
      environmentId,
      SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
    )
    const allocation = await ensureServiceIngressContainerAllocation(tx, {
      serviceId,
      serverId: params.serverId,
      composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
    })

    return {
      workspaceId,
      projectId,
      environmentId,
      serviceId,
      containerRowId: allocation.containerRowId,
      containerName: allocation.containerName,
    }
  })
}

/**
 * Mutable provision hook — tests may replace `ensure` to force failures.
 * Production callers use {@link ensureSystemHierarchy}.
 */
export const systemHierarchyProvision = {
  ensure: ensureSystemHierarchyImpl,
}

export async function ensureSystemHierarchy(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SystemHierarchyIds> {
  return await systemHierarchyProvision.ensure(db, params)
}

/**
 * Shared managed-ingress (ProxySQL) project under the system workspace.
 *
 * Race-safe via partial unique `uniq_project_workspace_system_component`.
 */
async function ensureManagedIngressProject(
  tx: Db,
  workspaceId: string,
): Promise<string> {
  return await ensureSystemComponentProject(tx, {
    workspaceId,
    component: SYSTEM_MANAGED_INGRESS_COMPONENT,
    displayName: SYSTEM_MANAGED_INGRESS_PROJECT_DISPLAY_NAME,
    missingLabel: 'managed-ingress',
  })
}

/**
 * Idempotently ensure workspace(kind=system) → project(managed-ingress) →
 * environment(server) → service(proxysql) → container(role='ingress',
 * `<serviceId>-in`).
 *
 * Uses the same ingress allocation helper as hosting Traefik — ProxySQL is the
 * protocol frontend and shares `role='ingress'` + the `-in` name suffix
 * (distinct from bare-uuid self-host stack services).
 */
async function ensureManagedIngressHierarchyImpl(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SystemHierarchyIds> {
  return await db.transaction(async (tx) => {
    const workspaceId = await ensureSystemWorkspace(tx, params.organizationId)
    const projectId = await ensureManagedIngressProject(tx, workspaceId)
    const [serverRow] = await tx
      .select({ name: server.name })
      .from(server)
      .where(eq(server.id, params.serverId))
      .limit(1)
    const environmentDisplayName =
      serverRow?.name?.trim() || SYSTEM_MANAGED_INGRESS_PROJECT_DISPLAY_NAME
    const environmentId = await ensureServerEnvironment(
      tx,
      projectId,
      params.serverId,
      environmentDisplayName,
    )
    const serviceId = await ensureComposeService(
      tx,
      environmentId,
      SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
    )

    const allocation = await ensureServiceIngressContainerAllocation(tx, {
      serviceId,
      serverId: params.serverId,
      composeServiceName: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
    })

    return {
      workspaceId,
      projectId,
      environmentId,
      serviceId,
      containerRowId: allocation.containerRowId,
      containerName: allocation.containerName,
    }
  })
}

/**
 * Mutable provision hook — tests may replace `ensure` to force failures.
 * Production callers use {@link ensureManagedIngressHierarchy}.
 */
export const managedIngressHierarchyProvision = {
  ensure: ensureManagedIngressHierarchyImpl,
}

export async function ensureManagedIngressHierarchy(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SystemHierarchyIds> {
  return await managedIngressHierarchyProvision.ensure(db, params)
}

/**
 * Read-only lookup of an existing managed-ingress service/container for this
 * server. Does not provision rows. Used for empty-cluster teardown so we never
 * create hierarchy on a host that never had a ProxySQL stack.
 */
export async function findManagedIngressHierarchy(
  db: Db,
  params: { serverId: string },
): Promise<SystemHierarchyIds | null> {
  const rows = await db
    .select({
      workspaceId: workspace.id,
      projectId: project.id,
      environmentId: environment.id,
      serviceId: service.id,
      containerRowId: container.id,
      containerName: container.containerName,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .innerJoin(service, eq(service.environmentId, environment.id))
    .innerJoin(container, eq(container.serviceId, service.id))
    .where(
      and(
        eq(environment.serverId, params.serverId),
        eq(workspace.kind, WORKSPACE_KIND_TURBOPANEL),
        sql`${project.metadata}->>'component' = ${SYSTEM_MANAGED_INGRESS_COMPONENT}`,
        eq(service.composeServiceName, SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME),
        eq(container.role, 'ingress'),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    containerRowId: row.containerRowId,
    containerName: row.containerName,
  }
}

/**
 * Shared managed-ha (Orchestrator) project under the system workspace.
 *
 * Race-safe via partial unique `uniq_project_workspace_system_component`.
 */
async function ensureManagedHaProject(
  tx: Db,
  workspaceId: string,
): Promise<string> {
  return await ensureSystemComponentProject(tx, {
    workspaceId,
    component: SYSTEM_MANAGED_HA_COMPONENT,
    displayName: SYSTEM_MANAGED_HA_PROJECT_DISPLAY_NAME,
    missingLabel: 'managed-ha',
  })
}

async function ensureManagedHaHierarchyImpl(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SystemHierarchyIds> {
  return await db.transaction(async (tx) => {
    const workspaceId = await ensureSystemWorkspace(tx, params.organizationId)
    const projectId = await ensureManagedHaProject(tx, workspaceId)
    const [serverRow] = await tx
      .select({ name: server.name })
      .from(server)
      .where(eq(server.id, params.serverId))
      .limit(1)
    const environmentDisplayName =
      serverRow?.name?.trim() || SYSTEM_MANAGED_HA_PROJECT_DISPLAY_NAME
    const environmentId = await ensureServerEnvironment(
      tx,
      projectId,
      params.serverId,
      environmentDisplayName,
    )
    const serviceId = await ensureComposeService(
      tx,
      environmentId,
      SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
    )

    const allocations = await allocateEnvironmentContainers(tx, {
      environmentId,
      serverId: params.serverId,
      containerServices: [
        {
          serviceId,
          composeServiceName: SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
          instances: 1,
          role: 'turbopanel',
          explicitContainerName: managedHaContainerNameFromService(serviceId),
        },
      ],
      containerNaming: 'uuid',
      environmentServiceIds: [serviceId],
    })
    const allocation = allocations[0]
    if (!allocation) {
      throw new Error(
        `managed-ha container allocation missing (service=${serviceId})`,
      )
    }

    return {
      workspaceId,
      projectId,
      environmentId,
      serviceId,
      containerRowId: allocation.containerRowId,
      containerName: allocation.containerName,
    }
  })
}

export const managedHaHierarchyProvision = {
  ensure: ensureManagedHaHierarchyImpl,
}

export async function ensureManagedHaHierarchy(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SystemHierarchyIds> {
  return await managedHaHierarchyProvision.ensure(db, params)
}

/**
 * Read-only lookup of an existing managed-ha service/container for this
 * server. Does not provision rows. Used for empty-cluster teardown.
 */
export async function findManagedHaHierarchy(
  db: Db,
  params: { serverId: string },
): Promise<SystemHierarchyIds | null> {
  const rows = await db
    .select({
      workspaceId: workspace.id,
      projectId: project.id,
      environmentId: environment.id,
      serviceId: service.id,
      containerRowId: container.id,
      containerName: container.containerName,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .innerJoin(service, eq(service.environmentId, environment.id))
    .innerJoin(container, eq(container.serviceId, service.id))
    .where(
      and(
        eq(environment.serverId, params.serverId),
        eq(workspace.kind, WORKSPACE_KIND_TURBOPANEL),
        sql`${project.metadata}->>'component' = ${SYSTEM_MANAGED_HA_COMPONENT}`,
        eq(service.composeServiceName, SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    containerRowId: row.containerRowId,
    containerName: row.containerName,
  }
}

/**
 * Shared self-host (`turbopanel`) project under the system workspace.
 *
 * Race-safe via the same partial unique `uniq_project_workspace_system_component`
 * used by the hosting-ingress project — `metadata.component` discriminates.
 */
async function ensureSelfHostProject(
  tx: Db,
  workspaceId: string,
): Promise<string> {
  return await ensureSystemComponentProject(tx, {
    workspaceId,
    component: SYSTEM_SELF_HOST_COMPONENT,
    displayName: SYSTEM_SELF_HOST_PROJECT_DISPLAY_NAME,
    missingLabel: 'self-host',
  })
}

/**
 * Idempotently ensure workspace(kind=system) → project(turbopanel) →
 * environment(colocated server) → service(database/queue) →
 * container(role=system, uuid naming, 1 instance each).
 *
 * Same one-transaction / partial-unique discipline as
 * {@link ensureSystemHierarchyImpl}. No `organizationId` / `serverId` is
 * stored in project/service/container metadata — those columns are the
 * source of truth.
 */
async function ensureSelfHostSystemHierarchyImpl(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SelfHostSystemHierarchyIds> {
  return await db.transaction(async (tx) => {
    const workspaceId = await ensureSystemWorkspace(tx, params.organizationId)
    const projectId = await ensureSelfHostProject(tx, workspaceId)
    const environmentId = await ensureServerEnvironment(
      tx,
      projectId,
      params.serverId,
      SYSTEM_SELF_HOST_ENVIRONMENT_DISPLAY_NAME,
    )

    const composeServiceIds = new Map<SystemSelfHostComposeServiceName, string>()
    for (const composeServiceName of SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES) {
      composeServiceIds.set(
        composeServiceName,
        await ensureComposeService(tx, environmentId, composeServiceName),
      )
    }

    const containerServices: ContainerServiceSpec[] = SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES
      .map((composeServiceName) => ({
        serviceId: composeServiceIds.get(composeServiceName)!,
        composeServiceName,
        instances: 1,
        role: 'turbopanel' as const,
      }))

    const allocations = await allocateEnvironmentContainers(tx, {
      environmentId,
      serverId: params.serverId,
      containerServices,
      containerNaming: 'uuid',
      environmentServiceIds: [...composeServiceIds.values()],
    })
    const allocationByService = new Map(
      allocations.map((row) => [row.serviceId, row]),
    )

    const services: SelfHostServiceAllocation[] = SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES
      .map((composeServiceName) => {
        const serviceId = composeServiceIds.get(composeServiceName)!
        const allocation = allocationByService.get(serviceId)
        if (!allocation) {
          throw new Error(
            `self-host container allocation missing (service=${serviceId})`,
          )
        }
        return {
          composeServiceName,
          serviceId,
          containerRowId: allocation.containerRowId,
          containerName: allocation.containerName,
        }
      })

    return { workspaceId, projectId, environmentId, services }
  })
}

/**
 * Mutable provision hook — tests may replace `ensure` to force failures.
 * Production callers use {@link ensureSelfHostSystemHierarchy}.
 */
export const selfHostSystemHierarchyProvision = {
  ensure: ensureSelfHostSystemHierarchyImpl,
}

export async function ensureSelfHostSystemHierarchy(
  db: Db,
  params: { organizationId: string; serverId: string },
): Promise<SelfHostSystemHierarchyIds> {
  return await selfHostSystemHierarchyProvision.ensure(db, params)
}

/**
 * Cascade-delete one system environment's descendants (container → service →
 * environment). Does not touch the shared project or system workspace.
 * Caller must verify no active containers remain via
 * {@link isActiveContainerStatus} before invoking.
 */
export async function deleteSystemEnvironmentSubtree(
  tx: Db,
  environmentId: string,
): Promise<void> {
  const serviceRows = await tx
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = serviceRows.map((row) => row.id)

  if (serviceIds.length > 0) {
    await tx.delete(container).where(inArray(container.serviceId, serviceIds))
    await tx.delete(service).where(inArray(service.id, serviceIds))
  }

  await tx.delete(environment).where(eq(environment.id, environmentId))
}
