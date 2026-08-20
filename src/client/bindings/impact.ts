/**
 * List services affected by a principal/database binding change so the API
 * can surface a `redeployRequired` hint. The API never restarts or redeploys.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  binding,
  environment,
  principal,
  service,
} from '../../lib/db/schema.ts'

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
  principalId: string,
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

  const services = rows
    .map(toImpact)
    .sort((a, b) => a.keyPrefix.localeCompare(b.keyPrefix))
  return { count: services.length, services }
}

export async function listBindingImpactForDatabase(
  db: Db,
  params: Readonly<{ managedId: string; databaseName: string }>,
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
      and(
        eq(principal.managedId, params.managedId),
        eq(binding.databaseName, params.databaseName),
      ),
    )

  const services = rows
    .map(toImpact)
    .sort((a, b) => a.keyPrefix.localeCompare(b.keyPrefix))
  return { count: services.length, services }
}

export async function hasBindingsForPrincipal(
  db: Db,
  principalId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: binding.id })
    .from(binding)
    .where(eq(binding.principalId, principalId))
    .limit(1)
  return Boolean(row)
}

export async function hasBindingsForDatabase(
  db: Db,
  params: Readonly<{ managedId: string; databaseName: string }>,
): Promise<boolean> {
  const impact = await listBindingImpactForDatabase(db, params)
  return impact.count > 0
}
