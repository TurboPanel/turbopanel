/**
 * System hierarchy provisioning for per-server hosting ingress and the
 * co-located self-host stack (`turbopanel` component: database/queue/analytics).
 *
 * Identity contract (do not store org/server ids in project/service/container
 * metadata — these keys are the source of truth):
 *
 * - `workspace.kind = 'system'` — one machine workspace per organization
 * - `project.metadata.component = 'hosting-ingress'` — shared ingress project
 * - `environment.server_id` under that project — one environment per enrolled
 *   server (identity is `project_id` + `server_id`, never
 *   `environment.metadata.component`)
 * - `service.composeServiceName = 'traefik'` — ingress service under that env
 * - `container` via `ensureServiceIngressContainerAllocation` (`role='ingress'`)
 *
 * Self-host stack (co-located instance only):
 *
 * - `project.metadata.component = 'turbopanel'` — shared self-host project
 * - `environment.server_id` under that project — one environment on the
 *   colocated server
 * - `service.composeServiceName` in `database` / `queue` / `analytics`
 * - `container` via `allocateEnvironmentContainers` (`role='system'`, uuid naming)
 *
 * The system workspace (`kind='system'`) is provisioned at self-hosted install
 * time (`completeInstanceInstall`), before any server enrolls. Hierarchy
 * functions below only *ensure* it (race-safe upsert) for Workers/HA orgs and
 * pre-existing installs. Full project/environment/service rows still wait on
 * server enrollment / enable-hosting (`server-registry`, `PATCH /servers/:id`)
 * and self-host bootstrap (`authn/install-state.ts`, Deno maintenance timer).
 * Must never be reached from public workspace/project routes.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  container,
  environment,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import { WORKSPACE_KIND_SYSTEM } from '../../lib/db/workspace-kind.ts'
import {
  allocateEnvironmentContainers,
  type ContainerServiceSpec,
  ensureServiceIngressContainerAllocation,
} from '../environments/allocate-containers.ts'

export const SYSTEM_HOSTING_INGRESS_COMPONENT = 'hosting-ingress'
export const SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME = 'traefik'
export const SYSTEM_WORKSPACE_DISPLAY_NAME = 'System'
export const SYSTEM_PROJECT_DISPLAY_NAME = 'Server Ingress'

/** Self-host project/environment identity key — not a wire `SystemComponentKey`. */
export const SYSTEM_SELF_HOST_COMPONENT = 'turbopanel'
export const SYSTEM_SELF_HOST_PROJECT_DISPLAY_NAME = 'TurboPanel'
export const SYSTEM_SELF_HOST_ENVIRONMENT_DISPLAY_NAME = 'Production'

export const SYSTEM_SELF_HOST_DATABASE_COMPOSE_SERVICE_NAME = 'database'
export const SYSTEM_SELF_HOST_QUEUE_COMPOSE_SERVICE_NAME = 'queue'
export const SYSTEM_SELF_HOST_ANALYTICS_COMPOSE_SERVICE_NAME = 'analytics'

/** Ordered so `ensureSelfHostSystemHierarchy` provisions deterministically. */
export const SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES = [
  SYSTEM_SELF_HOST_DATABASE_COMPOSE_SERVICE_NAME,
  SYSTEM_SELF_HOST_QUEUE_COMPOSE_SERVICE_NAME,
  SYSTEM_SELF_HOST_ANALYTICS_COMPOSE_SERVICE_NAME,
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
 * A server can now carry up to two system environments — hosting-ingress
 * (any enrolled server) and self-host `turbopanel` (colocated server only).
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
          AND w.kind = ${WORKSPACE_KIND_SYSTEM}
        LIMIT 1
      `)
    : db.execute<{ id: string }>(sql`
        SELECT e.id
        FROM environment e
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE e.server_id = ${serverId}::uuid
          AND w.kind = ${WORKSPACE_KIND_SYSTEM}
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
  // Partial unique index `uniq_workspace_organization_system` — Drizzle's
  // onConflictDoNothing cannot express `WHERE kind = 'system'`, so use raw SQL.
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO workspace (organization_id, name, kind)
    VALUES (
      ${organizationId}::uuid,
      ${SYSTEM_WORKSPACE_DISPLAY_NAME},
      ${WORKSPACE_KIND_SYSTEM}
    )
    ON CONFLICT (organization_id) WHERE kind = 'system' DO NOTHING
    RETURNING id
  `)
  if (inserted[0]?.id) return inserted[0].id

  const [existing] = await tx
    .select({ id: workspace.id })
    .from(workspace)
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        eq(workspace.kind, WORKSPACE_KIND_SYSTEM),
      ),
    )
    .limit(1)

  if (!existing) {
    throw new Error(
      `system workspace missing after insert race (organization=${organizationId})`,
    )
  }
  return existing.id
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
  const metadataJson = JSON.stringify({
    type: 'docker-compose',
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
  })

  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO project (workspace_id, name, metadata)
    VALUES (
      ${workspaceId}::uuid,
      ${SYSTEM_PROJECT_DISPLAY_NAME},
      ${metadataJson}::jsonb
    )
    ON CONFLICT (workspace_id, (metadata->>'component'))
      WHERE (metadata->>'component') IS NOT NULL
    DO NOTHING
    RETURNING id
  `)
  if (inserted[0]?.id) return inserted[0].id

  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id
    FROM project
    WHERE workspace_id = ${workspaceId}::uuid
      AND metadata->>'component' = ${SYSTEM_HOSTING_INGRESS_COMPONENT}
    LIMIT 1
  `)
  const existing = rows[0]?.id
  if (!existing) {
    throw new Error(
      `hosting-ingress project missing after insert race (workspace=${workspaceId})`,
    )
  }
  return existing
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
 * hosting-ingress traefik service and the self-host database/queue/analytics
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
      .select({ displayName: server.name })
      .from(server)
      .where(eq(server.id, params.serverId))
      .limit(1)
    const environmentDisplayName =
      serverRow?.displayName?.trim() || SYSTEM_PROJECT_DISPLAY_NAME
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
 * Shared self-host (`turbopanel`) project under the system workspace.
 *
 * Race-safe via the same partial unique `uniq_project_workspace_system_component`
 * used by the hosting-ingress project — `metadata.component` discriminates.
 */
async function ensureSelfHostProject(
  tx: Db,
  workspaceId: string,
): Promise<string> {
  const metadataJson = JSON.stringify({
    type: 'docker-compose',
    component: SYSTEM_SELF_HOST_COMPONENT,
  })

  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO project (workspace_id, name, metadata)
    VALUES (
      ${workspaceId}::uuid,
      ${SYSTEM_SELF_HOST_PROJECT_DISPLAY_NAME},
      ${metadataJson}::jsonb
    )
    ON CONFLICT (workspace_id, (metadata->>'component'))
      WHERE (metadata->>'component') IS NOT NULL
    DO NOTHING
    RETURNING id
  `)
  if (inserted[0]?.id) return inserted[0].id

  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id
    FROM project
    WHERE workspace_id = ${workspaceId}::uuid
      AND metadata->>'component' = ${SYSTEM_SELF_HOST_COMPONENT}
    LIMIT 1
  `)
  const existing = rows[0]?.id
  if (!existing) {
    throw new Error(
      `self-host project missing after insert race (workspace=${workspaceId})`,
    )
  }
  return existing
}

/**
 * Idempotently ensure workspace(kind=system) → project(turbopanel) →
 * environment(colocated server) → service(database/queue/analytics) →
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
        role: 'system' as const,
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
