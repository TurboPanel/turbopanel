import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { ensureProjectPlacements } from '../principals/placement-records.ts'
import {
  binding,
  container,
  deployment,
  environment,
  folder,
  hosting,
  leaf,
  managed,
  login,
  principal,
  project,
  service,
  share,
  slot,
  storage,
  storageCopy,
  tenancy,
} from '../../db/schema.ts'
import { markAssetFoldersRemoving } from '../folders/allocate.ts'
import { type COMMON_ASSET_IN_USE_ERROR, inUseBody, listUsesOfAssets } from '../folders/shares.ts'
import {
  applyStorageRetentionOnParentDelete,
  listStorageIdsDeletedWith,
} from '../storage/storage-records.ts'
import { purgeEnvironmentsComposeNetworks } from '../fabric/fabric-records.ts'
import {
  enqueueIngressForBindingChange,
  type BindingListenerSync,
} from '../bindings/enqueue-change.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { bindingLoginJoin, bindingManagedId } from '../managed/logins.ts'

/** Docker Compose states that are considered fully stopped (safe to cascade-delete). */
const STOPPED_CONTAINER_STATUSES = new Set(['exited', 'dead', 'removing'])

export const PROJECT_HAS_RUNNING_SERVICES_ERROR = 'project_has_running_services'
export const MANAGED_RUNTIME_PRESENT_ERROR = 'managed_runtime_present'

/**
 * True when a container still needs an environment.stop before project delete.
 * Stopped statuses (`exited` / `dead` / `removing`) are allowed; missing/unknown
 * statuses are treated as active so we never cascade over live stacks.
 */
export function isActiveContainerStatus(status: string | undefined): boolean {
  if (status === undefined || status.length === 0) return true
  return !STOPPED_CONTAINER_STATUSES.has(status)
}

export type ProjectDeleteResult =
  | { ok: true; warning?: string }
  | {
      ok: false
      error:
        | 'project_has_running_services'
        | 'managed_runtime_present'
        | 'project_has_folders'
        | typeof COMMON_ASSET_IN_USE_ERROR
      /** Extra fields for the 409 body (who still uses a shared asset). */
      detail?: Record<string, unknown>
    }

/**
 * Only tenant `service` containers gate deletion. Platform components
 * recorded against the environment (`ingress` ProxySQL, `ha` Orchestrator)
 * are shared per-server infrastructure whose lifecycle is server-scoped
 * ("does this server still front anything?") — the destroy fan-out and the
 * orphan sweep own their teardown, and a project must never be held hostage
 * by them.
 */
function hasActiveServiceContainer(
  rows: ReadonlyArray<{ status: string | null; role: string | null }>
): boolean {
  return rows.some(
    (row) => row.role === 'service' && isActiveContainerStatus(row.status ?? undefined)
  )
}

/** Deployment statuses that mean an apply is queued or running (or draining). */
const IN_PROGRESS_DEPLOYMENT_STATUSES = ['pending', 'applying', 'draining']

export const ENVIRONMENT_RUNNING_ERROR = 'environment_running'

type EnvironmentRowSet = {
  environmentIds: string[]
  serviceIds: string[]
  containerIds: string[]
  hostingIds: string[]
  /** Set when the whole project goes too (storage retention is scoped by it). */
  projectId?: string
}

/**
 * Drop the rows under the given environments, in FK-safe order: container ->
 * hosting -> tenancy -> binding -> service -> environment. Variables cascade
 * via FK. `tenancy.service_id` and `binding.service_id` are RESTRICT (safety
 * net on a direct service delete), so those edges go before services.
 * Shared by project delete, environment delete, and gone-host forget; run
 * inside a transaction. Does not check running state — callers that need
 * that gate do it before calling.
 */
async function loadBindingListenerTargets(
  db: Db,
  serviceIds: readonly string[]
): Promise<Array<{ managedId: string; serviceId: string }>> {
  if (serviceIds.length === 0) return []
  const rows = await db
    .select({
      managedId: bindingManagedId,
      serviceId: binding.serviceId,
    })
    .from(binding)
    .leftJoin(login, bindingLoginJoin())
    .leftJoin(principal, eq(principal.id, binding.principalId))
    .where(inArray(binding.serviceId, [...serviceIds]))
  return rows.filter((row): row is { managedId: string; serviceId: string } =>
    Boolean(row.managedId)
  )
}

function mergeBindingListenerWarning(
  current: string | undefined,
  outcome: Readonly<{ warning?: string }>
): string | undefined {
  if (current) return current
  return outcome.warning
}

async function syncRemovedBindingListeners(
  db: Db,
  targets: ReadonlyArray<{ managedId: string; serviceId: string }>,
  listenerSync?: BindingListenerSync
): Promise<string | undefined> {
  if (!listenerSync || targets.length === 0) return undefined
  const serviceIdsByManaged = new Map<string, string[]>()
  for (const row of targets) {
    const list = serviceIdsByManaged.get(row.managedId) ?? []
    list.push(row.serviceId)
    serviceIdsByManaged.set(row.managedId, list)
  }
  let warning: string | undefined
  await forEachSequential([...serviceIdsByManaged.entries()], async ([managedId, serviceIds]) => {
    const outcome = await enqueueIngressForBindingChange(listenerSync.c, db, {
      serviceIds: [...new Set(serviceIds)],
      managedId,
      actorId: listenerSync.actorId,
      organizationId: listenerSync.organizationId,
    })
    warning = mergeBindingListenerWarning(warning, outcome)
  })
  return warning
}

async function purgeEnvironmentServerPlacementArtifacts(
  tx: Db,
  environmentIds: readonly string[],
  serverId: string
): Promise<void> {
  if (environmentIds.length === 0) return
  const ids = [...environmentIds]
  await tx.delete(deployment).where(inArray(deployment.environmentId, ids))
  await tx.delete(slot).where(inArray(slot.environmentId, ids))

  const managedRows = await tx
    .select({ id: managed.id })
    .from(managed)
    .where(inArray(managed.environmentId, ids))
  const managedIds = managedRows.map((row) => row.id)
  if (managedIds.length > 0) {
    await tx
      .delete(leaf)
      .where(and(eq(leaf.serverId, serverId), inArray(leaf.managedId, managedIds)))
  }

  const storageRows = await tx
    .select({ id: storage.id })
    .from(storage)
    .where(inArray(storage.environmentId, ids))
  const storageIds = storageRows.map((row) => row.id)
  if (storageIds.length > 0) {
    await tx
      .delete(storageCopy)
      .where(and(inArray(storageCopy.storageId, storageIds), eq(storageCopy.serverId, serverId)))
  }
}

async function dropEnvironmentRows(tx: Db, rows: EnvironmentRowSet): Promise<void> {
  const { environmentIds, serviceIds, containerIds, hostingIds } = rows
  const retentionScope = {
    ...(rows.projectId ? { projectIds: [rows.projectId] } : {}),
    environmentIds,
    ...(serviceIds.length > 0 ? { serviceIds } : {}),
  }
  // These environments stop using shared assets first, and so does anything still
  // using an asset that goes with them (a delete that got this far has been checked;
  // a forget has no one to ask), so no asset meets a row that names it.
  const goneStorageIds = await listStorageIdsDeletedWith(tx, retentionScope)
  await tx
    .delete(share)
    .where(
      or(
        inArray(share.environmentId, [...environmentIds]),
        serviceIds.length > 0 ? inArray(share.serviceId, serviceIds) : undefined,
        goneStorageIds.length > 0 ? inArray(share.storageId, goneStorageIds) : undefined
      )
    )
  await applyStorageRetentionOnParentDelete(tx, retentionScope)
  // `network.environment_id` has no FK, so compose rows are not covered by cascade.
  await purgeEnvironmentsComposeNetworks(tx, environmentIds)
  if (containerIds.length > 0) {
    await tx.delete(container).where(inArray(container.id, containerIds))
  }
  if (hostingIds.length > 0) {
    await tx.delete(hosting).where(inArray(hosting.id, hostingIds))
  }
  if (serviceIds.length > 0) {
    // A shared service's folder row stays, locked, until the host confirms it gone.
    await markAssetFoldersRemoving(tx, { serviceIds })
    await tx.delete(tenancy).where(inArray(tenancy.serviceId, serviceIds))
    await tx.delete(binding).where(inArray(binding.serviceId, serviceIds))
    await tx.delete(service).where(inArray(service.id, serviceIds))
  }
  // Rows for folders already confirmed gone no longer lock anything; the others
  // were refused before this point (or belong to a host that is gone).
  await tx
    .delete(folder)
    .where(and(inArray(folder.environmentId, environmentIds), eq(folder.state, 'missing')))
  await tx.delete(environment).where(inArray(environment.id, environmentIds))
}

type EnvironmentChildren = {
  serviceIds: string[]
  containerRows: Array<{ id: string; status: string | null; role: string | null }>
  hostingIds: string[]
}

async function loadEnvironmentChildren(
  db: Db,
  environmentIds: readonly string[]
): Promise<EnvironmentChildren> {
  if (environmentIds.length === 0) {
    return { serviceIds: [], containerRows: [], hostingIds: [] }
  }
  const serviceRows = await db
    .select({ id: service.id })
    .from(service)
    .where(inArray(service.environmentId, environmentIds))
  const serviceIds = serviceRows.map((row) => row.id)
  if (serviceIds.length === 0) {
    return { serviceIds, containerRows: [], hostingIds: [] }
  }
  const containerRows = await db
    .select({ id: container.id, status: container.status, role: container.role })
    .from(container)
    .where(inArray(container.serviceId, serviceIds))
  const hostingRows = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(inArray(hosting.serviceId, serviceIds))
  return { serviceIds, containerRows, hostingIds: hostingRows.map((row) => row.id) }
}

/**
 * The shared (common) services and volumes that go with these environments,
 * when another environment, of this project or any other, still uses one.
 * Those environments have to stop using it first.
 */
async function sharedAssetsStillUsed(
  db: Db,
  scope: {
    projectIds?: readonly string[]
    environmentIds: readonly string[]
    serviceIds: readonly string[]
  }
): Promise<{ error: typeof COMMON_ASSET_IN_USE_ERROR; detail: Record<string, unknown> } | null> {
  const storageIds = await listStorageIdsDeletedWith(db, scope)
  const uses = await listUsesOfAssets(
    db,
    { serviceIds: scope.serviceIds, storageIds },
    scope.environmentIds
  )
  if (uses.length === 0) return null
  const { error, ...detail } = inUseBody(uses)
  return { error, detail }
}

/**
 * Cascade-delete a project and all child resources after verifying no active
 * containers remain and no managed-engine rows still exist. Managed host
 * runtime must be torn down with `managed.destroy` first —
 * `managed.environment_id` is ON DELETE CASCADE, so a live row here would
 * otherwise drop the cluster without stopping Docker.
 */
export async function deleteProjectCascade(
  db: Db,
  projectId: string,
  listenerSync?: BindingListenerSync
): Promise<ProjectDeleteResult> {
  const envRows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))

  const environmentIds = envRows.map((row) => row.id)

  if (environmentIds.length === 0) {
    await db.transaction(async (tx) => {
      await applyStorageRetentionOnParentDelete(tx, { projectIds: [projectId] })
      await tx.delete(project).where(eq(project.id, projectId))
    })
    return { ok: true }
  }

  const managedRows = await db
    .select({ id: managed.id })
    .from(managed)
    .where(inArray(managed.environmentId, environmentIds))
  if (managedRows.length > 0) {
    return { ok: false, error: MANAGED_RUNTIME_PRESENT_ERROR }
  }

  const children = await loadEnvironmentChildren(db, environmentIds)
  if (hasActiveServiceContainer(children.containerRows)) {
    return { ok: false, error: 'project_has_running_services' }
  }

  const sharedInUse = await sharedAssetsStillUsed(db, {
    projectIds: [projectId],
    environmentIds,
    serviceIds: children.serviceIds,
  })
  if (sharedInUse) return { ok: false, error: sharedInUse.error, detail: sharedInUse.detail }

  // A folder on a server holds its environment's name (and the project's slug)
  // until the host confirms it is gone; the delete waits for that.
  const folderRows = await db
    .select({ id: folder.id })
    .from(folder)
    .where(and(inArray(folder.environmentId, environmentIds), ne(folder.state, 'missing')))
  if (folderRows.length > 0) return { ok: false, error: 'project_has_folders' }

  const bindingTargets = await loadBindingListenerTargets(db, children.serviceIds)
  await db.transaction(async (tx) => {
    // The principals outlive the project (`project_id` SET NULL); their
    // placements become the only record of which servers they are on, so
    // write any that are missing while the environments still say where.
    await ensureProjectPlacements(tx, projectId)
    await dropEnvironmentRows(tx, {
      projectId,
      environmentIds,
      serviceIds: children.serviceIds,
      containerIds: children.containerRows.map((row) => row.id),
      hostingIds: children.hostingIds,
    })
    await tx.delete(project).where(eq(project.id, projectId))
  })
  const listenerWarning = await syncRemovedBindingListeners(db, bindingTargets, listenerSync)
  return listenerWarning ? { ok: true, warning: listenerWarning } : { ok: true }
}

export type EnvironmentDeleteRefusal =
  | typeof ENVIRONMENT_RUNNING_ERROR
  | typeof MANAGED_RUNTIME_PRESENT_ERROR
  | typeof COMMON_ASSET_IN_USE_ERROR

export type EnvironmentDeleteResult =
  | { ok: true; warning?: string }
  | { ok: false; error: EnvironmentDeleteRefusal; detail?: Record<string, unknown> }

async function hasInProgressDeployment(db: Db, environmentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: deployment.id })
    .from(deployment)
    .where(
      and(
        eq(deployment.environmentId, environmentId),
        inArray(deployment.status, IN_PROGRESS_DEPLOYMENT_STATUSES)
      )
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Drop the rows under these environments on an explicit transaction, without
 * the running-container or in-progress-deploy refusal. Used when the host is
 * already gone so leftover app records cannot be stopped first. Does not
 * refuse managed rows — the caller must not pass an environment that still
 * carries a managed database.
 */
export async function dropEnvironmentSubtreeInTx(
  tx: Db,
  environmentIds: readonly string[],
  opts?: Readonly<{ serverId?: string }>
): Promise<{ containers: number }> {
  if (environmentIds.length === 0) {
    return { containers: 0 }
  }
  const ids = [...environmentIds]
  if (opts?.serverId) {
    await purgeEnvironmentServerPlacementArtifacts(tx, ids, opts.serverId)
  }
  // The host is gone, so nothing will ever confirm these folders removed.
  await tx.delete(folder).where(inArray(folder.environmentId, ids))
  const children = await loadEnvironmentChildren(tx, ids)
  await dropEnvironmentRows(tx, {
    environmentIds: ids,
    serviceIds: children.serviceIds,
    containerIds: children.containerRows.map((row) => row.id),
    hostingIds: children.hostingIds,
  })
  return { containers: children.containerRows.length }
}

/**
 * Cascade-delete one environment and its services, hostings, containers,
 * tenancy, bindings and variables (the same rows, in the same order, as a
 * project delete). Refused with `environment_running` while a tenant container
 * is still active or a deploy is queued/applying/draining: the user must Stop
 * the environment first. `deployment` rows go with it (FK cascade).
 */
export async function deleteEnvironmentCascade(
  db: Db,
  environmentId: string,
  listenerSync?: BindingListenerSync
): Promise<EnvironmentDeleteResult> {
  const managedRows = await db
    .select({ id: managed.id })
    .from(managed)
    .where(eq(managed.environmentId, environmentId))
    .limit(1)
  if (managedRows.length > 0) {
    return { ok: false, error: MANAGED_RUNTIME_PRESENT_ERROR }
  }

  const children = await loadEnvironmentChildren(db, [environmentId])
  if (
    hasActiveServiceContainer(children.containerRows) ||
    (await hasInProgressDeployment(db, environmentId))
  ) {
    return { ok: false, error: ENVIRONMENT_RUNNING_ERROR }
  }

  const sharedInUse = await sharedAssetsStillUsed(db, {
    environmentIds: [environmentId],
    serviceIds: children.serviceIds,
  })
  if (sharedInUse) return { ok: false, error: sharedInUse.error, detail: sharedInUse.detail }

  const bindingTargets = await loadBindingListenerTargets(db, children.serviceIds)
  await db.transaction((tx) =>
    dropEnvironmentRows(tx, {
      environmentIds: [environmentId],
      serviceIds: children.serviceIds,
      containerIds: children.containerRows.map((row) => row.id),
      hostingIds: children.hostingIds,
    })
  )
  const listenerWarning = await syncRemovedBindingListeners(db, bindingTargets, listenerSync)
  return listenerWarning ? { ok: true, warning: listenerWarning } : { ok: true }
}
