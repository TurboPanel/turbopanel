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
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { getResolveFleetPresence } from '../../platform/ports/fleet-presence.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { hasLiveBackupCommand } from '../commands/command-records.ts'
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
import { loadManagedOptions } from './options.ts'
import { findInFlightRecovery, updateRecoveryLocked } from './recovery-records.ts'
import type { RecoveryRecord } from './recovery.ts'
import { parseManagedResidual } from './serialize.ts'
import { engineNeedsSwitchoverGtidProof } from './switchover-catchup.ts'
import type { ManagedEngineCode } from './types.ts'

const OUTSTANDING_COMMAND_STATUSES = COMMAND_STATUSES.filter(
  (status) => !TERMINAL_COMMAND_STATUSES.has(status)
)

export type ReseedDemotedPrimarySecrets = {
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
  /** Live daemon connections; absent = fall back to the stored column. */
  registry?: DaemonCellRegistry
}

export type ReseedDemotedPrimaryDeps = {
  listMembers?: typeof listManagedMembers
  /** True when every listed server is connected right now. */
  serversConnected?: (db: Db, serverIds: string[]) => Promise<boolean>
  findInFlightRecovery?: typeof findInFlightRecovery
  hasOutstandingApply?: (db: Db, managedId: string, memberId: string) => Promise<boolean>
  /** True while a backup or restore of this database is queued or running. */
  hasLiveBackup?: (db: Db, managedId: string) => Promise<boolean>
  /** Writes the outcome on the recovery row so the operator can see it. */
  recordOutcome?: (db: Db, recoveryId: string, outcome: ReseedOutcome) => Promise<void>
  loadCluster?: (db: Db, managedId: string) => Promise<ManagedApplyCluster | null>
  preflight?: typeof preflightManagedApplyInfrastructure
  loadOptions?: typeof loadManagedOptions
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

export type ReseedOutcome = {
  state: 'queued' | 'skipped' | 'failed'
  note: string
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

type Skipped = { skipped: string }

function skip(reason: string): Skipped {
  compatLogInfo('managed-ha', `managed.member.reseed.auto skipped: ${reason}`)
  return { skipped: reason }
}

function isSkipped(value: unknown): value is Skipped {
  return typeof value === 'object' && value !== null && 'skipped' in value
}

async function recordReseedOutcome(
  db: Db,
  recoveryId: string,
  outcome: ReseedOutcome
): Promise<void> {
  await updateRecoveryLocked(db, recoveryId, (current) => ({
    metadata: {
      ...current.metadata,
      reseedState: outcome.state,
      reseedNote: outcome.note.slice(0, 300),
    },
  }))
}

function warn(detail: string): void {
  compatLogWarn('managed-ha', `managed.member.reseed.auto: ${detail}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

async function storedServersConnected(db: Db, serverIds: string[]): Promise<boolean> {
  const rows = await db
    .select({ id: server.id, connected: server.isConnected })
    .from(server)
    .where(inArray(server.id, serverIds))
  const connected = new Set(rows.filter((row) => row.connected === true).map((row) => row.id))
  return serverIds.every((id) => connected.has(id))
}

/**
 * The route asks the live daemon registry (`assertTargetServerOnline`); the
 * stored column lags a reconnect, so use the registry whenever there is one.
 */
async function liveServersConnected(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverIds: string[]
): Promise<boolean> {
  if (!registry) return storedServersConnected(db, serverIds)
  const presence = await getResolveFleetPresence()(db, registry, serverIds)
  return serverIds.every((id) => presence.get(id)?.connected === true)
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
  cluster: ManagedApplyCluster
  secrets: {
    secretsConfig: SecretsConfig
    dataEncryptionSecrets: DerivedSecretsConfig
  }
  commandQueue: CommandQueue
}

function switchoverRecordReady(
  record: RecoveryRecord,
  engine: string
): { sourceId: string; targetId: string } | Skipped {
  if (record.kind !== 'switchover') return skip('kind is not switchover')
  if (!record.sourcePrimaryMemberId || !record.targetMemberId) {
    return skip('source or target member is missing')
  }
  // Drain AND stop proven. A stop alone lets an operator switchover go on.
  if (record.metadata.fenced !== true) return skip('old primary is not proven fenced')
  if (record.metadata.forced === true) return skip('switchover was forced')
  // Nothing may be missing from the new primary. Postgres: a fresh zero-lag
  // streaming reading taken before the fence. MySQL and MariaDB: the old
  // primary's final GTID set was captured when it stopped, and the promote
  // only succeeds once the new primary has applied all of it.
  const proven = engineNeedsSwitchoverGtidProof(engine as ManagedEngineCode)
    ? Boolean(record.metadata.switchoverRequiredGtidSet)
    : record.metadata.targetCaughtUp === true
  if (!proven) {
    return skip(
      `new primary was not proven caught up (${record.metadata.targetCaughtUpBasis ?? 'no proof'})`
    )
  }
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
): Promise<SwitchoverReseedReady | Skipped> {
  if (record.kind !== 'switchover') return skip('kind is not switchover')
  // A retried promote result must not queue a second wipe.
  if (record.metadata.reseedState !== undefined) return skip('re-seed already decided')

  const cluster = await (deps.loadCluster ?? loadManagedApplyCluster)(db, record.managedId)
  if (!cluster) return skip('managed row is missing')

  const recordReady = switchoverRecordReady(record, cluster.engine)
  if (isSkipped(recordReady)) return recordReady
  const dispatch = dispatchReady(commandQueue, secrets)
  if (!dispatch) return skip('secrets or command queue missing')

  const listMembers = deps.listMembers ?? listManagedMembers
  const members = await listMembers(db, record.managedId)
  const source = memberById(members, recordReady.sourceId)
  const target = memberById(members, recordReady.targetId)
  if (source?.role !== 'replica' || source.status !== 'needs_resync') {
    return skip('source member is not a needs_resync replica')
  }
  // The new primary must be a healthy, promoted member: its data is the only
  // copy the wipe leaves behind.
  if (target?.role !== 'primary') return skip('target member is not primary')
  if (target.status !== 'ready')
    return skip(`new primary is ${target.status ?? 'unknown'}, not ready`)

  // Both ends must be reachable now: the apply goes to the new primary's
  // server and the wipe happens on the old primary's.
  const connected =
    deps.serversConnected ??
    ((d: Db, ids: string[]) => liveServersConnected(d, secrets.registry, ids))
  if (!(await connected(db, [...new Set([source.serverId, target.serverId])]))) {
    return skip('the old or the new primary server is offline')
  }

  const inflight = await (deps.findInFlightRecovery ?? findInFlightRecovery)(db, record.managedId)
  if (inflight && inflight.id !== record.id) return skip('another recovery is in flight')

  // The host takes one backup or restore at a time, and a re-seed under a
  // running backup or restore would pull the data away from it.
  if (await (deps.hasLiveBackup ?? hasLiveBackupCommand)(db, record.managedId)) {
    return skip('a backup or restore is running')
  }

  const outstanding = deps.hasOutstandingApply ?? hasOutstandingManagedApplyForMember
  if (await outstanding(db, record.managedId, source.id)) {
    return skip(`member ${source.id} already has a managed.apply queued`)
  }

  return {
    source,
    cluster,
    secrets: {
      secretsConfig: dispatch.secretsConfig,
      dataEncryptionSecrets: dispatch.dataEncryptionSecrets,
    },
    commandQueue: dispatch.commandQueue,
  }
}

/** Queues the forced re-seed; returns why nothing was queued, or null when it was. */
async function enqueueSwitchoverReseedApply(
  db: Db,
  ready: SwitchoverReseedReady,
  record: RecoveryRecord,
  actorId: string,
  deps: ReseedDemotedPrimaryDeps
): Promise<Skipped | { failed: string } | null> {
  const { cluster } = ready
  const primaryServerId = cluster.serverId
  if (!primaryServerId) return skip('primary server is missing')

  const spec = getManagedEngineSpec(cluster.engine)
  if (!spec) return skip(`engine ${cluster.engine} is unrecognized`)
  const options = await (deps.loadOptions ?? loadManagedOptions)(db, spec, {
    id: cluster.id,
    options: cluster.options,
  })
  if (!options) return skip('managed options are invalid')

  const c = headlessManagedContext(ready.secrets)
  const preflight = deps.preflight ?? preflightManagedApplyInfrastructure
  const infra = await preflight(c, db, {
    serverId: primaryServerId,
  })
  if (infra) return skip(`apply preflight ${infra.kind}`)

  const residual = parseManagedResidual(cluster.metadata)
  const prepare = deps.preparePayloads ?? prepareManagedApplyPayloads
  const prepared = await prepare(c, db, {
    managedRow: cluster,
    spec,
    settings: options.settings,
    databases: options.databases,
    ownerRoleDatabases: options.ownerRoleDatabases,
    databaseOwners: options.databaseOwners,
    serverId: primaryServerId,
    environmentId: cluster.environmentId,
    organizationId: cluster.organizationId,
    rootUsername: residual.rootUsername ?? spec.rootUsername,
    forceResyncMemberIds: [ready.source.id],
  })
  if (isPrepareError(prepared)) return skip(`prepare failed (${prepared.kind})`)

  const enqueue = deps.enqueueApply ?? enqueuePreparedManagedApply
  const enqueued = await enqueue(c, db, ready.commandQueue, {
    userId: actorId,
    managedId: cluster.id,
    members: prepared.members,
  })
  if (enqueued instanceof Response) {
    warn(`enqueue returned ${enqueued.status}`)
    return { failed: `the re-seed could not be queued (${enqueued.status})` }
  }

  const failedResult = enqueued.find((row) => row.status === 'failed')
  if (failedResult) {
    warn(`apply for member ${failedResult.memberId} did not queue`)
    return { failed: failedResult.error ?? 'the re-seed apply did not queue' }
  }

  compatLogInfo(
    'managed-ha',
    `managed.member.reseed.auto managedId=${cluster.id} memberId=${ready.source.id} recoveryId=${record.id}`
  )
  return null
}

/**
 * Best-effort forced re-seed of the demoted switchover primary. Never throws.
 * The outcome lands on the recovery row (`reseedState`, `reseedNote`) so an
 * operator can see why a former primary was left `needs_resync`.
 */
export async function reseedDemotedPrimaryAfterSwitchover(
  db: Db,
  commandQueue: CommandQueue | undefined,
  secrets: ReseedDemotedPrimarySecrets,
  record: RecoveryRecord,
  actorId: string,
  deps: ReseedDemotedPrimaryDeps = {}
): Promise<void> {
  if (record.kind !== 'switchover') return
  let outcome: ReseedOutcome
  try {
    const ready = await evaluateSwitchoverReseed(db, commandQueue, secrets, record, deps)
    if (isSkipped(ready)) {
      outcome = { state: 'skipped', note: ready.skipped }
    } else {
      const result = await enqueueSwitchoverReseedApply(db, ready, record, actorId, deps)
      if (result === null) {
        outcome = { state: 'queued', note: 'forced re-seed of the former primary queued' }
      } else if ('failed' in result) {
        outcome = { state: 'failed', note: result.failed }
      } else {
        outcome = { state: 'skipped', note: result.skipped }
      }
    }
  } catch (err) {
    warn(errorMessage(err))
    outcome = { state: 'failed', note: errorMessage(err) }
  }
  if (outcome.state === 'skipped' && outcome.note === 're-seed already decided') return
  try {
    await (deps.recordOutcome ?? recordReseedOutcome)(db, record.id, outcome)
  } catch (err) {
    warn(`could not record the outcome: ${errorMessage(err)}`)
  }
}
