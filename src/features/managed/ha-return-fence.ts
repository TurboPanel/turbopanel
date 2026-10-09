/**
 * A database member that comes back after another member took over must never
 * serve writes as a second primary. Two entry points, both keyed on the ROLE
 * the control plane holds for the member, never on how it was replaced:
 *
 * 1. `handleBootHoldReport`: the daemon of a host that restarted without a
 *    clean shutdown stopped the primaries it runs and reports each one
 *    (`managed-ha-event`, `detector: 'boot-hold'`, feature
 *    `managed-ha-boot-hold-v1`). The control plane is the only party that
 *    knows whether it was replaced:
 *    - still the primary and nothing is in flight: answer with
 *      `managed.lifecycle start` (the daemon releases its hold when the start
 *      succeeds). The cluster's recovery history is checked first: an
 *      unfinished failover, or one that needs an operator, keeps it stopped.
 *    - no longer the primary: leave it stopped (it is `needs_resync`; the
 *      operator resyncs it from the database page) and note it on the
 *      recovery row.
 * 2. `runReturnFenceSweep`: a demoted member (`needs_resync`) whose server is
 *    connected again gets one `managed.lifecycle stop` per reconnect. This
 *    covers a host that did not reboot (so there was no boot hold) and any
 *    way of being replaced, manual switchover included. The command carries
 *    `returnFence` so the consumer does not project the stop onto the member
 *    or the cluster (it would overwrite `needs_resync`, which is the only
 *    thing keeping the old data from being started). The stop payload also
 *    carries `demoted: true` so the daemon keeps a durable marker and stops
 *    the engine again if it is started by hand.
 *
 * Both only ever stop or start; neither promotes, and neither resyncs: wiping
 * the old primary's data is a deliberate operator action (its un-replicated
 * writes exist nowhere else).
 */

import { and, eq, isNull, ne, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { managed, replica, server } from '../../db/schema.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  createCommandRecord,
  getCommandRecord,
  transitionCommand,
} from '../commands/command-records.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import { findInFlightRecovery, findLatestRecovery, updateRecovery } from './recovery-records.ts'
import type { RecoveryRecord } from './recovery.ts'
import type { ManagedEngineCode } from './types.ts'

/** `managed-ha-event` detector name of the daemon's boot hold. */
export const BOOT_HOLD_DETECTOR = 'boot-hold'

const RETURN_FENCE_TTL_MS = 120_000
const BOOT_HOLD_RELEASE_TTL_MS = 120_000

/** Demoted members looked at per tick. */
export const RETURN_FENCE_SWEEP_CAP = 25

export type BootHoldAnswer = 'released' | 'kept' | 'wait' | 'ignored'

/** Reads and writes behind `handleBootHoldReport` (test seams; production wires the defaults). */
export type BootHoldDeps = {
  listMembers: (db: Db, managedId: string) => Promise<ManagedMemberRow[]>
  inFlightRecovery: (db: Db, managedId: string) => Promise<RecoveryRecord | null>
  latestRecovery: (db: Db, managedId: string) => Promise<RecoveryRecord | null>
  enqueueLifecycle: typeof enqueueLifecycle
  noteReplacedMemberFenced: typeof noteReplacedMemberFenced
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function enqueueLifecycle(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    member: ManagedMemberRow
    action: 'start' | 'stop'
    engine: ManagedEngineCode
    ttlMs: number
    metadata: Record<string, unknown>
    /** Fence stop of a replaced writer; omitted on boot-hold start. */
    demoted?: boolean
  }
): Promise<string | null> {
  const record = await createCommandRecord(db, {
    serverId: params.member.serverId,
    actorType: 'system',
    actorId: params.member.serverId,
    type: 'managed.lifecycle',
    payload: {
      managedId: params.member.managedId,
      action: params.action,
      memberId: params.member.id,
      role: params.member.role,
      engine: params.engine,
      ...(params.demoted === true ? { demoted: true } : {}),
    },
    expiresAt: new Date(Date.now() + params.ttlMs).toISOString(),
    metadata: params.metadata,
  })
  try {
    await commandQueue.enqueue({
      commandId: record.id,
      serverId: record.serverId,
      type: 'managed.lifecycle',
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
  return record.id
}

/**
 * The reporting server hosts the member it names (the session's server id,
 * never a payload field), so a daemon can only ever speak for its own members.
 */
export async function handleBootHoldReport(
  db: Db,
  input: {
    managedId: string
    engine: ManagedEngineCode
    sourceMemberId: string | undefined
    reporterServerId: string
    commandQueue: CommandQueue | undefined
  },
  seams: Partial<BootHoldDeps> = {}
): Promise<BootHoldAnswer> {
  const deps: BootHoldDeps = {
    listMembers: listManagedMembers,
    inFlightRecovery: findInFlightRecovery,
    latestRecovery: findLatestRecovery,
    enqueueLifecycle,
    noteReplacedMemberFenced,
    ...seams,
  }
  const members = await deps.listMembers(db, input.managedId)
  const member = members.find((row) => row.id === input.sourceMemberId)
  if (member?.serverId !== input.reporterServerId) {
    compatLogWarn(
      'managed-ha',
      `boot-hold report for ${input.managedId} ignored: member ${input.sourceMemberId} is not on server ${input.reporterServerId}`
    )
    return 'ignored'
  }
  if (await deps.inFlightRecovery(db, input.managedId)) return 'wait'

  if (member.role !== 'primary') {
    await deps.noteReplacedMemberFenced(db, input.managedId, member)
    return 'kept'
  }
  const latest = await deps.latestRecovery(db, input.managedId)
  // Only this member's own failed failover holds it; an older failed row about another member
  // (or a manual recovery) must not keep a still-primary member stopped forever.
  if (
    latest?.state === 'failed' &&
    latest.metadata.needsOperator &&
    latest.sourcePrimaryMemberId === member.id
  ) {
    compatLogWarn(
      'managed-ha',
      `boot-hold report for ${input.managedId}: the last recovery needs an operator, member ${member.id} stays stopped`
    )
    return 'kept'
  }
  if (!input.commandQueue) return 'wait'
  const commandId = await deps.enqueueLifecycle(db, input.commandQueue, {
    member,
    action: 'start',
    engine: input.engine,
    ttlMs: BOOT_HOLD_RELEASE_TTL_MS,
    metadata: { bootHoldRelease: true },
  })
  if (!commandId) return 'wait'
  compatLogInfo(
    'managed-ha',
    `boot-hold: member ${member.id} of ${input.managedId} is still the primary, start queued`
  )
  return 'released'
}

/** The replaced member is stopped and `needs_resync`: say so on its recovery row. */
async function noteReplacedMemberFenced(
  db: Db,
  managedId: string,
  member: ManagedMemberRow
): Promise<void> {
  if (member.status !== 'needs_resync') {
    await db
      .update(replica)
      .set({ status: 'needs_resync', updatedAt: new Date().toISOString() })
      .where(and(eq(replica.id, member.id), eq(replica.managedId, managedId)))
  }
  const latest = await findLatestRecovery(db, managedId)
  if (
    latest?.sourcePrimaryMemberId === member.id &&
    latest.metadata.fenceBasis === 'host-loss-attested' &&
    latest.metadata.returnFence !== 'confirmed'
  ) {
    await updateRecovery(db, latest.id, {
      metadata: { ...latest.metadata, returnFence: 'confirmed' },
    })
  }
}

type DemotedMember = {
  member: ManagedMemberRow
  engine: string | null
  serverStatusChangedAt: string | null
}

export async function listDemotedOnConnectedServers(
  db: Db,
  limit: number
): Promise<DemotedMember[]> {
  const rows = await db
    .select({
      id: replica.id,
      managedId: replica.managedId,
      serverId: replica.serverId,
      role: replica.role,
      replicaClass: replica.replicaClass,
      readEligible: replica.isReadEligible,
      ordinal: replica.ordinal,
      replicationTransport: replica.replicationTransport,
      privatePort: replica.privatePort,
      status: replica.status,
      metadata: replica.metadata,
      options: replica.options,
      createdAt: replica.createdAt,
      updatedAt: replica.updatedAt,
      engine: managed.engine,
      serverStatusChangedAt: server.statusChangedAt,
    })
    .from(replica)
    .innerJoin(server, eq(server.id, replica.serverId))
    .innerJoin(managed, eq(managed.id, replica.managedId))
    .where(
      and(
        eq(replica.role, 'replica'),
        eq(replica.status, 'needs_resync'),
        eq(server.isConnected, true),
        // A resync or another operation is running on the cluster: leave it be.
        or(isNull(managed.status), ne(managed.status, 'applying'))
      )
    )
    .limit(limit)
  return rows.map(({ engine, serverStatusChangedAt, ...member }) => ({
    member,
    engine,
    serverStatusChangedAt,
  }))
}

/** What the member row says about its last return-fence stop. */
type ReturnFenceNote = { commandId: string; at: string; attempts: number }

function readReturnFenceNote(metadata: unknown): ReturnFenceNote | null {
  const fence = isRecord(metadata) && isRecord(metadata.returnFence) ? metadata.returnFence : null
  if (!fence || typeof fence.at !== 'string' || typeof fence.commandId !== 'string') return null
  return {
    commandId: fence.commandId,
    at: fence.at,
    attempts: typeof fence.attempts === 'number' ? fence.attempts : 1,
  }
}

/** Stamp the fence on the member row so one reconnect gets one stop (plus retries). */
async function noteReturnFence(
  db: Db,
  member: ManagedMemberRow,
  note: ReturnFenceNote
): Promise<void> {
  const base = isRecord(member.metadata) ? { ...member.metadata } : {}
  base.returnFence = note
  await db
    .update(replica)
    .set({ metadata: base, updatedAt: note.at })
    .where(eq(replica.id, member.id))
}

/** A stop that failed is retried a few times per reconnect, never for ever. */
export const RETURN_FENCE_MAX_ATTEMPTS = 5

const FAILED_COMMAND_STATUSES: ReadonlySet<string> = new Set(['failed', 'timed_out', 'cancelled'])

/**
 * `send`: this reconnect has not been fenced yet. `retry`: it was, but the stop
 * failed (and fewer than {@link RETURN_FENCE_MAX_ATTEMPTS} were tried).
 * `skip`: nothing to do.
 */
export async function returnFenceAction(
  db: Db,
  metadata: unknown,
  serverStatusChangedAt: string | null,
  loadCommand: (db: Db, commandId: string) => Promise<{ status: string } | null> = getCommandRecord
): Promise<{ action: 'send' | 'skip' } | { action: 'retry'; attempts: number }> {
  const note = readReturnFenceNote(metadata)
  if (!note) return { action: 'send' }
  if (serverStatusChangedAt && Date.parse(serverStatusChangedAt) > Date.parse(note.at)) {
    return { action: 'send' }
  }
  if (note.attempts >= RETURN_FENCE_MAX_ATTEMPTS) return { action: 'skip' }
  const record = await loadCommand(db, note.commandId)
  if (record && FAILED_COMMAND_STATUSES.has(record.status)) {
    return { action: 'retry', attempts: note.attempts + 1 }
  }
  return { action: 'skip' }
}

/** Reads and writes behind `runReturnFenceSweep` (test seams; production wires the defaults). */
export type ReturnFenceSweepDeps = {
  nowMs?: () => number
  listDemoted?: typeof listDemotedOnConnectedServers
  action?: typeof returnFenceAction
  enqueueLifecycle?: typeof enqueueLifecycle
  noteReturnFence?: typeof noteReturnFence
}

/**
 * One tick: every demoted member on a server that is connected again gets a
 * stop, once per reconnect. Never throws.
 */
export async function runReturnFenceSweep(
  db: Db,
  commandQueue: CommandQueue,
  deps: ReturnFenceSweepDeps = {}
): Promise<string[]> {
  const fenced: string[] = []
  let demoted: DemotedMember[]
  try {
    demoted = await (deps.listDemoted ?? listDemotedOnConnectedServers)(db, RETURN_FENCE_SWEEP_CAP)
  } catch (error) {
    compatLogWarn('managed-ha', `return fence sweep could not list members: ${String(error)}`)
    return fenced
  }
  await forEachSequential(demoted, async ({ member, engine, serverStatusChangedAt }) => {
    try {
      if (!engine) return
      const decision = await (deps.action ?? returnFenceAction)(
        db,
        member.metadata,
        serverStatusChangedAt
      )
      if (decision.action === 'skip') return
      const commandId = await (deps.enqueueLifecycle ?? enqueueLifecycle)(db, commandQueue, {
        member,
        action: 'stop',
        engine: engine as ManagedEngineCode,
        ttlMs: RETURN_FENCE_TTL_MS,
        metadata: { returnFence: true },
        demoted: true,
      })
      if (!commandId) return
      await (deps.noteReturnFence ?? noteReturnFence)(db, member, {
        commandId,
        at: new Date((deps.nowMs ?? Date.now)()).toISOString(),
        attempts: decision.action === 'retry' ? decision.attempts : 1,
      })
      fenced.push(member.id)
      compatLogInfo(
        'managed-ha',
        `return fence: stop queued for demoted member ${member.id} of ${member.managedId} (server is back)`
      )
    } catch (error) {
      compatLogWarn('managed-ha', `return fence for member ${member.id} failed: ${String(error)}`)
    }
  })
  return fenced
}
