import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import { isAdminRole } from '../authn/session-store.ts'
import { can, listVisible } from '../authz/index.ts'
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
  onDaemonUpdateQueued,
  onDaemonUpdateReset,
  onDaemonUpdateResult,
  repairStaleProjectedUpdate,
} from '../../daemon/cell/control-plane-monitor.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { UpdateProjection } from '../../features/servers/daemon-state.ts'
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
} from '../../contracts/cell-protocol.ts'
import {
  clearServerDaemonState,
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
  revokeDaemonKey,
} from '../../features/servers/server-identity-db.ts'
import { datacenter, license, organization, server } from '../../db/schema.ts'
import { INSTANCE_VERSION } from '../../app/version.ts'
import { resolveInstanceRevision } from '../../app/build-info.ts'
import { isExplicitDevelopmentMode } from '../../lib/dev-mode.ts'
import { createUpgradeCoordinator } from '../../features/upgrades/coordinator.ts'
import { parseUpgradeBatchDefault } from '../../features/settings/upgrade-settings.ts'
import { createDrizzleUpgradeStore } from '../../features/upgrades/store.ts'
import {
  parseUpgradeVerifyTimeoutMs,
  UPGRADE_VERIFY_TIMEOUT_ENV,
} from '../../features/upgrades/transitions.ts'
import {
  type ClientUpdateBlock,
  clientUpdateBlockReason,
  clientUpdateBlockStatus,
  type ServerUpdateBlockedCode,
} from '../../features/upgrades/decisions.ts'
import { resolveUpdateManifest } from '../../features/update/manifest.ts'
import { resolveInstanceUpdateChannel, type UpdateChannel } from '../../contracts/update-channel.ts'
import { getServerUpdatePreparer } from '../../features/update/prepare.ts'
import { revokeLicense } from '../../features/licenses/license.ts'
import { recomputeOrganizationAssignments } from '../../features/tiers/assignment-records.ts'
import { syncSelfHostedGrant } from '../../features/tiers/self-hosted-grant-records.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  type HierarchyDeleteFkBlocker,
  runHierarchyDeleteResult,
} from '../hierarchy-delete.ts'
import { purgeServerForeignKeysForDelete } from './server-fk.ts'
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
import { resolveColocatedServerId } from '../authn/install-state.ts'
import { hasActiveColocatedLicenseBinding, resolveColocatedServerIdSet } from './colocated.ts'
import {
  colocatedServerUpdateBlockedReason,
  isStaleProjectedUpdating,
  loadServerStatusRecords,
  resolveServerUpdateStatus,
  type ServerUpdateCommit,
} from './update-status.ts'
import { UPDATE_REQUEST_TTL_MS } from '../../features/update/constants.ts'
import { registerServerCommandRoutes } from './commands-routes.ts'
import { registerServerMetricsRoutes } from './metrics-routes.ts'
import { registerServerTrafficMapRoutes } from './traffic-map-routes.ts'
import { registerServerLabelRoutes } from './labels-routes.ts'
import { registerServerServicesRoutes } from './services-routes.ts'
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
  queueServerUpdateHttpStatus,
  repairedUpdateDoneProjection,
  repairedUpdateIdleProjection,
  resolveBatchUpdateEligibility,
  resolveServerHostDefaultsFields,
  resolveServerTimezoneFields,
  resolveTrunkTargetFields,
  runPreparedServerUpdate,
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

const UPDATE_REQUEST_TTL_SECONDS = 300

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

type QueuedUpdateResult = {
  ok: true
  queued: true
  status: 'updating'
  serverId: string
  requestId: string
  channel: UpdateChannel
}

type QueueUpdateFailure = {
  ok: false
  error: string
}

/** The channel this control plane follows — the one every queued update targets. */
function instanceUpdateChannel(c: Context<AppEnv>): UpdateChannel {
  return resolveInstanceUpdateChannel(c.get('platformEnv'))
}

/**
 * The instance's upgrade coordinator for this request, plus the co-located
 * server id it was built with (callers exclude that host from fleet runs).
 */
async function buildUpgradeCoordinator(
  c: Context<AppEnv>,
  db: Db,
  registry: DaemonCellRegistry,
  runtime: 'deno' | 'workers'
): Promise<{
  coordinator: ReturnType<typeof createUpgradeCoordinator>
  colocated: Awaited<ReturnType<typeof resolveColocatedServerId>>
}> {
  const revision = resolveInstanceRevision(c.get('platformEnv'))
  const colocated = await resolveColocatedServerId(db, registry)
  const coordinator = createUpgradeCoordinator({
    store: createDrizzleUpgradeStore(
      db,
      registry,
      parseUpgradeBatchDefault(c.get('platformEnv')?.TURBOPANEL_UPGRADE_BATCH)
    ),
    enqueue: (serverId, envelope) => registry.getCell(serverId).enqueue(envelope),
    runtime,
    channel: instanceUpdateChannel(c),
    development: isExplicitDevelopmentMode(),
    now: () => new Date().toISOString(),
    colocatedServerId: colocated,
    instanceInstalled: { version: INSTANCE_VERSION, commit: revision.commit },
    verifyTimeoutMs: parseUpgradeVerifyTimeoutMs(
      c.get('platformEnv')?.[UPGRADE_VERIFY_TIMEOUT_ENV]
    ),
  })
  return { coordinator, colocated }
}

async function clientUpdateGate(
  c: Context<AppEnv>,
  runtime: 'deno' | 'workers'
): Promise<ClientUpdateBlock> {
  if (runtime === 'workers') {
    return { blocked: true, error: 'updates_managed' }
  }
  const db = getDb(c)
  const registry = getDaemonCellRegistry(c)
  if (!db || !registry) return { blocked: false, useCoordinator: false }
  const { coordinator } = await buildUpgradeCoordinator(c, db, registry, runtime)
  try {
    return await coordinator.updateGate()
  } catch {
    if (isExplicitDevelopmentMode()) {
      return { blocked: false, useCoordinator: false }
    }
    return { blocked: true, error: 'upgrade_gate_unavailable' }
  }
}

function blockedUpdateResponse(c: Context<AppEnv>, gate: ClientUpdateBlock): Response | null {
  if (!gate.blocked) return null
  return c.json({ ok: false, error: gate.error }, clientUpdateBlockStatus(gate.error))
}

/** Legacy per-server enqueue is development-only. Production fails closed. */
function legacyUpdateAllowed(gate: ClientUpdateBlock): boolean {
  return !gate.blocked && !gate.useCoordinator && isExplicitDevelopmentMode()
}

function gateFields(gate: ClientUpdateBlock): {
  updateBlocked?: boolean
  updateBlockedCode?: ServerUpdateBlockedCode
  updateBlockedReason?: string
} {
  if (!gate.blocked) return {}
  return {
    updateBlocked: true,
    updateBlockedCode: gate.error,
    updateBlockedReason: clientUpdateBlockReason(gate.error),
  }
}

async function queueServerUpdate(
  registry: DaemonCellRegistry,
  db: Db,
  serverId: string,
  channel: UpdateChannel
): Promise<QueuedUpdateResult | QueueUpdateFailure> {
  const presence = await resolveFleetPresence(db, registry, [serverId])
  const live = presence.get(serverId)
  if (!live?.connected) {
    return { ok: false, error: 'Daemon not connected' }
  }
  // Includes the self-host pin: the "don't remote-update the host you run
  // on" guard must hold on both runtimes, and the transport probes
  // (`__direct__`, the local machine key) only ever fire on the self-hosted
  // one. Against TurboPanel High Availability the co-located daemon connects
  // over HTTPS like any other, so the pin is the only thing that still knows.
  const colocatedIds = await resolveColocatedServerIdSet(db, registry, [serverId], {
    includeSelfHostPin: true,
  })
  if (colocatedIds.has(serverId)) {
    return { ok: false, error: colocatedServerUpdateBlockedReason() }
  }

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'update',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    channel: channel,
  }

  const preparer = getServerUpdatePreparer()
  if (preparer) {
    // Dev-only: rebuild the local daemon overlay before releasing the
    // envelope. Mark the projection as updating now so the UI polls through
    // the build; the envelope enqueues when the (single-flight) build lands.
    await onDaemonUpdateQueued(db, serverId, requestId, channel, envelope.at)
    void runPreparedServerUpdate({
      prepare: preparer,
      enqueue: async () => {
        await registry.getCell(serverId).enqueue(envelope, {
          ttlSeconds: UPDATE_REQUEST_TTL_SECONDS,
        })
      },
      markQueued: (queuedAt) => onDaemonUpdateQueued(db, serverId, requestId, channel, queuedAt),
      markFailed: (error, finishedAt) =>
        onDaemonUpdateResult(db, serverId, requestId, false, finishedAt, error),
    })
    return {
      ok: true,
      queued: true,
      status: 'updating',
      serverId,
      requestId,
      channel: channel,
    }
  }

  await registry.getCell(serverId).enqueue(envelope, {
    ttlSeconds: UPDATE_REQUEST_TTL_SECONDS,
  })

  await onDaemonUpdateQueued(db, serverId, requestId, channel, envelope.at)

  return {
    ok: true,
    queued: true,
    status: 'updating',
    serverId,
    requestId,
    channel: channel,
  }
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

/**
 * Soft-revokes the registration key that enrolled this server.
 * Licenses are one-shot: deleting the server retires the key on every runtime
 * so it cannot enroll a replacement host.
 */
async function revokeBoundLicenseOnServerDelete(
  db: Db,
  serverId: string,
  licenseId: string | null,
  organizationId: string
): Promise<void> {
  if (!licenseId) return

  const invalidated = await revokeLicense(db, licenseId, organizationId)
  if (!invalidated) {
    compatLogWarn(
      'servers',
      `server ${serverId} deleted but license ${licenseId} was not invalidated (missing, wrong org, or already revoked)`
    )
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
 * Blocks delete while system hosting-ingress containers are still active.
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

  const blockingContainers = await listSystemContainersBlockingServerDelete(
    db,
    serverId,
    opts.serverConnected
  )
  if (blockingContainers.length > 0) {
    return serverSystemContainersDeleteBlockedResponse(c, {
      serverConnected: opts.serverConnected,
      containers: blockingContainers,
    })
  }
  return { systemEnvironmentIds }
}

async function deleteServerWithSystemSubtree(
  db: Db,
  serverId: string,
  organizationId: string,
  systemEnvironmentIds: readonly string[],
  forgetResources: boolean
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
    const placementByServer = await loadTierPlacementsForServers(db, serverIds, {
      deployment: metricsDeploymentKindForRuntime(opts.runtime),
      orgOptions,
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
    // Self-host pin included — see `queueServerUpdate`.
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, visibleIds, {
      includeSelfHostPin: true,
    })
    const channel = instanceUpdateChannel(c)
    const targetManifest = await resolveUpdateManifest(channel)
    const { target, targetStatus, targetError } = resolveTrunkTargetFields(targetManifest, channel)
    const gate = await clientUpdateGate(c, opts.runtime)

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
          ...gateFields(gate),
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

  router.post('/servers/updates', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope

    // Starting a fleet update opens the one instance-wide upgrade run: the
    // same organization:manage bar as updating a single server.
    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (opts.runtime === 'workers') {
      return c.json({ ok: false, error: 'updates_managed' }, 409)
    }
    const gate = await clientUpdateGate(c, opts.runtime)
    const blocked = blockedUpdateResponse(c, gate)
    if (blocked) return blocked
    if (!gate.blocked && gate.useCoordinator) {
      const { coordinator, colocated } = await buildUpgradeCoordinator(
        c,
        db,
        registry,
        opts.runtime
      )
      const started = await coordinator.start({
        source: 'server',
        startedBy: session.userId,
        fleetServerIds: visibleIds.filter((id) => id !== colocated),
      })
      if (!started.ok) return c.json(started, 409)
      return c.json({ ok: true, runId: started.runId, queued: true })
    }
    if (!legacyUpdateAllowed(gate)) {
      return c.json({ ok: false, error: 'upgrade_gate_unavailable' }, 503)
    }

    const channel = instanceUpdateChannel(c)
    const targetManifest = await resolveUpdateManifest(channel)
    const presence = await resolveFleetPresence(db, registry, visibleIds)
    // Self-host pin included — see `queueServerUpdate`.
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, visibleIds, {
      includeSelfHostPin: true,
    })

    const results = await Promise.all(
      visibleIds.map(async (serverId) => {
        const manageable = await can(db, session.userId, 'organization:manage', 'server', serverId)
        if (!manageable) {
          return {
            serverId,
            ok: false,
            error: 'Forbidden',
          }
        }

        const current = currentCommitFromDaemonBuild(presence.get(serverId)?.daemonBuild)
        const eligibility = resolveBatchUpdateEligibility({
          connected: presence.get(serverId)?.connected ?? false,
          colocated: colocatedIds.has(serverId),
          current,
          targetCommit: targetManifest?.commit ?? null,
        })
        if (!eligibility.ok) {
          return {
            serverId,
            ok: false,
            error: eligibility.error,
          }
        }

        const queued = await queueServerUpdate(registry, db, serverId, channel)
        if (!queued.ok) {
          return { serverId, ok: false, error: queued.error }
        }

        return {
          serverId,
          ok: true,
          queued: true,
          status: queued.status,
          requestId: queued.requestId,
          channel: queued.channel,
        }
      })
    )

    return c.json({
      ok: results.every((result) => result.ok),
      results,
    })
  })

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
      // Self-host pin included — see `queueServerUpdate`.
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
    // Self-host pin included — see `queueServerUpdate`.
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

    const gate = await clientUpdateGate(c, opts.runtime)
    return c.json({
      ok: true,
      serverId: id,
      channel,
      current,
      colocatedWithInstance: colocatedIds.has(id),
      ...resolved,
      ...gateFields(gate),
    })
  })

  router.post('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    if (opts.runtime === 'workers') {
      return c.json({ ok: false, error: 'updates_managed' }, 409)
    }
    const gate = await clientUpdateGate(c, opts.runtime)
    const blocked = blockedUpdateResponse(c, gate)
    if (blocked) return blocked
    if (!gate.blocked && gate.useCoordinator) {
      const { coordinator } = await buildUpgradeCoordinator(c, db, registry, opts.runtime)
      const started = await coordinator.start({
        source: 'server',
        startedBy: c.get('session')?.userId ?? null,
        serverId: id,
      })
      if (!started.ok) return c.json(started, 409)
      return c.json({ ok: true, runId: started.runId, queued: true })
    }
    if (!legacyUpdateAllowed(gate)) {
      return c.json({ ok: false, error: 'upgrade_gate_unavailable' }, 503)
    }

    const queued = await queueServerUpdate(registry, db, id, instanceUpdateChannel(c))
    if (!queued.ok) {
      return c.json({ ok: false, error: queued.error }, queueServerUpdateHttpStatus(queued.error))
    }

    return c.json(queued)
  })

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
      orgOptions,
      unwatched: 'ids',
    })

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
        tierPlacement: placementByServer.get(id) ?? null,
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

    const [boundLicense] = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.serverId, id))
      .limit(1)

    const serverConnected = await isServerConnectedStoredOrLive(db, registry, id, row.isConnected)
    const idleOrBlocked = await assertSystemEnvironmentIdleOrBlocked(c, db, id, {
      forgetResources,
      serverConnected,
    })
    if (idleOrBlocked instanceof Response) return idleOrBlocked

    const result = await deleteServerWithSystemSubtree(
      db,
      id,
      organizationId,
      idleOrBlocked.systemEnvironmentIds,
      forgetResources
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

    await clearServerDaemonState(db, id)

    const purgeError = await purgeServerDaemonCell(registry, id)
    await revokeBoundLicenseOnServerDelete(db, id, boundLicense?.id ?? null, organizationId)
    // The freed tier may now cover a server that was uncovered, or let a
    // server move down: re-derive the organization's assignment. This runs
    // on both runtimes — self-hosted derives an assignment too, from its
    // grant. The grant is squared up first, and *shrinking* it is allowed
    // on either runtime: the revoked license just gave its granted unit
    // back, and leaving it standing would be a free license on the hosted
    // runtime.
    await syncSelfHostedGrant(db, organizationId, {
      allowGrow: metricsDeploymentKindForRuntime(opts.runtime) === 'self-hosted',
    }).catch((err) => {
      compatLogWarn('servers', `self-hosted grant sync after delete failed: ${String(err)}`)
    })
    await recomputeOrganizationAssignments(db, organizationId).catch((err) => {
      compatLogWarn('servers', `tier assignment recompute after delete failed: ${String(err)}`)
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
  registerServerServicesRoutes(router, opts)
}
