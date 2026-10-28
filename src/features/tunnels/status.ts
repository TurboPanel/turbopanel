import { and, eq, inArray, sql } from 'drizzle-orm'
import type { createDenoDb } from '../../db/connection.ts'
import { portal, tunnel } from '../../db/schema.ts'
import { mapSequential } from '../../lib/sequential.ts'
import type {
  TunnelStatusCommandResult,
  TunnelStatusConnector,
  TunnelStatusConnectorState,
} from '../../contracts/commands/tunnel-status.ts'

/**
 * What a server's daemon reports about its tunnel connectors (`server.tunnel.status`),
 * written onto the portal rows that already exist for that server. No new table
 * or column: `reported`, `last_seen_at`, `last_error`, `connector_version` and
 * `version_checked_at` are on `portal`, and the rest rides in `metadata.connector`.
 */

type Db = ReturnType<typeof createDenoDb>

/** The portal's own word for what a connector state means. */
export function portalStateOf(
  status: TunnelStatusConnectorState
): 'connected' | 'unknown' | 'down' | 'error' {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'connecting':
      return 'unknown'
    case 'failed':
      return 'error'
    default:
      return 'down'
  }
}

/** The plain-words reason shown with a portal that is down or in error, or null. */
export function portalErrorOf(connector: TunnelStatusConnector): string | null {
  if (connector.status === 'failed') return 'The connector service stopped with an error.'
  if (connector.lastUpdate?.outcome === 'rolled-back' && connector.lastUpdate.reason) {
    return `The last connector update did not finish: ${connector.lastUpdate.reason}`
  }
  return null
}

/**
 * Write one status answer for one server. Only portals of this server for a
 * tunnel the daemon names by its provider id are touched; ids the panel does
 * not know (and the instance's own tunnel) are ignored. Returns how many
 * portals were updated.
 */
export async function recordTunnelStatus(
  db: Db,
  serverId: string,
  result: TunnelStatusCommandResult,
  now: Date = new Date()
): Promise<number> {
  const stamp = now.toISOString()
  const counts = await mapSequential(result.connectors, async (connector) => {
    if (connector.tunnelId === 'instance' || connector.tunnelId === 'default') return 0
    const portals = await db
      .select({ id: portal.id })
      .from(portal)
      .innerJoin(tunnel, eq(portal.tunnelId, tunnel.id))
      .where(and(eq(portal.serverId, serverId), eq(tunnel.externalId, connector.tunnelId)))
    if (portals.length === 0) return 0
    const info = {
      pinnedVersion: result.pinnedVersion,
      slot: connector.slot,
      ...(connector.lastUpdate ? { lastUpdate: connector.lastUpdate } : {}),
    }
    await db
      .update(portal)
      .set({
        reported: portalStateOf(connector.status),
        lastSeenAt: stamp,
        lastError: portalErrorOf(connector),
        connectorVersion: connector.version,
        versionCheckedAt: stamp,
        metadata: sql`coalesce(${portal.metadata}, '{}'::jsonb) || ${JSON.stringify({ connector: info })}::jsonb`,
      })
      .where(
        inArray(
          portal.id,
          portals.map((p) => p.id)
        )
      )
    return portals.length
  })
  return counts.reduce((sum, n) => sum + n, 0)
}

/** What the screen says about a connector's version. */
export type ConnectorUpdateNotice = {
  /** The server runs a different connector version than its daemon is moving to. */
  pending: boolean
  runningVersion: string | null
  pinnedVersion: string | null
  /** Why the last attempt stopped, when it did. */
  reason: string | null
}

/** Read the notice from a portal row's `connector_version` and `metadata`. */
export function connectorUpdateNotice(
  connectorVersion: string | null,
  metadata: unknown
): ConnectorUpdateNotice {
  const info =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? ((metadata as Record<string, unknown>).connector as Record<string, unknown> | undefined)
      : undefined
  const pinned = typeof info?.pinnedVersion === 'string' ? info.pinnedVersion : null
  const last =
    typeof info?.lastUpdate === 'object' && info.lastUpdate !== null
      ? (info.lastUpdate as Record<string, unknown>)
      : undefined
  const reason =
    last?.outcome === 'rolled-back' && typeof last.reason === 'string' ? last.reason : null
  return {
    pending: connectorVersion !== null && pinned !== null && connectorVersion !== pinned,
    runningVersion: connectorVersion,
    pinnedVersion: pinned,
    reason,
  }
}
