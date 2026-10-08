/**
 * After a planned switchover, re-seed the demoted former primary so it
 * returns as a streaming replica without an operator Resync.
 *
 * Automatic failover and disaster recovery must not use this path: the old
 * primary may hold unreplicated writes and stays `needs_resync`.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { command, environment, managed, project, server } from '../../db/schema.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { COMMAND_STATUSES, TERMINAL_COMMAND_STATUSES } from '../commands/types.ts'
import {
  enqueuePreparedManagedApply,
  isPrepareError,
  prepareManagedApplyPayloads,
  preflightManagedApplyInfrastructure,
  type BuildManagedApplyInput,
  type PreparedManagedMemberApply,
} from './apply-prepare.ts'
import { headlessManagedContext } from './headless-context.ts'
import { getManagedEngineSpec } from './index.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import { parseManagedRowOptions } from './options.ts'
import { findInFlightRecovery } from './recovery-records.ts'
import type { RecoveryRecord } from './recovery.ts'
import { parseManagedResidual } from './serialize.ts'

const OUTSTANDING_COMMAND_STATUSES = COMMAND_STATUSES.filter(
  (status) => !TERMINAL_COMMAND_STATUSES.has(status)
)

export type ReseedDemotedPrimarySecrets = {
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
}

export type ReseedDemotedPrimaryDeps = {
  listMembers?: typeof listManagedMembers
  isServerConnected?: (db: Db, serverId: string) => Promise<boolean>
  findInFlightRecovery?: typeof findInFlightRecovery
  hasOutstandingApply?: (db: Db, managedId: string, memberId: string) => Promise<boolean>
  loadCluster?: (db: Db, managedId: string) => Promise<ManagedApplyCluster | null>
  preflight?: typeof preflightManagedApplyInfrastructure
  preparePayloads?: (
    c: Context,
    db: Db,
    input: BuildManagedApplyInput
  ) => ReturnType<typeof prepareManagedApplyPayloads>
  enqueueApply?: (
    c: Context,
    db: Db,
    commandQueue: CommandQueue,
    params: {
      userId: string
      managedId: string
      members: PreparedManagedMemberApply[]
    }
  ) => ReturnType<typeof enqueuePreparedManagedApply>
}

export type ManagedApplyCluster = {
  id: string
  environmentId: string
  organizationId: string
  engine: string
  status: string | null
  metadata: unknown
  options: unknown
  serverId: string | null
}

function skip(reason: string): void {
  compatLogInfo('managed-ha', `managed.member.reseed.auto skipped: ${reason}`)
}

function warn(detail: string): void {
  compatLogWarn('managed-ha', `managed.member.reseed.auto: ${detail}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fenceStopProven(record: RecoveryRecord): boolean {
  return record.metadata.stopApplied === true
}

function contextMemberId(context: unknown): string | null {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    return null
  }
  const memberId = (context as { memberId?: unknown }).memberId
  return typeof memberId === 'string' && memberId.length > 0 ? memberId : null
}

function pendingStandbyMemberIds(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return []
  }
  const pending = (metadata as { pendingStandbyApplies?: unknown }).pendingStandbyApplies
  if (!Array.isArray(pending)) return []
  const ids: string[] = []
  for (const entry of pending) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const memberId = (entry as { memberId?: unknown }).memberId
    if (typeof memberId === 'string' && memberId.length > 0) ids.push(memberId)
  }
  return ids
}

function applyTargetsMember(
  row: { context: unknown; metadata: unknown },
  memberId: string
): boolean {
  if (contextMemberId(row.context) === memberId) return true
  return pendingStandbyMemberIds(row.metadata).includes(memberId)
}

export async function hasOutstandingManagedApplyForMember(
  db: Db,
  managedId: string,
  memberId: string
): Promise<boolean> {
  const rows = await db
    .select({
      id: command.id,
      context: command.context,
      metadata: command.metadata,
    })
    .from(command)
    .where(
      and(
        eq(command.name, 'managed.apply'),
        inArray(command.status, OUTSTANDING_COMMAND_STATUSES),
        sql`${command.context}->>'managedId' = ${managedId}`
      )
    )
  return rows.some((row) => applyTargetsMember(row, memberId))
}

async function memberServerConnected(db: Db, serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ connected: server.isConnected })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.connected === true
}

export async function loadManagedApplyCluster(
  db: Db,
  managedId: string
): Promise<ManagedApplyCluster | null> {
  const [row] = await db
    .select({
      id: managed.id,
      environmentId: managed.environmentId,
      organizationId: project.organizationId,
      engine: managed.engine,
      status: managed.status,
      metadata: managed.metadata,
      options: managed.options,
      serverId: managed.serverId,
    })
    .from(managed)
    .innerJoin(environment, eq(managed.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(managed.id, managedId))
    .limit(1)
  return row ?? null
}

function memberById(
  members: readonly ManagedMemberRow[],
  memberId: string
): ManagedMemberRow | undefined {
  return members.find((row) => row.id === memberId)
}

type SwitchoverReseedReady = {
  source: ManagedMemberRow
  secrets: {
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  }
  commandQueue: CommandQueue
}

function switchoverRecordReady(
  record: RecoveryRecord
): { sourceId: string; targetId: string } | string {
  if (record.kind !== 'switchover') return 'kind is not switchover'
  if (!record.sourcePrimaryMemberId || !record.targetMemberId) {
    return 'source or target member is missing'
  }
  if (!fenceStopProven(record)) return 'fence stop is unproven'
  return { sourceId: record.sourcePrimaryMemberId, targetId: record.targetMemberId }
}

function dispatchReady(
  commandQueue: CommandQueue | undefined,
  secrets: ReseedDemotedPrimarySecrets
): (SwitchoverReseedReady['secrets'] & { commandQueue: CommandQueue }) | null {
  if (!commandQueue || !secrets.secretsConfig || !secrets.dataEncryptionSecrets) {
    return null
  }
  return {
    commandQueue,
    secretsConfig: secrets.secretsConfig,
    dataEncryptionSecrets: secrets.dataEncryptionSecrets,
  }
}

async function evaluateSwitchoverReseed(
  db: Db,
  commandQueue: CommandQueue | undefined,
  secrets: ReseedDemotedPrimarySecrets,
  record: RecoveryRecord,
  deps: ReseedDemotedPrimaryDeps
): Promise<SwitchoverReseedReady | null> {
  const recordReady = switchoverRecordReady(record)
  if (typeof recordReady === 'string') {
    skip(recordReady)
    return null
  }
  const dispatch = dispatchReady(commandQueue, secrets)
  if (!dispatch) {
    skip('secrets or command queue missing')
    return null
  }

  const listMembers = deps.listMembers ?? listManagedMembers
  const members = await listMembers(db, record.managedId)
  const source = memberById(members, recordReady.sourceId)
  const target = memberById(members, recordReady.targetId)
  if (source?.role !== 'replica' || source.status !== 'needs_resync') {
    skip('source member is not a needs_resync replica')
    return null
  }
  if (target?.role !== 'primary') {
    skip('target member is not primary')
    return null
  }

  const connected = deps.isServerConnected ?? memberServerConnected
  if (!(await connected(db, source.serverId))) {
    skip(`source server ${source.serverId} is offline`)
    return null
  }

  const inflight = await (deps.findInFlightRecovery ?? findInFlightRecovery)(db, record.managedId)
  if (inflight && inflight.id !== record.id) {
    skip('another recovery is in flight')
    return null
  }

  const outstanding = deps.hasOutstandingApply ?? hasOutstandingManagedApplyForMember
  if (await outstanding(db, record.managedId, source.id)) {
    skip(`member ${source.id} already has a managed.apply queued`)
    return null
  }

  return {
    source,
    secrets: {
      secretsConfig: dispatch.secretsConfig,
      dataEncryptionSecrets: dispatch.dataEncryptionSecrets,
    },
    commandQueue: dispatch.commandQueue,
  }
}

async function enqueueSwitchoverReseedApply(
  db: Db,
  ready: SwitchoverReseedReady,
  record: RecoveryRecord,
  actorId: string,
  deps: ReseedDemotedPrimaryDeps
): Promise<void> {
  const loadCluster = deps.loadCluster ?? loadManagedApplyCluster
  const cluster = await loadCluster(db, record.managedId)
  const primaryServerId = cluster?.serverId
  if (!cluster || !primaryServerId) {
    skip('managed row or primary server is missing')
    return
  }

  const spec = getManagedEngineSpec(cluster.engine)
  if (!spec) {
    skip(`engine ${cluster.engine} is unrecognized`)
    return
  }
  const options = parseManagedRowOptions(spec, cluster.options)
  if (!options) {
    skip('managed options are invalid')
    return
  }

  const c = headlessManagedContext(ready.secrets)
  const preflight = deps.preflight ?? preflightManagedApplyInfrastructure
  const infra = await preflight(c, db, {
    serverId: primaryServerId,
  })
  if (infra) {
    skip(`apply preflight ${infra.kind}`)
    return
  }

  const residual = parseManagedResidual(cluster.metadata)
  const prepare = deps.preparePayloads ?? prepareManagedApplyPayloads
  const prepared = await prepare(c, db, {
    managedRow: cluster,
    spec,
    settings: options.settings,
    databases: options.databases,
    serverId: primaryServerId,
    environmentId: cluster.environmentId,
    organizationId: cluster.organizationId,
    rootUsername: residual.rootUsername ?? spec.rootUsername,
    forceResyncMemberIds: [ready.source.id],
  })
  if (isPrepareError(prepared)) {
    skip(`prepare failed (${prepared.kind})`)
    return
  }

  const enqueue = deps.enqueueApply ?? enqueuePreparedManagedApply
  const enqueued = await enqueue(c, db, ready.commandQueue, {
    userId: actorId,
    managedId: cluster.id,
    members: prepared.members,
  })
  if (enqueued instanceof Response) {
    warn(`enqueue returned ${enqueued.status}`)
    return
  }

  compatLogInfo(
    'managed-ha',
    `managed.member.reseed.auto managedId=${cluster.id} memberId=${ready.source.id} recoveryId=${record.id}`
  )
}

/**
 * Best-effort forced re-seed of the demoted switchover primary. Never throws.
 */
export async function reseedDemotedPrimaryAfterSwitchover(
  db: Db,
  commandQueue: CommandQueue | undefined,
  secrets: ReseedDemotedPrimarySecrets,
  record: RecoveryRecord,
  actorId: string,
  deps: ReseedDemotedPrimaryDeps = {}
): Promise<void> {
  try {
    const ready = await evaluateSwitchoverReseed(db, commandQueue, secrets, record, deps)
    if (!ready) return
    await enqueueSwitchoverReseedApply(db, ready, record, actorId, deps)
  } catch (err) {
    warn(errorMessage(err))
  }
}
