/**
 * Pre-allocate `container` rows for an environment deploy (uuid naming).
 *
 * Idempotent via atomic upsert on `uniq_container_service_role_ordinal`
 * (`(service, role, ordinal)`). Placement changes re-home the same service row
 * (update `server_id`) so previewed UUID names stay stable and stale pending
 * rows on a previous server are not left behind.
 * Names come from {@link containerNameFromService} (service UUID) or an
 * explicit `service.options.container.name` — applied in every project naming
 * mode, with `-<ordinal>` suffixes when `instances > 1`.
 */

import { and, eq, gt, inArray, isNull, ne, notInArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  containerNameFromService,
  ingressContainerNameFromService,
} from '../../lib/naming.ts'
import type { ContainerNamingMode } from '../../lib/project-options.ts'
import { parseServiceOptions } from '../../lib/service-options.ts'
import { container } from '../../lib/db/schema.ts'

export type ContainerWorkloadRole = 'service' | 'system'

export type ContainerServiceSpec = {
  serviceId: string
  composeServiceName: string
  instances: number
  /** Explicit `service.options.container.name` when set. */
  explicitContainerName?: string
  /** Workload role for allocated rows; defaults to `'service'`. */
  role?: ContainerWorkloadRole
}

export type ContainerAllocation = {
  serviceId: string
  composeServiceName: string
  cloneComposeServiceName: string
  containerRowId: string
  containerName: string
  ordinal: number
  instances: number
}

export type ServiceIngressAllocation = {
  serviceId: string
  containerRowId: string
  containerName: string
  composeServiceName: string
}

function cloneComposeServiceName(
  originalName: string,
  ordinal: number,
  instances: number,
): string {
  if (instances === 1) return originalName
  return `${originalName}-${ordinal}`
}

function shouldAllocateService(
  containerNaming: ContainerNamingMode,
  explicitContainerName: string | undefined,
): boolean {
  if (containerNaming === 'uuid') return true
  // custom: only when an explicit per-service name is known up front
  return typeof explicitContainerName === 'string' && explicitContainerName.length > 0
}

/**
 * Resolve the compose `container_name` stored on the allocation row.
 *
 * Explicit `service.options.container.name` wins in every project naming mode.
 * Otherwise the name is derived from the **service** id (not the container
 * row). Multi-instance services append `-<ordinal>` so clones never share a
 * name.
 */
export function resolveAllocatedContainerName(input: {
  explicitContainerName: string | undefined
  serviceId: string
  ordinal: number
  instances: number
}): string {
  if (
    typeof input.explicitContainerName === 'string' &&
    input.explicitContainerName.length > 0
  ) {
    if (input.instances === 1) return input.explicitContainerName
    return `${input.explicitContainerName}-${input.ordinal}`
  }
  return containerNameFromService({
    serviceId: input.serviceId,
    ordinal: input.ordinal,
    instanceCount: input.instances,
  })
}

/**
 * Delete pending null-id rows for the given services that were not kept as
 * current-deploy pre-allocations. Scans every server so a placement change
 * cannot leave phantom pending rows that block project delete.
 */
export async function pruneUnexpectedPendingContainers(
  db: Db,
  params: {
    serviceIds: readonly string[]
    keepIds: ReadonlySet<string>
  },
): Promise<void> {
  if (params.serviceIds.length === 0) return

  const conditions = [
    inArray(container.serviceId, [...params.serviceIds]),
    eq(container.status, 'pending'),
    isNull(container.containerId),
  ]
  if (params.keepIds.size > 0) {
    conditions.push(notInArray(container.id, [...params.keepIds]))
  }

  await db.delete(container).where(and(...conditions))
}

async function allocateServiceContainers(
  db: Db,
  params: {
    serverId: string
    service: ContainerServiceSpec
  },
): Promise<ContainerAllocation[]> {
  const { serverId, service: svc } = params
  const instances = svc.instances
  const role: ContainerWorkloadRole = svc.role ?? 'service'
  const allocations: ContainerAllocation[] = []

  await db.transaction(async (tx) => {
    for (let ordinal = 1; ordinal <= instances; ordinal += 1) {
      const cloneName = cloneComposeServiceName(svc.composeServiceName, ordinal, instances)

      await tx
        .insert(container)
        .values({
          serviceId: svc.serviceId,
          serverId,
          containerId: null,
          containerName: 'pending',
          status: 'pending',
          role,
          composeServiceName: cloneName,
          ordinal,
        })
        .onConflictDoNothing({
          target: [container.serviceId, container.role, container.ordinal],
        })

      const [row] = await tx
        .select({
          id: container.id,
          serverId: container.serverId,
          containerName: container.containerName,
          composeServiceName: container.composeServiceName,
        })
        .from(container)
        .where(
          and(
            eq(container.serviceId, svc.serviceId),
            eq(container.role, role),
            eq(container.ordinal, ordinal),
          ),
        )
        .limit(1)

      if (!row) {
        throw new Error(
          `container allocation missing after upsert (service=${svc.serviceId} ordinal=${ordinal})`,
        )
      }

      const nextName = resolveAllocatedContainerName({
        explicitContainerName: svc.explicitContainerName,
        serviceId: svc.serviceId,
        ordinal,
        instances,
      })
      if (
        row.serverId !== serverId ||
        row.containerName !== nextName ||
        row.composeServiceName !== cloneName
      ) {
        await tx
          .update(container)
          .set({
            serverId,
            containerName: nextName,
            composeServiceName: cloneName,
            role,
          })
          .where(eq(container.id, row.id))
      }

      allocations.push({
        serviceId: svc.serviceId,
        composeServiceName: svc.composeServiceName,
        cloneComposeServiceName: cloneName,
        containerRowId: row.id,
        containerName: nextName,
        ordinal,
        instances,
      })
    }

    await tx
      .delete(container)
      .where(
        and(
          eq(container.serviceId, svc.serviceId),
          eq(container.role, role),
          gt(container.ordinal, instances),
        ),
      )
  })

  return allocations
}

/**
 * Idempotently ensure a `role='ingress'` ordinal-1 `container` row on an
 * already-allocated `serviceId`, named
 * {@link ingressContainerNameFromService} (`<service.id>-in`). Does
 * **not** insert or select a `service` row — ingress lives on the service /
 * engine service. Re-homes / renames / cleans stray pending rows scoped to
 * `role='ingress'` so sibling `role='service'` rows are untouched.
 */
export async function ensureServiceIngressContainerAllocation(
  db: Db,
  params: {
    serviceId: string
    serverId: string
    composeServiceName: string
  },
): Promise<ServiceIngressAllocation> {
  const { serviceId, serverId, composeServiceName } = params

  await db
    .insert(container)
    .values({
      serviceId,
      serverId,
      containerId: null,
      containerName: 'pending',
      status: 'pending',
      role: 'ingress',
      composeServiceName,
      ordinal: 1,
    })
    .onConflictDoNothing({
      target: [container.serviceId, container.role, container.ordinal],
    })

  const [row] = await db
    .select({
      id: container.id,
      serverId: container.serverId,
      containerName: container.containerName,
      status: container.status,
      containerId: container.containerId,
      composeServiceName: container.composeServiceName,
    })
    .from(container)
    .where(
      and(
        eq(container.serviceId, serviceId),
        eq(container.role, 'ingress'),
        eq(container.ordinal, 1),
      ),
    )
    .limit(1)

  if (!row) {
    throw new Error(
      `service ingress container allocation missing after upsert (service=${serviceId})`,
    )
  }

  const nextName = ingressContainerNameFromService(serviceId)
  if (row.containerId === null) {
    if (
      row.status !== 'pending' ||
      row.containerName !== nextName ||
      row.composeServiceName !== composeServiceName ||
      row.serverId !== serverId
    ) {
      await db
        .update(container)
        .set({
          serverId,
          status: 'pending',
          containerName: nextName,
          composeServiceName,
          role: 'ingress',
        })
        .where(eq(container.id, row.id))
    }
  } else if (row.containerName !== nextName) {
    await db
      .update(container)
      .set({ containerName: nextName, role: 'ingress' })
      .where(eq(container.id, row.id))
  }

  await db
    .delete(container)
    .where(
      and(
        eq(container.serviceId, serviceId),
        eq(container.role, 'ingress'),
        isNull(container.containerId),
        eq(container.status, 'pending'),
        ne(container.id, row.id),
      ),
    )

  return {
    serviceId,
    containerRowId: row.id,
    containerName: nextName,
    composeServiceName,
  }
}

/**
 * Idempotently allocate container rows for container compose services.
 *
 * Skips allocation when `containerNaming === 'custom'` and the service has no
 * explicit `options.container.name` (Compose-default names; rows come from
 * reconcile after the daemon report).
 */
export async function allocateEnvironmentContainers(
  db: Db,
  params: {
    /**
     * Call-site context for the environment being allocated. Reserved for
     * Future: scoped diagnostics / logging; not read by allocation today.
     */
    environmentId: string
    serverId: string
    containerServices: readonly ContainerServiceSpec[]
    containerNaming: ContainerNamingMode
    /**
     * All environment service ids (including non-allocated). Pending rows
     * outside the current allocation set are pruned so reconcile cannot
     * treat them as survivable pre-allocations.
     */
    environmentServiceIds?: readonly string[]
    /**
     * Extra container row ids to retain during pending prune (e.g. per-service
     * tcp/udp ingress allocations that must survive alongside service rows).
     */
    extraKeepIds?: ReadonlySet<string>
  },
): Promise<ContainerAllocation[]> {
  const allocations: ContainerAllocation[] = []

  for (const svc of params.containerServices) {
    if (!shouldAllocateService(params.containerNaming, svc.explicitContainerName)) {
      continue
    }
    const serviceAllocations = await allocateServiceContainers(db, {
      serverId: params.serverId,
      service: svc,
    })
    allocations.push(...serviceAllocations)
  }

  const pruneServiceIds = params.environmentServiceIds ??
    params.containerServices.map((svc) => svc.serviceId)
  const keepIds = new Set(allocations.map((row) => row.containerRowId))
  if (params.extraKeepIds) {
    for (const id of params.extraKeepIds) keepIds.add(id)
  }
  await pruneUnexpectedPendingContainers(db, {
    serviceIds: pruneServiceIds,
    keepIds,
  })

  return allocations
}

/** Build {@link ContainerServiceSpec} list from service rows + compose names. */
export function buildContainerServiceSpecs(
  serviceRows: ReadonlyArray<{
    id: string
    composeServiceName: string
    options: unknown
  }>,
  containerComposeNames: ReadonlySet<string>,
): ContainerServiceSpec[] {
  const specs: ContainerServiceSpec[] = []
  for (const row of serviceRows) {
    if (!containerComposeNames.has(row.composeServiceName)) continue
    const parsed = parseServiceOptions(row.options) ?? {}
    const instances = parsed.instances ?? 1
    const explicitContainerName = parsed.container?.name
    specs.push({
      serviceId: row.id,
      composeServiceName: row.composeServiceName,
      instances,
      ...(explicitContainerName ? { explicitContainerName } : {}),
    })
  }
  return specs
}
