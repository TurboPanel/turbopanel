import { and, count, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { container, ip, network, peer, server } from '../../lib/db/schema.ts'

export type ServerDeleteBlockerKind = 'network' | 'container' | 'peer' | 'ip'

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

  const [
    [networkCountRow],
    [containerCountRow],
    [peerCountRow],
    [ipCountRow],
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(network)
      .where(eq(network.serverId, serverId)),
    db
      .select({ value: count() })
      .from(container)
      .where(eq(container.serverId, serverId)),
    db
      .select({ value: count() })
      .from(peer)
      .where(eq(peer.serverId, serverId)),
    db
      .select({ value: count() })
      .from(ip)
      .where(eq(ip.serverId, serverId)),
  ])

  const blockers: ServerDeleteBlocker[] = []
  const networkCount = Number(networkCountRow?.value ?? 0)
  if (networkCount > 0) {
    blockers.push({ kind: 'network', count: networkCount })
  }
  const containerCount = Number(containerCountRow?.value ?? 0)
  if (containerCount > 0) {
    blockers.push({ kind: 'container', count: containerCount })
  }
  const peerCount = Number(peerCountRow?.value ?? 0)
  if (peerCount > 0) {
    blockers.push({ kind: 'peer', count: peerCount })
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
