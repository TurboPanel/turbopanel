import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  deleteWouldOrphanPrimary,
  lockProjectForEnvironmentChange,
  lockProjectsForEnvironmentChange,
  PRIMARY_ENVIRONMENT_DELETE_ERROR,
} from './primary-environment.ts'
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
  project,
  service,
  share,
  slot,
  storage,
  storageCopy,
  tenancy,
} from '../../db/schema.ts'
import { markAssetFoldersRemoving, releaseEnvironmentFolders } from '../folders/allocate.ts'
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
import { type ProjectPrincipalFate, requestProjectPrincipalRemoval } from '../principals/removal.ts'
import {
  lockCertificatesPinnedBy,
  removeUnusedSiteCertificates,
} from '../tls/unused-letsencrypt.ts'

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

/** What a finished delete left for the servers to finish. */
export type DeleteCleanup = {
  /** Servers asked to remove folders (each holds rows `removing` until it confirms). */
  folderServerIds: string[]
}

export type ProjectDeleteResult =
  | {
      ok: true
      warning?: string
      cleanup: DeleteCleanup & { principals: ProjectPrincipalFate }
    }
  | {
      ok: false
      error:
        | 'project_has_running_services'
        | 'managed_runtime_present'
        | 'project_stop_failed'
        | typeof PROJECT_DEPLOY_RUNNING_ERROR
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
  /** The person deleting, for the audit trail; absent for a forget. */
  actorUserId?: string
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
      managedId: login.managedId,
      serviceId: binding.serviceId,
    })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
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

async function dropEnvironmentRows(tx: Db, rows: EnvironmentRowSet): Promise<string[]> {
  const { environmentIds, serviceIds, containerIds, hostingIds } = rows
  // One lock order everywhere: the project row first, then the environment rows.
  const projectIds = rows.projectId ? [rows.projectId] : await projectIdsOf(tx, environmentIds)
  await lockProjectsForEnvironmentChange(tx, projectIds)
  await lockEnvironmentRows(tx, environmentIds)
  // The Let's Encrypt lock before any site row is touched: a deploy takes it
  // after its environment row, so this order never waits on one in a cycle.
  const certificateIds = await lockCertificatesPinnedBy(tx, hostingIds)
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
  // Every folder under these environments lets go of them: kept volumes keep
  // theirs, the rest wait `removing` for their server (after this commits the
  // caller asks the servers, and the folder sweep asks again until they confirm).
  const folderServerIds = new Set(
    await releaseEnvironmentFolders(tx, { environmentIds, deletedStorageIds: goneStorageIds })
  )
  for (const serverId of await applyStorageRetentionOnParentDelete(tx, retentionScope)) {
    folderServerIds.add(serverId)
  }
  // `network.environment_id` has no FK, so compose rows are not covered by cascade.
  await purgeEnvironmentsComposeNetworks(tx, environmentIds)
  if (containerIds.length > 0) {
    await tx.delete(container).where(inArray(container.id, containerIds))
  }
  if (hostingIds.length > 0) {
    await tx.delete(hosting).where(inArray(hosting.id, hostingIds))
    // The Let's Encrypt entries made for these sites go too, unless another site uses one.
    await removeUnusedSiteCertificates(tx, certificateIds, {
      reason: 'its sites were deleted',
      ...(rows.actorUserId ? { actor: { userId: rows.actorUserId } } : {}),
    })
  }
  if (serviceIds.length > 0) {
    // A shared service's folder row stays, locked, until the host confirms it gone.
    for (const serverId of await markAssetFoldersRemoving(tx, { serviceIds })) {
      folderServerIds.add(serverId)
    }
    await tx.delete(tenancy).where(inArray(tenancy.serviceId, serviceIds))
    await tx.delete(binding).where(inArray(binding.serviceId, serviceIds))
    await tx.delete(service).where(inArray(service.id, serviceIds))
  }
  await tx.delete(environment).where(inArray(environment.id, environmentIds))
  // Deleting a whole project removes every environment with it; nothing is left to promote.
  if (!rows.projectId && projectIds.length > 0) await promoteOldestAsPrimary(tx, projectIds)
  return [...folderServerIds].sort((a, b) => a.localeCompare(b))
}

/** The environment rows, locked in id order (after their project rows). */
async function lockEnvironmentRows(tx: Db, environmentIds: readonly string[]): Promise<void> {
  if (environmentIds.length === 0) return
  const ids = sql.join(
    environmentIds.map((id) => sql`${id}::uuid`),
    sql`, `
  )
  await tx.execute(sql`SELECT 1 FROM "environment" WHERE "id" IN (${ids}) ORDER BY "id" FOR UPDATE`)
}

async function projectIdsOf(tx: Db, environmentIds: readonly string[]): Promise<string[]> {
  const rows = await tx
    .select({ projectId: environment.projectId })
    .from(environment)
    .where(inArray(environment.id, [...environmentIds]))
  return [...new Set(rows.map((row) => row.projectId))]
}

/**
 * A project that lost its primary environment but still has others gets the
 * oldest one as primary, so the marker never goes missing. Run after the delete.
 */
async function promoteOldestAsPrimary(tx: Db, projectIds: readonly string[]): Promise<void> {
  await tx.execute(sql`
    UPDATE "environment" SET "is_primary" = true, "updated_at" = now()
    WHERE "id" IN (
      SELECT DISTINCT ON ("e"."project_id") "e"."id" FROM "environment" AS "e"
      WHERE "e"."project_id" IN (${sql.join(
        projectIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
        AND NOT EXISTS (
          SELECT 1 FROM "environment" AS "p" WHERE "p"."project_id" = "e"."project_id" AND "p"."is_primary"
        )
      ORDER BY "e"."project_id", "e"."created_at", "e"."id"
    )
  `)
}

export type EnvironmentChildren = {
  serviceIds: string[]
  containerRows: Array<{ id: string; status: string | null; role: string | null }>
  hostingIds: string[]
}

export async function loadEnvironmentChildren(
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
export async function sharedAssetsStillUsed(
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
 * Delete a project and everything it owns. Refused only for what cannot be
 * removed safely in this step: a managed database (it is deleted on its own,
 * with its own confirmation), or a shared service or volume another project
 * still uses. With `stopHosts` the stacks are stopped first (a running
 * service is no reason to refuse; the stop not going out is); without it a
 * running service still refuses.
 *
 * The rows go in one transaction. Folders on the servers outlive it as
 * `removing` rows (kept volumes as `orphan` rows) until each host confirms,
 * and the project's site owners nothing else uses are marked for the removal
 * sweep, which retires their host accounts once their folders are gone.
 */
export async function deleteProjectCascade(
  db: Db,
  projectId: string,
  listenerSync?: BindingListenerSync,
  stopHosts?: () => Promise<boolean>,
  stopTimeoutMs: number = STOP_HOSTS_TIMEOUT_MS
): Promise<ProjectDeleteResult> {
  // The stop is sent before the transaction opens, never inside it: a stop
  // takes its own connection, and where a request has one connection (the
  // hosted panel) a stop inside the transaction waits on itself forever. The
  // checks run first so a refused delete sends nothing; the transaction runs
  // them again under the project lock.
  const allowRunning = stopHosts !== undefined
  if (stopHosts) {
    const refused = await checkBeforeStop(db, projectId)
    if (refused) return refused
    const stopped = await stopWithin(stopHosts, stopTimeoutMs)
    if (!stopped) {
      return { ok: false, error: 'project_stop_failed', detail: { message: STOP_FAILED_MESSAGE } }
    }
  }
  // Everything is read and written under the project lock, so an environment
  // created meanwhile cannot slip past the child cleanup the others get.
  const outcome = await db.transaction(async (tx) => {
    await lockProjectForEnvironmentChange(tx, projectId)
    return await deleteProjectLocked(tx, projectId, allowRunning, listenerSync?.actorId)
  })
  if ('refused' in outcome) return outcome.refused
  const cleanup = { folderServerIds: outcome.folderServerIds, principals: outcome.principals }
  const listenerWarning = await syncRemovedBindingListeners(
    db,
    outcome.bindingTargets,
    listenerSync
  )
  return listenerWarning ? { ok: true, warning: listenerWarning, cleanup } : { ok: true, cleanup }
}

/** How long a project delete waits for its servers to accept the stop. */
export const STOP_HOSTS_TIMEOUT_MS = 30_000
const STOP_FAILED_MESSAGE =
  'The servers did not accept the stop in time, so nothing was deleted. Check that they are online and try again.'

async function stopWithin(stopHosts: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = stopHosts()
  work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The refusals a delete would hit, read without the lock, before any stop goes out. */
async function checkBeforeStop(db: Db, projectId: string): Promise<ProjectDeleteResult | null> {
  const envRows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))
  if (envRows.length === 0) return null
  const refusal = await refuseProjectDelete(
    db,
    projectId,
    envRows.map((row) => row.id),
    true
  )
  return 'refused' in refusal ? refusal.refused : null
}

type LockedProjectDelete =
  | { refused: ProjectDeleteResult }
  | {
      bindingTargets: Awaited<ReturnType<typeof loadBindingListenerTargets>>
      folderServerIds: string[]
      principals: ProjectPrincipalFate
    }

/** The checks and the delete, with the project row already locked. */
async function deleteProjectLocked(
  tx: Db,
  projectId: string,
  allowRunning: boolean,
  actorUserId?: string
): Promise<LockedProjectDelete> {
  const envRows = await tx
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))
  const environmentIds = envRows.map((row) => row.id)

  let children: EnvironmentChildren = { serviceIds: [], containerRows: [], hostingIds: [] }
  if (environmentIds.length > 0) {
    const refusal = await refuseProjectDelete(tx, projectId, environmentIds, allowRunning)
    if ('refused' in refusal) return refusal
    children = refusal.children
  }
  // Read before the volume rows go: uses by them do not keep a site owner.
  const deletedStorageIds = await listStorageIdsDeletedWith(tx, {
    projectIds: [projectId],
    environmentIds,
    ...(children.serviceIds.length > 0 ? { serviceIds: children.serviceIds } : {}),
  })

  const bindingTargets = await loadBindingListenerTargets(tx, children.serviceIds)
  // The placements are the record of which servers the site owners are on
  // once `project_id` is cleared (the removal sweep and any later delete read
  // them), so write any that are missing while the environments still say where.
  await ensureProjectPlacements(tx, projectId)
  const folderServerIds =
    environmentIds.length > 0
      ? await dropEnvironmentRows(tx, {
          projectId,
          ...(actorUserId ? { actorUserId } : {}),
          environmentIds,
          serviceIds: children.serviceIds,
          containerIds: children.containerRows.map((row) => row.id),
          hostingIds: children.hostingIds,
        })
      : await applyStorageRetentionOnParentDelete(tx, { projectIds: [projectId] })
  const principals = await requestProjectPrincipalRemoval(tx, projectId, {
    environmentIds,
    serviceIds: children.serviceIds,
    storageIds: deletedStorageIds,
  })
  await tx.delete(project).where(eq(project.id, projectId))
  return { bindingTargets, folderServerIds, principals }
}

/** Why a project cannot be deleted yet, or the children the delete will remove. */
async function refuseProjectDelete(
  tx: Db,
  projectId: string,
  environmentIds: string[],
  allowRunning: boolean
): Promise<{ refused: ProjectDeleteResult } | { children: EnvironmentChildren }> {
  const managedRows = await tx
    .select({ id: managed.id })
    .from(managed)
    .where(inArray(managed.environmentId, environmentIds))
  if (managedRows.length > 0) {
    return {
      refused: {
        ok: false,
        error: MANAGED_RUNTIME_PRESENT_ERROR,
        detail: { message: MANAGED_PRESENT_MESSAGE },
      },
    }
  }

  const children = await loadEnvironmentChildren(tx, environmentIds)
  if (!allowRunning && hasActiveServiceContainer(children.containerRows)) {
    return { refused: { ok: false, error: 'project_has_running_services' } }
  }

  const sharedInUse = await sharedAssetsStillUsed(tx, {
    projectIds: [projectId],
    environmentIds,
    serviceIds: children.serviceIds,
  })
  if (sharedInUse) {
    return { refused: { ok: false, error: sharedInUse.error, detail: sharedInUse.detail } }
  }
  // A deploy in flight would recreate what the delete removes.
  if (await hasInProgressDeployment(tx, environmentIds)) {
    return {
      refused: {
        ok: false,
        error: PROJECT_DEPLOY_RUNNING_ERROR,
        detail: { message: PROJECT_DEPLOY_RUNNING_MESSAGE },
      },
    }
  }
  return { children }
}

export const PROJECT_DEPLOY_RUNNING_ERROR = 'project_deploy_running'
export const PROJECT_DEPLOY_RUNNING_MESSAGE =
  'A deploy is running in this project. Delete it when the deploy finishes.'

/** Why a managed database refuses a delete, in plain words. */
export const MANAGED_PRESENT_MESSAGE =
  'This includes a managed database. Delete the database first (it asks for its own confirmation, because its data goes with it), then try again.'

const PRIMARY_DELETE_DETAIL = {
  message:
    'This is the primary environment. Make another environment primary first, then delete this one.',
}

export type EnvironmentDeleteRefusal =
  | typeof PRIMARY_ENVIRONMENT_DELETE_ERROR
  | typeof ENVIRONMENT_RUNNING_ERROR
  | typeof MANAGED_RUNTIME_PRESENT_ERROR
  | typeof COMMON_ASSET_IN_USE_ERROR

export type EnvironmentDeleteResult =
  | { ok: true; warning?: string; cleanup: DeleteCleanup }
  | { ok: false; error: EnvironmentDeleteRefusal; detail?: Record<string, unknown> }

/** True when one of these environments has a deploy queued, applying or draining. */
export async function hasInProgressDeployment(
  db: Pick<Db, 'select'>,
  environmentIds: readonly string[]
): Promise<boolean> {
  if (environmentIds.length === 0) return false
  const rows = await db
    .select({ id: deployment.id })
    .from(deployment)
    .where(
      and(
        inArray(deployment.environmentId, [...environmentIds]),
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
 * project delete). Refused while a deploy is queued/applying/draining
 * (`environment_running`), for the primary environment, and for a managed
 * database or a shared asset another environment uses. A running service is
 * stopped first through `stopHosts`; without it, or when the stop does not
 * go out, a running service refuses. Folders on the servers outlive the rows
 * as `removing` rows until each host confirms. `deployment` rows go with it
 * (FK cascade).
 */
export async function deleteEnvironmentCascade(
  db: Db,
  environmentId: string,
  listenerSync?: BindingListenerSync,
  stopHosts?: () => Promise<boolean>,
  stopTimeoutMs: number = STOP_HOSTS_TIMEOUT_MS
): Promise<EnvironmentDeleteResult> {
  const managedRows = await db
    .select({ id: managed.id })
    .from(managed)
    .where(eq(managed.environmentId, environmentId))
    .limit(1)
  if (managedRows.length > 0) {
    return {
      ok: false,
      error: MANAGED_RUNTIME_PRESENT_ERROR,
      detail: { message: MANAGED_PRESENT_MESSAGE },
    }
  }

  if (await hasInProgressDeployment(db, [environmentId])) {
    return { ok: false, error: ENVIRONMENT_RUNNING_ERROR, detail: DEPLOY_RUNNING_DETAIL }
  }
  const children = await loadEnvironmentChildren(db, [environmentId])
  const running = hasActiveServiceContainer(children.containerRows)
  if (running && !stopHosts) {
    return { ok: false, error: ENVIRONMENT_RUNNING_ERROR, detail: STILL_RUNNING_DETAIL }
  }

  const sharedInUse = await sharedAssetsStillUsed(db, {
    environmentIds: [environmentId],
    serviceIds: children.serviceIds,
  })
  if (sharedInUse) return { ok: false, error: sharedInUse.error, detail: sharedInUse.detail }

  if (running && stopHosts) {
    // Asked before anything is stopped: a delete that is refused stops nothing.
    if (await db.transaction((tx) => deleteWouldOrphanPrimary(tx, environmentId))) {
      return { ok: false, error: PRIMARY_ENVIRONMENT_DELETE_ERROR, detail: PRIMARY_DELETE_DETAIL }
    }
    if (!(await stopWithin(stopHosts, stopTimeoutMs))) {
      return {
        ok: false,
        error: ENVIRONMENT_RUNNING_ERROR,
        detail: { message: STOP_FAILED_MESSAGE },
      }
    }
  }

  const bindingTargets = await loadBindingListenerTargets(db, children.serviceIds)
  const outcome = await db.transaction(async (tx) => {
    // Under the project lock: a "make primary" racing this delete is seen.
    if (await deleteWouldOrphanPrimary(tx, environmentId)) return null
    return await dropEnvironmentRows(tx, {
      ...(listenerSync ? { actorUserId: listenerSync.actorId } : {}),
      environmentIds: [environmentId],
      serviceIds: children.serviceIds,
      containerIds: children.containerRows.map((row) => row.id),
      hostingIds: children.hostingIds,
    })
  })
  if (outcome === null)
    return { ok: false, error: PRIMARY_ENVIRONMENT_DELETE_ERROR, detail: PRIMARY_DELETE_DETAIL }
  const cleanup = { folderServerIds: outcome }
  const listenerWarning = await syncRemovedBindingListeners(db, bindingTargets, listenerSync)
  return listenerWarning ? { ok: true, warning: listenerWarning, cleanup } : { ok: true, cleanup }
}

export const ENVIRONMENT_DEPLOY_RUNNING_MESSAGE =
  'A deploy is running for this environment. Delete it when the deploy finishes.'
const DEPLOY_RUNNING_DETAIL = { message: ENVIRONMENT_DEPLOY_RUNNING_MESSAGE }
const STILL_RUNNING_DETAIL = {
  message: 'This environment is still running. Stop it first, then delete it.',
}
