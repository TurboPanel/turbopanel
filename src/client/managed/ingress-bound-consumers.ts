/**
 * Which managed clusters a server's ProxySQL must front for **consumers**.
 *
 * Split out of {@link ./ingress-desired.ts} so the exposure/connection surface
 * ({@link ./host-exposure.ts}) can reuse the same fronting set without importing
 * the reconcile builder — which imports the connection helpers in turn.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  binding,
  environment,
  principal,
  project,
  service,
  slot,
  workspace,
} from '../../lib/db/schema.ts'
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from '../../lib/project-options.ts'

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
  organizationId: string,
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
            sql`${project.options}->>'defaultServerId' = ${serverId}`,
          ),
        ),
      ),
    )

  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.managedId) continue
    const placement = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    )
    if (placement === serverId || row.taskServerId === serverId) {
      ids.add(row.managedId)
    }
  }
  return [...ids]
}
