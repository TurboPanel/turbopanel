/**
 * After a promote or recover, remaining replicas follow the new primary
 * (`managed.ha.failover` phase `repoint`) without a full Resync.
 *
 * Failures are logged and left to health checks; they must never fail the
 * promote.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, managed, server } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { commandContextFromPayload } from '../commands/context.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { COMMAND_STATUSES, TERMINAL_COMMAND_STATUSES } from '../commands/types.ts'
import type { ManagedHaFailoverCommandPayload } from '../../contracts/commands/schemas.ts'
import { getManagedEngineSpec } from './index.ts'
import {
  listManagedMembers,
  type ManagedMemberPeer,
  type ManagedMemberRow,
  resolvePeerToMember,
} from './members.ts'
import { isManagedEngineCode, type ManagedEngineCode } from './types.ts'

const FOLLOW_PRIMARY_TTL_MS = 600_000
/** Member rows that can follow a new primary without a full Resync. */
const FOLLOW_PRIMARY_STATUSES = new Set(['ready', 'streaming'])
const OUTSTANDING_COMMAND_STATUSES = COMMAND_STATUSES.filter(
  (status) => !TERMINAL_COMMAND_STATUSES.has(status)
)
const SUPERSEDED_FOLLOW_PRIMARY_ERROR = 'Superseded by a follow-primary to a newer primary'

export type ReplicaFollowPrimaryDial = {
  targetHost: string
  targetPort: number
  targetHostaddr?: string
}

export type FollowPrimaryEnqueueParams = {
  managedId: string
  newPrimaryMemberId: string
  actorId: string
  engine?: ManagedEngineCode
}

export type OutstandingFollowPrimary = {
  commandId: string
  memberId: string
  targetMemberId: string | null
}

export type FollowPrimaryEnginePort = {
  engine: ManagedEngineCode
  defaultPort: number
}

export type FollowPrimaryEnqueueDeps = {
  listMembers?: typeof listManagedMembers
  resolvePeer?: typeof resolvePeerToMember
  loadEngine?: (db: Db, managedId: string) => Promise<FollowPrimaryEnginePort | null>
  loadConnectedServerIds?: (db: Db, serverIds: readonly string[]) => Promise<Set<string>>
  outstandingRepoints?: (db: Db, managedId: string) => Promise<OutstandingFollowPrimary[]>
  cancelCommand?: (db: Db, commandId: string) => Promise<void>
  enqueue?: (
    db: Db,
    commandQueue: CommandQueue,
    spec: {
      serverId: string
      payload: ManagedHaFailoverCommandPayload
      actorId: string
      memberId: string
    }
  ) => Promise<boolean>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function logFollowPrimaryFailure(detail: string): void {
  compatLogWarn('managed-ha', `follow-primary: ${detail}`)
}

/** Physical replication slot apply uses for a member (`tp_member_<ordinal>`). */
export function managedMemberSlotName(ordinal: number): string {
  return `tp_member_${ordinal}`
}

/**
 * How a replica dials the new primary — same host / hostaddr / port shape
 * apply uses when seeding replication.
 */
export function replicaFollowPrimaryDial(
  managedId: string,
  primaryPeer: Pick<ManagedMemberPeer, 'address' | 'port' | 'containerName'>
): ReplicaFollowPrimaryDial {
  if (primaryPeer.containerName) {
    return { targetHost: primaryPeer.containerName, targetPort: primaryPeer.port }
  }
  return {
    targetHost: `managed-${managedId}`,
    targetPort: primaryPeer.port,
    targetHostaddr: primaryPeer.address,
  }
}

/** Remaining replicas that should follow the new primary. */
export function membersEligibleToFollowPrimary(
  members: readonly ManagedMemberRow[],
  newPrimaryMemberId: string,
  connectedServerIds?: ReadonlySet<string>
): ManagedMemberRow[] {
  return members.filter((row) => {
    if (row.id === newPrimaryMemberId || row.role === 'primary') return false
    if (!FOLLOW_PRIMARY_STATUSES.has(row.status ?? '')) return false
    if (connectedServerIds && !connectedServerIds.has(row.serverId)) return false
    return true
  })
}

async function loadManagedEnginePort(
  db: Db,
  managedId: string
): Promise<FollowPrimaryEnginePort | null> {
  const [row] = await db
    .select({ engine: managed.engine })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  if (!row?.engine || !isManagedEngineCode(row.engine)) return null
  const defaultPort = getManagedEngineSpec(row.engine)?.defaultPort
  if (defaultPort === undefined) return null
  return { engine: row.engine, defaultPort }
}

function resolveEngineAndPort(
  params: FollowPrimaryEnqueueParams,
  loaded: FollowPrimaryEnginePort | null
): FollowPrimaryEnginePort | null {
  const engine = params.engine ?? loaded?.engine
  if (!engine) return null
  const defaultPort = getManagedEngineSpec(engine)?.defaultPort ?? loaded?.defaultPort
  if (defaultPort === undefined) return null
  return { engine, defaultPort }
}

async function loadConnectedServerIds(db: Db, serverIds: readonly string[]): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(and(inArray(server.id, [...serverIds]), eq(server.isConnected, true)))
  return new Set(rows.map((row) => row.id))
}

function followPrimaryTargetFromContext(context: unknown): {
  memberId: string
  targetMemberId: string | null
} | null {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return null
  const record = context as { memberId?: unknown; targetMemberId?: unknown }
  if (typeof record.memberId !== 'string' || record.memberId.length === 0) return null
  const targetMemberId =
    typeof record.targetMemberId === 'string' && record.targetMemberId.length > 0
      ? record.targetMemberId
      : null
  return { memberId: record.memberId, targetMemberId }
}

async function outstandingFollowPrimaryRepoints(
  db: Db,
  managedId: string
): Promise<OutstandingFollowPrimary[]> {
  const rows = await db
    .select({ id: command.id, context: command.context })
    .from(command)
    .where(
      and(
        eq(command.name, 'managed.ha.failover'),
        inArray(command.status, OUTSTANDING_COMMAND_STATUSES),
        sql`${command.context}->>'managedId' = ${managedId}`
      )
    )
  const outstanding: OutstandingFollowPrimary[] = []
  for (const row of rows) {
    const parsed = followPrimaryTargetFromContext(row.context)
    if (!parsed) continue
    outstanding.push({
      commandId: row.id,
      memberId: parsed.memberId,
      targetMemberId: parsed.targetMemberId,
    })
  }
  return outstanding
}

async function cancelSupersededFollowPrimary(db: Db, commandId: string): Promise<void> {
  await transitionCommand(db, commandId, {
    status: 'cancelled',
    error: SUPERSEDED_FOLLOW_PRIMARY_ERROR,
  })
}

async function publishFollowPrimaryCommand(
  db: Db,
  commandQueue: CommandQueue,
  spec: {
    serverId: string
    payload: ManagedHaFailoverCommandPayload
    actorId: string
    memberId: string
  }
): Promise<boolean> {
  const fromPayload = commandContextFromPayload(spec.payload)
  const record = await createCommandRecord(db, {
    serverId: spec.serverId,
    actorType: 'system',
    actorId: spec.actorId,
    type: 'managed.ha.failover',
    payload: spec.payload,
    expiresAt: new Date(Date.now() + FOLLOW_PRIMARY_TTL_MS).toISOString(),
    context: { ...fromPayload, memberId: spec.memberId },
  })
  try {
    await commandQueue.enqueue({
      commandId: record.id,
      serverId: record.serverId,
      type: 'managed.ha.failover',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    })
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return false
  }
  return true
}

function replicaFollowPrimaryPayload(params: {
  managedId: string
  replica: ManagedMemberRow
  newPrimaryMemberId: string
  engine: ManagedEngineCode
  dial: ReplicaFollowPrimaryDial
}): ManagedHaFailoverCommandPayload {
  return {
    managedId: params.managedId,
    sourceMemberId: params.replica.id,
    targetMemberId: params.newPrimaryMemberId,
    phase: 'repoint',
    engine: params.engine,
    targetHost: params.dial.targetHost,
    targetPort: params.dial.targetPort,
    ...(params.dial.targetHostaddr ? { targetHostaddr: params.dial.targetHostaddr } : {}),
  }
}

function ensureSlotsPayload(params: {
  managedId: string
  primary: ManagedMemberRow
  engine: ManagedEngineCode
  ensureSlots: string[]
}): ManagedHaFailoverCommandPayload {
  return {
    managedId: params.managedId,
    sourceMemberId: params.primary.id,
    targetMemberId: params.primary.id,
    phase: 'repoint',
    engine: params.engine,
    ensureSlots: params.ensureSlots,
  }
}

type FollowPrimaryRun = {
  db: Db
  commandQueue: CommandQueue
  params: FollowPrimaryEnqueueParams
  members: readonly ManagedMemberRow[]
  engine: ManagedEngineCode
  defaultPort: number
  outstanding: OutstandingFollowPrimary[]
  deps: FollowPrimaryEnqueueDeps
}

function cancelIdsForMember(
  outstanding: readonly OutstandingFollowPrimary[],
  memberId: string,
  targetMemberId: string
): { skip: boolean; cancelIds: string[] } {
  const mine = outstanding.filter((row) => row.memberId === memberId)
  return {
    skip: mine.some((row) => row.targetMemberId === targetMemberId),
    cancelIds: mine
      .filter((row) => row.targetMemberId !== targetMemberId)
      .map((row) => row.commandId),
  }
}

async function cancelStaleRepoints(
  run: FollowPrimaryRun,
  cancelIds: readonly string[]
): Promise<void> {
  const cancelCommand = run.deps.cancelCommand ?? cancelSupersededFollowPrimary
  await forEachSequential(cancelIds, (commandId) => cancelCommand(run.db, commandId))
}

async function publishMemberFollowPrimary(
  run: FollowPrimaryRun,
  spec: {
    serverId: string
    memberId: string
    payload: ManagedHaFailoverCommandPayload
  }
): Promise<void> {
  const enqueue = run.deps.enqueue ?? publishFollowPrimaryCommand
  const queued = await enqueue(run.db, run.commandQueue, {
    serverId: spec.serverId,
    actorId: run.params.actorId,
    memberId: spec.memberId,
    payload: spec.payload,
  })
  if (!queued) {
    logFollowPrimaryFailure(`could not queue follow-primary for member ${spec.memberId}`)
  }
}

async function enqueueEnsureSlotsOnNewPrimary(
  run: FollowPrimaryRun,
  eligible: readonly ManagedMemberRow[]
): Promise<void> {
  try {
    await enqueueEnsureSlotsOnNewPrimaryInner(run, eligible)
  } catch (err) {
    logFollowPrimaryFailure(`ensureSlots: ${errorMessage(err)}`)
  }
}

async function enqueueEnsureSlotsOnNewPrimaryInner(
  run: FollowPrimaryRun,
  eligible: readonly ManagedMemberRow[]
): Promise<void> {
  const primary = run.members.find((row) => row.id === run.params.newPrimaryMemberId)
  if (!primary) {
    logFollowPrimaryFailure(`new primary member ${run.params.newPrimaryMemberId} is missing`)
    return
  }
  const ensureSlots = eligible.map((row) => managedMemberSlotName(row.ordinal))
  if (ensureSlots.length === 0) return
  const plan = cancelIdsForMember(run.outstanding, primary.id, primary.id)
  await cancelStaleRepoints(run, plan.cancelIds)
  if (plan.skip) return
  await publishMemberFollowPrimary(run, {
    serverId: primary.serverId,
    memberId: primary.id,
    payload: ensureSlotsPayload({
      managedId: run.params.managedId,
      primary,
      engine: run.engine,
      ensureSlots,
    }),
  })
}

async function enqueueOneReplicaFollowPrimary(
  run: FollowPrimaryRun,
  replica: ManagedMemberRow
): Promise<void> {
  try {
    await enqueueOneReplicaFollowPrimaryInner(run, replica)
  } catch (err) {
    logFollowPrimaryFailure(`member ${replica.id}: ${errorMessage(err)}`)
  }
}

async function enqueueOneReplicaFollowPrimaryInner(
  run: FollowPrimaryRun,
  replica: ManagedMemberRow
): Promise<void> {
  const plan = cancelIdsForMember(run.outstanding, replica.id, run.params.newPrimaryMemberId)
  await cancelStaleRepoints(run, plan.cancelIds)
  if (plan.skip) return
  const resolvePeer = run.deps.resolvePeer ?? resolvePeerToMember
  const primary = run.members.find((row) => row.id === run.params.newPrimaryMemberId)
  if (!primary) {
    logFollowPrimaryFailure(`new primary is not reachable from member ${replica.id}`)
    return
  }
  const peer = await resolvePeer(run.db, replica, primary, run.defaultPort)
  if ('kind' in peer) {
    logFollowPrimaryFailure(`no path to the new primary for member ${replica.id} (${peer.kind})`)
    return
  }
  await publishMemberFollowPrimary(run, {
    serverId: replica.serverId,
    memberId: replica.id,
    payload: replicaFollowPrimaryPayload({
      managedId: run.params.managedId,
      replica,
      newPrimaryMemberId: run.params.newPrimaryMemberId,
      engine: run.engine,
      dial: replicaFollowPrimaryDial(run.params.managedId, peer),
    }),
  })
}

async function connectedIdsForMembers(
  db: Db,
  members: readonly ManagedMemberRow[],
  loadConnected: (db: Db, serverIds: readonly string[]) => Promise<Set<string>>
): Promise<Set<string> | undefined> {
  try {
    return await loadConnected(db, [...new Set(members.map((row) => row.serverId))])
  } catch (err) {
    logFollowPrimaryFailure(`could not load server liveness: ${errorMessage(err)}`)
    return undefined
  }
}

/**
 * Queue slot-ensure on the new primary, then one follow-primary per remaining
 * healthy replica. Never throws.
 */
export async function enqueueFollowPrimaryOnReplicas(
  db: Db,
  commandQueue: CommandQueue | undefined,
  params: FollowPrimaryEnqueueParams,
  deps: FollowPrimaryEnqueueDeps = {}
): Promise<void> {
  if (!commandQueue || isNoopCommandQueue(commandQueue)) return
  try {
    const listMembers = deps.listMembers ?? listManagedMembers
    const members = await listMembers(db, params.managedId)
    const loadEngine = deps.loadEngine ?? loadManagedEnginePort
    const loaded = params.engine ? null : await loadEngine(db, params.managedId)
    const resolved = resolveEngineAndPort(params, loaded)
    if (!resolved) {
      logFollowPrimaryFailure(`no engine port for managed ${params.managedId}`)
      return
    }
    const loadConnected = deps.loadConnectedServerIds ?? loadConnectedServerIds
    const connected = await connectedIdsForMembers(db, members, loadConnected)
    const eligible = membersEligibleToFollowPrimary(members, params.newPrimaryMemberId, connected)
    if (eligible.length === 0) return
    const loadOutstanding = deps.outstandingRepoints ?? outstandingFollowPrimaryRepoints
    const outstanding = await loadOutstanding(db, params.managedId)
    const run: FollowPrimaryRun = {
      db,
      commandQueue,
      params,
      members,
      engine: resolved.engine,
      defaultPort: resolved.defaultPort,
      outstanding,
      deps,
    }
    await enqueueEnsureSlotsOnNewPrimary(run, eligible)
    await forEachSequential(eligible, (replica) => enqueueOneReplicaFollowPrimary(run, replica))
  } catch (err) {
    logFollowPrimaryFailure(errorMessage(err))
  }
}
