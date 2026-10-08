/**
 * After a promote or recover, remaining replicas follow the new primary
 * (`managed.ha.failover` phase `repoint`) without a full Resync.
 *
 * Failures are logged and left to health checks; they must never fail the
 * promote.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, managed } from '../../db/schema.ts'
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
  resolvePeersForMember,
} from './members.ts'
import type { ManagedEngineCode } from './types.ts'

const FOLLOW_PRIMARY_TTL_MS = 600_000
const SKIP_FOLLOW_STATUSES = new Set(['needs_resync', 'failed'])
const OUTSTANDING_COMMAND_STATUSES = COMMAND_STATUSES.filter(
  (status) => !TERMINAL_COMMAND_STATUSES.has(status)
)

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

export type FollowPrimaryEnqueueDeps = {
  listMembers?: typeof listManagedMembers
  resolvePeers?: typeof resolvePeersForMember
  loadDefaultPort?: (db: Db, managedId: string) => Promise<number | null>
  outstandingMemberIds?: (db: Db, managedId: string) => Promise<Set<string>>
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
  newPrimaryMemberId: string
): ManagedMemberRow[] {
  return members.filter((row) => {
    if (row.id === newPrimaryMemberId || row.role === 'primary') return false
    return !SKIP_FOLLOW_STATUSES.has(row.status ?? '')
  })
}

async function loadEngineDefaultPort(db: Db, managedId: string): Promise<number | null> {
  const [row] = await db
    .select({ engine: managed.engine })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  if (!row?.engine) return null
  return getManagedEngineSpec(row.engine)?.defaultPort ?? null
}

async function outstandingFollowPrimaryMemberIds(db: Db, managedId: string): Promise<Set<string>> {
  const rows = await db
    .select({ context: command.context })
    .from(command)
    .where(
      and(
        eq(command.name, 'managed.ha.failover'),
        inArray(command.status, OUTSTANDING_COMMAND_STATUSES),
        sql`${command.context}->>'managedId' = ${managedId}`
      )
    )
  const ids = new Set<string>()
  for (const row of rows) {
    const context = row.context
    if (typeof context !== 'object' || context === null || Array.isArray(context)) continue
    const memberId = (context as { memberId?: unknown }).memberId
    if (typeof memberId === 'string' && memberId.length > 0) ids.add(memberId)
  }
  return ids
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

function followPrimaryPayload(params: {
  managedId: string
  replica: ManagedMemberRow
  newPrimaryMemberId: string
  engine?: ManagedEngineCode
  dial: ReplicaFollowPrimaryDial
}): ManagedHaFailoverCommandPayload {
  return {
    managedId: params.managedId,
    sourceMemberId: params.replica.id,
    targetMemberId: params.newPrimaryMemberId,
    phase: 'repoint',
    targetHost: params.dial.targetHost,
    targetPort: params.dial.targetPort,
    ...(params.engine ? { engine: params.engine } : {}),
    ...(params.dial.targetHostaddr ? { targetHostaddr: params.dial.targetHostaddr } : {}),
  }
}

async function enqueueOneReplicaFollowPrimary(
  db: Db,
  commandQueue: CommandQueue,
  params: FollowPrimaryEnqueueParams,
  replica: ManagedMemberRow,
  members: readonly ManagedMemberRow[],
  defaultPort: number,
  outstanding: ReadonlySet<string>,
  deps: FollowPrimaryEnqueueDeps
): Promise<void> {
  if (outstanding.has(replica.id)) return
  try {
    await enqueueOneReplicaFollowPrimaryInner(
      db,
      commandQueue,
      params,
      replica,
      members,
      defaultPort,
      deps
    )
  } catch (err) {
    logFollowPrimaryFailure(`member ${replica.id}: ${errorMessage(err)}`)
  }
}

async function enqueueOneReplicaFollowPrimaryInner(
  db: Db,
  commandQueue: CommandQueue,
  params: FollowPrimaryEnqueueParams,
  replica: ManagedMemberRow,
  members: readonly ManagedMemberRow[],
  defaultPort: number,
  deps: FollowPrimaryEnqueueDeps
): Promise<void> {
  const resolvePeers = deps.resolvePeers ?? resolvePeersForMember
  const peers = await resolvePeers(db, members, replica, defaultPort)
  if (!Array.isArray(peers)) {
    logFollowPrimaryFailure(`no path to the new primary for member ${replica.id} (${peers.kind})`)
    return
  }
  const primaryPeer = peers.find((peer) => peer.memberId === params.newPrimaryMemberId)
  if (!primaryPeer) {
    logFollowPrimaryFailure(`new primary is not reachable from member ${replica.id}`)
    return
  }
  const enqueue = deps.enqueue ?? publishFollowPrimaryCommand
  const queued = await enqueue(db, commandQueue, {
    serverId: replica.serverId,
    actorId: params.actorId,
    memberId: replica.id,
    payload: followPrimaryPayload({
      managedId: params.managedId,
      replica,
      newPrimaryMemberId: params.newPrimaryMemberId,
      engine: params.engine,
      dial: replicaFollowPrimaryDial(params.managedId, primaryPeer),
    }),
  })
  if (!queued) {
    logFollowPrimaryFailure(`could not queue follow-primary for member ${replica.id}`)
  }
}

/**
 * Queue one follow-primary command per remaining healthy replica. Never throws.
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
    const eligible = membersEligibleToFollowPrimary(members, params.newPrimaryMemberId)
    if (eligible.length === 0) return
    const loadDefaultPort = deps.loadDefaultPort ?? loadEngineDefaultPort
    const defaultPort = await loadDefaultPort(db, params.managedId)
    if (defaultPort === null) {
      logFollowPrimaryFailure(`no engine port for managed ${params.managedId}`)
      return
    }
    const loadOutstanding = deps.outstandingMemberIds ?? outstandingFollowPrimaryMemberIds
    const outstanding = await loadOutstanding(db, params.managedId)
    await forEachSequential(eligible, (replica) =>
      enqueueOneReplicaFollowPrimary(
        db,
        commandQueue,
        params,
        replica,
        members,
        defaultPort,
        outstanding,
        deps
      )
    )
  } catch (err) {
    logFollowPrimaryFailure(errorMessage(err))
  }
}
