/**
 * Resolve the host/port a compose service dials for a managed cluster.
 *
 * A placed consuming service always dials **its own server's** ProxySQL
 * listener (15432 Postgres family / 16306 MySQL family), addressed by Docker
 * container name on the shared {@link MANAGED_INGRESS_NETWORK} — never a
 * host-published address and never the engine-native port. That listener
 * routes to local or remote engine backends over the private path
 * (configured by `managed.ingress.reconcile` on the consumer host). This is
 * independent of the cluster's public `exposure` setting: a compose service
 * on the same Docker host reaches ProxySQL over the internal network
 * regardless of whether ProxySQL also publishes a host port, so a `127.0.0.1`
 * (loopback-only) endpoint would be unreachable from inside a container even
 * when exposure is enabled. Never returns an engine container address.
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  binding,
  environment,
  node,
  principal,
  project,
  server,
  service,
  task,
} from '../../lib/db/schema.ts'
import type { PrivateEndpointError } from '../../lib/net/private-endpoint.ts'
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from '../../lib/project-options.ts'
import { ensureManagedIngressHierarchy } from '../system/hierarchy.ts'
import { isPrivateEndpointError } from '../../lib/net/private-endpoint.ts'

export type BindingEndpointError =
  | PrivateEndpointError
  | { kind: 'binding_endpoint_unavailable' }

export type ResolvedBindingEndpoint = {
  /** Docker container name of the target server's ProxySQL frontend. */
  host: string
  port: number
  /** True when the cluster has at least one `read_eligible` replica. */
  readSplit: boolean
  listenerServerId: string
}

export function isBindingEndpointError(
  value: unknown,
): value is BindingEndpointError {
  return (
    isPrivateEndpointError(value) ||
    (typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      (value as { kind: string }).kind === 'binding_endpoint_unavailable')
  )
}

/**
 * Resolve the placement server for a compose service (environment pin, else
 * project default). Exported for binding-side ingress reconcile fan-out.
 */
export async function loadServicePlacementServerId(
  db: Db,
  serviceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      environmentServerId: environment.serverId,
      projectOptions: project.options,
    })
    .from(service)
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(service.id, serviceId))
    .limit(1)
  if (!row) return null
  return resolveEffectivePlacementServerId(
    row.environmentServerId,
    parseProjectOptions(row.projectOptions),
  )
}

async function loadClusterMembers(
  db: Db,
  managedId: string,
): Promise<Array<{ serverId: string; role: string; ordinal: number; readEligible: boolean }>> {
  return await db
    .select({
      serverId: node.serverId,
      role: node.role,
      ordinal: node.ordinal,
      readEligible: node.isReadEligible,
    })
    .from(node)
    .where(eq(node.managedId, managedId))
    .orderBy(
      // Primary first, then lowest ordinal.
      sql`CASE WHEN ${node.role} = 'primary' THEN 0 ELSE 1 END`,
      asc(node.ordinal),
    )
}

/**
 * Docker container name of `serverId`'s ProxySQL frontend, provisioning the
 * per-server managed-ingress hierarchy if it does not exist yet. Reachable
 * from any compose service on the same host that joins
 * {@link MANAGED_INGRESS_NETWORK} — never a `127.0.0.1` / host-published
 * address, which a container cannot dial across its own network namespace.
 */
async function listenerForServer(
  db: Db,
  params: Readonly<{ serverId: string; protocolPort: number }>,
): Promise<{ host: string; port: number } | null> {
  const [row] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1)
  if (!row?.organizationId) return null

  const hierarchy = await ensureManagedIngressHierarchy(db, {
    organizationId: row.organizationId,
    serverId: params.serverId,
  })
  return { host: hierarchy.containerName, port: params.protocolPort }
}

/**
 * What host/port does service *S* dial for managed cluster *M*?
 *
 * Placed consumers always use **their own server's** ProxySQL listener
 * (by container name, over {@link MANAGED_INGRESS_NETWORK}) so traffic stays
 * on-box and ProxySQL peers over private/VPN to remote engines. This is
 * independent of the cluster's `exposure` setting — same-host container
 * reachability never depends on whether ProxySQL also publishes a host port.
 */
export async function resolveBindingEndpoint(
  db: Db,
  params: Readonly<{
    serviceId: string
    managedId: string
    protocolPort: number
  }>,
): Promise<ResolvedBindingEndpoint | BindingEndpointError> {
  const members = await loadClusterMembers(db, params.managedId)
  if (members.length === 0) {
    return { kind: 'binding_endpoint_unavailable' }
  }

  const readSplit = members.some((m) => m.readEligible)
  const serviceServerId = await loadServicePlacementServerId(db, params.serviceId)
  // No service placement yet (deploy prerequisite unmet) — fall back to a
  // cluster member's server (primary first) as a best-effort display target.
  const targetServerId = serviceServerId ?? members[0]!.serverId

  const listener = await listenerForServer(db, {
    serverId: targetServerId,
    protocolPort: params.protocolPort,
  })
  if (!listener) {
    return { kind: 'binding_endpoint_unavailable' }
  }
  return {
    host: listener.host,
    port: listener.port,
    readSplit,
    listenerServerId: targetServerId,
  }
}

/** Whether a managed cluster `node` row exists for this (managed, server) pair. */
export async function memberServerIdsForManaged(
  db: Db,
  managedId: string,
): Promise<string[]> {
  const rows = await db
    .select({ serverId: node.serverId })
    .from(node)
    .where(and(eq(node.managedId, managedId)))
  return rows.map((r) => r.serverId)
}

/**
 * Servers that host a compose service bound to this managed cluster.
 * Inverse of `loadBoundManagedIdsForServer`: env pin, project default, and
 * any `task.serverId`. One query — no per-service round trips.
 */
export async function consumerServerIdsForManaged(
  db: Db,
  managedId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      environmentServerId: environment.serverId,
      projectOptions: project.options,
      taskServerId: task.serverId,
    })
    .from(binding)
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .leftJoin(task, eq(task.serviceId, service.id))
    .where(eq(principal.managedId, managedId))

  const ids = new Set<string>()
  for (const row of rows) {
    const placement = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    )
    if (placement) ids.add(placement)
    if (row.taskServerId) ids.add(row.taskServerId)
  }
  return [...ids]
}
