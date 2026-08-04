import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { EnvironmentDeployContainer } from '../commands/schemas.ts'
import {
  parseServiceOptions,
  resolveServiceInstances,
} from '../service-options.ts'
import { container, service } from './schema.ts'

/** Matches `service_display_name_format_check` in schema. */
const SERVICE_DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]+$/

type ServiceRow = {
  id: string
  displayName: string | null
  composeServiceName: string
  options: unknown
}

type ExistingContainerRow = {
  id: string
  serviceId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  ordinal: number
}

function buildServiceComposeIndex(serviceRows: ServiceRow[]): {
  serviceIds: Set<string>
  serviceIdByComposeName: Map<string, string>
  maxOrdinalByServiceId: Map<string, number>
} {
  const serviceIds = new Set(serviceRows.map((row) => row.id))
  const serviceIdByComposeName = new Map<string, string>()
  const maxOrdinalByServiceId = new Map<string, number>()
  for (const row of serviceRows) {
    serviceIdByComposeName.set(row.composeServiceName, row.id)
    maxOrdinalByServiceId.set(
      row.id,
      resolveServiceInstances(parseServiceOptions(row.options) ?? {}),
    )
  }
  return { serviceIds, serviceIdByComposeName, maxOrdinalByServiceId }
}

/** Strip trailing `-<digits>` from multi-instance clone compose keys. */
function baseComposeServiceName(name: string): string {
  return name.replace(/-\d+$/, '')
}

function parseCloneOrdinal(composeServiceName: string): number | null {
  const match = /-(\d+)$/.exec(composeServiceName)
  if (!match) return null
  const ordinal = Number(match[1])
  return Number.isFinite(ordinal) && ordinal >= 1 ? ordinal : null
}

/**
 * Resolve the container role from a daemon report. Prefer the explicit wire
 * field; fall back to the `-ingress` container-name convention, then the
 * compose-service naming convention, so older daemons that omit `role` still
 * map Traefik sidecars correctly.
 */
function resolveReportedRole(
  reported: EnvironmentDeployContainer,
): 'app' | 'ingress' {
  if (reported.role === 'app' || reported.role === 'ingress') {
    return reported.role
  }
  if (reported.containerName.endsWith('-ingress')) return 'ingress'
  return reported.composeServiceName.endsWith('-ingress') ? 'ingress' : 'app'
}

/**
 * Deploy creates containers before hostings/services are configured in the UI.
 * Upsert missing `service` rows for reported compose names so container FKs can
 * resolve without requiring a prior hostname save.
 *
 * Only creates rows for reported names that match neither an existing service
 * nor a known base compose name (so pre-allocated `web-2` never spawns a
 * bogus `web-2` service when `web` already exists). Ingress reports never mint
 * a service row — they attach to the engine/app service.
 */
async function ensureServicesForReportedContainers(
  db: Db,
  environmentId: string,
  containers: EnvironmentDeployContainer[],
  serviceRows: ServiceRow[],
): Promise<ServiceRow[]> {
  const { serviceIds, serviceIdByComposeName } = buildServiceComposeIndex(serviceRows)

  const missingNames = new Set<string>()
  for (const reported of containers) {
    if (resolveReportedRole(reported) === 'ingress') continue
    if (
      reported.serviceId !== undefined &&
      serviceIds.has(reported.serviceId)
    ) {
      continue
    }
    if (serviceIdByComposeName.has(reported.composeServiceName)) continue
    if (serviceIdByComposeName.has(baseComposeServiceName(reported.composeServiceName))) {
      continue
    }
    if (!SERVICE_DISPLAY_NAME_RE.test(reported.composeServiceName)) continue
    if (reported.composeServiceName.length < 1 || reported.composeServiceName.length > 255) {
      continue
    }
    missingNames.add(reported.composeServiceName)
  }

  if (missingNames.size === 0) return serviceRows

  const names = [...missingNames].sort((a, b) => a.localeCompare(b))
  const inserted = await db
    .insert(service)
    .values(
      names.map((composeServiceName) => ({
        environmentId,
        displayName: composeServiceName,
        composeServiceName,
      })),
    )
    .returning({
      id: service.id,
      displayName: service.displayName,
      composeServiceName: service.composeServiceName,
      options: service.options,
    })

  return [...serviceRows, ...inserted]
}

function resolveReportedServiceId(
  reported: EnvironmentDeployContainer,
  serviceIds: Set<string>,
  serviceIdByComposeName: Map<string, string>,
): string | undefined {
  if (reported.serviceId !== undefined && serviceIds.has(reported.serviceId)) {
    return reported.serviceId
  }
  const exact = serviceIdByComposeName.get(reported.composeServiceName)
  if (exact) return exact
  return serviceIdByComposeName.get(baseComposeServiceName(reported.composeServiceName))
}

/**
 * True when a pending null-id row is still expected for this deploy shape.
 * Ingress rows are always expected (not bounded by `options.instances`); app
 * rows must sit within the service's current instance count. Stale ordinals
 * (after a scale-down) and pending for unknown services are not.
 */
function isExpectedPendingAllocation(
  row: ExistingContainerRow,
  maxOrdinalByServiceId: Map<string, number>,
): boolean {
  if (row.status !== 'pending' || row.containerId !== null) return false
  if (row.role === 'ingress') return true
  const maxOrdinal = maxOrdinalByServiceId.get(row.serviceId)
  if (maxOrdinal === undefined) return false
  return row.ordinal >= 1 && row.ordinal <= maxOrdinal
}

export type ExpectedContainerAllocation = {
  serviceId: string
  role: 'app' | 'ingress'
  ordinal: number
}

export type ReconcileEnvironmentContainersParams = {
  serverId: string
  environmentId: string
  containers: EnvironmentDeployContainer[]
  /**
   * System-safe mode (e.g. `system.reconcile`): unmatched rows that match an
   * expected `(serviceId, role, ordinal)` are reset to `exited` / null Docker
   * id instead of deleted. Tenant deploy/stop omit this and keep the delete
   * path for stale unmatched rows.
   */
  expectedAllocations?: ReadonlyArray<ExpectedContainerAllocation>
}

/**
 * Identity-based upsert of container rows after an authoritative daemon report.
 *
 * Matches by `container_name` first, then by compose service + `(role, ordinal)`
 * for multi-instance clones. Updates matched rows in place; inserts only
 * unmatched reported containers (custom-naming projects). Pre-allocated app
 * pending rows (`status = 'pending'`, `container_id IS NULL`) survive a partial
 * report only when their ordinal is still within the service's current
 * `options.instances`; ingress pending rows always survive (not bounded by
 * instances). Stale pending rows outside that set are deleted. An empty report
 * (stop / destroy) resets rows to `exited` / null `container_id` instead of
 * deleting, so pre-allocated identity survives stop → start.
 */
export async function reconcileEnvironmentContainers(
  db: Db,
  params: ReconcileEnvironmentContainersParams,
): Promise<void> {
  const { serverId, environmentId, containers, expectedAllocations } = params

  let serviceRows = await db
    .select({
      id: service.id,
      displayName: service.displayName,
      composeServiceName: service.composeServiceName,
      options: service.options,
    })
    .from(service)
    .where(eq(service.environmentId, environmentId))

  if (serviceRows.length === 0 && containers.length === 0) {
    return
  }

  serviceRows = await ensureServicesForReportedContainers(
    db,
    environmentId,
    containers,
    serviceRows,
  )

  if (serviceRows.length === 0) return

  const { serviceIds, serviceIdByComposeName, maxOrdinalByServiceId } =
    buildServiceComposeIndex(serviceRows)
  const allServiceIdList = serviceRows.map((row) => row.id)

  const existingRows = await db
    .select({
      id: container.id,
      serviceId: container.serviceId,
      containerId: container.containerId,
      containerName: container.containerName,
      status: container.status,
      role: container.role,
      composeServiceName: container.composeServiceName,
      ordinal: container.ordinal,
    })
    .from(container)
    .where(
      and(
        eq(container.serverId, serverId),
        inArray(container.serviceId, allServiceIdList),
      ),
    )

  if (containers.length === 0) {
    await resetContainersOnEmptyReport(db, existingRows)
    return
  }

  await upsertReportedContainers(db, {
    serverId,
    containers,
    existingRows,
    serviceIds,
    serviceIdByComposeName,
    maxOrdinalByServiceId,
    expectedAllocations,
  })
}

async function resetContainersOnEmptyReport(
  db: Db,
  existingRows: ExistingContainerRow[],
): Promise<void> {
  if (existingRows.length === 0) return
  await db
    .update(container)
    .set({
      status: 'exited',
      containerId: null,
    })
    .where(
      inArray(
        container.id,
        existingRows.map((row) => row.id),
      ),
    )
}

/**
 * Resolve an unmatched existing row for a reported container.
 *
 * Prefer `container_name`, then compose clone ordinal, then ordinal 1 — always
 * scoped by `(service, role, ordinal)` so an ingress report cannot claim an
 * app row and vice versa. When the name match was already claimed, fall back
 * to an unmatched (service, role, ordinal) row instead of inserting a duplicate.
 */
function matchUnmatchedExistingContainer(params: {
  reported: EnvironmentDeployContainer
  serviceId: string
  role: 'app' | 'ingress'
  byName: Map<string, ExistingContainerRow>
  byServiceOrdinal: Map<string, ExistingContainerRow>
  matchedIds: Set<string>
}): ExistingContainerRow | undefined {
  const { reported, serviceId, role, byName, byServiceOrdinal, matchedIds } =
    params
  const cloneOrdinal = parseCloneOrdinal(reported.composeServiceName)
  const cloneRow = cloneOrdinal === null
    ? undefined
    : byServiceOrdinal.get(`${serviceId}:${role}:${cloneOrdinal}`)
  const primary =
    byName.get(reported.containerName) ??
    cloneRow ??
    byServiceOrdinal.get(`${serviceId}:${role}:1`)

  if (!primary) return undefined
  if (!matchedIds.has(primary.id)) return primary

  // Name (or default ordinal-1) match already claimed — try clone ordinal only.
  if (!cloneRow || matchedIds.has(cloneRow.id)) return undefined
  return cloneRow
}

function unmatchedStaleExistingIds(
  existingRows: ExistingContainerRow[],
  matchedIds: Set<string>,
  maxOrdinalByServiceId: Map<string, number>,
  expectedKeys: Set<string> | null,
): { deleteIds: string[]; resetIds: string[] } {
  const deleteIds: string[] = []
  const resetIds: string[] = []
  for (const row of existingRows) {
    if (matchedIds.has(row.id)) continue
    const expectedKey = `${row.serviceId}:${row.role}:${row.ordinal}`
    if (expectedKeys?.has(expectedKey)) {
      resetIds.push(row.id)
      continue
    }
    // Only current-deploy expected pending rows survive a partial report.
    if (!isExpectedPendingAllocation(row, maxOrdinalByServiceId)) {
      deleteIds.push(row.id)
    }
  }
  return { deleteIds, resetIds }
}

async function upsertReportedContainers(
  db: Db,
  params: {
    serverId: string
    containers: EnvironmentDeployContainer[]
    existingRows: ExistingContainerRow[]
    serviceIds: Set<string>
    serviceIdByComposeName: Map<string, string>
    maxOrdinalByServiceId: Map<string, number>
    expectedAllocations?: ReadonlyArray<ExpectedContainerAllocation>
  },
): Promise<void> {
  const byName = new Map(params.existingRows.map((row) => [row.containerName, row]))
  const byServiceOrdinal = new Map(
    params.existingRows.map((row) => [
      `${row.serviceId}:${row.role}:${row.ordinal}`,
      row,
    ]),
  )
  const matchedIds = new Set<string>()
  const nextOrdinalByService = new Map<string, number>()

  for (const row of params.existingRows) {
    // Ingress always sits at ordinal 1 and must not consume the app counter.
    if (row.role === 'ingress') continue
    const current = nextOrdinalByService.get(row.serviceId) ?? 0
    if (row.ordinal > current) nextOrdinalByService.set(row.serviceId, row.ordinal)
  }

  const reportedSorted = [...params.containers].sort((a, b) => {
    const byContainerName = a.containerName.localeCompare(b.containerName)
    if (byContainerName !== 0) return byContainerName
    return a.containerId.localeCompare(b.containerId)
  })

  const expectedKeys = params.expectedAllocations
    ? new Set(
      params.expectedAllocations.map(
        (row) => `${row.serviceId}:${row.role}:${row.ordinal}`,
      ),
    )
    : null

  await db.transaction(async (tx) => {
    for (const reported of reportedSorted) {
      const serviceId = resolveReportedServiceId(
        reported,
        params.serviceIds,
        params.serviceIdByComposeName,
      )
      if (serviceId === undefined) continue

      const role = resolveReportedRole(reported)
      const existing = matchUnmatchedExistingContainer({
        reported,
        serviceId,
        role,
        byName,
        byServiceOrdinal,
        matchedIds,
      })

      if (existing) {
        matchedIds.add(existing.id)
        await tx
          .update(container)
          .set({
            containerId: reported.containerId,
            status: reported.status,
            containerName: reported.containerName,
            composeServiceName: reported.composeServiceName,
          })
          .where(eq(container.id, existing.id))
        continue
      }

      let ordinal: number
      if (role === 'ingress') {
        ordinal = 1
      } else {
        ordinal = (nextOrdinalByService.get(serviceId) ?? 0) + 1
        nextOrdinalByService.set(serviceId, ordinal)
      }
      const [inserted] = await tx
        .insert(container)
        .values({
          serviceId,
          serverId: params.serverId,
          containerId: reported.containerId,
          containerName: reported.containerName,
          status: reported.status,
          role,
          composeServiceName: reported.composeServiceName,
          ordinal,
        })
        .returning({ id: container.id })
      matchedIds.add(inserted!.id)
    }

    const { deleteIds, resetIds } = unmatchedStaleExistingIds(
      params.existingRows,
      matchedIds,
      params.maxOrdinalByServiceId,
      expectedKeys,
    )
    if (resetIds.length > 0) {
      await tx
        .update(container)
        .set({
          status: 'exited',
          containerId: null,
        })
        .where(inArray(container.id, resetIds))
    }
    if (deleteIds.length > 0) {
      await tx.delete(container).where(inArray(container.id, deleteIds))
    }
  })
}
