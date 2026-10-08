/**
 * Durable recovery journal + fencing/promote enqueue. Consumer advances
 * state off the `recovery` row; HTTP routes and cell events call into here.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CommandQueue } from '../commands/queue.ts'
import type { CommandType } from '../commands/types.ts'
import type {
  ManagedHaFailoverCommandPayload,
  ManagedPromoteCommandPayload,
} from '../../contracts/commands/schemas.ts'
import type { ManagedEngineCode } from './types.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import {
  findInFlightRecovery,
  findLatestAcceptedAutomaticFailover,
  findLatestRecovery,
  findRecoveryById,
  insertRecoveryIfFree,
  recordBlockedRecovery,
  type RecoveryPatch,
  updateRecovery,
  updateRecoveryLocked,
} from './recovery-records.ts'
import { container, managed, replica, server, service } from '../../db/schema.ts'
import { OrchestratorManagedHaAuthority } from './ha-authority.ts'
import {
  attestedLostServerIds,
  hostLossFenceAdvance,
  type FenceOutcome,
  nextStateAfterFence,
  nextStateAfterPromoteSuccess,
} from './ha-recovery-pure.ts'
import { fanOutManagedHaReconcile } from './ha-desired.ts'
import { enqueueFollowPrimaryOnReplicas } from './follow-primary.ts'
import { reseedDemotedPrimaryAfterSwitchover } from './reseed-demoted-primary.ts'
import { evaluateSwitchoverCatchUp } from './switchover-catchup.ts'
import {
  failRecoveryIngressNotQueued,
  parkRecoveryAtIngressGate,
  settleIngressCommandForRecovery,
} from './ha-ingress-gate.ts'
import type { ManagedIngressFanOutOutcome } from './ingress-desired.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import { findManagedHaHierarchy } from '../system/hierarchy.ts'
import { loadDatacenterMembershipsForServers } from '../net/datacenter-membership.ts'
import { isPrivateEndpointError, resolvePrivateEndpoints } from '../net/private-endpoint.ts'
import {
  automaticFailoverBlockCause,
  automaticFailoverBlockedReason,
  automaticFailoverCoolingDown,
  type HaMemberCandidateInput,
  isAutomaticFailoverClassMember,
} from './ha-policy.ts'
import {
  DEFAULT_FRESH_STANDBY_MARGIN_MS,
  evaluateFreshStandby,
  type FreshStandbyProbe,
  isMysqlFamilyEngine,
  pickMostAdvancedStandby,
  pickMysqlFamilyStandby,
} from './ha-fresh-standby.ts'
import { isAutomaticFailoverHealthy, replicationFromMemberMetadata } from './promote-lag.ts'
import {
  AUTOMATIC_FAILOVER_BLOCKED_ERROR,
  AUTOMATIC_FAILOVER_COOLDOWN_MESSAGE,
  AUTOMATIC_FAILOVER_NO_QUEUE_MESSAGE,
  AUTOMATIC_FAILOVER_NO_QUEUE_REASON,
  AUTOMATIC_FAILOVER_STANDBY_NOT_PROVEN_MESSAGE,
  FENCE_STOP_UNQUEUED_MESSAGE,
  HOST_LOSS_HOST_RETURNED_MESSAGE,
  isTerminalRecoveryState,
  PROMOTE_UNQUEUED_MESSAGE,
  RECOVERY_COMMAND_TIMED_OUT_MESSAGE,
  RECOVERY_STEP_FAILED_MESSAGE,
  type RecoveryKind,
  type RecoveryMetadata,
  type RecoveryRecord,
} from './recovery.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import {
  type AutoFailoverSetting,
  AUTOMATIC_FAILOVER_DISABLED_MESSAGE,
  AUTOMATIC_FAILOVER_DISABLED_REASON,
} from './auto-failover-switch.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export type RecoveryEnqueueOk = {
  ok: true
  commandId: string
  serverId: string
  fencePending: boolean
  recoveryId: string
}

export type RecoveryEnqueueErr = {
  ok: false
  error: string
  status: 409 | 422 | 503
}

export type RecoveryEnqueueResult = RecoveryEnqueueOk | RecoveryEnqueueErr

export type RecoveryCommandActor = {
  actorType: 'user' | 'system'
  actorId: string
}

const FENCE_TTL_MS = 600_000
const PROMOTE_TTL_MS = 600_000

async function isServerConnected(db: Db, serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ connected: server.isConnected })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.connected === true
}

async function stampManagedApplying(db: Db, managedId: string): Promise<void> {
  await db
    .update(managed)
    .set({ status: 'applying', updatedAt: new Date().toISOString() })
    .where(eq(managed.id, managedId))
}

async function stampManagedReady(db: Db, managedId: string): Promise<void> {
  await db
    .update(managed)
    .set({ status: 'ready', updatedAt: new Date().toISOString() })
    .where(eq(managed.id, managedId))
}

type CommandSpec = {
  serverId: string
  type: CommandType
  payload: unknown
  expiresAtMs: number
  actor: RecoveryCommandActor
  metadata?: Record<string, unknown>
}

/** A command row written `queued` but not yet handed to the queue. */
type PreparedCommand = {
  commandId: string
  serverId: string
  type: CommandType
  queuedAt: string
}

async function prepareCommand(db: Db, params: CommandSpec): Promise<PreparedCommand> {
  const expiresAt = new Date(Date.now() + params.expiresAtMs).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: params.actor.actorType,
    actorId: params.actor.actorId,
    type: params.type,
    payload: params.payload,
    expiresAt,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  })
  return {
    commandId: record.id,
    serverId: params.serverId,
    type: params.type,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
}

/** Hand a prepared command to the queue; on failure the row is failed and false returned. */
async function publishCommand(
  db: Db,
  commandQueue: CommandQueue,
  prepared: PreparedCommand
): Promise<boolean> {
  try {
    await commandQueue.enqueue({
      commandId: prepared.commandId,
      serverId: prepared.serverId,
      type: prepared.type,
      attempt: 1,
      queuedAt: prepared.queuedAt,
    })
  } catch {
    await transitionCommand(db, prepared.commandId, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return false
  }
  return true
}

async function enqueueCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: CommandSpec
): Promise<{ commandId: string; serverId: string } | null> {
  const prepared = await prepareCommand(db, params)
  if (!(await publishCommand(db, commandQueue, prepared))) return null
  return { commandId: prepared.commandId, serverId: prepared.serverId }
}

async function detectHaPresent(db: Db, members: readonly ManagedMemberRow[]): Promise<boolean> {
  for (const member of members) {
    const hierarchy = await findManagedHaHierarchy(db, {
      serverId: member.serverId,
    })
    if (hierarchy) return true
  }
  return false
}

function candidateInputs(
  members: readonly ManagedMemberRow[],
  primary: ManagedMemberRow,
  datacenterByServer: Map<string, Set<string>>
): HaMemberCandidateInput[] {
  const primaryDcs = datacenterByServer.get(primary.serverId) ?? new Set()
  return members.map((member) => {
    const dcs = datacenterByServer.get(member.serverId) ?? new Set()
    let same = false
    for (const id of dcs) {
      if (primaryDcs.has(id)) {
        same = true
        break
      }
    }
    return {
      id: member.id,
      role: member.role,
      replicaClass: member.replicaClass,
      ordinal: member.ordinal,
      sameDatacenterAsPrimary: same,
      healthy: isAutomaticFailoverHealthy(replicationFromMemberMetadata(member.metadata)),
    }
  })
}

export async function loadDatacenterSets(
  db: Db,
  members: readonly ManagedMemberRow[]
): Promise<Map<string, Set<string>>> {
  const serverIds = [...new Set(members.map((row) => row.serverId))]
  const pins = await loadDatacenterMembershipsForServers(db, serverIds)
  const sets = new Map<string, Set<string>>()
  for (const [serverId, rows] of pins) {
    const ids = new Set<string>()
    for (const pin of rows) ids.add(pin.datacenterId)
    sets.set(serverId, ids)
  }
  return sets
}

export function firstDatacenterId(sets: Map<string, Set<string>>, serverId: string): string | null {
  const ids = [...(sets.get(serverId) ?? [])].sort((a, b) => a.localeCompare(b))
  return ids[0] ?? null
}

async function markNeedsResync(db: Db, memberId: string): Promise<void> {
  await db
    .update(replica)
    .set({ status: 'needs_resync', updatedAt: new Date().toISOString() })
    .where(eq(replica.id, memberId))
}

async function memberDialHost(
  db: Db,
  observerServerId: string,
  member: ManagedMemberRow
): Promise<string | undefined> {
  if (member.serverId === observerServerId) {
    const [row] = await db
      .select({ containerName: container.containerName })
      .from(container)
      .innerJoin(service, eq(service.id, container.serviceId))
      .innerJoin(managed, eq(managed.environmentId, service.environmentId))
      .where(
        and(
          eq(managed.id, member.managedId),
          eq(container.serverId, observerServerId),
          eq(container.role, 'service'),
          eq(container.ordinal, member.ordinal)
        )
      )
      .limit(1)
    return row?.containerName ?? undefined
  }
  const endpoints = await resolvePrivateEndpoints(db, {
    fromServerId: observerServerId,
    toServerIds: [member.serverId],
    purpose: 'failover-replication',
  })
  const resolved = endpoints.get(member.serverId)
  if (!resolved || isPrivateEndpointError(resolved)) return undefined
  return resolved.address
}

async function failoverPayload(
  db: Db,
  observerServerId: string,
  params: {
    managedId: string
    source: ManagedMemberRow
    target: ManagedMemberRow
    engine: ManagedEngineCode
    phase: 'drain' | 'recover'
  }
): Promise<ManagedHaFailoverCommandPayload> {
  const sourceHost = await memberDialHost(db, observerServerId, params.source)
  const targetHost = await memberDialHost(db, observerServerId, params.target)
  return {
    managedId: params.managedId,
    sourceMemberId: params.source.id,
    targetMemberId: params.target.id,
    engine: params.engine,
    phase: params.phase,
    ...(sourceHost ? { sourceHost } : {}),
    ...(params.source.privatePort !== null ? { sourcePort: params.source.privatePort } : {}),
    ...(targetHost ? { targetHost } : {}),
    ...(params.target.privatePort !== null ? { targetPort: params.target.privatePort } : {}),
  }
}

async function enqueuePromoteOrRecover(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    recovery: RecoveryRecord
    engine: ManagedEngineCode
    source: ManagedMemberRow
    target: ManagedMemberRow
    actor: RecoveryCommandActor
    haPresent: boolean
  }
): Promise<RecoveryEnqueueResult> {
  const authority = OrchestratorManagedHaAuthority
  const metadata: RecoveryMetadata = {
    ...params.recovery.metadata,
    haPresent: params.haPresent,
  }
  await updateRecovery(db, params.recovery.id, {
    state: 'promoting',
    metadata,
  })

  if (authority.shouldUseOrchestrator(params.haPresent)) {
    const payload = await failoverPayload(db, params.target.serverId, {
      managedId: params.recovery.managedId,
      source: params.source,
      target: params.target,
      engine: params.engine,
      phase: 'recover',
    })
    const queued = await enqueueCommand(db, commandQueue, {
      serverId: params.target.serverId,
      type: 'managed.ha.failover',
      payload,
      expiresAtMs: PROMOTE_TTL_MS,
      actor: params.actor,
      metadata: { recoveryId: params.recovery.id },
    })
    if (!queued) {
      await blockUnqueuedPromote(db, params.recovery.id, metadata)
      return { ok: false, error: 'Command queue unavailable', status: 503 }
    }
    await updateRecovery(db, params.recovery.id, {
      metadata: { ...metadata, failoverCommandId: queued.commandId },
    })
    return {
      ok: true,
      commandId: queued.commandId,
      serverId: queued.serverId,
      fencePending: false,
      recoveryId: params.recovery.id,
    }
  }

  const payload: ManagedPromoteCommandPayload = {
    managedId: params.recovery.managedId,
    memberId: params.target.id,
    engine: params.engine,
    demoteMemberId: params.source.id,
  }
  const queued = await enqueueCommand(db, commandQueue, {
    serverId: params.target.serverId,
    type: 'managed.promote',
    payload,
    expiresAtMs: PROMOTE_TTL_MS,
    actor: params.actor,
    metadata: { recoveryId: params.recovery.id },
  })
  if (!queued) {
    await blockUnqueuedPromote(db, params.recovery.id, metadata)
    return { ok: false, error: 'Command queue unavailable', status: 503 }
  }
  await updateRecovery(db, params.recovery.id, {
    metadata: { ...metadata, promoteCommandId: queued.commandId },
  })
  return {
    ok: true,
    commandId: queued.commandId,
    serverId: queued.serverId,
    fencePending: false,
    recoveryId: params.recovery.id,
  }
}

/**
 * A `promoting` row whose promote command never got queued would hold the
 * in-flight slot (managed_busy) with nothing to advance it: make it terminal.
 */
async function blockUnqueuedPromote(
  db: Db,
  recoveryId: string,
  metadata: RecoveryMetadata
): Promise<void> {
  await updateRecovery(db, recoveryId, {
    state: 'blocked',
    metadata: { ...metadata, blockedReason: PROMOTE_UNQUEUED_MESSAGE },
  })
}

type FenceParams = {
  recovery: RecoveryRecord
  engine: ManagedEngineCode
  source: ManagedMemberRow
  target: ManagedMemberRow
  members: readonly ManagedMemberRow[]
  actor: RecoveryCommandActor
  haPresent: boolean
}

/** Drain rows for every connected member server (written, not yet queued). */
async function prepareDrainCommands(db: Db, params: FenceParams): Promise<PreparedCommand[]> {
  const prepared: PreparedCommand[] = []
  const drainServers = [...new Set(params.members.map((row) => row.serverId))]
  await forEachSequential(drainServers, async (serverId) => {
    if (!(await isServerConnected(db, serverId))) return
    const payload = await failoverPayload(db, serverId, {
      managedId: params.recovery.managedId,
      source: params.source,
      target: params.target,
      engine: params.engine,
      phase: 'drain',
    })
    prepared.push(
      await prepareCommand(db, {
        serverId,
        type: 'managed.ha.failover',
        payload,
        expiresAtMs: FENCE_TTL_MS,
        actor: params.actor,
        metadata: { recoveryId: params.recovery.id, fencePhase: 'drain' },
      })
    )
  })
  return prepared
}

/**
 * Record every fence command id on the row BEFORE any is queued, so no result
 * can arrive for a command the row does not know about yet.
 */
function recordFenceCommands(
  db: Db,
  recoveryId: string,
  fenceCommandIds: string[],
  haPresent: boolean
): Promise<RecoveryRecord | null> {
  return updateRecoveryLocked(db, recoveryId, (current) =>
    current.state === 'fencing'
      ? {
          metadata: {
            ...current.metadata,
            haPresent,
            fenceCommandIds,
            fencingEpoch: new Date().toISOString(),
            drainApplied: false,
            stopApplied: false,
          },
        }
      : null
  )
}

/**
 * The stop command never reached the queue: nothing can prove the fence, so
 * the row turns terminal `blocked` (never promote without fencing) instead of
 * holding the in-flight slot.
 */
async function blockUnqueuedFenceStop(db: Db, recoveryId: string, stopId: string): Promise<void> {
  const blocked = await updateRecoveryLocked(db, recoveryId, (current) =>
    current.state === 'fencing'
      ? {
          state: 'blocked',
          metadata: {
            ...current.metadata,
            fenceCommandIds: (current.metadata.fenceCommandIds ?? []).filter((id) => id !== stopId),
            blockedReason: FENCE_STOP_UNQUEUED_MESSAGE,
          },
        }
      : null
  )
  if (blocked) await stampManagedReady(db, blocked.managedId)
}

async function enqueueFenceCommands(
  db: Db,
  commandQueue: CommandQueue,
  params: FenceParams
): Promise<RecoveryEnqueueResult> {
  const drains = await prepareDrainCommands(db, params)
  const stop = await prepareCommand(db, {
    serverId: params.source.serverId,
    type: 'managed.lifecycle',
    payload: {
      managedId: params.recovery.managedId,
      action: 'stop',
      memberId: params.source.id,
      engine: params.engine,
    },
    expiresAtMs: FENCE_TTL_MS,
    actor: params.actor,
    metadata: { recoveryId: params.recovery.id, fencePhase: 'stop' },
  })
  const fenceCommandIds = [...drains.map((row) => row.commandId), stop.commandId]
  const recorded = await recordFenceCommands(
    db,
    params.recovery.id,
    fenceCommandIds,
    params.haPresent
  )
  if (!recorded) return { ok: false, error: 'managed_busy', status: 409 }
  await stampManagedApplying(db, params.recovery.managedId)

  const settle = {
    recoveryId: params.recovery.id,
    engine: params.engine,
    actor: params.actor,
  }
  await forEachSequential(drains, async (drain) => {
    if (await publishCommand(db, commandQueue, drain)) return
    // A drain that never left still has to leave the pending list; the stop
    // is still pending, so this never advances the row on its own.
    await settleFenceCommand(db, commandQueue, {
      ...settle,
      commandId: drain.commandId,
    })
  })
  if (!(await publishCommand(db, commandQueue, stop))) {
    await blockUnqueuedFenceStop(db, params.recovery.id, stop.commandId)
    return { ok: false, error: 'Command queue unavailable', status: 503 }
  }
  return {
    ok: true,
    commandId: stop.commandId,
    serverId: stop.serverId,
    fencePending: true,
    recoveryId: params.recovery.id,
  }
}

async function beginRecovery(params: {
  db: Db
  commandQueue: CommandQueue
  managedId: string
  kind: RecoveryKind
  engine: ManagedEngineCode
  source: ManagedMemberRow
  target: ManagedMemberRow
  members: readonly ManagedMemberRow[]
  actor: RecoveryCommandActor
  extraMetadata?: RecoveryMetadata
  /**
   * Whole-host loss (`ha-host-loss-sweep.ts`): the old primary's server is
   * silent and the replicas confirmed it. Only an automatic failover may carry
   * it, and only while that server is still not connected.
   */
  hostLoss?: boolean
}): Promise<RecoveryEnqueueResult> {
  const inflight = await findInFlightRecovery(params.db, params.managedId)
  if (inflight) {
    return { ok: false, error: 'managed_busy', status: 409 }
  }

  const haPresent = await detectHaPresent(params.db, params.members)
  const recovery = await insertRecoveryIfFree(params.db, {
    managedId: params.managedId,
    kind: params.kind,
    sourcePrimaryMemberId: params.source.id,
    targetMemberId: params.target.id,
    state: 'fencing',
    metadata: {
      haPresent,
      sourceServerId: params.source.serverId,
      targetServerId: params.target.serverId,
      ...params.extraMetadata,
    },
  })
  // Lost the race for the in-flight slot to a concurrent recovery.
  if (!recovery) return { ok: false, error: 'managed_busy', status: 409 }

  const sourceOnline = await isServerConnected(params.db, params.source.serverId)
  if (params.hostLoss && sourceOnline) {
    // The host came back between the decision and now: it is a normal primary
    // again. Nothing was changed yet, so the row just ends, and without a
    // target so that it never starts the 15 minute cooldown.
    await updateRecovery(params.db, recovery.id, {
      state: 'blocked',
      targetMemberId: null,
      metadata: { ...recovery.metadata, blockedReason: HOST_LOSS_HOST_RETURNED_MESSAGE },
    })
    await stampManagedReady(params.db, params.managedId)
    return { ok: false, error: AUTOMATIC_FAILOVER_BLOCKED_ERROR, status: 409 }
  }
  if (!sourceOnline) {
    await markNeedsResync(params.db, params.source.id)
    const advance =
      params.hostLoss && params.kind === 'automatic-failover'
        ? hostLossFenceAdvance(recovery.metadata)
        : nextStateAfterFence({
            kind: params.kind,
            outcome: {
              oldPrimaryReachable: false,
              drainApplied: false,
              stopApplied: false,
            },
            metadata: recovery.metadata,
          })
    await updateRecovery(params.db, recovery.id, {
      state: advance.state,
      metadata: advance.metadata,
    })
    if (advance.state === 'blocked') {
      await stampManagedReady(params.db, params.managedId)
      return {
        ok: false,
        error: AUTOMATIC_FAILOVER_BLOCKED_ERROR,
        status: 409,
      }
    }
    await stampManagedApplying(params.db, params.managedId)
    return enqueuePromoteOrRecover(params.db, params.commandQueue, {
      recovery: { ...recovery, state: 'promoting', metadata: advance.metadata },
      engine: params.engine,
      source: params.source,
      target: params.target,
      actor: params.actor,
      haPresent,
    })
  }

  return enqueueFenceCommands(params.db, params.commandQueue, {
    recovery,
    engine: params.engine,
    source: params.source,
    target: params.target,
    members: params.members,
    actor: params.actor,
    haPresent,
  })
}

export function beginOperatorSwitchover(params: {
  db: Db
  commandQueue: CommandQueue
  managedId: string
  engine: ManagedEngineCode
  source: ManagedMemberRow
  target: ManagedMemberRow
  members: readonly ManagedMemberRow[]
  actor: RecoveryCommandActor
  /** The operator forced the switchover past the lag gate. */
  forced?: boolean
  /** The target's fresh replication reading taken before the fence. */
  targetReplication?: unknown
}): Promise<RecoveryEnqueueResult> {
  const { forced, targetReplication, ...rest } = params
  const catchUp = evaluateSwitchoverCatchUp(params.engine, targetReplication)
  return beginRecovery({
    ...rest,
    kind: 'switchover',
    extraMetadata: {
      forced: forced === true,
      targetCaughtUp: catchUp.caughtUp,
      targetCaughtUpBasis: catchUp.basis,
    },
  })
}

export function beginDisasterRecovery(params: {
  db: Db
  commandQueue: CommandQueue
  managedId: string
  engine: ManagedEngineCode
  source: ManagedMemberRow
  target: ManagedMemberRow
  members: readonly ManagedMemberRow[]
  actor: RecoveryCommandActor
  extraMetadata?: RecoveryMetadata
}): Promise<RecoveryEnqueueResult> {
  return beginRecovery({ ...params, kind: 'disaster-recovery' })
}

function detectorMetadata(
  detector: string | undefined,
  evidence: string | undefined
): { detector?: string; detectorEvidence?: string } {
  return {
    ...(detector ? { detector } : {}),
    ...(evidence ? { detectorEvidence: evidence } : {}),
  }
}

/**
 * Automatic failover is switched off for this deployment: record the accepted
 * event as a TERMINAL row with no target (never counts for the cooldown) and
 * queue nothing. Manual switchover / DR stay available.
 */
async function recordAutoFailoverDisabled(params: {
  db: Db
  managedId: string
  members: readonly ManagedMemberRow[]
  sourceMemberId?: string
  detector?: string
  evidence?: string
}): Promise<RecoveryRecord | null> {
  const primary =
    params.members.find((row) => row.role === 'primary') ??
    params.members.find((row) => row.id === params.sourceMemberId)
  if (!primary) return null
  compatLogWarn(
    'managed-ha',
    `automatic failover for ${params.managedId} not started: ${AUTOMATIC_FAILOVER_DISABLED_REASON}`
  )
  return recordBlockedRecovery(params.db, {
    managedId: params.managedId,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: primary.id,
    state: 'blocked',
    metadata: {
      blockedReason: AUTOMATIC_FAILOVER_DISABLED_MESSAGE,
      sourceServerId: primary.serverId,
      ...detectorMetadata(params.detector, params.evidence),
    },
  })
}

/**
 * A dead-primary report that does not name the current primary: record it as
 * a TERMINAL stale row (no target, so it never counts for the cooldown) and do
 * nothing else. Never fences, never promotes.
 */
export async function recordStaleDeadPrimaryReport(params: {
  db: Db
  managedId: string
  members: readonly ManagedMemberRow[]
  reason: string
  detector?: string
  evidence?: string
}): Promise<RecoveryRecord | null> {
  const primary = params.members.find((row) => row.role === 'primary')
  if (!primary) return null
  compatLogWarn(
    'managed-ha',
    `stale dead-primary report for ${params.managedId} ignored: ${params.reason}`
  )
  return recordBlockedRecovery(params.db, {
    managedId: params.managedId,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: primary.id,
    state: 'blocked',
    metadata: {
      stale: true,
      blockedReason: `Ignored stale dead-primary report: ${params.reason}`,
      sourceServerId: primary.serverId,
      ...detectorMetadata(params.detector, params.evidence),
    },
  })
}

type FreshStandbyGate = {
  /** Asks a candidate's daemon for a fresh reading at event time. */
  probeStandby?: FreshStandbyProbe
  /** Control-plane ms of the detector's first hard failure; null = unknown. */
  failureStartedAtMs?: number | null
  /** `TURBOPANEL_AUTO_FAILOVER_RECEIPT_MARGIN_SECONDS` in ms; default 10 s. */
  freshStandbyMarginMs?: number
  /** Test seam for the probe start time. */
  nowMs?: () => number
}

type AutomaticFailoverParams = FreshStandbyGate & {
  db: Db
  commandQueue: CommandQueue | null
  managedId: string
  engine: ManagedEngineCode
  members: readonly ManagedMemberRow[]
  sourceMemberId?: string
  /** `managed-ha-event` detector; recorded on the journal row. */
  detector?: string
  /** Bounded detector evidence (JSON text); recorded on the journal row. */
  evidence?: string
  actor: RecoveryCommandActor
  /** `TURBOPANEL_AUTO_FAILOVER` for this deployment; absent = `on`. */
  autoFailover?: AutoFailoverSetting
  /**
   * Whole-host loss incident (`<serverId>@<offline since>`): the old primary's
   * server is silent. Only `ha-host-loss-sweep.ts` sets it, after the replicas
   * confirmed the host is gone; the fence is then attested, not proven.
   */
  hostLossIncident?: string
}

type CandidatePick = {
  inputs: HaMemberCandidateInput[]
  candidate: HaMemberCandidateInput | null
  /** What the fresh-standby probe found; absent when it did not run. */
  freshStandby?: string
}

/**
 * Postgres, MySQL and MariaDB: the stored observations name no healthy candidate, so probe
 * each same-DC `failover` replica now and let the fresh-standby gate accept
 * one that stopped streaming only because its primary died. Probes run in
 * parallel. Of the accepted ones, the standby that received the most WAL
 * wins (`pickMostAdvancedStandby`: highest `receivedLsn`, then lowest
 * ordinal), not simply the lowest ordinal.
 */
async function probeFreshStandbys(
  params: AutomaticFailoverParams,
  inputs: HaMemberCandidateInput[]
): Promise<CandidatePick | null> {
  const probe = params.probeStandby
  const failureStartedAtMs = params.failureStartedAtMs
  if (
    !(params.engine === 'postgres' || isMysqlFamilyEngine(params.engine)) ||
    !probe ||
    typeof failureStartedAtMs !== 'number'
  ) {
    return null
  }
  const now = params.nowMs ?? Date.now
  // MySQL and MariaDB: a stored `streaming` reading proves no GTID state, so
  // every failover-class replica is probed, healthy-looking or not.
  const mysqlFamily = isMysqlFamilyEngine(params.engine)
  const unhealthy = inputs.filter(
    (input) => isAutomaticFailoverClassMember(input) && (mysqlFamily || !input.healthy)
  )
  if (unhealthy.length === 0) return null
  const verdicts = await Promise.all(
    unhealthy.map(async (input) => {
      const member = params.members.find((row) => row.id === input.id)
      const probeStartedAtMs = now()
      const replication = member
        ? await probe({
            memberId: member.id,
            managedId: member.managedId,
            serverId: member.serverId,
            engine: params.engine,
          }).catch(() => null)
        : null
      const verdict = evaluateFreshStandby({
        replication,
        probeStartedAtMs,
        failureStartedAtMs,
        engine: params.engine,
        marginMs: params.freshStandbyMarginMs ?? DEFAULT_FRESH_STANDBY_MARGIN_MS,
      })
      return {
        id: input.id,
        ordinal: input.ordinal,
        verdict,
        receivedLsn: replication?.receivedLsn,
        executedGtid: replication?.executedGtid,
      }
    })
  )
  const accepted = new Set(verdicts.filter((row) => row.verdict.accepted).map((row) => row.id))
  const probedIds = new Set(unhealthy.map((input) => input.id))
  const probed = inputs.map((input) => {
    if (accepted.has(input.id)) return { ...input, healthy: true }
    return mysqlFamily && probedIds.has(input.id) ? { ...input, healthy: false } : input
  })
  const freshStandby = verdicts
    .map(({ id, verdict }) =>
      verdict.accepted ? `${id} accepted: ${verdict.basis}` : `${id} refused: ${verdict.reason}`
    )
    .join('; ')
  // Several accepted: the one that received the most WAL loses the least.
  const acceptedRows = verdicts.filter((row) => row.verdict.accepted)
  const best = mysqlFamily
    ? pickMysqlFamilyStandby(acceptedRows)
    : pickMostAdvancedStandby(acceptedRows)
  return {
    inputs: probed,
    candidate: best ? (probed.find((input) => input.id === best.id) ?? null) : null,
    freshStandby,
  }
}

async function pickAutomaticCandidate(
  params: AutomaticFailoverParams,
  primary: ManagedMemberRow,
  dcSets: Map<string, Set<string>>
): Promise<CandidatePick> {
  const inputs = candidateInputs(params.members, primary, dcSets)
  const probeFirst =
    isMysqlFamilyEngine(params.engine) &&
    params.probeStandby !== undefined &&
    typeof params.failureStartedAtMs === 'number'
  const candidate = probeFirst
    ? null
    : OrchestratorManagedHaAuthority.pickAutomaticCandidate(inputs)
  if (candidate) return { inputs, candidate }
  return (await probeFreshStandbys(params, inputs)) ?? { inputs, candidate: null }
}

function noCandidateBlockedReason(pick: CandidatePick): string {
  const cause = automaticFailoverBlockCause(pick.inputs) ?? 'no-candidate'
  if (cause === 'unhealthy' && pick.freshStandby) {
    return AUTOMATIC_FAILOVER_STANDBY_NOT_PROVEN_MESSAGE
  }
  return automaticFailoverBlockedReason(cause)
}

export async function beginAutomaticFailover(
  params: AutomaticFailoverParams
): Promise<RecoveryRecord | null> {
  const inflight = await findInFlightRecovery(params.db, params.managedId)
  if (inflight) return inflight

  if (params.autoFailover === 'off') return recordAutoFailoverDisabled(params)

  // Persisted cooldown: the journal row of the last accepted failover, so a
  // flapping detector or a restart can never chain failovers back to back.
  const lastAccepted = await findLatestAcceptedAutomaticFailover(params.db, params.managedId)
  if (automaticFailoverCoolingDown(lastAccepted?.startedAt ?? null, Date.now())) {
    compatLogWarn(
      'managed-ha',
      `automatic failover for ${params.managedId} refused: previous one started ${lastAccepted?.startedAt} (cooldown)`
    )
    // Visible in the journal / UI, terminal, and without a target so it never
    // extends the cooldown itself. The daemon re-sends after the cooldown.
    const coolingPrimary =
      params.members.find((row) => row.role === 'primary') ??
      params.members.find((row) => row.id === params.sourceMemberId)
    if (!coolingPrimary) return null
    return recordBlockedRecovery(params.db, {
      managedId: params.managedId,
      kind: 'automatic-failover',
      sourcePrimaryMemberId: coolingPrimary.id,
      state: 'blocked',
      metadata: {
        blockedReason: AUTOMATIC_FAILOVER_COOLDOWN_MESSAGE,
        sourceServerId: coolingPrimary.serverId,
        ...detectorMetadata(params.detector, params.evidence),
      },
    })
  }

  const primary =
    params.members.find((row) => row.role === 'primary') ??
    params.members.find((row) => row.id === params.sourceMemberId)
  if (!primary) return null

  const dcSets = await loadDatacenterSets(params.db, params.members)
  const pick = await pickAutomaticCandidate(params, primary, dcSets)
  const freshStandby = pick.freshStandby ? { freshStandby: pick.freshStandby } : {}
  const candidate = pick.candidate
  if (!candidate) {
    return recordBlockedRecovery(params.db, {
      managedId: params.managedId,
      kind: 'automatic-failover',
      sourcePrimaryMemberId: primary.id,
      state: 'blocked',
      metadata: {
        blockedReason: noCandidateBlockedReason(pick),
        sourceServerId: primary.serverId,
        sourceDatacenterId: firstDatacenterId(dcSets, primary.serverId),
        ...freshStandby,
        ...detectorMetadata(params.detector, params.evidence),
      },
    })
  }
  const target = params.members.find((row) => row.id === candidate.id)
  if (!target) return null

  if (!params.commandQueue) {
    // No queue means nothing can ever fence or promote: record a TERMINAL row
    // (never `detecting`, which would hold the in-flight slot forever) and no
    // target, so it does not count as an accepted failover for the cooldown.
    compatLogWarn(
      'managed-ha',
      `automatic failover for ${params.managedId} not started: ${AUTOMATIC_FAILOVER_NO_QUEUE_REASON}`
    )
    return recordBlockedRecovery(params.db, {
      managedId: params.managedId,
      kind: 'automatic-failover',
      sourcePrimaryMemberId: primary.id,
      state: 'blocked',
      metadata: {
        blockedReason: AUTOMATIC_FAILOVER_NO_QUEUE_MESSAGE,
        sourceServerId: primary.serverId,
        targetServerId: target.serverId,
        sourceDatacenterId: firstDatacenterId(dcSets, primary.serverId),
        targetDatacenterId: firstDatacenterId(dcSets, target.serverId),
        ...freshStandby,
        ...detectorMetadata(params.detector, params.evidence),
      },
    })
  }

  const result = await beginRecovery({
    db: params.db,
    commandQueue: params.commandQueue,
    managedId: params.managedId,
    kind: 'automatic-failover',
    engine: params.engine,
    source: primary,
    target,
    members: params.members,
    actor: params.actor,
    extraMetadata: {
      sourceDatacenterId: firstDatacenterId(dcSets, primary.serverId),
      targetDatacenterId: firstDatacenterId(dcSets, target.serverId),
      ...freshStandby,
      ...detectorMetadata(params.detector, params.evidence),
      ...(params.hostLossIncident ? { hostLossIncident: params.hostLossIncident } : {}),
    },
    ...(params.hostLossIncident ? { hostLoss: true } : {}),
  })
  if (!result.ok) {
    return findLatestRecovery(params.db, params.managedId)
  }
  return findRecoveryById(params.db, result.recoveryId)
}

function fenceOutcomeFromMetadata(metadata: RecoveryMetadata): FenceOutcome {
  return {
    oldPrimaryReachable: true,
    drainApplied: Boolean(metadata.drainApplied),
    stopApplied: Boolean(metadata.stopApplied),
  }
}

type FenceSettlement = {
  recoveryId: string
  commandId: string
  /** Set when the command succeeded; absent for a failed (or never queued) one. */
  applied?: 'drain' | 'stop'
  engine: ManagedEngineCode
  actor: RecoveryCommandActor
}

/**
 * Pure step applied under the row lock. Only a `fencing` row whose pending
 * list still holds this command changes: a duplicate or late result, or one
 * for a command the row never recorded, is ignored rather than advancing on
 * an empty list. The result that empties the list decides the next state.
 */
function applyFenceSettlement(
  current: RecoveryRecord,
  settlement: Pick<FenceSettlement, 'commandId' | 'applied'>
): RecoveryPatch | null {
  if (current.state !== 'fencing') return null
  const recorded = current.metadata.fenceCommandIds ?? []
  if (!recorded.includes(settlement.commandId)) return null
  const pending = recorded.filter((id) => id !== settlement.commandId)
  const metadata: RecoveryMetadata = {
    ...current.metadata,
    fenceCommandIds: pending,
  }
  if (settlement.applied === 'drain') metadata.drainApplied = true
  if (settlement.applied === 'stop') metadata.stopApplied = true
  if (pending.length > 0) return { metadata }
  const advance = nextStateAfterFence({
    kind: current.kind,
    outcome: fenceOutcomeFromMetadata(metadata),
    metadata,
  })
  return { state: advance.state, metadata: advance.metadata }
}

/** After the lock is released: act on the state the settlement produced. */
async function followFenceAdvance(
  db: Db,
  commandQueue: CommandQueue | undefined,
  record: RecoveryRecord,
  settlement: FenceSettlement
): Promise<void> {
  if (record.state === 'blocked') {
    await stampManagedReady(db, record.managedId)
    return
  }
  if (!commandQueue || record.state !== 'promoting') return

  const members = await listManagedMembers(db, record.managedId)
  const source = members.find((row) => row.id === record.sourcePrimaryMemberId)
  const target = record.targetMemberId
    ? members.find((row) => row.id === record.targetMemberId)
    : null
  if (!source || !target) return

  await enqueuePromoteOrRecover(db, commandQueue, {
    recovery: record,
    engine: settlement.engine,
    source,
    target,
    actor: settlement.actor,
    haPresent: Boolean(record.metadata.haPresent),
  })
}

async function settleFenceCommand(
  db: Db,
  commandQueue: CommandQueue | undefined,
  settlement: FenceSettlement
): Promise<void> {
  const updated = await updateRecoveryLocked(db, settlement.recoveryId, (current) =>
    applyFenceSettlement(current, settlement)
  )
  if (!updated) return
  await followFenceAdvance(db, commandQueue, updated, settlement)
}

export async function onFenceCommandSucceeded(
  db: Db,
  commandQueue: CommandQueue | undefined,
  params: {
    recoveryId: string
    commandId: string
    fencePhase: 'drain' | 'stop'
    engine: ManagedEngineCode
    actor: RecoveryCommandActor
  }
): Promise<void> {
  await settleFenceCommand(db, commandQueue, {
    recoveryId: params.recoveryId,
    commandId: params.commandId,
    applied: params.fencePhase,
    engine: params.engine,
    actor: params.actor,
  })
}

export async function onFenceCommandFailed(
  db: Db,
  commandQueue: CommandQueue | undefined,
  params: {
    recoveryId: string
    commandId: string
    engine: ManagedEngineCode
    actor: RecoveryCommandActor
  }
): Promise<void> {
  await settleFenceCommand(db, commandQueue, params)
}

async function reclassifyAfterDisasterRecovery(db: Db, record: RecoveryRecord): Promise<void> {
  const members = await listManagedMembers(db, record.managedId)
  const newPrimary = members.find((row) => row.id === record.targetMemberId)
  if (!newPrimary) return
  const dcSets = await loadDatacenterSets(db, members)
  const primaryDcs = dcSets.get(newPrimary.serverId) ?? new Set()
  await forEachSequential(members, async (member) => {
    const dcs = dcSets.get(member.serverId) ?? new Set()
    let same = false
    for (const id of dcs) {
      if (primaryDcs.has(id)) {
        same = true
        break
      }
    }
    const nextClass = OrchestratorManagedHaAuthority.replicaClassAfterDisasterRecovery({
      role: member.role,
      replicaClass: member.replicaClass,
      sameDatacenterAsNewPrimary: same,
    })
    if (nextClass === null || nextClass === member.replicaClass) return
    await db
      .update(replica)
      .set({ replicaClass: nextClass, updatedAt: new Date().toISOString() })
      .where(eq(replica.id, member.id))
  })
}

/** Terminal `failed` the operator has to look at; frees the cluster's slot. */
function failedNeedsOperator(current: RecoveryRecord, reason: string): RecoveryPatch {
  return {
    state: 'failed',
    metadata: {
      ...current.metadata,
      needsOperator: true,
      failedReason: reason,
    },
  }
}

async function failRecoveryForOperator(
  db: Db,
  recoveryId: string,
  reason: string
): Promise<RecoveryRecord | null> {
  const failed = await updateRecoveryLocked(db, recoveryId, (current) =>
    failedNeedsOperator(current, reason)
  )
  if (failed) await stampManagedFailedIfApplying(db, failed.managedId)
  return failed
}

async function stampManagedFailedIfApplying(db: Db, managedId: string): Promise<void> {
  await db
    .update(managed)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(and(eq(managed.id, managedId), eq(managed.status, 'applying')))
}

/**
 * Claim the promote result exactly once: only a row still at or before
 * `promoting` moves to `repointing`, under the row lock, so a redelivered queue
 * message (or a concurrent consumer) finds it already owned and does nothing.
 */
function claimPromoteResult(
  db: Db,
  recoveryId: string
): Promise<{ record: RecoveryRecord; metadata: RecoveryMetadata } | null> {
  let metadata: RecoveryMetadata | null = null
  return updateRecoveryLocked(db, recoveryId, (current) => {
    if (!['detecting', 'fencing', 'promoting'].includes(current.state)) {
      return null
    }
    const afterPromote = nextStateAfterPromoteSuccess(current.metadata)
    metadata = afterPromote.metadata
    return { state: afterPromote.state, metadata: afterPromote.metadata }
  }).then((record) => (record && metadata ? { record, metadata } : null))
}

async function fanOutAfterPromote(
  db: Db,
  commandQueue: CommandQueue | undefined,
  secrets: {
    secretsConfig?: SecretsConfig
    dataEncryptionSecrets?: DerivedSecretsConfig
  },
  record: RecoveryRecord,
  actorId: string
): Promise<ManagedIngressFanOutOutcome | null> {
  if (!commandQueue || !secrets.secretsConfig || !secrets.dataEncryptionSecrets) return null
  const { fanOutManagedIngressReconcile } = await import('./ingress-desired.ts')
  const ingress = await fanOutManagedIngressReconcile(db, commandQueue, {
    managedId: record.managedId,
    actorType: 'system',
    actorId,
    secretsConfig: secrets.secretsConfig,
    dataEncryptionSecrets: secrets.dataEncryptionSecrets,
    recoveryId: record.id,
    excludeServerIds: attestedLostServerIds(record.metadata),
  })
  await fanOutManagedHaReconcile(db, commandQueue, {
    managedId: record.managedId,
    actorType: 'system',
    actorId,
    secretsConfig: secrets.secretsConfig,
    dataEncryptionSecrets: secrets.dataEncryptionSecrets,
  })
  return ingress
}

export type PromoteFollowUpRuntime = {
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
  /** Live daemon connections, for the planned-switchover re-seed. */
  registry?: DaemonCellRegistry
}

/** Test seam: replaces the planned-switchover re-seed. */
export type PromoteFollowUpHooks = {
  reseed?: typeof reseedDemotedPrimaryAfterSwitchover
}

async function reseedAfterPlannedSwitchover(
  db: Db,
  commandQueue: CommandQueue | undefined,
  runtime: PromoteFollowUpRuntime,
  record: RecoveryRecord,
  actorId: string,
  hooks: PromoteFollowUpHooks
): Promise<void> {
  if (record.kind !== 'switchover') return
  try {
    const reseed = hooks.reseed ?? reseedDemotedPrimaryAfterSwitchover
    await reseed(db, commandQueue, runtime, record, actorId)
  } catch (err) {
    compatLogWarn(
      'managed-ha',
      `managed.member.reseed.auto: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export async function onPromoteSucceeded(
  db: Db,
  commandQueue: CommandQueue | undefined,
  secrets: PromoteFollowUpRuntime,
  recoveryId: string,
  actorId: string,
  hooks: PromoteFollowUpHooks = {}
): Promise<void> {
  const existing = await findRecoveryById(db, recoveryId)
  if (!existing || isTerminalRecoveryState(existing.state)) return

  const claimed = await claimPromoteResult(db, recoveryId)
  if (!claimed) return
  const { record } = claimed

  // The role flip already happened. A throw from here on would strand the row
  // at `repointing` (nothing else advances it), so any failure ends it
  // terminal for the operator instead.
  try {
    if (record.kind === 'disaster-recovery' && record.targetMemberId) {
      await reclassifyAfterDisasterRecovery(db, record)
    }
    if (record.targetMemberId) {
      await enqueueFollowPrimaryOnReplicas(db, commandQueue, {
        managedId: record.managedId,
        newPrimaryMemberId: record.targetMemberId,
        actorId,
      })
    }
    const ingress = await fanOutAfterPromote(db, commandQueue, secrets, record, actorId)
    if (ingress) {
      // Not completed until every ingress confirms (ha-ingress-gate.ts).
      await parkRecoveryAtIngressGate(
        db,
        record.id,
        ingress,
        attestedLostServerIds(record.metadata)
      )
      await reseedAfterPlannedSwitchover(db, commandQueue, secrets, record, actorId, hooks)
      return
    }
    // Nothing could be queued, so no ingress was told about the new primary.
    const members = await listManagedMembers(db, record.managedId)
    await failRecoveryIngressNotQueued(db, record.id, [
      ...new Set(members.map((row) => row.serverId)),
    ])
  } catch (error) {
    logRecoveryAdvanceFailure(
      record.id,
      error instanceof Error ? error.message : 'post-promote step failed'
    )
    await failRecoveryForOperator(db, record.id, RECOVERY_STEP_FAILED_MESSAGE)
  }
}

/**
 * A step after the role change (the consumer's side effect of a successful
 * promote) threw. The roles already changed, so the row ends terminal for the
 * operator rather than waiting for the sweep.
 */
export async function onRecoveryStepFailed(db: Db, recoveryId: string): Promise<void> {
  await failRecoveryForOperator(db, recoveryId, RECOVERY_STEP_FAILED_MESSAGE)
}

export async function onRecoveryCommandFailed(db: Db, recoveryId: string): Promise<void> {
  await failRecoveryForOperator(db, recoveryId, RECOVERY_COMMAND_TIMED_OUT_MESSAGE)
}

/**
 * The stale-command sweep timed out a command that belongs to a recovery (the
 * consumer that was waiting for it died with its process). Settle the journal
 * the way the consumer's failure path would have, so the row never strands the
 * cluster's in-flight slot. A fence command that is gone fails the fence
 * (`blocked`, never promote); a promote / failover command that is gone fails
 * the row for the operator, who has to check which member is the writer.
 */
export async function onRecoveryCommandTimedOut(
  db: Db,
  params: {
    recoveryId: string
    commandId: string
    type: string
    fencePhase: 'drain' | 'stop' | null
  }
): Promise<void> {
  const isFenceCommand = params.fencePhase !== null || params.type === 'managed.lifecycle'
  if (isFenceCommand) {
    await onFenceCommandFailed(db, undefined, {
      recoveryId: params.recoveryId,
      commandId: params.commandId,
      // No queue here, so the engine and actor are never used to enqueue.
      engine: 'postgres',
      actor: { actorType: 'system', actorId: params.commandId },
    })
    return
  }
  if (params.type === 'managed.ingress.reconcile') {
    // A repoint that never answered: the completion gate names the server.
    await settleIngressCommandForRecovery(db, params.recoveryId)
    return
  }
  if (params.type === 'managed.promote' || params.type === 'managed.ha.failover') {
    await onRecoveryCommandFailed(db, params.recoveryId)
  }
}

export function recoveryIdFromCommandMetadata(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const value = metadata?.recoveryId
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function fencePhaseFromCommandMetadata(
  metadata: Record<string, unknown> | null | undefined
): 'drain' | 'stop' | null {
  const value = metadata?.fencePhase
  if (value === 'drain' || value === 'stop') return value
  return null
}

export { isServerConnected }

export function logRecoveryAdvanceFailure(commandId: string, message: string): void {
  compatLogWarn('managed-ha', `recovery advance failed for command ${commandId}: ${message}`)
}
