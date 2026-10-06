/**
 * List services affected by a principal/database binding change so the API
 * can surface a `redeployRequired` hint. The API never restarts or redeploys.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { binding, environment, principal, service } from '../../db/schema.ts'

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

export async function listBindingImpactForDatabase(
  db: Db,
  params: Readonly<{ managedId: string; databaseName: string }>
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
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .where(
      and(eq(principal.managedId, params.managedId), eq(binding.databaseName, params.databaseName))
    )

  const services = rows.map(toImpact).sort((a, b) => a.keyPrefix.localeCompare(b.keyPrefix))
  return { count: services.length, services }
}

/** Every service bound to any login of this managed cluster. */
export async function listBindingImpactForManaged(
  db: Db,
  managedId: string
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
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .where(eq(principal.managedId, managedId))

  const services = rows
    .map(toImpact)
    .sort(
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
export async function detachBindingsForManaged(db: Db, managedId: string): Promise<void> {
  await db
    .delete(binding)
    .where(
      inArray(
        binding.principalId,
        db.select({ id: principal.id }).from(principal).where(eq(principal.managedId, managedId))
      )
    )
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
