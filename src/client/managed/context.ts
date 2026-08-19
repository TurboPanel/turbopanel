import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { type Db, getDaemonCellRegistry } from '../../db.ts'
import {
  getManagedEngineSpec,
  MANAGED_ENGINE_STATUS,
  type ManagedEngineSpec,
} from '../../lib/managed/index.ts'
import { environment, project } from '../../lib/db/schema.ts'
import type { ManagedOrganizationDefaults } from '../../lib/managed/org-defaults.ts'
import { loadManagedOrgDefaults } from './org-defaults.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
} from '../shared.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { getCatalogEntry } from '../projects/catalog/index.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'
import type { ManagedStatus } from '../../lib/managed/types.ts'

export async function authorizeManagedRequest(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  mode: 'read' | 'manage',
): Promise<{ userId: string; organizationId: string } | Response> {
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  const entityOrgId = await resolveEntityOrganizationId(
    db,
    'environment',
    environmentId,
  )
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = mode === 'read'
    ? await assertCanReadOr403(c, 'environment', environmentId)
    : await assertCanManageOr403(c, 'environment', environmentId)
  if (denied) return denied

  if (mode === 'manage') {
    const immutable = await assertNotSystemOwnedOr403(
      c,
      'environment',
      environmentId,
    )
    if (immutable) return immutable
  }

  return { userId: session.userId, organizationId: orgResult }
}

function readProjectCatalogCode(metadata: unknown): string | null {
  if (
    typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)
  ) {
    return null
  }
  const code = (metadata as Record<string, unknown>).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

export type ManagedContext = {
  environmentId: string
  projectId: string
  envDisplayName: string | null
  catalogCode: string
  spec: ManagedEngineSpec
  /**
   * The environment's *current* placement pin — **not** necessarily the host
   * that owns an existing managed service. Once a `managed` row exists,
   * `managed.server_id` is the source of truth for where the engine actually
   * runs; this field may be `null` (placement cleared) or point at a
   * different server than `managed.server_id` after the environment's
   * compose placement moves independently. Routes operating on an existing
   * row must resolve their target via {@link resolveManagedTargetServerId},
   * not by reading this field directly. It remains required (via
   * {@link requireManagedCreateServerId}) only when creating a brand-new
   * managed row.
   */
  serverId: string | null
  organizationId: string
  /**
   * Org-wide managed defaults inherited by services with no override
   * (`organization.options.managedDatabase`). Resolve an effective value with
   * the matching `resolveManaged*` helper rather than reading a service field
   * directly.
   */
  orgDefaults: ManagedOrganizationDefaults
}

export async function loadManagedContext(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  organizationId: string,
): Promise<ManagedContext | Response> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      serverId: environment.serverId,
      displayName: environment.name,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!envRow) return c.json({ error: 'Not found' }, 404)

  const [projectRow] = await db
    .select({ metadata: project.metadata })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return c.json({ error: 'Not found' }, 404)

  const code = readProjectCatalogCode(projectRow.metadata)
  if (!code) {
    return c.json({ error: 'not_managed_environment' }, 400)
  }

  const spec = getManagedEngineSpec(code)
  if (!spec) {
    return c.json({ error: 'not_managed_environment' }, 400)
  }

  const engineStatus = MANAGED_ENGINE_STATUS[spec.engine]
  if (engineStatus !== 'available') {
    return c.json({ error: 'managed_engine_unavailable' }, 400)
  }

  // Environment placement is not required here: an existing `managed` row
  // resolves its target host from `managed.server_id` instead (see
  // `resolveManagedTargetServerId`). Placement is only enforced at create
  // time, via `requireManagedCreateServerId` in the route handler.
  const serverId = envRow.serverId
  if (serverId && !(await verifyServerInOrg(db, serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }

  const entry = getCatalogEntry(code)
  if (entry?.kind !== 'managed') {
    return c.json({ error: 'not_managed_environment' }, 400)
  }

  return {
    environmentId,
    projectId: envRow.projectId,
    envDisplayName: envRow.displayName,
    catalogCode: code,
    spec,
    serverId,
    organizationId,
    orgDefaults: await loadManagedOrgDefaults(db, organizationId),
  }
}

/**
 * Require an environment placement for **creating** a brand-new managed
 * service. A fresh managed row has no `server_id` pin of its own yet, so the
 * environment's current placement is the only source of truth. Existing rows
 * must resolve via {@link resolveManagedTargetServerId} instead — do not use
 * this helper once a `managed` row exists for the environment.
 */
export function requireManagedCreateServerId(
  c: Context<AppEnv>,
  serverId: string | null,
): string | Response {
  if (!serverId) {
    return c.json({ error: 'server_placement_required' }, 409)
  }
  return serverId
}

/**
 * Resolve the host that actually owns an **existing** managed service.
 * `managed.server_id` (the host `managed.apply` last targeted) is required;
 * environment placement is not a fallback once a managed row exists.
 */
export function resolveManagedTargetServerId(
  c: Context<AppEnv>,
  managedServerId: string | null,
): string | Response {
  if (!managedServerId) {
    return c.json({ error: 'server_placement_required' }, 409)
  }
  return managedServerId
}

export function assertManagedNotBusy(
  c: Context<AppEnv>,
  status: string | null,
): Response | null {
  if (status === 'applying') {
    return c.json({ error: 'managed_busy' }, 409)
  }
  return null
}

export async function assertTargetServerOnline(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
): Promise<Response | null> {
  const registry = getDaemonCellRegistry(c)
  const records = await loadServerStatusRecords(db, registry, [serverId])
  const live = records[0]
  if (!live?.connected) {
    return c.json({ error: 'server_offline' }, 409)
  }
  return null
}

export function isManagedStatus(value: string | null): value is ManagedStatus {
  return value === 'provisioning' ||
    value === 'applying' ||
    value === 'ready' ||
    value === 'stopped' ||
    value === 'failed'
}
