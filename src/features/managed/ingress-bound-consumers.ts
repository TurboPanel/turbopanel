/**
 * Which managed clusters a server's ProxySQL must front for **consumers**.
 *
 * Split out of {@link ./ingress-desired.ts} so the exposure/connection surface
 * ({@link ./host-exposure.ts}) can reuse the same fronting set without importing
 * the reconcile builder — which imports the connection helpers in turn.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  binding,
  environment,
  principal,
  project,
  service,
  slot,
  variable,
  workspace,
} from '../../db/schema.ts'
import { HOST_RUN_LOOPBACK_HOST } from '../../lib/naming.ts'
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from '../projects/project-options.ts'

/**
 * Managed clusters whose consumers (compose services) place on `serverId`.
 * Those servers need ProxySQL routes even when they host no engine members.
 * Scoped to the target organization and server (env pin, slot pin, or
 * unpinned env whose project default server is this server). The project
 * default match is pushed into SQL so unpinned environments that default to
 * other servers are never loaded.
 */
export async function loadBoundManagedIdsForServer(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<string[]> {
  const rows = await db
    .select({
      managedId: principal.managedId,
      environmentServerId: environment.serverId,
      projectOptions: project.options,
      taskServerId: slot.serverId,
    })
    .from(binding)
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .leftJoin(slot, eq(slot.serviceId, service.id))
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        or(
          eq(environment.serverId, serverId),
          eq(slot.serverId, serverId),
          and(
            isNull(environment.serverId),
            sql`${project.options}->>'defaultServerId' = ${serverId}`
          )
        )
      )
    )

  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.managedId) continue
    const placement = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions)
    )
    if (placement === serverId || row.taskServerId === serverId) {
      ids.add(row.managedId)
    }
  }
  return [...ids]
}

/**
 * Whether a host-run consumer (a PHP site or native app, not a container) with
 * a database binding is placed on `serverId`.
 *
 * Such a service dials ProxySQL on `127.0.0.1`, so the frontend must publish
 * its listener on loopback even when no cluster asks for host exposure. The
 * binding's own host row says so: a host-run binding stores the loopback
 * address there and a container binding a container name (see
 * `features/bindings/host-run.ts`). `organizationId` narrows to one
 * organization; omitted, any organization's service on the server counts.
 */
export async function serverHasHostRunBinding(
  db: Db,
  serverId: string,
  organizationId?: string
): Promise<boolean> {
  const rows = await db
    .select({
      environmentServerId: environment.serverId,
      projectOptions: project.options,
      taskServerId: slot.serverId,
    })
    .from(binding)
    .innerJoin(
      variable,
      and(
        eq(variable.bindingId, binding.id),
        eq(variable.key, sql`${binding.keyPrefix} || '_HOST'`),
        eq(variable.value, HOST_RUN_LOOPBACK_HOST)
      )
    )
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .leftJoin(slot, eq(slot.serviceId, service.id))
    .where(
      and(
        organizationId === undefined ? undefined : eq(workspace.organizationId, organizationId),
        or(
          eq(environment.serverId, serverId),
          eq(slot.serverId, serverId),
          and(
            isNull(environment.serverId),
            sql`${project.options}->>'defaultServerId' = ${serverId}`
          )
        )
      )
    )
  return rows.some(
    (row) =>
      resolveEffectivePlacementServerId(
        row.environmentServerId,
        parseProjectOptions(row.projectOptions)
      ) === serverId || row.taskServerId === serverId
  )
}
