import { and, count, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { ip, network, server } from '../../lib/db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../lib/db/workspace-kind.ts'

export type ServerDeleteBlockerKind = 'network' | 'container' | 'ip'

export type ServerDeleteBlocker = {
  kind: ServerDeleteBlockerKind
  count: number
}

export const SERVER_HAS_BLOCKERS_CODE = 'server_has_blockers'

export const SERVER_HAS_BLOCKERS_ERROR =
  'Cannot delete this server while dependent resources still exist'

export const COLOCATED_SERVER_DELETE_BLOCKED_REASON =
  'The co-located control plane server cannot be deleted'

export function colocatedServerDeleteBlockedReason(): string {
  return COLOCATED_SERVER_DELETE_BLOCKED_REASON
}

/**
 * Placement and dependency blockers for server delete.
 * Future: extend when service.options carries server/replica placement.
 */
export async function listServerDeleteBlockers(
  db: Db,
  serverId: string,
  organizationId: string,
): Promise<ServerDeleteBlocker[]> {
  const [serverRow] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (!serverRow) return []

  // System-workspace ingress rows are torn down by
  // `deleteSystemEnvironmentSubtree` during DELETE — exclude them from the
  // generic blocker scan so stopped system inventory does not 409 the delete.
  const [
    [networkCountRow],
    containerCountRows,
    [ipCountRow],
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(network)
      .where(eq(network.serverId, serverId)),
    db.execute<{ value: number | string }>(sql`
      SELECT count(*)::int AS value
      FROM container c
      WHERE c.server_id = ${serverId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM service s
          JOIN environment e ON e.id = s.environment_id
          JOIN project p ON p.id = e.project_id
          JOIN workspace w ON w.id = p.workspace_id
          WHERE s.id = c.service_id
            AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
        )
    `),
    db
      .select({ value: count() })
      .from(ip)
      .where(eq(ip.serverId, serverId)),
  ])
  const containerCountRow = containerCountRows[0]

  const blockers: ServerDeleteBlocker[] = []
  const networkCount = Number(networkCountRow?.value ?? 0)
  if (networkCount > 0) {
    blockers.push({ kind: 'network', count: networkCount })
  }
  const containerCount = Number(containerCountRow?.value ?? 0)
  if (containerCount > 0) {
    blockers.push({ kind: 'container', count: containerCount })
  }
  const ipCount = Number(ipCountRow?.value ?? 0)
  if (ipCount > 0) {
    blockers.push({ kind: 'ip', count: ipCount })
  }
  return blockers
}

export function serverDeleteBlockersResponse(
  c: Context,
  blockers: ServerDeleteBlocker[],
): Response {
  return c.json({
    error: SERVER_HAS_BLOCKERS_ERROR,
    code: SERVER_HAS_BLOCKERS_CODE,
    blockers,
  }, 409)
}
