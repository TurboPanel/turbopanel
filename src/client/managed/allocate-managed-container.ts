/**
 * Pre-allocate managed engine `service` + `container` rows for apply.
 *
 * - {@link ensureManagedContainerAllocation} — engine path: upserts a `service`
 *   row plus a `role='app'` ordinal-1 container named
 *   {@link managedContainerName} (`<service.id>-1`).
 * - {@link ensureManagedIngressContainerAllocation} — ingress path: delegates to
 *   {@link ensureServiceIngressContainerAllocation} on the **engine's**
 *   `service.id` (never a separate ingress `service` row), named
 *   {@link ingressContainerNameFromService} (`<service.id>-ingress`).
 *
 * Called from {@link buildManagedApplyPayload}. **No nested `db.transaction`**
 * — the create path already runs inside a transaction and passes that `tx` as
 * `db`; wrapping again would nest transactions incorrectly.
 */

import { and, eq, isNull, ne } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { managedContainerName } from '../../lib/naming.ts'
import { container, service } from '../../lib/db/schema.ts'
import {
  ensureServiceIngressContainerAllocation,
  type ServiceIngressAllocation,
} from '../environments/allocate-containers.ts'

export type ManagedContainerAllocation = {
  serviceId: string
  containerRowId: string
  containerName: string
}

/**
 * Idempotently ensure a `service` row for `composeServiceName` and an
 * ordinal-1 `role='app'` `container` row pinned to `serverId`, named
 * {@link managedContainerName} (`<service.id>-1`). Upserts on
 * `(service, role, ordinal)` so a placement change re-homes the same row;
 * prunes other pending null-id `role='app'` rows for that service (stale
 * ordinals) without touching same-service ingress allocations.
 */
export async function ensureManagedContainerAllocation(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    composeServiceName: string
  },
): Promise<ManagedContainerAllocation> {
  const { environmentId, serverId, composeServiceName } = params

  await db
    .insert(service)
    .values({
      environmentId,
      displayName: composeServiceName,
      composeServiceName,
    })
    .onConflictDoNothing({
      target: [service.environmentId, service.composeServiceName],
    })

  const [serviceRow] = await db
    .select({ id: service.id })
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
      role: 'app',
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
        eq(container.serviceId, serviceRow.id),
        eq(container.role, 'app'),
        eq(container.ordinal, 1),
      ),
    )
    .limit(1)

  if (!row) {
    throw new Error(
      `managed container allocation missing after upsert (service=${serviceRow.id})`,
    )
  }

  const nextName = managedContainerName(serviceRow.id)
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
          role: 'app',
        })
        .where(eq(container.id, row.id))
    }
  } else if (row.containerName !== nextName) {
    await db
      .update(container)
      .set({ containerName: nextName, role: 'app' })
      .where(eq(container.id, row.id))
  }

  await db
    .delete(container)
    .where(
      and(
        eq(container.serviceId, serviceRow.id),
        eq(container.role, 'app'),
        isNull(container.containerId),
        eq(container.status, 'pending'),
        ne(container.id, row.id),
      ),
    )

  return {
    serviceId: serviceRow.id,
    containerRowId: row.id,
    containerName: nextName,
  }
}

/**
 * Idempotently ensure a `role='ingress'` ordinal-1 `container` row on the
 * engine's already-allocated `serviceId`. Delegates to the shared tenant
 * helper {@link ensureServiceIngressContainerAllocation}.
 */
export async function ensureManagedIngressContainerAllocation(
  db: Db,
  params: {
    serviceId: string
    serverId: string
    composeServiceName: string
  },
): Promise<ManagedContainerAllocation> {
  const alloc: ServiceIngressAllocation = await ensureServiceIngressContainerAllocation(
    db,
    params,
  )
  return {
    serviceId: alloc.serviceId,
    containerRowId: alloc.containerRowId,
    containerName: alloc.containerName,
  }
}
