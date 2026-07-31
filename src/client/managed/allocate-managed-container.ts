/**
 * Pre-allocate the managed engine `service` + ordinal-1 `container` rows.
 *
 * Called from {@link buildManagedApplyPayload}. **No nested `db.transaction`**
 * — the create path already runs inside a transaction and passes that `tx` as
 * `db`; wrapping again would nest transactions incorrectly.
 */

import { and, eq, isNull, ne } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { managedContainerName } from '../../lib/naming.ts'
import { container, service } from '../../lib/db/schema.ts'

export type ManagedContainerAllocation = {
  serviceId: string
  containerRowId: string
  containerName: string
}

/**
 * Idempotently ensure a `service` row for `composeServiceName` and an
 * ordinal-1 `container` row pinned to `serverId`, named
 * {@link managedContainerName} (`<service.id>-1`). Upserts on
 * `(service, ordinal)` so a placement change re-homes the same row; prunes
 * other pending null-id rows for that service (stale ordinals).
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
      composeServiceName,
      ordinal: 1,
    })
    .onConflictDoNothing({
      target: [container.serviceId, container.ordinal],
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
        })
        .where(eq(container.id, row.id))
    }
  } else if (row.containerName !== nextName) {
    await db
      .update(container)
      .set({ containerName: nextName })
      .where(eq(container.id, row.id))
  }

  await db
    .delete(container)
    .where(
      and(
        eq(container.serviceId, serviceRow.id),
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
