import { and, eq, inArray, sql } from 'drizzle-orm'
import type { createDenoDb } from '../../db/connection.ts'
import { command, portal, server, tunnel } from '../../db/schema.ts'
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
    if (connector.tunnelId === 'instance') return 0
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
  await recordPeerClientAuth(db, serverId, result)
  await recordStatusPortsLock(db, serverId, result)
  await requestConnectorRepair(db, serverId, result)
  return counts.reduce((sum, n) => sum + n, 0)
}

/** What a server reports about the client-certificate check on its peer hop. */
export type PeerHopStatus = {
  clientAuth: 'verify' | 'require'
  /** `require` was asked and `verify` is what runs. */
  downgraded: boolean
}

/** Read the peer hop status from `server.metadata`, or null when the daemon never reported one. */
export function peerHopStatusOf(metadata: unknown): PeerHopStatus | null {
  const raw = (
    metadata as { tunnelPeerHop?: { clientAuth?: unknown; downgraded?: unknown } } | null
  )?.tunnelPeerHop
  if (raw?.clientAuth !== 'verify' && raw?.clientAuth !== 'require') return null
  return { clientAuth: raw.clientAuth, downgraded: raw.downgraded === true }
}

/** Remove `server.metadata.tunnelPeerHop` when there is one. */
async function clearPeerClientAuth(db: Db, serverId: string): Promise<void> {
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (peerHopStatusOf(row?.metadata) === null) return
  await db
    .update(server)
    .set({ metadata: sql`${server.metadata} - 'tunnelPeerHop'` })
    .where(eq(server.id, serverId))
}

/**
 * A daemon reported that `require` runs as `verify` (its peer leaf lacks client
 * use) and the leaf has not been minted again for this report. Once per
 * report: {@link markPeerLeafReminted} sets the flag, and a report that
 * changes the mode starts a new one, so a daemon that still downgrades after a
 * fresh leaf is logged by the caller, not served another one every tick.
 */
export function peerLeafRemintDue(metadata: unknown): boolean {
  const raw = (metadata as { tunnelPeerHop?: { downgraded?: unknown; reminted?: unknown } } | null)
    ?.tunnelPeerHop
  return raw?.downgraded === true && raw.reminted !== true
}

/** True when this report is a downgrade whose re-mint was already done. */
export function peerDowngradeRepeats(metadata: unknown): boolean {
  const raw = (metadata as { tunnelPeerHop?: { downgraded?: unknown; reminted?: unknown } } | null)
    ?.tunnelPeerHop
  return raw?.downgraded === true && raw.reminted === true
}

/** Record that the peer leaf was minted again because of the stored downgrade. */
export async function markPeerLeafReminted(db: Db, serverId: string): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(coalesce(${server.metadata}, '{}'::jsonb), '{tunnelPeerHop,reminted}', 'true'::jsonb)`,
    })
    .where(and(eq(server.id, serverId), sql`${server.metadata} -> 'tunnelPeerHop' IS NOT NULL`))
}

/**
 * Keep the reported peer hop mode on the server (`server.metadata.tunnelPeerHop`),
 * so the server's tunnel status can show a downgrade. It is a report and never
 * part of the table hash, so writing it does not make the table go out again.
 * Written only when it changed.
 */
async function recordPeerClientAuth(
  db: Db,
  serverId: string,
  result: TunnelStatusCommandResult
): Promise<void> {
  if (result.peerClientAuth === undefined) {
    // A daemon that no longer reports a mode (the table went away, or it was
    // rolled back) must not leave an old downgrade showing.
    await clearPeerClientAuth(db, serverId)
    return
  }
  const next: PeerHopStatus = {
    clientAuth: result.peerClientAuth,
    downgraded: result.peerClientAuthDowngraded === true,
  }
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const current = peerHopStatusOf(row?.metadata)
  const reportedAt = new Date().toISOString()
  if (current?.clientAuth === next.clientAuth && current.downgraded === next.downgraded) {
    // The same report again: only its time moves, so the re-mint flag stays.
    await db
      .update(server)
      .set({
        metadata: sql`jsonb_set(${server.metadata}, '{tunnelPeerHop,reportedAt}', ${JSON.stringify(reportedAt)}::jsonb)`,
      })
      .where(eq(server.id, serverId))
    return
  }
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(coalesce(${server.metadata}, '{}'::jsonb), '{tunnelPeerHop}', ${JSON.stringify({ ...next, reportedAt })}::jsonb)`,
    })
    .where(eq(server.id, serverId))
}

/** What the API shows of a server's peer hop: `none` when the daemon reports no mode. */
export type ApiPeerHop = {
  mode: 'require' | 'verify' | 'none'
  downgraded: boolean
  reportedAt: string | null
}

export function toApiPeerHop(metadata: unknown): ApiPeerHop {
  const status = peerHopStatusOf(metadata)
  if (status === null) return { mode: 'none', downgraded: false, reportedAt: null }
  const at = (metadata as { tunnelPeerHop?: { reportedAt?: unknown } }).tunnelPeerHop?.reportedAt
  return {
    mode: status.clientAuth,
    downgraded: status.downgraded,
    reportedAt: typeof at === 'string' ? at : null,
  }
}

/** What a server last reported about the nftables lock on the connector status ports. */
export type StatusPortsLock = {
  locked: boolean
  reason: string | null
  checkedAt: string | null
}

/** Read the lock report from `server.metadata`, or null when the daemon never sent one (unknown). */
export function statusPortsLockOf(metadata: unknown): StatusPortsLock | null {
  const raw = (
    metadata as {
      tunnelStatusPorts?: { locked?: unknown; reason?: unknown; checkedAt?: unknown }
    } | null
  )?.tunnelStatusPorts
  if (typeof raw?.locked !== 'boolean') return null
  return {
    locked: raw.locked,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
  }
}

/**
 * Keep the reported lock on the status ports in `server.metadata.tunnelStatusPorts`.
 * A daemon that sends no fact (an older one, or no load tried yet) leaves nothing
 * stored, so a missing fact reads as unknown and never as locked.
 */
async function recordStatusPortsLock(
  db: Db,
  serverId: string,
  result: TunnelStatusCommandResult
): Promise<void> {
  if (result.statusPortsLocked === undefined) {
    await db
      .update(server)
      .set({ metadata: sql`${server.metadata} - 'tunnelStatusPorts'` })
      .where(
        and(eq(server.id, serverId), sql`jsonb_exists(${server.metadata}, 'tunnelStatusPorts')`)
      )
    return
  }
  const fact = {
    locked: result.statusPortsLocked,
    ...(result.statusPortsLockReason === undefined ? {} : { reason: result.statusPortsLockReason }),
    ...(result.statusPortsLockCheckedAt === undefined
      ? {}
      : { checkedAt: result.statusPortsLockCheckedAt }),
  }
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(coalesce(${server.metadata}, '{}'::jsonb), '{tunnelStatusPorts}', ${JSON.stringify(fact)}::jsonb)`,
    })
    .where(eq(server.id, serverId))
}

/** What the API shows of a server's status-port lock: every field null while the daemon has not said. */
export type ApiStatusPorts = {
  locked: boolean | null
  reason: string | null
  checkedAt: string | null
}

export function toApiStatusPorts(metadata: unknown): ApiStatusPorts {
  return statusPortsLockOf(metadata) ?? { locked: null, reason: null, checkedAt: null }
}

/**
 * States in which a connector the server was asked to run is not running, which
 * a resend repairs: the daemon starts a stopped or failed connector again and
 * reinstalls a missing one (`not-installed`) from its stored token copy.
 */
const NOT_RUNNING: ReadonlySet<TunnelStatusConnectorState> = new Set([
  'stopped',
  'failed',
  'not-installed',
])

/** A connector command that has not finished yet. */
const OPEN_COMMAND: ReadonlySet<string> = new Set([
  'queued',
  'dispatching',
  'sent',
  'acked',
  'running',
])

/**
 * The connectors the last list asked this server to run that it reports as
 * not running (stopped by hand, given up on by systemd, or its unit gone), sorted. Pure.
 */
export function connectorsNeedingRepair(
  result: TunnelStatusCommandResult,
  asked: readonly string[]
): string[] {
  return result.connectors
    .filter((c) => asked.includes(c.tunnelId) && NOT_RUNNING.has(c.status))
    .map((c) => c.tunnelId)
    .toSorted((a, b) => (a < b ? -1 : 1))
}

/**
 * A connector list that went out well is never sent again while it is
 * unchanged, so a connector that stopped afterwards stayed down. When the
 * answer shows one of the asked connectors stopped or failed, and the last list
 * has finished (one still on its way is waited for), the remembered hash of
 * the last list (`server.metadata.tunnelConnectors.stateHash`) is cleared: the
 * next connector sweep sends the same list again, and a daemon that starts
 * stopped connectors on a resend brings it back. The rest of that record (the
 * ids being removed) is kept.
 */
async function requestConnectorRepair(
  db: Db,
  serverId: string,
  result: TunnelStatusCommandResult
): Promise<void> {
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const sent = (
    row?.metadata as { tunnelConnectors?: { installed?: unknown; commandId?: unknown } } | null
  )?.tunnelConnectors
  if (!sent || !Array.isArray(sent.installed)) return
  const asked = sent.installed.filter((id): id is string => typeof id === 'string')
  if (connectorsNeedingRepair(result, asked).length === 0) return
  // A list still on its way is waited for, not sent a second time.
  if (typeof sent.commandId === 'string' && (await commandStillOpen(db, sent.commandId))) return
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(${server.metadata}, '{tunnelConnectors,stateHash}', '""'::jsonb)`,
    })
    .where(and(eq(server.id, serverId), sql`${server.metadata} -> 'tunnelConnectors' IS NOT NULL`))
}

async function commandStillOpen(db: Db, commandId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: command.status })
    .from(command)
    .where(eq(command.id, commandId))
    .limit(1)
  return row !== undefined && OPEN_COMMAND.has(row.status)
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
