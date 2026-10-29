import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { nudgeTunnelRoutesAfterResponse } from '../organizations/tunnel-nudge.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import { isAdminRole } from '../authn/session-store.ts'
import { listVisible } from '../authz/index.ts'
import { assertCanManageOr403, assertCanReadOr403, getOrgId, parseJsonBody } from '../shared.ts'
import { type Db, getDaemonCellRegistry, getDb } from '../../db/connection.ts'
import { recordAuditAndNotify } from '../../features/notifications/audit-bridge.ts'
import { parseOrganizationOptions } from '../../features/organizations/organization-options.ts'
import { parseDatacenterOptions } from '../../features/datacenters/datacenter-options.ts'
import {
  parseServerOptions,
  redactServerOptions,
  type ServerOptions,
} from '../../features/servers/server-metadata.ts'
import { metricsDeploymentKindForRuntime } from '../../contracts/capability-plan.ts'
import { loadTierPlacementsForServers } from '../../features/tiers/tier-enforcement.ts'
import { loadServerLayoutPaths } from '../../features/servers/server-topology-records.ts'
import { cachedServerDetailReadModel } from '../../query-cache/read-models/server-detail.ts'
import { listServerLabels } from '../../features/servers/label-records.ts'
import { fetchDaemonServerCell } from '../../daemon/cell/server-diagnostics.ts'
import {
  isServerConnectedStoredOrLive,
  resolveFleetPresence,
} from '../../daemon/cell/fleet-presence.ts'
import { readProjectionsForServers } from '../../daemon/cell/postgres-projection.ts'
import {
  onDaemonUpdateExpired,
  onDaemonUpdateReset,
  onDaemonUpdateResult,
  repairStaleProjectedUpdate,
} from '../../daemon/cell/control-plane-monitor.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { UpdateProjection } from '../../features/servers/daemon-state.ts'
import {
  clearServerDaemonState,
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
  revokeDaemonKey,
} from '../../features/servers/server-identity-db.ts'
import { datacenter, organization, principal, server } from '../../db/schema.ts'
import { resolveUpdateManifest } from '../../features/update/manifest.ts'
import { resolveInstanceUpdateChannel, type UpdateChannel } from '../../contracts/update-channel.ts'
import { revokeLicensesBoundToServer } from '../../features/licenses/license.ts'
import { updatesAutomaticBody } from '../../features/upgrades/decisions.ts'
import { syncSelfHostedGrant } from '../../features/tiers/self-hosted-grant-records.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  type HierarchyDeleteFkBlocker,
  runHierarchyDeleteResult,
} from '../hierarchy-delete.ts'
import { purgeServerForeignKeysForDelete } from './server-fk.ts'
import {
  isPrincipalUnused,
  loadPrincipalUsage,
} from '../../features/principals/placement-records.ts'
import {
  loadPrincipalRemovalPlan,
  parsePrincipalRemovalChoices,
  PRINCIPAL_DELETE_REFUSED_CODE,
  PRINCIPAL_DELETE_REFUSED_ERROR,
  PRINCIPAL_NOT_ON_SERVER_CODE,
  PRINCIPAL_NOT_ON_SERVER_ERROR,
  principalIdsToDelete,
  registerServerPrincipalRemovalRoutes,
  resolvePrincipalRemovalRefusals,
} from './principal-removal.ts'
import * as systemHierarchy from '../../features/system/hierarchy.ts'
import { enqueueSystemReconcile } from '../../features/system/reconcile.ts'
import type { SystemReconcileAction } from '../../contracts/commands/schemas.ts'
import { assertDispatchInfrastructure } from './command-dispatch.ts'
import { reconcileFabricMembership } from '../../features/fabric/enqueue.ts'
import {
  assertServerOfflineForForget,
  COLOCATED_SERVER_KEY_REVOKE_BLOCKED_REASON,
  colocatedServerDeleteBlockedReason,
  forgetServerOwnedResources,
  type ForgottenServerResources,
  isServerHasBlockersDuringForgetError,
  isServerOnlineDuringForgetError,
  loadServerDeletePreview,
  listSystemContainersBlockingServerDelete,
  parseForgetResourcesFlag,
  planServerForget,
  type ServerDeleteBlocker,
  serverDeleteBlockersResponse,
  type ServerForgetBlockedDatabase,
  type ServerForgetBlockedEnvironment,
  serverOnlineForgetBlockedResponse,
  serverSystemContainersDeleteBlockedResponse,
} from './delete-guards.ts'
import { hasActiveColocatedLicenseBinding, resolveColocatedServerIdSet } from './colocated.ts'
import {
  isStaleProjectedUpdating,
  loadServerStatusRecords,
  resolveServerUpdateStatus,
  type ServerUpdateCommit,
} from './update-status.ts'
import { UPDATE_REQUEST_TTL_MS } from '../../features/update/constants.ts'
import { registerServerCommandRoutes } from './commands-routes.ts'
import { registerServerMetricsRoutes } from './metrics-routes.ts'
import { registerServerTrafficMapRoutes } from './traffic-map-routes.ts'
import { registerServerAddressRoutes } from './address-routes.ts'
import { registerServerLabelRoutes } from './labels-routes.ts'
import { registerServerServicesRoutes } from './services-routes.ts'
import {
  enrichServerDetailTierPlacement,
  registerServerLicenseTierRoutes,
} from './license-tier-routes.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { cachedServersListReadModel } from '../../query-cache/read-models/servers-list.ts'
import { applyLocationPatch, resolveLocation } from '../../features/geo/location-override.ts'
import {
  buildBatchStatusCoalesceKey,
  currentCommitFromDaemonBuild,
  distinctNonEmptyIds,
  emptyServersUpdatesPayload,
  errorMessageFromUnknown,
  expiredBatchStatusCoalesceKeys,
  hostingHierarchyFailedBody,
  isHostingDisableTransition,
  isHostingEnableTransition,
  parseServerPatchCore,
  repairedUpdateDoneProjection,
  repairedUpdateIdleProjection,
  resolveServerHostDefaultsFields,
  resolveServerTimezoneFields,
  resolveTrunkTargetFields,
  serverDeletedPayload,
  type ServerPatchFields,
  shapeServerDatacenters,
  shapeServerPresenceFields,
  shouldSkipProjectedUpdateRepair,
  STATUS_CACHE_CONTROL,
  STATUS_CACHE_MAX_AGE_MS,
  updateResetErrorStatus,
} from './routes-helpers.ts'
import {
  loadDatacenterDisplayNames,
  loadDatacenterMembershipsForServers,
} from '../../features/net/datacenter-membership.ts'

type BatchStatusPayload = {
  servers: Awaited<ReturnType<typeof loadServerStatusRecords>>
}

type BatchStatusCoalesceEntry = {
  expiresAt: number
  promise?: Promise<BatchStatusPayload>
  result?: BatchStatusPayload
}

const batchStatusCoalesce = new Map<string, BatchStatusCoalesceEntry>()

function evictExpiredBatchStatusEntries(now = Date.now()): void {
  for (const key of expiredBatchStatusCoalesceKeys(batchStatusCoalesce, now)) {
    batchStatusCoalesce.delete(key)
  }
}

/** The channel this control plane follows — the one every queued update targets. */
function instanceUpdateChannel(c: Context<AppEnv>): UpdateChannel {
  return resolveInstanceUpdateChannel(c.get('platformEnv'))
}

/**
 * Every server updates on its own (the control plane's hourly check); the
 * routes that started one by hand answer 410 `updates_automatic`.
 */
function updatesAutomaticResponse(c: Context<AppEnv>): Response {
  return c.json(updatesAutomaticBody(), 410)
}

async function repairProjectedUpdateIfStale(
  db: Db,
  serverId: string,
  projectedUpdate: UpdateProjection | null | undefined,
  current: ServerUpdateCommit | null,
  targetCommit?: string
): Promise<UpdateProjection | null | undefined> {
  if (shouldSkipProjectedUpdateRepair(projectedUpdate)) {
    return projectedUpdate
  }

  const repaired = await repairStaleProjectedUpdate(db, serverId, projectedUpdate!, {
    currentCommit: current?.commit,
    targetCommit,
    updateTtlMs: UPDATE_REQUEST_TTL_MS,
  })
  if (!repaired) return projectedUpdate

  if (targetCommit && current?.commit === targetCommit) {
    return repairedUpdateDoneProjection({
      requestId: projectedUpdate!.requestId ?? undefined,
      channel: projectedUpdate!.channel ?? undefined,
      queuedAt: projectedUpdate!.queuedAt ?? undefined,
      finishedAt: new Date().toISOString(),
    })
  }

  return repairedUpdateIdleProjection()
}

/**
 * Refuses an action that would sever the control plane from its own host:
 * the co-located server (self-host pin, probe match, or — until that pin
 * exists — an active reserved license binding).
 */
async function assertServerNotColocatedOr403(
  c: Context,
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  organizationId: string,
  reason: string
): Promise<Response | null> {
  const colocatedIds = await resolveColocatedServerIdSet(db, registry, [serverId], {
    includeSelfHostPin: true,
  })
  if (colocatedIds.has(serverId)) {
    return c.json({ error: reason }, 403)
  }
  if (await hasActiveColocatedLicenseBinding(db, organizationId, serverId)) {
    return c.json({ error: reason }, 403)
  }
  return null
}

async function assertServerDeletable(
  c: Context,
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  organizationId: string,
  opts: Readonly<{
    skipForgettableBlockers?: boolean
    refuseIfOnline?: boolean
    storedConnected?: boolean
  }> = {}
): Promise<Response | null> {
  const colocated = await assertServerNotColocatedOr403(
    c,
    db,
    registry,
    serverId,
    organizationId,
    colocatedServerDeleteBlockedReason()
  )
  if (colocated) return colocated

  if (opts.refuseIfOnline) {
    const online = await isServerConnectedStoredOrLive(
      db,
      registry,
      serverId,
      opts.storedConnected === true
    )
    if (online) {
      return serverOnlineForgetBlockedResponse(c)
    }
  }

  const plan = await planServerForget(db, serverId, organizationId)
  if (opts.skipForgettableBlockers === true) {
    if (plan.blockedDatabases.length > 0 || plan.blockedEnvironments.length > 0) {
      return serverDeleteBlockersResponse(
        c,
        plan.blockingBlockers,
        plan.blockedDatabases,
        plan.blockedEnvironments
      )
    }
    return null
  }
  if (plan.blockers.length > 0) {
    return serverDeleteBlockersResponse(c, plan.blockers)
  }

  return null
}

/**
 * Why a purge did not happen, as a fixed code.
 *
 * Deliberately not the driver's message: the registry is Redis or a Durable
 * Object, and its errors name hosts, keys and internal addresses. This code
 * goes into an API response that an organization admin reads; the message it
 * replaces goes to the log, where an operator can see it.
 */
export type DaemonCellPurgeFailure = 'purge_failed' | 'registry_unavailable'

async function purgeServerDaemonCell(
  registry: DaemonCellRegistry,
  serverId: string
): Promise<DaemonCellPurgeFailure | null> {
  try {
    await registry.getCell(serverId).purge()
    return null
  } catch (err) {
    const message = errorMessageFromUnknown(err)
    console.error(`Failed to purge daemon cell for server ${serverId}: ${message}`)
    return 'purge_failed'
  }
}

async function loadDatacenterOptionsMap(
  db: Db,
  datacenterIds: Array<string | null | undefined>
): Promise<Map<string, ReturnType<typeof parseDatacenterOptions>>> {
  const distinct = distinctNonEmptyIds(datacenterIds)
  if (distinct.length === 0) return new Map()

  const rows = await db
    .select({ id: datacenter.id, options: datacenter.options })
    .from(datacenter)
    .where(inArray(datacenter.id, distinct))

  const map = new Map<string, ReturnType<typeof parseDatacenterOptions>>()
  for (const row of rows) {
    map.set(row.id, parseDatacenterOptions(row.options))
  }
  return map
}

function parseServerPatchBody(
  c: Context,
  body: Record<string, unknown>
): ServerPatchFields | Response {
  const core = parseServerPatchCore(body)
  if (!core.ok) {
    return c.json({ error: core.error }, core.status)
  }
  return core.patch
}

function buildServerUpdateFields(patch: ServerPatchFields): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: patch.updatedAt }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.machineClass !== undefined) {
    update.machineClass = patch.machineClass
    // A pin or a clear is the operator's word; ingest never overwrites it.
    update.machineClassSource = patch.machineClass === null ? null : 'operator'
  }
  if (patch.options !== undefined || patch.location !== undefined) {
    // Shallow jsonb merge, as before; a resolved `location` is written as one
    // key (the route already merged it with the stored override), and a reset
    // removes the key so every field falls back to the detected geo.
    let options = sql`COALESCE(${server.options}, '{}'::jsonb)`
    if (patch.location === null) {
      options = sql`(${options} - 'location')`
    } else if (patch.location !== undefined) {
      options = sql`${options} || ${JSON.stringify({ location: patch.location })}::jsonb`
    }
    if (patch.options !== undefined) {
      options = sql`${options} || ${JSON.stringify(patch.options)}::jsonb`
    }
    update.options = options
  }
  if (patch.options?.hosting?.enabled !== undefined) {
    update.isHostingEnabled = patch.options.hosting.enabled
  }
  return update
}

/**
 * Persist a hosting-enable PATCH only when hierarchy provisioning succeeds.
 * Returns an error Response when provisioning fails so the enabled flag is
 * not left committed without inventory. Daemon enrollment keeps best-effort
 * hierarchy in `server-registry` (must not block enroll).
 */
async function applyServerPatchWithHostingEnable(
  c: Context,
  db: Db,
  params: Readonly<{
    serverId: string
    organizationId: string
    patch: ServerPatchFields
  }>
): Promise<Response | null> {
  const update = buildServerUpdateFields(params.patch)
  try {
    await db.transaction(async (tx) => {
      await tx.update(server).set(update).where(eq(server.id, params.serverId))
      await systemHierarchy.ensureSystemHierarchy(tx, {
        organizationId: params.organizationId,
        serverId: params.serverId,
      })
    })
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'servers',
      `ensureSystemHierarchy failed for server ${params.serverId}: ${message}`
    )
    return c.json(hostingHierarchyFailedBody(), 500)
  }
}

/**
 * Persist a server PATCH. Hosting-enable commits only when hierarchy
 * provisioning succeeds; other patches (including hosting-disable) update
 * in place and leave inventory rows alone.
 */
async function applyServerPatchUpdate(
  c: Context,
  db: Db,
  params: Readonly<{
    serverId: string
    organizationId: string
    patch: ServerPatchFields
    previousOptions: ServerOptions | null
  }>
): Promise<Response | null> {
  if (isHostingEnableTransition(params.previousOptions, params.patch)) {
    return applyServerPatchWithHostingEnable(c, db, {
      serverId: params.serverId,
      organizationId: params.organizationId,
      patch: params.patch,
    })
  }
  await db
    .update(server)
    .set(buildServerUpdateFields(params.patch))
    .where(eq(server.id, params.serverId))
  return null
}

/**
 * Best-effort `system.reconcile` after a hosting enable/disable transition.
 * Enqueues after the PATCH transaction commits — never inside it. Sweep
 * retries on failure; missing dispatch infra is a no-op.
 *
 * Enable uses `action: 'reconcile'` (self-heal). Disable uses `action: 'stop'`
 * scoped to the hosting-ingress environment so the shared proxy is torn
 * down intentionally — ordinary desired:'absent' drift stays report-only.
 */
async function enqueueHostingReconcileBestEffort(
  c: Context,
  db: Db,
  params: Readonly<{
    serverId: string
    actorId: string
    action: SystemReconcileAction
    environmentId?: string
  }>
): Promise<void> {
  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return

  try {
    const enqueued = await enqueueSystemReconcile(db, commandQueue, {
      serverId: params.serverId,
      actorType: 'user',
      actorId: params.actorId,
      action: params.action,
      ...(params.environmentId ? { environmentId: params.environmentId } : {}),
    })
    if (!enqueued.ok && enqueued.reason !== 'not_provisioned') {
      compatLogWarn(
        'servers',
        `system.reconcile enqueue failed for server ${params.serverId}: ${enqueued.reason}`
      )
    }
  } catch (err) {
    const message = errorMessageFromUnknown(err)
    compatLogWarn(
      'servers',
      `system.reconcile enqueue failed for server ${params.serverId}: ${message}`
    )
  }
}

/**
 * Blocks delete while system hosting-ingress containers are still active on
 * the host (a `pending` row the host never created does not count).
 * On an offline host, `forgetResources` skips this — stale rows are removed
 * with the system subtree. Otherwise every refusal lists the containers.
 */
async function assertSystemEnvironmentIdleOrBlocked(
  c: Context,
  db: Db,
  serverId: string,
  opts: Readonly<{ forgetResources: boolean; serverConnected: boolean }>
): Promise<{ systemEnvironmentIds: string[] } | Response> {
  const systemEnvironmentIds = await systemHierarchy.listSystemEnvironmentIdsForServer(db, serverId)
  if (systemEnvironmentIds.length === 0) return { systemEnvironmentIds: [] }

  if (opts.forgetResources && !opts.serverConnected) {
    return { systemEnvironmentIds }
  }

  const blockingContainers = await listSystemContainersBlockingServerDelete(db, serverId)
  if (blockingContainers.length > 0) {
    return serverSystemContainersDeleteBlockedResponse(c, {
      serverConnected: opts.serverConnected,
      containers: blockingContainers,
    })
  }
  return { systemEnvironmentIds }
}

async function stillUnusedPrincipalIds(
  db: Db,
  serverId: string,
  principalIds: readonly string[]
): Promise<string[]> {
  if (principalIds.length === 0) return []
  const usage = await loadPrincipalUsage(db, principalIds, serverId)
  const unused = principalIds.filter((id) => {
    const counts = usage.get(id)
    return counts !== undefined && isPrincipalUnused(counts)
  })
  const kept = principalIds.filter((id) => !unused.includes(id))
  if (kept.length > 0) {
    compatLogWarn(
      'servers',
      `principal delete on server ${serverId} kept ${kept.join(', ')}: used again since the check`
    )
  }
  return unused
}

async function deleteServerWithSystemSubtree(
  db: Db,
  serverId: string,
  organizationId: string,
  systemEnvironmentIds: readonly string[],
  forgetResources: boolean,
  /** Principals the owner chose to delete outright (already checked unused). */
  deletePrincipalIds: readonly string[] = []
): Promise<{
  status: 'ok' | 'has_children' | 'online' | 'blockers'
  forgotten: ForgottenServerResources | null
  blockers: ServerDeleteBlocker[]
  blockedDatabases: ServerForgetBlockedDatabase[]
  blockedEnvironments: ServerForgetBlockedEnvironment[]
  fkBlockers?: HierarchyDeleteFkBlocker[]
}> {
  let forgotten: ForgottenServerResources | null = null
  try {
    const deleteResult = await runHierarchyDeleteResult(db, async (tx) => {
      if (forgetResources) {
        await assertServerOfflineForForget(tx, serverId)
        forgotten = await forgetServerOwnedResources(tx, serverId, organizationId)
      }
      await Promise.all(
        systemEnvironmentIds.map((environmentId) =>
          systemHierarchy.deleteSystemEnvironmentSubtree(tx, environmentId)
        )
      )
      await purgeServerForeignKeysForDelete(tx, serverId)
      // Placements on this server go with it (cascade); a principal chosen
      // for outright deletion goes too. The usage check ran before the
      // transaction, so it is repeated here: a tenancy or binding created in
      // between keeps the identity (the default answer) rather than being
      // cascaded away.
      const stillUnused = await stillUnusedPrincipalIds(tx, serverId, deletePrincipalIds)
      if (stillUnused.length > 0) {
        await tx
          .delete(principal)
          .where(
            and(inArray(principal.id, stillUnused), eq(principal.organizationId, organizationId))
          )
      }
      // Licenses are one-shot: the key that enrolled this server is retired
      // in the same step, so a daemon still running there cannot enroll
      // again and the key never holds a license unbound in between.
      await revokeLicensesBoundToServer(tx, serverId, organizationId)
      await tx.delete(server).where(eq(server.id, serverId))
    })
    return {
      status: deleteResult.status === 'ok' ? 'ok' : 'has_children',
      forgotten: deleteResult.status === 'ok' ? forgotten : null,
      blockers: [],
      blockedDatabases: [],
      blockedEnvironments: [],
      ...(deleteResult.status === 'has_children' ? { fkBlockers: [...deleteResult.blockers] } : {}),
    }
  } catch (error) {
    if (isServerOnlineDuringForgetError(error)) {
      return {
        status: 'online',
        forgotten: null,
        blockers: [],
        blockedDatabases: [],
        blockedEnvironments: [],
      }
    }
    if (isServerHasBlockersDuringForgetError(error)) {
      return {
        status: 'blockers',
        forgotten: null,
        blockers: error.blockers,
        blockedDatabases: error.blockedDatabases,
        blockedEnvironments: error.blockedEnvironments,
      }
    }
    throw error
  }
}

/**
 * Per-principal answers on server removal. Every placement defaults to keep;
 * a `delete` is refused (409) while something else still uses the principal,
 * and a choice naming a principal that is not on this server is a 400.
 */
async function refusePrincipalRemovalChoices(
  c: Context,
  db: Db,
  serverId: string,
  choices: ReadonlyArray<{ principalId: string; action: 'keep' | 'delete' }>
): Promise<Response | null> {
  if (choices.length === 0) return null
  const plan = await loadPrincipalRemovalPlan(db, serverId)
  const refusals = resolvePrincipalRemovalRefusals(plan, choices)
  if (refusals.length === 0) return null
  const notOnServer = refusals.filter((refusal) => refusal.reason === 'not_on_server')
  if (notOnServer.length > 0) {
    return c.json(
      {
        error: PRINCIPAL_NOT_ON_SERVER_ERROR,
        code: PRINCIPAL_NOT_ON_SERVER_CODE,
        principals: notOnServer,
      },
      400
    )
  }
  return c.json(
    {
      error: PRINCIPAL_DELETE_REFUSED_ERROR,
      code: PRINCIPAL_DELETE_REFUSED_CODE,
      principals: refusals,
    },
    409
  )
}

async function reconcileFabricAfterServerDelete(
  c: Context,
  db: Db,
  organizationId: string,
  actorId: string
): Promise<void> {
  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return
  try {
    const secretsConfig = c.get('secretsConfig')
    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    await reconcileFabricMembership({
      db,
      commandQueue,
      actorType: 'user',
      actorId,
      organizationId,
      ...(secretsConfig ? { secretsConfig } : {}),
      ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}),
    })
  } catch (err) {
    compatLogWarn(
      'servers',
      `reconcileFabricMembership after delete failed for org ${organizationId}: ${errorMessageFromUnknown(
        err
      )}`
    )
  }
}

function serverDeletedResponse(
  c: Context,
  serverId: string,
  purgeError: DaemonCellPurgeFailure | null
): Response {
  const payload = serverDeletedPayload(serverId, purgeError)
  if (payload.ok) {
    return c.json({ ok: true, serverId: payload.serverId })
  }
  return c.json(
    {
      ok: false,
      serverId: payload.serverId,
      deleted: true,
      error: payload.error,
    },
    payload.status
  )
}

export function registerServerRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server routes')
  }
  const secrets = opts.secrets

  router.use('/servers', createSessionMiddleware(secrets))
  router.use('/servers/*', createSessionMiddleware(secrets))

  router.get('/servers', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ servers: [] })
    }

    let display
    try {
      display = await cachedServersListReadModel(c, {
        userId: session.userId,
        organizationId,
        visibleIds,
      })
    } catch {
      return c.json({ error: 'Database unavailable' }, 503)
    }

    const presence = new Map(display.presence.map((live) => [live.serverId, live]))
    const colocatedIds = new Set(display.colocatedIds)

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    const orgOptions = parseOrganizationOptions(orgRow?.options)

    const serverIds = display.rows.map((row) => row.id)
    const membershipsByServer = await loadDatacenterMembershipsForServers(db, serverIds)
    const membershipDcIds = [...membershipsByServer.values()].flatMap((pins) =>
      pins.map((pin) => pin.datacenterId)
    )
    const datacenterOptionsById = await loadDatacenterOptionsMap(db, membershipDcIds)
    const datacenterDisplayNamesById = await loadDatacenterDisplayNames(
      db,
      distinctNonEmptyIds(membershipDcIds)
    )
    const layoutPathsByServer = await loadServerLayoutPaths(db, serverIds)
    const deployment = metricsDeploymentKindForRuntime(opts.runtime)
    const placementByServer = await loadTierPlacementsForServers(db, serverIds, {
      deployment,
      unwatched: 'counts',
    })

    return c.json({
      servers: display.rows.map((row) => {
        const live = presence.get(row.id)
        const memberships = membershipsByServer.get(row.id) ?? []
        const datacenters = shapeServerDatacenters(memberships, datacenterDisplayNamesById)
        const primaryDcId = datacenters[0]?.id
        const dcOptions = primaryDcId ? datacenterOptionsById.get(primaryDcId) : undefined
        const timezoneFields = resolveServerTimezoneFields(
          row.options,
          orgOptions,
          dcOptions,
          live?.timeSync?.timezone
        )
        const hostDefaultsFields = resolveServerHostDefaultsFields(
          row.options,
          orgOptions,
          dcOptions
        )
        return {
          ...row,
          // Belt to the read model's braces: the loader strips secret-bearing
          // `options` keys before caching, and the response strips them again
          // in case a stale cache entry predates that. See
          // `REDACTED_SERVER_OPTION_KEYS`.
          options: redactServerOptions(row.options),
          location: resolveLocation(row.options, live?.geo),
          datacenters,
          ...shapeServerPresenceFields(
            live,
            colocatedIds.has(row.id),
            metricsDeploymentKindForRuntime(opts.runtime)
          ),
          ...timezoneFields,
          ...hostDefaultsFields,
          licenseId: row.licenseId ?? null,
          tierPlacement: placementByServer.get(row.id) ?? null,
          layoutPaths: layoutPathsByServer.get(row.id) ?? null,
        }
      }),
    })
  })

  router.get('/servers/updates', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json(emptyServersUpdatesPayload(instanceUpdateChannel(c)))
    }

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, visibleIds)
    const projections = await readProjectionsForServers(db, visibleIds)
    // Self-host pin included — see `resolveColocatedServerIdSet`.
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, visibleIds, {
      includeSelfHostPin: true,
    })
    const channel = instanceUpdateChannel(c)
    const targetManifest = await resolveUpdateManifest(channel)
    const { target, targetStatus, targetError } = resolveTrunkTargetFields(targetManifest, channel)

    const servers = await Promise.all(
      visibleIds.map(async (serverId) => {
        const current = currentCommitFromDaemonBuild(presence.get(serverId)?.daemonBuild)
        const projection = projections.get(serverId)
        const repairedUpdate = await repairProjectedUpdateIfStale(
          db,
          serverId,
          projection?.update ?? null,
          current,
          targetManifest?.commit
        )
        const resolved = await resolveServerUpdateStatus({
          serverId,
          current,
          channel,
          targetManifest,
          colocatedWithInstance: colocatedIds.has(serverId),
          projectedUpdate: repairedUpdate ?? null,
        })
        return {
          serverId,
          current,
          colocatedWithInstance: colocatedIds.has(serverId),
          ...resolved,
        }
      })
    )

    return c.json({
      ok: true,
      channel,
      target,
      targetStatus,
      targetError,
      servers,
    })
  })

  router.post('/servers/updates', (c) => updatesAutomaticResponse(c))

  router.get('/servers/status', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    evictExpiredBatchStatusEntries()
    const coalesceKey = buildBatchStatusCoalesceKey(session.userId, organizationId, visibleIds)
    const now = Date.now()

    let entry = batchStatusCoalesce.get(coalesceKey)
    if (entry && entry.expiresAt > now) {
      if (entry.result) {
        return c.json(entry.result, 200, {
          'Cache-Control': STATUS_CACHE_CONTROL,
        })
      }
      if (entry.promise !== undefined) {
        const result = await entry.promise
        return c.json(result, 200, { 'Cache-Control': STATUS_CACHE_CONTROL })
      }
    }

    if (batchStatusCoalesce.get(coalesceKey)?.promise === undefined) {
      const registry = getDaemonCellRegistry(c)
      const promise = loadServerStatusRecords(db, registry, visibleIds)
        .then((servers) => ({ servers }))
        .then((result) => {
          const current = batchStatusCoalesce.get(coalesceKey)
          if (current) {
            current.result = result
            current.promise = undefined
            current.expiresAt = Date.now() + STATUS_CACHE_MAX_AGE_MS
          }
          return result
        })
        .catch((err) => {
          const current = batchStatusCoalesce.get(coalesceKey)
          if (current?.promise === promise) {
            batchStatusCoalesce.delete(coalesceKey)
          }
          throw err
        })

      batchStatusCoalesce.set(coalesceKey, {
        expiresAt: now + STATUS_CACHE_MAX_AGE_MS,
        promise,
      })
    }

    entry = batchStatusCoalesce.get(coalesceKey)!
    const result = entry.result ?? (await entry.promise!)
    return c.json(result, 200, { 'Cache-Control': STATUS_CACHE_CONTROL })
  })

  router.get('/servers/:id/delete-preview', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, organizationId } = scope
    const id = c.req.param('id')

    const [row] = await db
      .select({ id: server.id, isConnected: server.isConnected })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, [id], {
      includeSelfHostPin: true,
    })
    const colocated =
      colocatedIds.has(id) || (await hasActiveColocatedLicenseBinding(db, organizationId, id))
    const preview = await loadServerDeletePreview(db, id, organizationId, {
      online: await isServerConnectedStoredOrLive(db, registry, id, row.isConnected),
      colocated,
    })
    return c.json(preview)
  })

  router.get('/servers/:id/status', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const records = await loadServerStatusRecords(db, registry, [id])
    if (records.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json(records[0], 200, { 'Cache-Control': STATUS_CACHE_CONTROL })
  })

  // DEBUG/DIAGNOSTIC ENDPOINT — hits the Durable Object directly via fetchDaemonServerCell.
  // Admin/superadmin only. Must NOT be polled by normal UI — use `/servers/status`
  // for Postgres-backed presence instead.
  router.get('/servers/:id/cell', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    if (!isAdminRole(session.role)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const result = await fetchDaemonServerCell(db, registry, id)
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }
    return c.json(result)
  })

  router.post('/servers/:id/update/reset', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    try {
      const presence = await resolveFleetPresence(db, registry, [id])
      const projections = await readProjectionsForServers(db, [id])
      // Self-host pin included — see `resolveColocatedServerIdSet`.
      const colocatedIds = await resolveColocatedServerIdSet(db, registry, [id], {
        includeSelfHostPin: true,
      })
      const current = currentCommitFromDaemonBuild(presence.get(id)?.daemonBuild)
      const channel = instanceUpdateChannel(c)
      const targetManifest = await resolveUpdateManifest(channel)
      const projectedUpdate = projections.get(id)?.update
      const stale = isStaleProjectedUpdating({
        projectedUpdate,
        currentCommit: current?.commit,
        targetCommit: targetManifest?.commit,
        updateTtlMs: UPDATE_REQUEST_TTL_MS,
      })

      const { cleared } = await registry.getCell(id).clearUpdateStatus({
        allowStale: stale,
        currentCommit: current?.commit,
        targetCommit: targetManifest?.commit,
        queuedAt: projectedUpdate?.queuedAt,
        updateTtlMs: UPDATE_REQUEST_TTL_MS,
      })

      if (stale && projectedUpdate?.status === 'updating') {
        const finishedAt = new Date().toISOString()
        const requestId = projectedUpdate.requestId ?? ''
        if (current?.commit === targetManifest?.commit && targetManifest != null) {
          await onDaemonUpdateResult(db, id, requestId, true, finishedAt)
        } else {
          await onDaemonUpdateExpired(db, id, requestId, finishedAt)
        }
      } else {
        await onDaemonUpdateReset(db, id)
      }

      const resolved = await resolveServerUpdateStatus({
        serverId: id,
        current,
        channel,
        targetManifest,
        colocatedWithInstance: colocatedIds.has(id),
        projectedUpdate: { status: 'idle' },
      })

      return c.json({
        ok: true,
        serverId: id,
        cleared,
        channel,
        current,
        colocatedWithInstance: colocatedIds.has(id),
        ...resolved,
      })
    } catch (err) {
      const message = errorMessageFromUnknown(err)
      return c.json({ ok: false, error: message }, updateResetErrorStatus(message))
    }
  })

  router.get('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, [id])
    const projections = await readProjectionsForServers(db, [id])
    // Self-host pin included — see `resolveColocatedServerIdSet`.
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, [id], {
      includeSelfHostPin: true,
    })
    const current = currentCommitFromDaemonBuild(presence.get(id)?.daemonBuild)
    const channel = instanceUpdateChannel(c)
    const targetManifest = await resolveUpdateManifest(channel)
    const repairedUpdate = await repairProjectedUpdateIfStale(
      db,
      id,
      projections.get(id)?.update ?? null,
      current,
      targetManifest?.commit
    )

    const resolved = await resolveServerUpdateStatus({
      serverId: id,
      current,
      channel,
      targetManifest,
      colocatedWithInstance: colocatedIds.has(id),
      projectedUpdate: repairedUpdate ?? null,
    })

    return c.json({
      ok: true,
      serverId: id,
      channel,
      current,
      colocatedWithInstance: colocatedIds.has(id),
      ...resolved,
    })
  })

  router.post('/servers/:id/update', (c) => updatesAutomaticResponse(c))

  router.get('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const [serverRow] = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!serverRow) return c.json({ error: 'Not found' }, 404)

    let display
    try {
      display = await cachedServerDetailReadModel(c, {
        organizationId,
        serverId: id,
      })
    } catch {
      return c.json({ error: 'Database unavailable' }, 503)
    }
    if (!display) return c.json({ error: 'Not found' }, 404)

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    const orgOptions = parseOrganizationOptions(orgRow?.options)
    const membershipsByServer = await loadDatacenterMembershipsForServers(db, [id])
    const memberships = membershipsByServer.get(id) ?? []
    const membershipDcIds = memberships.map((pin) => pin.datacenterId)
    const datacenterOptionsById = await loadDatacenterOptionsMap(db, membershipDcIds)
    const datacenterDisplayNamesById = await loadDatacenterDisplayNames(
      db,
      distinctNonEmptyIds(membershipDcIds)
    )
    const datacenters = shapeServerDatacenters(memberships, datacenterDisplayNamesById)
    const primaryDcId = datacenters[0]?.id
    const dcOptions = primaryDcId ? datacenterOptionsById.get(primaryDcId) : undefined
    const labelRows = await listServerLabels(db, id)
    const live = display.presence
    const timezoneFields = resolveServerTimezoneFields(
      display.row.options,
      orgOptions,
      dcOptions,
      live?.timeSync?.timezone
    )
    const hostDefaultsFields = resolveServerHostDefaultsFields(
      display.row.options,
      orgOptions,
      dcOptions
    )
    const layoutPathsByServer = await loadServerLayoutPaths(db, [id])
    const placementByServer = await loadTierPlacementsForServers(db, [id], {
      deployment: metricsDeploymentKindForRuntime(opts.runtime),
      unwatched: 'ids',
    })
    const tierPlacement = await enrichServerDetailTierPlacement(
      db,
      organizationId,
      placementByServer.get(id) ?? null
    )

    return c.json({
      ok: true,
      server: {
        ...display.row,
        // See the list route: redacted again at the response boundary so a
        // cache entry written before the redaction cannot leak.
        options: redactServerOptions(display.row.options),
        location: resolveLocation(display.row.options, live?.geo),
        datacenters,
        ...shapeServerPresenceFields(
          live,
          display.colocatedWithInstance,
          metricsDeploymentKindForRuntime(opts.runtime)
        ),
        ...timezoneFields,
        ...hostDefaultsFields,
        orgDefaultTimezone: orgOptions.defaultServerTimezone ?? null,
        enforceServerTimezone: orgOptions.enforceServerTimezone ?? false,
        datacenterDefaultTimezone: dcOptions?.defaultServerTimezone ?? null,
        datacenterEnforceServerTimezone: dcOptions?.enforceServerTimezone ?? false,
        licenseId: display.row.licenseId ?? null,
        tierPlacement,
        layoutPaths: layoutPathsByServer.get(id) ?? null,
        labels: labelRows.map((row) => ({ key: row.key, value: row.value })),
      },
    })
  })

  router.patch('/servers/:id', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const id = c.req.param('id')

    const [existing] = await db
      .select({ id: server.id, options: server.options })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patch = parseServerPatchBody(c, body)
    if (patch instanceof Response) return patch

    const previousOptions = parseServerOptions(existing.options)
    if (patch.locationPatch !== undefined) {
      patch.location = applyLocationPatch(previousOptions?.location, patch.locationPatch)
    }
    const hostingEnable = isHostingEnableTransition(previousOptions, patch)
    const hostingDisable = isHostingDisableTransition(previousOptions, patch)

    const failed = await applyServerPatchUpdate(c, db, {
      serverId: id,
      organizationId,
      patch,
      previousOptions,
    })
    if (failed) return failed

    if (hostingEnable) {
      await enqueueHostingReconcileBestEffort(c, db, {
        serverId: id,
        actorId: session.userId,
        action: 'reconcile',
      })
    } else if (hostingDisable) {
      const hostingEnvironmentId = await systemHierarchy.findSystemEnvironmentForServer(
        db,
        id,
        systemHierarchy.SYSTEM_HOSTING_INGRESS_COMPONENT
      )
      await enqueueHostingReconcileBestEffort(c, db, {
        serverId: id,
        actorId: session.userId,
        action: 'stop',
        ...(hostingEnvironmentId ? { environmentId: hostingEnvironmentId } : {}),
      })
    }

    nudgeTunnelRoutesAfterResponse(c, organizationId)
    return c.json({ ok: true as const })
  })

  /**
   * The compromised-host cutoff. Revoke first — durable, and what
   * `POST /auth/session`, the WebSocket connect check, and (self-hosted)
   * every inbound frame re-check — then purge the live cell as best effort
   * so an open socket does not wait for its next frame or JWT expiry to
   * notice. Registry down means
   * the revoke still lands and `purged: false` says so; re-calling on an
   * already-revoked key is idempotent and re-attempts the purge. Sticky:
   * `POST /enroll` refuses a revoked server, so the license token still on
   * the host cannot re-enroll it — recovery is `DELETE /servers/:id`.
   */
  router.post('/servers/:id/daemon-key/revoke', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const id = c.req.param('id')

    const [row] = await db
      .select({ id: server.id, name: server.name, hostname: server.hostname })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const stepUp = await requireStepUpIfConfigured(c, organizationId, 'server.daemon_key.revoke')
    if (stepUp) return stepUp

    const registry = getDaemonCellRegistry(c)
    const blocked = await assertServerNotColocatedOr403(
      c,
      db,
      registry,
      id,
      organizationId,
      COLOCATED_SERVER_KEY_REVOKE_BLOCKED_REASON
    )
    if (blocked) return blocked

    const daemonState = await getServerDaemonStateByServerId(db, id)
    if (!daemonState) {
      return c.json({ error: 'Server is not enrolled' }, 409)
    }

    if (isDaemonKeyActive(daemonState.key)) {
      await revokeDaemonKey(db, id)
    }
    const purgeError = registry ? await purgeServerDaemonCell(registry, id) : 'registry_unavailable'
    const revoked = await getServerDaemonStateByServerId(db, id)

    await recordAuditAndNotify(
      c,
      {
        organizationId,
        actorUserId: session.userId,
        actorEmail: session.email,
        action: 'server.daemon_key.revoke',
        targetType: 'server',
        targetId: id,
        context: { purged: purgeError === null },
      },
      { serverName: row.name ?? row.hostname ?? id }
    )

    return c.json({
      ok: true as const,
      revokedAt: revoked?.key.revokedAt ?? null,
      purged: purgeError === null,
      ...(purgeError !== null ? { purgeError } : {}),
    })
  })

  router.delete('/servers/:id', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const id = c.req.param('id')

    const [row] = await db
      .select({
        id: server.id,
        name: server.name,
        hostname: server.hostname,
        isConnected: server.isConnected,
      })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const stepUp = await requireStepUpIfConfigured(c, organizationId, 'server.delete')
    if (stepUp) return stepUp

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const forgetResources = parseForgetResourcesFlag(c.req.query('forgetResources'), body)
    const principalChoices = parsePrincipalRemovalChoices(body)
    if ('error' in principalChoices) {
      return c.json({ error: principalChoices.error }, 400)
    }

    // Co-located guard before the registry 503 so an unavailable registry can
    // never turn a self-host-pinned (or probe-matched) host into a deletable one.
    const registry = getDaemonCellRegistry(c)
    const blocked = await assertServerDeletable(c, db, registry, id, organizationId, {
      skipForgettableBlockers: forgetResources,
      refuseIfOnline: forgetResources,
      storedConnected: row.isConnected,
    })
    if (blocked) return blocked

    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    const serverConnected = await isServerConnectedStoredOrLive(db, registry, id, row.isConnected)
    const idleOrBlocked = await assertSystemEnvironmentIdleOrBlocked(c, db, id, {
      forgetResources,
      serverConnected,
    })
    if (idleOrBlocked instanceof Response) return idleOrBlocked

    const principalRefusal = await refusePrincipalRemovalChoices(c, db, id, principalChoices)
    if (principalRefusal) return principalRefusal

    const result = await deleteServerWithSystemSubtree(
      db,
      id,
      organizationId,
      idleOrBlocked.systemEnvironmentIds,
      forgetResources,
      principalIdsToDelete(principalChoices)
    )
    if (result.status === 'online') {
      return serverOnlineForgetBlockedResponse(c)
    }
    if (result.status === 'blockers') {
      return serverDeleteBlockersResponse(
        c,
        result.blockers,
        result.blockedDatabases,
        result.blockedEnvironments
      )
    }
    if (result.status === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c, result.fkBlockers ?? [])
    }

    await reconcileFabricAfterServerDelete(c, db, organizationId, session.userId)
    nudgeTunnelRoutesAfterResponse(c, organizationId)

    await clearServerDaemonState(db, id)

    const purgeError = await purgeServerDaemonCell(registry, id)
    // The freed seat stays free: no other server is moved onto it (only a
    // manager assigns licenses). The self-hosted grant is squared up, and
    // *shrinking* it is allowed on either runtime: the revoked license just
    // gave its granted unit back, and leaving it standing would be a free
    // license on the hosted runtime.
    await syncSelfHostedGrant(db, organizationId, {
      allowGrow: metricsDeploymentKindForRuntime(opts.runtime) === 'self-hosted',
    }).catch((err) => {
      compatLogWarn('servers', `self-hosted grant sync after delete failed: ${String(err)}`)
    })

    await recordAuditAndNotify(
      c,
      {
        organizationId,
        actorUserId: session.userId,
        actorEmail: session.email,
        action: 'server.delete',
        targetType: 'server',
        targetId: id,
        context: {
          purged: purgeError === null,
          ...(result.forgotten ? { forgotten: result.forgotten } : {}),
        },
      },
      { serverName: row.name ?? row.hostname ?? id }
    )

    return serverDeletedResponse(c, id, purgeError)
  })

  registerServerCommandRoutes(router, opts)
  registerServerMetricsRoutes(router, opts)
  registerServerTrafficMapRoutes(router, opts)
  registerServerLabelRoutes(router, opts)
  registerServerAddressRoutes(router)
  registerServerServicesRoutes(router, opts)
  registerServerPrincipalRemovalRoutes(router, opts)
  registerServerLicenseTierRoutes(router, opts)
}
