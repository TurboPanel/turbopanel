import { and, eq, inArray, sql } from 'drizzle-orm'
import type { createDenoDb } from '../../db/connection.ts'
import { portal, server, tunnel } from '../../db/schema.ts'
import { mapSequential } from '../../lib/sequential.ts'
import { carryingServers } from './lifecycle.ts'
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

/** What one connector answer means for a portal. */
type PortalAnswer = 'connected' | 'unknown' | 'down' | 'error'

/**
 * Where a tunnel's own status goes after a connector answered. A connected
 * connector makes it `active`; with none connected, one that is down or in
 * error makes it `attention`; otherwise it stays as it is. A tunnel being
 * removed keeps `removing`. An all-servers tunnel has no portal rows to read,
 * so a down answer only moves it off `pending`: one server going down must
 * not undo what the others reported.
 */
export function nextTunnelStatus(
  current: string,
  portalStates: readonly string[],
  answer: PortalAnswer
): string {
  if (current === 'removing') return current
  if (answer === 'connected' || portalStates.includes('connected')) return 'active'
  const trouble = answer === 'down' || answer === 'error'
  if (portalStates.length === 0) return trouble && current === 'pending' ? 'attention' : current
  return trouble || portalStates.some((s) => s === 'down' || s === 'error') ? 'attention' : current
}

/** Move the tunnel the daemon names by its provider id to the status its reports now show. */
async function followTunnelStatus(
  db: Db,
  serverId: string,
  providerId: string,
  answer: PortalAnswer
): Promise<void> {
  const [match] = await db
    .select({ tunnel })
    .from(tunnel)
    .innerJoin(server, eq(server.organizationId, tunnel.organizationId))
    .where(and(eq(server.id, serverId), eq(tunnel.externalId, providerId)))
    .limit(1)
  if (!match) return
  const found = match.tunnel
  // A server that does not carry the tunnel has no say in its status.
  if (!(await carryingServers(db, found)).includes(serverId)) return
  const reports = await db
    .select({ reported: portal.reported })
    .from(portal)
    .where(eq(portal.tunnelId, found.id))
  const next = nextTunnelStatus(
    found.status,
    reports.map((r) => r.reported),
    answer
  )
  if (next !== found.status) {
    await db
      .update(tunnel)
      .set({ status: next })
      .where(and(eq(tunnel.id, found.id), eq(tunnel.status, found.status)))
  }
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
    if (portals.length === 0) {
      await followTunnelStatus(db, serverId, connector.tunnelId, portalStateOf(connector.status))
      return 0
    }
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
    await followTunnelStatus(db, serverId, connector.tunnelId, portalStateOf(connector.status))
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
