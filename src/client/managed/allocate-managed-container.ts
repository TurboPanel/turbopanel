/**
 * Pre-allocate managed engine `service` + per-member `container` rows for apply.
 *
 * {@link ensureManagedContainerAllocation} upserts a `service` row plus a
 * `role='service'` container at the member ordinal named
 * {@link managedContainerName} (`<service.id>-<ordinal>`), and sets
 * `service.options.instances` to the cluster member count so reconcile keeps
 * ordinal-2/3 pending rows.
 *
 * Called from {@link prepareManagedApplyPayloads}. **No nested `db.transaction`**
 * — the create path already runs inside a transaction and passes that `tx` as
 * `db`; wrapping again would nest transactions incorrectly.
 */

import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { managedContainerName } from '../../lib/naming.ts'
import { container, service } from '../../lib/db/schema.ts'

export type ManagedContainerAllocation = {
  serviceId: string
  containerRowId: string
  containerName: string
}

/**
 * Idempotently ensure a `service` row for `composeServiceName` and a
 * `role='service'` `container` row at `ordinal` pinned to `serverId`, named
 * {@link managedContainerName}. Upserts on `(service, role, ordinal)` so a
 * placement change re-homes the same row. When `memberOrdinals` is provided,
 * prunes pending null-id `role='service'` rows whose ordinal is outside that
 * set and writes `service.options.instances` to the member count.
 */
export async function ensureManagedContainerAllocation(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    composeServiceName: string
    ordinal: number
    /** Full member ordinal set for prune + `options.instances` sync. */
    memberOrdinals?: readonly number[]
  },
): Promise<ManagedContainerAllocation> {
  const { environmentId, serverId, composeServiceName, ordinal } = params
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new TypeError(`Invalid managed container ordinal: ${ordinal}`)
  }

  await db
    .insert(service)
    .values({
      environmentId,
      name: composeServiceName,
      composeServiceName,
    })
    .onConflictDoNothing({
      target: [service.environmentId, service.composeServiceName],
    })

  const [serviceRow] = await db
    .select({ id: service.id, options: service.options })
    .from(service)
    .where(
      and(
        eq(service.environmentId, environmentId),
        eq(service.composeServiceName, composeServiceName),
      ),
    )
    .limit(1)

  if (!serviceRow) {
    throw new Error(
      `managed service allocation missing after upsert (environment=${environmentId} composeServiceName=${composeServiceName})`,
    )
  }

  await db
    .insert(container)
    .values({
      serviceId: serviceRow.id,
      serverId,
      containerId: null,
      containerName: 'pending',
      status: 'pending',
      role: 'service',
      composeServiceName,
      ordinal,
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
        eq(container.serviceId, serviceRow.id),
        eq(container.role, 'service'),
        eq(container.ordinal, ordinal),
      ),
    )
    .limit(1)

  if (!row) {
    throw new Error(
      `managed container allocation missing after upsert (service=${serviceRow.id} ordinal=${ordinal})`,
    )
  }

  const nextName = managedContainerName(serviceRow.id, ordinal)
  // Reused null-id rows (e.g. after destroy left `exited`, or a placement
  // change) must become `pending` on the target server so project-delete
  // treats the new apply as active. Do not clear or downgrade rows that
  // still have a Docker containerId.
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
          role: 'service',
        })
        .where(eq(container.id, row.id))
    }
  } else if (row.containerName !== nextName) {
    await db
      .update(container)
      .set({ containerName: nextName, role: 'service' })
      .where(eq(container.id, row.id))
  }

  const memberOrdinals = params.memberOrdinals
  if (memberOrdinals && memberOrdinals.length > 0) {
    await pruneManagedContainersOutsideMemberSet(
      db,
      serviceRow.id,
      memberOrdinals,
    )
    await syncServiceInstances(db, serviceRow.id, serviceRow.options, memberOrdinals.length)
  }

  return {
    serviceId: serviceRow.id,
    containerRowId: row.id,
    containerName: nextName,
  }
}

/**
 * Delete pending null-id `role='service'` rows whose ordinal is not in the
 * current member set (replica removal cleanup).
 */
export async function pruneManagedContainersOutsideMemberSet(
  db: Db,
  serviceId: string,
  ordinals: readonly number[],
): Promise<void> {
  if (ordinals.length === 0) return
  await db
    .delete(container)
    .where(
      and(
        eq(container.serviceId, serviceId),
        eq(container.role, 'service'),
        isNull(container.containerId),
        eq(container.status, 'pending'),
        notInArray(container.ordinal, [...ordinals]),
      ),
    )
}


async function syncServiceInstances(
  db: Db,
  serviceId: string,
  currentOptions: unknown,
  instances: number,
): Promise<void> {
  const base =
    typeof currentOptions === 'object' &&
      currentOptions !== null &&
      !Array.isArray(currentOptions)
      ? { ...(currentOptions as Record<string, unknown>) }
      : {}
  if (base.instances === instances) return
  await db
    .update(service)
    .set({
      options: { ...base, instances },
      updatedAt: sql`now()`,
    })
    .where(eq(service.id, serviceId))
}

/** Delete a single pending null-id service-role row for a removed replica. */
export async function deleteManagedContainerAllocation(
  db: Db,
  params: { serviceId: string; ordinal: number },
): Promise<void> {
  await db.delete(container).where(
    and(
      eq(container.serviceId, params.serviceId),
      eq(container.role, 'service'),
      eq(container.ordinal, params.ordinal),
      isNull(container.containerId),
    ),
  )
}

/** Resolve the engine service id for a managed environment (if allocated). */
export async function findManagedEngineServiceId(
  db: Db,
  environmentId: string,
  composeServiceName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.environmentId, environmentId),
        eq(service.composeServiceName, composeServiceName),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/** Used by tests / cleanup — delete pending allocations for listed ordinals. */
export async function pruneManagedContainerOrdinals(
  db: Db,
  serviceId: string,
  ordinals: readonly number[],
): Promise<void> {
  if (ordinals.length === 0) return
  await db.delete(container).where(
    and(
      eq(container.serviceId, serviceId),
      eq(container.role, 'service'),
      isNull(container.containerId),
      inArray(container.ordinal, [...ordinals]),
    ),
  )
}
