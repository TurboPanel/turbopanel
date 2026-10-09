/**
 * List services affected by a principal/database binding change so the API
 * can surface a `redeployRequired` hint. The API never restarts or redeploys.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { binding, environment, principal, service } from '../../db/schema.ts'
import { enqueueIngressForBindingChange, type BindingListenerSync } from './enqueue-change.ts'

export type BindingImpactService = {
  serviceId: string
  name: string | null
  environmentId: string
  projectId: string
  keyPrefix: string
}

export type BindingRedeployRequired = {
  count: number
  services: BindingImpactService[]
}

function toImpact(row: {
  serviceId: string
  name: string | null
  environmentId: string
  projectId: string
  keyPrefix: string
}): BindingImpactService {
  return {
    serviceId: row.serviceId,
    name: row.name,
    environmentId: row.environmentId,
    projectId: row.projectId,
    keyPrefix: row.keyPrefix,
  }
}

export async function listBindingImpactForPrincipal(
  db: Db,
  principalId: string
): Promise<BindingRedeployRequired> {
  const rows = await db
    .select({
      serviceId: binding.serviceId,
      name: service.name,
      environmentId: service.environmentId,
      projectId: environment.projectId,
      keyPrefix: binding.keyPrefix,
    })
    .from(binding)
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .where(eq(binding.principalId, principalId))

  const services = rows.map(toImpact).sort((a, b) => a.keyPrefix.localeCompare(b.keyPrefix))
  return { count: services.length, services }
}

/**
 * Services bound to a login of one managed cluster, optionally narrowed to one
 * of its databases. Unsorted: each caller picks its own order.
 */
async function listManagedBindingImpact(
  db: Db,
  managedId: string,
  databaseName?: string
): Promise<BindingImpactService[]> {
  const rows = await db
    .select({
      serviceId: binding.serviceId,
      name: service.name,
      environmentId: service.environmentId,
      projectId: environment.projectId,
      keyPrefix: binding.keyPrefix,
    })
    .from(binding)
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .where(
      databaseName === undefined
        ? eq(principal.managedId, managedId)
        : and(eq(principal.managedId, managedId), eq(binding.databaseName, databaseName))
    )
  return rows.map(toImpact)
}

export async function listBindingImpactForDatabase(
  db: Db,
  params: Readonly<{ managedId: string; databaseName: string }>
): Promise<BindingRedeployRequired> {
  const services = (await listManagedBindingImpact(db, params.managedId, params.databaseName)).sort(
    (a, b) => a.keyPrefix.localeCompare(b.keyPrefix)
  )
  return { count: services.length, services }
}

/** Every service bound to any login of this managed cluster. */
export async function listBindingImpactForManaged(
  db: Db,
  managedId: string
): Promise<BindingRedeployRequired> {
  const services = (await listManagedBindingImpact(db, managedId)).sort(
    (a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.keyPrefix.localeCompare(b.keyPrefix)
  )
  return { count: services.length, services }
}

/**
 * Remove every binding of a managed cluster's logins. Each binding's
 * materialized variables go with it (they cascade on `binding_id`), so the
 * services stop receiving the cluster's connection variables at their next
 * deploy instead of keeping dangling ones.
 */
export async function detachBindingsForManaged(
  db: Db,
  managedId: string,
  listenerSync?: BindingListenerSync
): Promise<void> {
  const impact = await listManagedBindingImpact(db, managedId)
  const serviceIds = [...new Set(impact.map((row) => row.serviceId))]
  await db
    .delete(binding)
    .where(
      inArray(
        binding.principalId,
        db.select({ id: principal.id }).from(principal).where(eq(principal.managedId, managedId))
      )
    )
  if (listenerSync && serviceIds.length > 0) {
    await enqueueIngressForBindingChange(listenerSync.c, db, {
      serviceIds,
      managedId,
      actorId: listenerSync.actorId,
      organizationId: listenerSync.organizationId,
    })
  }
}

export async function hasBindingsForPrincipal(db: Db, principalId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: binding.id })
    .from(binding)
    .where(eq(binding.principalId, principalId))
    .limit(1)
  return Boolean(row)
}

export async function hasBindingsForDatabase(
  db: Db,
  params: Readonly<{ managedId: string; databaseName: string }>
): Promise<boolean> {
  const impact = await listBindingImpactForDatabase(db, params)
  return impact.count > 0
}
