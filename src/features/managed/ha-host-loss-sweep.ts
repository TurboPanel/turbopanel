/**
 * Whole-host loss of an HA database primary: gather the facts, apply the rule
 * (`ha-host-loss.ts`) and act on the answer.
 *
 * Runs on both runtimes' sweep ticks (the Workers cron's `reconcile` phase and
 * the self-hosted Deno timer, about once a minute). Stateless by design: every
 * tick re-reads who is offline and for how long, so a restart loses nothing and
 * a host that comes back inside the window simply stops being a candidate.
 *
 * What it writes:
 * - an alert-only outcome is a terminal `blocked` row in the recovery journal
 *   with the reason in plain words (`recordBlockedRecovery` folds repeats of
 *   the same reason into one row, so a one-minute tick never floods it);
 * - a go is `beginAutomaticFailover`, whose switch, cooldown, candidate gate
 *   and command-queue checks apply unchanged, with `hostLossIncident` set so
 *   the unreachable old primary is fenced by attestation plus the daemon's
 *   boot hold instead of a stop command (`ha-recovery.ts`).
 *
 * The probe seam is injected (the transports build it from their registry): a
 * test pins that the failover modules themselves never import the probe.
 */

import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, managed, replica, server } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import type { CommandQueue } from '../commands/queue.ts'
import type { AutoFailoverSetting } from './auto-failover-switch.ts'
import type { FreshStandbyProbe } from './ha-fresh-standby.ts'
import { beginAutomaticFailover } from './ha-recovery.ts'
import {
  HOST_LOSS_ALERT_MESSAGES,
  HOST_LOSS_DETECTOR,
  HOST_LOSS_GIVE_UP_MS,
  HOST_LOSS_PLANNED_GRACE_MS,
  type HostLossAlertCode,
  hostLossFailureStartMs,
  hostLossIncidentKey,
  hostLossPreflight,
  hostLossVerdict,
  type PeerReading,
  readPeer,
} from './ha-host-loss.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import { findInFlightRecovery, recordBlockedRecovery } from './recovery-records.ts'
import type { RecoveryRecord } from './recovery.ts'
import { isManagedEngineCode, type ManagedEngineCode } from './types.ts'

/** Clusters looked at per tick; the rest wait for the next one. */
export const HOST_LOSS_SWEEP_CAP = 25

export type HostLossCandidate = {
  managedId: string
  engine: string | null
  primaryMemberId: string
  primaryServerId: string
  organizationId: string | null
  /** `server.status_changed_at` of the primary's server (offline mark). */
  offlineSince: string
}

/** What a tick needs to know about the primary's server beyond the member row. */
export type HostLossServerFacts = {
  features: readonly string[]
  updateInFlight: boolean
  rebootRecently: boolean
}

export type HostLossLoaders = {
  listOfflinePrimaries: (
    db: Db,
    params: { cutoffIso: string; limit: number }
  ) => Promise<HostLossCandidate[]>
  listMembers: (db: Db, managedId: string) => Promise<ManagedMemberRow[]>
  /** Connected flag per server id (a missing server reads as offline). */
  connectedServers: (db: Db, serverIds: readonly string[]) => Promise<Map<string, boolean>>
  serverFacts: (db: Db, serverId: string, sinceIso: string) => Promise<HostLossServerFacts>
  organizationServers: (
    db: Db,
    organizationId: string
  ) => Promise<{ total: number; offline: number }>
  /** The cluster's in-flight recovery, if any. */
  inFlightRecovery: (db: Db, managedId: string) => Promise<RecoveryRecord | null>
}

export type HostLossSweepDeps = {
  commandQueue: CommandQueue | null
  /** `TURBOPANEL_AUTO_FAILOVER` for this deployment. */
  autoFailover: AutoFailoverSetting
  /** Fresh health read of one member's daemon; `null` = no answer. */
  probeStandby: FreshStandbyProbe
  windowMs: number
  freshStandbyMarginMs?: number
  nowMs?: () => number
  /** Test seams. */
  loaders?: Partial<HostLossLoaders>
  beginFailover?: typeof beginAutomaticFailover
  recordAlert?: typeof recordAlert
}

export type HostLossOutcome =
  | { managedId: string; result: 'wait' | 'ignore' | 'busy' | 'failover' }
  | { managedId: string; result: 'alert'; code: HostLossAlertCode }
  | { managedId: string; result: 'error' }

function toMs(iso: string): number {
  return Date.parse(iso)
}

async function listOfflinePrimaries(
  db: Db,
  params: { cutoffIso: string; limit: number }
): Promise<HostLossCandidate[]> {
  const giveUpBoundary = new Date(toMs(params.cutoffIso) - HOST_LOSS_GIVE_UP_MS).toISOString()

  const rows = await db
    .select({
      managedId: replica.managedId,
      engine: managed.engine,
      primaryMemberId: replica.id,
      primaryServerId: replica.serverId,
      organizationId: server.organizationId,
      offlineSince: server.statusChangedAt,
    })
    .from(replica)
    .innerJoin(server, eq(server.id, replica.serverId))
    .innerJoin(managed, eq(managed.id, replica.managedId))
    .where(
      and(
        eq(replica.role, 'primary'),
        eq(server.isConnected, false),
        isNotNull(server.statusChangedAt),
        gte(server.statusChangedAt, giveUpBoundary),
        lte(server.statusChangedAt, params.cutoffIso)
      )
    )
    .orderBy(server.statusChangedAt)
    .limit(params.limit)
  return rows.flatMap((row) =>
    row.offlineSince ? [{ ...row, offlineSince: row.offlineSince } satisfies HostLossCandidate] : []
  )
}

async function connectedServers(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(serverIds.map((id) => [id, false]))
  await Promise.all(
    serverIds.map(async (id) => {
      const [row] = await db
        .select({ connected: server.isConnected })
        .from(server)
        .where(eq(server.id, id))
        .limit(1)
      result.set(id, row?.connected === true)
    })
  )
  return result
}

async function loadServerFacts(
  db: Db,
  serverId: string,
  sinceIso: string
): Promise<HostLossServerFacts> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  const reboots = await db
    .select({ id: command.id })
    .from(command)
    .where(
      and(
        eq(command.serverId, serverId),
        eq(command.name, 'server.reboot'),
        gte(command.createdAt, sinceIso)
      )
    )
    .limit(1)
  return {
    features: state?.projection?.features ?? [],
    updateInFlight: state?.projection?.update?.status === 'updating',
    rebootRecently: reboots.length > 0,
  }
}

async function organizationServers(
  db: Db,
  organizationId: string
): Promise<{ total: number; offline: number }> {
  const rows = await db
    .select({ connected: server.isConnected })
    .from(server)
    .where(eq(server.organizationId, organizationId))
  return {
    total: rows.length,
    offline: rows.filter((row) => !row.connected).length,
  }
}

export const DEFAULT_HOST_LOSS_LOADERS: HostLossLoaders = {
  listOfflinePrimaries,
  listMembers: listManagedMembers,
  connectedServers,
  serverFacts: loadServerFacts,
  organizationServers,
  inFlightRecovery: findInFlightRecovery,
}

function evidenceJson(fields: Record<string, unknown>): string {
  return JSON.stringify(fields).slice(0, 600)
}

export async function recordAlert(
  db: Db,
  params: {
    managedId: string
    primary: ManagedMemberRow
    code: HostLossAlertCode
    incident: string
    evidence: string
  }
): Promise<RecoveryRecord> {
  compatLogWarn(
    'managed-ha',
    `host loss for ${params.managedId} (${params.incident}): not promoting, ${params.code}`
  )
  return recordBlockedRecovery(db, {
    managedId: params.managedId,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: params.primary.id,
    state: 'blocked',
    metadata: {
      blockedReason: HOST_LOSS_ALERT_MESSAGES[params.code],
      sourceServerId: params.primary.serverId,
      detector: HOST_LOSS_DETECTOR,
      detectorEvidence: params.evidence,
      hostLossIncident: params.incident,
    },
  })
}

async function readPeers(
  deps: HostLossSweepDeps,
  engine: string,
  peers: readonly ManagedMemberRow[],
  windowMs: number
): Promise<PeerReading[]> {
  return Promise.all(
    peers.map(async (peer) =>
      readPeer(
        await deps
          .probeStandby({
            memberId: peer.id,
            managedId: peer.managedId,
            serverId: peer.serverId,
            engine,
          })
          .catch(() => null),
        windowMs
      )
    )
  )
}

/** Hand a confirmed loss to the ordinary automatic failover, anchored on the offline mark. */
function startFailover(
  db: Db,
  deps: HostLossSweepDeps,
  params: {
    candidate: HostLossCandidate
    engine: ManagedEngineCode
    members: readonly ManagedMemberRow[]
    primary: ManagedMemberRow
    incident: string
    offlineSinceMs: number
    evidence: string
  }
): Promise<unknown> {
  const begin = deps.beginFailover ?? beginAutomaticFailover
  return begin({
    db,
    commandQueue: deps.commandQueue,
    managedId: params.candidate.managedId,
    engine: params.engine,
    members: params.members,
    sourceMemberId: params.primary.id,
    detector: HOST_LOSS_DETECTOR,
    evidence: params.evidence,
    actor: { actorType: 'system', actorId: params.candidate.primaryServerId },
    autoFailover: deps.autoFailover,
    probeStandby: deps.probeStandby,
    ...(deps.freshStandbyMarginMs === undefined
      ? {}
      : { freshStandbyMarginMs: deps.freshStandbyMarginMs }),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
    failureStartedAtMs: hostLossFailureStartMs(params.offlineSinceMs),
    hostLossIncident: params.incident,
  })
}

async function evaluateCluster(
  db: Db,
  deps: HostLossSweepDeps,
  loaders: HostLossLoaders,
  candidate: HostLossCandidate,
  nowMs: number
): Promise<HostLossOutcome> {
  const { managedId } = candidate
  const engine = candidate.engine
  const members = await loaders.listMembers(db, managedId)
  const primary = members.find((row) => row.id === candidate.primaryMemberId)
  if (
    members.length < 2 ||
    primary?.role !== 'primary' ||
    !engine ||
    !isManagedEngineCode(engine)
  ) {
    return { managedId, result: 'ignore' }
  }
  if (await loaders.inFlightRecovery(db, managedId)) return { managedId, result: 'busy' }

  const incident = hostLossIncidentKey(candidate.primaryServerId, candidate.offlineSince)
  const offlineSinceMs = toMs(candidate.offlineSince)
  const peers = members.filter((row) => row.id !== primary.id)
  const peerServerIds = [...new Set(peers.map((row) => row.serverId))]
  const connected = await loaders.connectedServers(db, peerServerIds)
  const facts = await loaders.serverFacts(
    db,
    candidate.primaryServerId,
    new Date(nowMs - HOST_LOSS_PLANNED_GRACE_MS).toISOString()
  )
  const org = candidate.organizationId
    ? await loaders.organizationServers(db, candidate.organizationId)
    : { total: 0, offline: 0 }

  const alert = deps.recordAlert ?? recordAlert
  const pre = hostLossPreflight({
    nowMs,
    offlineSinceMs,
    windowMs: deps.windowMs,
    engine,
    primaryDaemonFeatures: facts.features,
    plannedReboot: facts.updateInFlight || facts.rebootRecently,
    orgServers: org.total,
    orgServersOffline: org.offline,
    peerServerOffline: peerServerIds.some((id) => connected.get(id) !== true),
  })
  const evidence = evidenceJson({
    incident,
    silentMs: nowMs - offlineSinceMs,
    windowMs: deps.windowMs,
  })
  if (pre.action === 'wait') return { managedId, result: 'wait' }
  if (pre.action === 'ignore') return { managedId, result: 'ignore' }
  if (pre.action === 'alert') {
    await alert(db, { managedId, primary, code: pre.code, incident, evidence })
    return { managedId, result: 'alert', code: pre.code }
  }

  const readings = await readPeers(deps, engine, peers, deps.windowMs)
  const verdict = hostLossVerdict(readings)
  if (verdict.action === 'alert') {
    await alert(db, {
      managedId,
      primary,
      code: verdict.code,
      incident,
      evidence: evidenceJson({ incident, silentMs: nowMs - offlineSinceMs, peers: readings }),
    })
    return { managedId, result: 'alert', code: verdict.code }
  }

  compatLogInfo(
    'managed-ha',
    `host loss confirmed for ${managedId} (${incident}): every other member reports the primary is gone`
  )
  await startFailover(db, deps, {
    candidate,
    engine,
    members,
    primary,
    incident,
    offlineSinceMs,
    evidence: evidenceJson({ incident, silentMs: nowMs - offlineSinceMs, peers: readings }),
  })
  return { managedId, result: 'failover' }
}

/** One tick. Never throws: a failing cluster is logged and the rest still run. */
export async function runHostLossSweep(
  db: Db,
  deps: HostLossSweepDeps
): Promise<HostLossOutcome[]> {
  const nowMs = (deps.nowMs ?? Date.now)()
  const loaders: HostLossLoaders = { ...DEFAULT_HOST_LOSS_LOADERS, ...deps.loaders }
  const outcomes: HostLossOutcome[] = []
  let candidates: HostLossCandidate[]
  try {
    candidates = await loaders.listOfflinePrimaries(db, {
      cutoffIso: new Date(nowMs - deps.windowMs).toISOString(),
      limit: HOST_LOSS_SWEEP_CAP,
    })
  } catch (error) {
    compatLogWarn('managed-ha', `host loss sweep could not list candidates: ${String(error)}`)
    return outcomes
  }
  await forEachSequential(candidates, async (candidate) => {
    try {
      outcomes.push(await evaluateCluster(db, deps, loaders, candidate, nowMs))
    } catch (error) {
      compatLogWarn(
        'managed-ha',
        `host loss check for ${candidate.managedId} failed: ${String(error)}`
      )
      outcomes.push({ managedId: candidate.managedId, result: 'error' })
    }
  })
  return outcomes
}
