/**
 * Durable recovery journal + fencing/promote enqueue. Consumer advances
 * state off the `recovery` row; HTTP routes and cell events call into here.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type { CommandType } from '../../lib/commands/types.ts'
import type {
  ManagedHaFailoverCommandPayload,
  ManagedPromoteCommandPayload,
} from '../../lib/commands/schemas.ts'
import type { ManagedEngineCode } from '../../lib/managed/types.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import {
  findInFlightRecovery,
  findLatestRecovery,
  findRecoveryById,
  insertRecovery,
  updateRecovery,
} from '../../lib/db/recovery-records.ts'
import { container, managed, node, server, service } from '../../lib/db/schema.ts'
import { OrchestratorManagedHaAuthority } from './ha-authority.ts'
import {
  nextStateAfterFence,
  nextStateAfterIngressReconcile,
  nextStateAfterPromoteSuccess,
  nextStateAfterVerify,
  type FenceOutcome,
} from './ha-recovery-pure.ts'
import { fanOutManagedHaReconcile } from './ha-desired.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import { findManagedHaHierarchy } from '../system/hierarchy.ts'
import { loadDatacenterMembershipsForServers } from '../../lib/net/datacenter-membership.ts'
import {
  isPrivateEndpointError,
  resolvePrivateEndpoints,
} from '../../lib/net/private-endpoint.ts'
import {
  automaticFailoverBlockCause,
  automaticFailoverBlockedReason,
  type HaMemberCandidateInput,
} from '../../lib/managed/ha-policy.ts'
import {
  isAutomaticFailoverHealthy,
  replicationFromMemberMetadata,
} from '../../lib/managed/promote-lag.ts'
import {
  AUTOMATIC_FAILOVER_BLOCKED_ERROR,
  isTerminalRecoveryState,
  type RecoveryKind,
  type RecoveryMetadata,
  type RecoveryRecord,
} from '../../lib/managed/recovery.ts'
import { compatLogWarn } from '../../log-compat.ts'

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

async function enqueueCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string
    type: CommandType
    payload: unknown
    expiresAtMs: number
    actor: RecoveryCommandActor
    metadata?: Record<string, unknown>
  },
): Promise<{ commandId: string; serverId: string } | null> {
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
  try {
    await commandQueue.enqueue({
      commandId: record.id,
      serverId: params.serverId,
      type: params.type,
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    })
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return null
  }
  return { commandId: record.id, serverId: params.serverId }
}

async function detectHaPresent(
  db: Db,
  members: readonly ManagedMemberRow[],
): Promise<boolean> {
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
  datacenterByServer: Map<string, Set<string>>,
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
      healthy: isAutomaticFailoverHealthy(
        replicationFromMemberMetadata(member.metadata),
      ),
    }
  })
}

export async function loadDatacenterSets(
  db: Db,
  members: readonly ManagedMemberRow[],
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

export function firstDatacenterId(
  sets: Map<string, Set<string>>,
  serverId: string,
): string | null {
  const ids = [...(sets.get(serverId) ?? [])].sort((a, b) => a.localeCompare(b))
  return ids[0] ?? null
}

async function markNeedsResync(db: Db, memberId: string): Promise<void> {
  await db
    .update(node)
    .set({ status: 'needs_resync', updatedAt: new Date().toISOString() })
    .where(eq(node.id, memberId))
}

async function memberDialHost(
  db: Db,
  observerServerId: string,
  member: ManagedMemberRow,
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
          eq(container.ordinal, member.ordinal),
        ),
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
  },
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
    ...(params.source.privatePort !== null
      ? { sourcePort: params.source.privatePort }
      : {}),
    ...(targetHost ? { targetHost } : {}),
    ...(params.target.privatePort !== null
      ? { targetPort: params.target.privatePort }
      : {}),
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
  },
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

async function enqueueFenceCommands(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    recovery: RecoveryRecord
    engine: ManagedEngineCode
    source: ManagedMemberRow
    target: ManagedMemberRow
    members: readonly ManagedMemberRow[]
    actor: RecoveryCommandActor
    haPresent: boolean
  },
): Promise<RecoveryEnqueueResult> {
  const fenceCommandIds: string[] = []
  const drainServers = [...new Set(params.members.map((row) => row.serverId))]
  for (const serverId of drainServers) {
    if (!(await isServerConnected(db, serverId))) continue
    const payload = await failoverPayload(db, serverId, {
      managedId: params.recovery.managedId,
      source: params.source,
      target: params.target,
      engine: params.engine,
      phase: 'drain',
    })
    const queued = await enqueueCommand(db, commandQueue, {
      serverId,
      type: 'managed.ha.failover',
      payload,
      expiresAtMs: FENCE_TTL_MS,
      actor: params.actor,
      metadata: { recoveryId: params.recovery.id, fencePhase: 'drain' },
    })
    if (queued) fenceCommandIds.push(queued.commandId)
  }

  const stopQueued = await enqueueCommand(db, commandQueue, {
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
  if (!stopQueued) {
    return { ok: false, error: 'Command queue unavailable', status: 503 }
  }
  fenceCommandIds.push(stopQueued.commandId)

  await updateRecovery(db, params.recovery.id, {
    state: 'fencing',
    metadata: {
      ...params.recovery.metadata,
      haPresent: params.haPresent,
      fenceCommandIds,
      fencingEpoch: new Date().toISOString(),
      drainApplied: false,
      stopApplied: false,
    },
  })
  await stampManagedApplying(db, params.recovery.managedId)
  return {
    ok: true,
    commandId: stopQueued.commandId,
    serverId: stopQueued.serverId,
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
}): Promise<RecoveryEnqueueResult> {
  const inflight = await findInFlightRecovery(params.db, params.managedId)
  if (inflight) {
    return { ok: false, error: 'managed_busy', status: 409 }
  }

  const haPresent = await detectHaPresent(params.db, params.members)
  const recovery = await insertRecovery(params.db, {
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

  const sourceOnline = await isServerConnected(params.db, params.source.serverId)
  if (!sourceOnline) {
    await markNeedsResync(params.db, params.source.id)
    const advance = nextStateAfterFence({
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
}): Promise<RecoveryEnqueueResult> {
  return beginRecovery({ ...params, kind: 'switchover' })
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

export async function beginAutomaticFailover(params: {
  db: Db
  commandQueue: CommandQueue | null
  managedId: string
  engine: ManagedEngineCode
  members: readonly ManagedMemberRow[]
  sourceMemberId?: string
  actor: RecoveryCommandActor
}): Promise<RecoveryRecord | null> {
  const inflight = await findInFlightRecovery(params.db, params.managedId)
  if (inflight) return inflight

  const primary = params.members.find((row) => row.role === 'primary') ??
    params.members.find((row) => row.id === params.sourceMemberId)
  if (!primary) return null

  const dcSets = await loadDatacenterSets(params.db, params.members)
  const inputs = candidateInputs(params.members, primary, dcSets)
  const candidate = OrchestratorManagedHaAuthority.pickAutomaticCandidate(inputs)
  if (!candidate) {
    const cause = automaticFailoverBlockCause(inputs) ?? 'no-candidate'
    return insertRecovery(params.db, {
      managedId: params.managedId,
      kind: 'automatic-failover',
      sourcePrimaryMemberId: primary.id,
      state: 'blocked',
      metadata: {
        blockedReason: automaticFailoverBlockedReason(cause),
        sourceServerId: primary.serverId,
        sourceDatacenterId: firstDatacenterId(dcSets, primary.serverId),
      },
    })
  }
  const target = params.members.find((row) => row.id === candidate.id)
  if (!target) return null

  if (!params.commandQueue) {
    return insertRecovery(params.db, {
      managedId: params.managedId,
      kind: 'automatic-failover',
      sourcePrimaryMemberId: primary.id,
      targetMemberId: target.id,
      state: 'detecting',
      metadata: {
        sourceServerId: primary.serverId,
        targetServerId: target.serverId,
        sourceDatacenterId: firstDatacenterId(dcSets, primary.serverId),
        targetDatacenterId: firstDatacenterId(dcSets, target.serverId),
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
    },
  })
  if (!result.ok) {
    return findLatestRecovery(params.db, params.managedId)
  }
  return findRecoveryById(params.db, result.recoveryId)
}

async function loadRecovery(
  db: Db,
  recoveryId: string,
): Promise<RecoveryRecord | null> {
  const current = await findRecoveryById(db, recoveryId)
  if (!current || isTerminalRecoveryState(current.state)) return null
  return current
}

function fenceOutcomeFromMetadata(metadata: RecoveryMetadata): FenceOutcome {
  return {
    oldPrimaryReachable: true,
    drainApplied: Boolean(metadata.drainApplied),
    stopApplied: Boolean(metadata.stopApplied),
  }
}

async function maybeAdvanceAfterFence(
  db: Db,
  commandQueue: CommandQueue | undefined,
  params: {
    current: RecoveryRecord
    engine: ManagedEngineCode
    actor: RecoveryCommandActor
  },
): Promise<void> {
  const pending = params.current.metadata.fenceCommandIds ?? []
  if (pending.length > 0) {
    await updateRecovery(db, params.current.id, {
      metadata: params.current.metadata,
    })
    return
  }

  const advance = nextStateAfterFence({
    kind: params.current.kind,
    outcome: fenceOutcomeFromMetadata(params.current.metadata),
    metadata: params.current.metadata,
  })
  await updateRecovery(db, params.current.id, {
    state: advance.state,
    metadata: advance.metadata,
  })
  if (advance.state === 'blocked') {
    await stampManagedReady(db, params.current.managedId)
    return
  }
  if (!commandQueue || advance.state !== 'promoting') return

  const members = await listManagedMembers(db, params.current.managedId)
  const source = members.find((row) =>
    row.id === params.current.sourcePrimaryMemberId
  )
  const target = params.current.targetMemberId
    ? members.find((row) => row.id === params.current.targetMemberId)
    : null
  if (!source || !target) return

  await enqueuePromoteOrRecover(db, commandQueue, {
    recovery: {
      ...params.current,
      state: 'promoting',
      metadata: advance.metadata,
    },
    engine: params.engine,
    source,
    target,
    actor: params.actor,
    haPresent: Boolean(advance.metadata.haPresent),
  })
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
  },
): Promise<void> {
  const current = await loadRecovery(db, params.recoveryId)
  if (!current) return

  const pending = (current.metadata.fenceCommandIds ?? []).filter(
    (id) => id !== params.commandId,
  )
  const metadata: RecoveryMetadata = {
    ...current.metadata,
    fenceCommandIds: pending,
    drainApplied: params.fencePhase === 'drain' ||
      Boolean(current.metadata.drainApplied),
    stopApplied: params.fencePhase === 'stop' ||
      Boolean(current.metadata.stopApplied),
  }
  await maybeAdvanceAfterFence(db, commandQueue, {
    current: { ...current, metadata },
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
  },
): Promise<void> {
  const current = await loadRecovery(db, params.recoveryId)
  if (!current) return

  const pending = (current.metadata.fenceCommandIds ?? []).filter(
    (id) => id !== params.commandId,
  )
  const metadata: RecoveryMetadata = {
    ...current.metadata,
    fenceCommandIds: pending,
  }
  await maybeAdvanceAfterFence(db, commandQueue, {
    current: { ...current, metadata },
    engine: params.engine,
    actor: params.actor,
  })
}

async function reclassifyAfterDisasterRecovery(
  db: Db,
  record: RecoveryRecord,
): Promise<void> {
  const members = await listManagedMembers(db, record.managedId)
  const newPrimary = members.find((row) => row.id === record.targetMemberId)
  if (!newPrimary) return
  const dcSets = await loadDatacenterSets(db, members)
  const primaryDcs = dcSets.get(newPrimary.serverId) ?? new Set()
  for (const member of members) {
    const dcs = dcSets.get(member.serverId) ?? new Set()
    let same = false
    for (const id of dcs) {
      if (primaryDcs.has(id)) {
        same = true
        break
      }
    }
    const nextClass = OrchestratorManagedHaAuthority
      .replicaClassAfterDisasterRecovery({
        role: member.role,
        replicaClass: member.replicaClass,
        sameDatacenterAsNewPrimary: same,
      })
    if (nextClass === null || nextClass === member.replicaClass) continue
    await db
      .update(node)
      .set({ replicaClass: nextClass, updatedAt: new Date().toISOString() })
      .where(eq(node.id, member.id))
  }
}

export async function onPromoteSucceeded(
  db: Db,
  commandQueue: CommandQueue | undefined,
  secrets: {
    secretsConfig?: SecretsConfig
    dataEncryptionSecrets?: DerivedSecretsConfig
  },
  recoveryId: string,
  actorId: string,
): Promise<void> {
  const record = await findRecoveryById(db, recoveryId)
  if (!record || isTerminalRecoveryState(record.state)) return

  if (record.kind === 'disaster-recovery' && record.targetMemberId) {
    await reclassifyAfterDisasterRecovery(db, record)
  }

  const afterPromote = nextStateAfterPromoteSuccess(record.metadata)
  await updateRecovery(db, record.id, {
    state: afterPromote.state,
    metadata: afterPromote.metadata,
  })

  if (
    commandQueue && secrets.secretsConfig && secrets.dataEncryptionSecrets
  ) {
    const { fanOutManagedIngressReconcile } = await import(
      './ingress-desired.ts'
    )
    await fanOutManagedIngressReconcile(db, commandQueue, {
      managedId: record.managedId,
      actorType: 'system',
      actorId,
      secretsConfig: secrets.secretsConfig,
      dataEncryptionSecrets: secrets.dataEncryptionSecrets,
    })
    await fanOutManagedHaReconcile(db, commandQueue, {
      managedId: record.managedId,
      actorType: 'system',
      actorId,
      secretsConfig: secrets.secretsConfig,
      dataEncryptionSecrets: secrets.dataEncryptionSecrets,
    })
  }

  const afterIngress = nextStateAfterIngressReconcile(afterPromote.metadata)
  const members = await listManagedMembers(db, record.managedId)
  const writerCount = members.filter((row) => row.role === 'primary').length
  const verified = nextStateAfterVerify({
    writerCount,
    metadata: afterIngress.metadata,
  })
  await updateRecovery(db, record.id, {
    state: verified.state,
    metadata: verified.metadata,
  })
}

export async function onRecoveryCommandFailed(
  db: Db,
  recoveryId: string,
): Promise<void> {
  const latest = await findRecoveryById(db, recoveryId)
  if (!latest || isTerminalRecoveryState(latest.state)) return
  await updateRecovery(db, recoveryId, { state: 'failed' })
}

export function recoveryIdFromCommandMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.recoveryId
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function fencePhaseFromCommandMetadata(
  metadata: Record<string, unknown> | null | undefined,
): 'drain' | 'stop' | null {
  const value = metadata?.fencePhase
  if (value === 'drain' || value === 'stop') return value
  return null
}

export { isServerConnected }

export function logRecoveryAdvanceFailure(
  commandId: string,
  message: string,
): void {
  compatLogWarn(
    'managed-ha',
    `recovery advance failed for command ${commandId}: ${message}`,
  )
}
