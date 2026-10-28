/**
 * Sends each server its `server.tunnel.routes` table and keeps it current.
 *
 * What a server should hold is rebuilt from the database (`route-facts.ts`,
 * `route-builder.ts`). The panel remembers, per server, the hash of the last
 * table it sent (without the certificate, which is minted fresh) and the
 * command that carried it, in `server.metadata.tunnelRoutes`. A server is sent
 * the table again when the wanted table changed, or when the last command did
 * not finish well (a server that was offline never got it: the consumer does
 * not queue commands for a disconnected server). A resend of an unchanged table
 * is harmless: the daemon compares the hash and does nothing.
 *
 * Only a server whose daemon advertises tunnel support is sent anything, and
 * only while it is connected.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, server, tunnel } from '../../db/schema.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import { issuePeerLeaf, type PeerLeafIssue } from '../tls/peer-leaf.ts'
import { pendingTlsLeafMetadata } from '../tls/leaf-tracking.ts'
import { daemonCanCarryTunnels } from './daemon-gate.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import {
  buildTunnelRoutes,
  hashTunnelRoutes,
  type RouteBuildResult,
  toRoutesPayload,
} from './route-builder.ts'
import { relinkDoorwayHostings } from './doorway-links.ts'
import { loadRoutingFacts } from './route-facts.ts'

/** The least time between two sends of the same table to one server. */
export const TUNNEL_ROUTES_RESEND_GAP_MS = 10 * 60 * 1000

/** How long a command that has not finished is trusted before the table is sent again. */
export const TUNNEL_ROUTES_STALE_MS = 10 * 60 * 1000

export type TunnelSyncDeps = Readonly<{
  commandQueue: CommandQueue
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}>

export type TunnelSyncOutcome =
  | { status: 'sent'; commandId: string }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

type SentState = {
  stateHash: string
  commandId: string
  sentAt: string
  /** Names the server should forward (routes whose site runs elsewhere). */
  forwarded: number
}

function readSentState(metadata: unknown): SentState | null {
  const raw = (metadata as { tunnelRoutes?: Partial<SentState> } | null)?.tunnelRoutes
  if (
    raw &&
    typeof raw.stateHash === 'string' &&
    typeof raw.commandId === 'string' &&
    typeof raw.sentAt === 'string' &&
    typeof raw.forwarded === 'number'
  ) {
    return {
      stateHash: raw.stateHash,
      commandId: raw.commandId,
      sentAt: raw.sentAt,
      forwarded: raw.forwarded,
    }
  }
  return null
}

async function recordSent(db: Db, serverId: string, state: SentState): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(coalesce(${server.metadata}, '{}'::jsonb), '{tunnelRoutes}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(eq(server.id, serverId))
}

/**
 * Did the command that carried the last table finish well, or is it still
 * moving? A command that succeeded but reports warnings, or fewer forwarded
 * names than wanted, means the daemon emptied or trimmed its forwarding (for
 * example after a refused validation), so the table is sent again.
 */
export function lastSendIsSettled(
  row: { status: string; resultSummary: unknown } | undefined,
  state: SentState,
  nowMs: number
): boolean {
  if (row?.status === 'succeeded') {
    const result = row.resultSummary as { warnings?: unknown; routeCount?: unknown } | null
    if (!result) return true
    const warned = Array.isArray(result.warnings) && result.warnings.length > 0
    return !warned && result.routeCount === state.forwarded
  }
  const open = ['queued', 'dispatching', 'sent', 'acked', 'running']
  // Still moving: wait for it, unless it has been stuck for too long.
  return Boolean(
    row && open.includes(row.status) && nowMs - Date.parse(state.sentAt) < TUNNEL_ROUTES_STALE_MS
  )
}

function describeUnsettled(row: { status: string; resultSummary: unknown } | undefined): string {
  if (!row) return 'the command is gone'
  if (row.status !== 'succeeded') return `the command ended as ${row.status}`
  return 'the server reported warnings or fewer forwarded names than wanted'
}

async function loadLastSend(db: Db, state: SentState) {
  const [row] = await db
    .select({ status: command.status, resultSummary: command.resultSummary })
    .from(command)
    .where(eq(command.id, state.commandId))
    .limit(1)
  return row
}

async function enqueueRoutes(
  db: Db,
  commandQueue: CommandQueue,
  serverId: string,
  payload: Awaited<ReturnType<typeof toRoutesPayload>>,
  issue: PeerLeafIssue | null
): Promise<{ ok: true; commandId: string } | { ok: false; reason: string }> {
  const record = await createCommandRecord(db, {
    serverId,
    actorType: 'system',
    actorId: serverId,
    type: 'server.tunnel.routes',
    payload,
    expiresAt: new Date(Date.now() + TUNNEL_ROUTES_STALE_MS).toISOString(),
    ...(issue ? { metadata: pendingTlsLeafMetadata(issue.pendingTlsLeaf) } : {}),
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: 'server.tunnel.routes',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, { status: 'failed', error: 'Command queue unavailable' })
    return { ok: false, reason: 'Command queue unavailable' }
  }
  return { ok: true, commandId: record.id }
}

type ServerReady = { ok: true; metadata: unknown } | { ok: false; outcome: TunnelSyncOutcome }

/** The server exists, is connected, and runs a daemon that advertises tunnel support. */
async function checkServerReady(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<ServerReady> {
  const [row] = await db
    .select({ isConnected: server.isConnected, metadata: server.metadata })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  const skip = (reason: string): ServerReady => ({
    ok: false,
    outcome: { status: 'skipped', reason },
  })
  if (!row) return skip('unknown server')
  if (!row.isConnected) return skip('server offline')
  const state = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonCanCarryTunnels(state?.projection?.features)) return skip('daemon too old')
  return { ok: true, metadata: row.metadata }
}

/**
 * Is the table already where it should be? A table that finished is left alone.
 * One that did not finish waits out the gap before it is sent again, so a table
 * the server keeps refusing is not sent (and a new certificate minted) every tick.
 */
async function isAlreadyCurrent(
  db: Db,
  serverId: string,
  sent: SentState | null,
  built: RouteBuildResult,
  stateHash: string
): Promise<boolean> {
  if (sent === null) return !built.needsPeerMaterial && built.routes.length === 0
  if (sent.stateHash !== stateHash) return false
  const last = await loadLastSend(db, sent)
  if (lastSendIsSettled(last, sent, Date.now())) return true
  if (Date.now() - Date.parse(sent.sentAt) < TUNNEL_ROUTES_RESEND_GAP_MS) return true
  compatLogWarn(
    'tunnel-sync',
    `server ${serverId}: the last forwarding table was not applied (${describeUnsettled(last)}); sending it again`
  )
  return false
}

/**
 * Bring one server up to date. `issue` is a freshly minted peer leaf from the
 * renewal path; without it one is minted when the table needs a certificate.
 */
export async function syncServerTunnelRoutes(
  db: Db,
  deps: TunnelSyncDeps,
  params: { organizationId: string; serverId: string; issue?: PeerLeafIssue; force?: boolean }
): Promise<TunnelSyncOutcome> {
  if (isNoopCommandQueue(deps.commandQueue)) {
    return { status: 'skipped', reason: 'no command queue' }
  }
  const { organizationId, serverId } = params
  const ready = await checkServerReady(db, organizationId, serverId)
  if (!ready.ok) return ready.outcome
  const facts = await loadRoutingFacts(db, organizationId)
  const built = buildTunnelRoutes(serverId, facts.tunnels, facts.addresses)
  const stateHash = await hashTunnelRoutes(built, undefined)
  const sent = readSentState(ready.metadata)
  const open = !params.force && !params.issue
  if (open && (await isAlreadyCurrent(db, serverId, sent, built, stateHash))) {
    return { status: 'unchanged' }
  }
  const issue = await peerLeafFor(db, deps, built, params)
  if ('failed' in issue) return { status: 'failed', reason: issue.failed }
  const material = built.needsPeerMaterial ? issue.leaf?.material : undefined
  const payload = await toRoutesPayload(built, material)
  const notes = [...built.warnings, ...built.skipped.map((n) => `${n.hostname}: ${n.reason}`)]
  for (const note of notes) compatLogWarn('tunnel-sync', `server ${serverId}: ${note}`)
  // The leaf is tracked as delivered only when the certificate really went out.
  const queued = await enqueueRoutes(
    db,
    deps.commandQueue,
    serverId,
    payload,
    material ? issue.leaf : null
  )
  if (!queued.ok) return { status: 'failed', reason: queued.reason }
  await recordSent(db, serverId, {
    stateHash,
    commandId: queued.commandId,
    sentAt: new Date().toISOString(),
    forwarded: built.routes.filter((r) => !r.local).length,
  })
  return { status: 'sent', commandId: queued.commandId }
}

/** The leaf to send: the one handed in, or a freshly minted one when the table needs a certificate. */
async function peerLeafFor(
  db: Db,
  deps: TunnelSyncDeps,
  built: RouteBuildResult,
  params: { organizationId: string; serverId: string; issue?: PeerLeafIssue }
): Promise<{ leaf: PeerLeafIssue | null } | { failed: string }> {
  if (params.issue || !built.needsPeerMaterial) return { leaf: params.issue ?? null }
  const minted = await issuePeerLeaf(db, deps.secretsConfig, deps.dataEncryptionSecrets, {
    organizationId: params.organizationId,
    serverId: params.serverId,
  })
  if (!minted.ok) return { failed: `peer certificate: ${minted.error.kind}` }
  return { leaf: minted }
}

/** Servers that carry a tunnel, run a site on one, or were sent a table before. */
export async function serversToCheck(db: Db, organizationId: string): Promise<string[]> {
  const facts = await loadRoutingFacts(db, organizationId)
  const wanted = new Set<string>()
  for (const t of facts.tunnels) {
    t.carrying.forEach((id) => wanted.add(id))
    t.doorways.forEach((d) => d.siteServerIds.forEach((id) => wanted.add(id)))
  }
  // A server that once held a table and now should hold none still has to be told.
  const remembered = await db
    .select({ id: server.id })
    .from(server)
    .where(
      and(
        eq(server.organizationId, organizationId),
        sql`${server.metadata} -> 'tunnelRoutes' IS NOT NULL`
      )
    )
  remembered.forEach((r) => wanted.add(r.id))
  return [...wanted]
}

/** Every organization that has a tunnel, or a server that was sent a table. */
async function organizationsToCheck(db: Db): Promise<string[]> {
  const withTunnels = await db.selectDistinct({ id: tunnel.organizationId }).from(tunnel)
  const withTables = await db
    .selectDistinct({ id: server.organizationId })
    .from(server)
    .where(sql`${server.metadata} -> 'tunnelRoutes' IS NOT NULL`)
  const ids = new Set<string>()
  for (const r of [...withTunnels, ...withTables]) if (r.id) ids.add(r.id)
  return [...ids]
}

/** One server's sync where a failure is logged and counted, never thrown. */
export async function syncServerQuietly(
  db: Db,
  deps: TunnelSyncDeps,
  organizationId: string,
  serverId: string
): Promise<'sent' | 'failed' | 'other'> {
  try {
    const outcome = await syncServerTunnelRoutes(db, deps, { organizationId, serverId })
    if (outcome.status === 'failed') {
      compatLogWarn('tunnel-sync', `server ${serverId}: ${outcome.reason}`)
      return 'failed'
    }
    return outcome.status === 'sent' ? 'sent' : 'other'
  } catch (err) {
    compatLogWarn('tunnel-sync', `server ${serverId}: ${err instanceof Error ? err.message : err}`)
    return 'failed'
  }
}

/**
 * The sweep: send every involved server whatever it is missing. It also covers
 * a server that reconnects, because a table sent while it was offline never
 * finished. Runs from the periodic offline sweep.
 */
export async function runTunnelRoutesSweepTick(
  db: Db,
  deps: TunnelSyncDeps
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  await forEachSequential(await organizationsToCheck(db), async (organizationId) => {
    await relinkDoorwayHostings(db, organizationId)
    await forEachSequential(await serversToCheck(db, organizationId), async (serverId) => {
      const outcome = await syncServerQuietly(db, deps, organizationId, serverId)
      if (outcome === 'sent') sent += 1
      if (outcome === 'failed') failed += 1
    })
  })
  return { sent, failed }
}

/** Renewal hook for peer leaves: send the table together with the fresh certificate. */
export function peerLeafDelivery(
  commandQueue: CommandQueue,
  deps: Omit<TunnelSyncDeps, 'commandQueue'>
) {
  return async (
    db: Db,
    issue: PeerLeafIssue,
    row: { organizationId: string; serverId: string }
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const outcome = await syncServerTunnelRoutes(
      db,
      { commandQueue, ...deps },
      { organizationId: row.organizationId, serverId: row.serverId, issue, force: true }
    )
    if (outcome.status === 'sent') return { ok: true }
    return {
      ok: false,
      reason: outcome.status === 'unchanged' ? 'nothing to send' : outcome.reason,
    }
  }
}
