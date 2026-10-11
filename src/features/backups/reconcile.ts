/**
 * Push a server's backup policies to its host as `server.backups.reconcile`.
 *
 * The payload is the **complete** set for the server (the same rule as
 * `server.principals.reconcile`): a policy absent from it is one the host no
 * longer runs, so its timer goes. A managed policy's host is its engine's
 * `managed.server_id`, and a copy policy's is its copy's `copy.server_id`,
 * both resolved here at push time, so moving an engine or a copy only needs
 * both servers reconciled — nothing on the policy row changes.
 *
 * Every enqueue here is best-effort and **never throws**: it runs after the
 * write that changed the set, and that write has already succeeded. A server
 * that misses one (offline, queue down) is caught by
 * {@link runBackupsReconcileSweep}, which pushes once after each reconnect.
 */

import { and, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  environment,
  retention,
  managed,
  principal,
  storage,
  storageCopy,
} from '../../db/schema.ts'
import {
  type BackupPolicyWireEntry,
  parseBackupsReconcilePayload,
} from '../../contracts/commands/schemas.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import { getManagedBackupDescriptor, getManagedEngineSpec } from '../managed/index.ts'
import { defaultBackupDatabase } from '../managed/default-backup-database.ts'
import { parseManagedRowOptions } from '../managed/options.ts'
import { managedHasBackupPolicies } from './policy-records.ts'
import { translateBackupSchedule } from './schedules.ts'
import { COPY_TARGET_SELECT, type CopyTargetRow, resolveCopyBackupSource } from './copy-targets.ts'

export const BACKUPS_RECONCILE_COMMAND = 'server.backups.reconcile'

/** Servers one sweep tick reconciles at most. */
const BACKUPS_RECONCILE_SWEEP_CAP = 100

export type BackupsReconcileActor = {
  actorType: string
  actorId: string
}

export type BackupsReconcileOutcome = {
  /** Servers a command was queued for. */
  queuedServerIds: string[]
  /** Servers whose command could not be built or queued. */
  failedServerIds: string[]
}

type ManagedPolicyRow = {
  id: string
  managedId: string | null
  schedule: string
  timezone: string | null
  retentionKeep: number
  isEnabled: boolean
  engine: string
  /** `managed.options`, as stored: it lists the instance's databases. */
  options?: unknown
}

/**
 * The database a scheduled run dumps: the same default a manual backup picks
 * (the first non-system database). Absent when the stored options cannot say,
 * so the daemon falls back to its engine default rather than the run failing here.
 */
function scheduledBackupDatabase(row: ManagedPolicyRow): string | undefined {
  const spec = getManagedEngineSpec(row.engine)
  const options = spec ? parseManagedRowOptions(spec, row.options) : null
  if (!options) return undefined
  return defaultBackupDatabase(options.databases, row.engine) ?? undefined
}

function toWireEntry(row: ManagedPolicyRow): BackupPolicyWireEntry | null {
  const descriptor = getManagedBackupDescriptor(row.engine)
  if (!descriptor || !row.managedId) return null
  const onCalendar = translateBackupSchedule(row.schedule, row.timezone)
  if (!onCalendar.ok) {
    // Validated on write; only a schedule stored before a rule changed gets here.
    compatLogWarn(
      'backups',
      `backup policy ${row.id} skipped: its schedule no longer translates (${onCalendar.error})`
    )
    return null
  }
  const database = scheduledBackupDatabase(row)
  return {
    policyId: row.id,
    targetKind: 'managed',
    managedId: row.managedId,
    engine: row.engine as BackupPolicyWireEntry['engine'],
    artifactExtension: descriptor.artifactExtension,
    ...(database === undefined ? {} : { database }),
    onCalendar: onCalendar.value,
    retentionKeep: row.retentionKeep,
    enabled: row.isEnabled,
  }
}

type CopyPolicyRow = CopyTargetRow & {
  id: string
  schedule: string
  timezone: string | null
  retentionKeep: number
  isEnabled: boolean
}

/** A copy policy as its host runs it; null (and a warning) when the copy can no longer be backed up. */
function toCopyWireEntry(row: CopyPolicyRow): BackupPolicyWireEntry | null {
  const source = resolveCopyBackupSource(row)
  if (!source.ok) {
    compatLogWarn('backups', `backup policy ${row.id} skipped: ${source.error}`)
    return null
  }
  const onCalendar = translateBackupSchedule(row.schedule, row.timezone)
  if (!onCalendar.ok) {
    compatLogWarn(
      'backups',
      `backup policy ${row.id} skipped: its schedule no longer translates (${onCalendar.error})`
    )
    return null
  }
  return {
    policyId: row.id,
    targetKind: 'copy',
    ...source.source,
    onCalendar: onCalendar.value,
    retentionKeep: row.retentionKeep,
    enabled: row.isEnabled,
  }
}

async function loadManagedPolicyRows(db: Db, serverId: string): Promise<ManagedPolicyRow[]> {
  return await db
    .select({
      id: retention.id,
      managedId: retention.managedId,
      schedule: retention.schedule,
      timezone: retention.timezone,
      retentionKeep: retention.retentionKeep,
      isEnabled: retention.isEnabled,
      engine: managed.engine,
      options: managed.options,
    })
    .from(retention)
    .innerJoin(managed, eq(managed.id, retention.managedId))
    .where(and(eq(managed.serverId, serverId), eq(retention.targetKind, 'managed')))
}

/** Copy policies whose copy is placed on `serverId` (`copy.server_id`, like a managed engine's). */
async function loadCopyPolicyRows(db: Db, serverId: string): Promise<CopyPolicyRow[]> {
  return await db
    .select({
      ...COPY_TARGET_SELECT,
      id: retention.id,
      schedule: retention.schedule,
      timezone: retention.timezone,
      retentionKeep: retention.retentionKeep,
      isEnabled: retention.isEnabled,
    })
    .from(retention)
    .innerJoin(storageCopy, eq(storageCopy.id, retention.copyId))
    .innerJoin(storage, eq(storage.id, storageCopy.storageId))
    .leftJoin(principal, eq(principal.id, storage.principalId))
    .leftJoin(environment, eq(environment.id, storage.environmentId))
    .where(and(eq(storageCopy.serverId, serverId), eq(retention.targetKind, 'copy')))
}

/**
 * Every policy one server runs — the completeness rule. Disabled policies are
 * included with `enabled: false` so the host drops their timers.
 */
export async function buildBackupPolicySetForServer(
  db: Db,
  serverId: string
): Promise<BackupPolicyWireEntry[]> {
  const managedRows = await loadManagedPolicyRows(db, serverId)
  const copyRows = await loadCopyPolicyRows(db, serverId)
  const entries: BackupPolicyWireEntry[] = []
  for (const row of managedRows) {
    const entry = toWireEntry(row)
    if (entry) entries.push(entry)
  }
  for (const row of copyRows) {
    const entry = toCopyWireEntry(row)
    if (entry) entries.push(entry)
  }
  // The same parser the command carries is run here, so a set the daemon
  // would refuse is never queued.
  return parseBackupsReconcilePayload({ policies: entries }).policies
}

async function enqueueOne(
  db: Db,
  queue: CommandQueue,
  actor: BackupsReconcileActor,
  serverId: string
): Promise<boolean> {
  const policies = await buildBackupPolicySetForServer(db, serverId)
  const record = await createCommandRecord(db, {
    serverId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    type: BACKUPS_RECONCILE_COMMAND,
    payload: { policies },
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: BACKUPS_RECONCILE_COMMAND,
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await queue.enqueue(envelope)
    return true
  } catch {
    // The row exists but nothing will pick it up; leaving it `queued` would
    // show a command that is permanently pending.
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Failed to enqueue backups reconcile',
    })
    return false
  }
}

/** Enqueue one full-set reconcile per server (each server once). Never throws. */
export async function enqueueBackupsReconcile(
  db: Db,
  queue: CommandQueue | undefined,
  actor: BackupsReconcileActor,
  serverIds: readonly (string | null | undefined)[]
): Promise<BackupsReconcileOutcome> {
  const unique = [...new Set(serverIds.filter((id): id is string => typeof id === 'string'))]
  const queued: string[] = []
  const failed: string[] = []
  if (!queue || isNoopCommandQueue(queue)) {
    return { queuedServerIds: queued, failedServerIds: unique }
  }
  await forEachSequential(unique, async (serverId) => {
    try {
      if (await enqueueOne(db, queue, actor, serverId)) queued.push(serverId)
      else failed.push(serverId)
    } catch (err) {
      compatLogWarn('backups', `backups reconcile for server ${serverId} failed: ${String(err)}`)
      failed.push(serverId)
    }
  })
  return { queuedServerIds: queued, failedServerIds: failed }
}

/** `managed.server_id` for an engine, or null when it has none (or is gone). */
export async function readManagedServerId(db: Db, managedId: string): Promise<string | null> {
  const [row] = await db
    .select({ serverId: managed.serverId })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  return row?.serverId ?? null
}

function canEnqueue(queue: CommandQueue | undefined): queue is CommandQueue {
  return queue !== undefined && !isNoopCommandQueue(queue)
}

/**
 * Before a write that may re-home a managed engine: the server its policies
 * run on now, or null when there is nothing to move (no queue to push with,
 * no policies, no server). Pass the value to {@link reconcileBackupsAfterManagedMove}.
 */
export async function captureManagedBackupHost(
  db: Db,
  queue: CommandQueue | undefined,
  managedId: string
): Promise<string | null> {
  if (!canEnqueue(queue)) return null
  try {
    if (!(await managedHasBackupPolicies(db, managedId))) return null
    return await readManagedServerId(db, managedId)
  } catch (err) {
    compatLogWarn('backups', `backup host lookup for managed ${managedId} failed: ${String(err)}`)
    return null
  }
}

/**
 * After that write: when the engine's server changed (a promote or failover
 * re-pinned it), reconcile both hosts — the old one drops the timers, the new
 * one gains them. Never throws.
 */
export async function reconcileBackupsAfterManagedMove(
  db: Db,
  queue: CommandQueue | undefined,
  params: { managedId: string; previousServerId: string | null; actorId: string }
): Promise<void> {
  if (!params.previousServerId || !canEnqueue(queue)) return
  try {
    const nextServerId = await readManagedServerId(db, params.managedId)
    if (nextServerId === params.previousServerId) return
    await enqueueBackupsReconcile(db, queue, { actorType: 'system', actorId: params.actorId }, [
      params.previousServerId,
      nextServerId,
    ])
  } catch (err) {
    compatLogWarn('backups', `backups reconcile after moving ${params.managedId}: ${String(err)}`)
  }
}

/** Servers that run a backup policy for the copies `where` selects. */
async function readCopyBackupHosts(db: Db, where: SQL | undefined): Promise<string[]> {
  const rows = await db
    .selectDistinct({ serverId: storageCopy.serverId })
    .from(storageCopy)
    .innerJoin(retention, eq(retention.copyId, storageCopy.id))
    .where(and(where, isNotNull(storageCopy.serverId)))
  return rows.flatMap((row) => (row.serverId ? [row.serverId] : []))
}

/**
 * Before a write that may move, change or remove storage copies: the servers
 * running a backup policy for any of them (all copies of `storageId`, or the
 * copies in `copyIds`). Empty when there is no queue to push with. Never throws.
 */
export async function captureCopyBackupHosts(
  db: Db,
  queue: CommandQueue | undefined,
  target: { copyIds: readonly string[] } | { storageId: string }
): Promise<string[]> {
  if (!canEnqueue(queue)) return []
  if ('copyIds' in target && target.copyIds.length === 0) return []
  const where =
    'storageId' in target
      ? eq(storageCopy.storageId, target.storageId)
      : inArray(storageCopy.id, [...target.copyIds])
  try {
    return await readCopyBackupHosts(db, where)
  } catch (err) {
    compatLogWarn('backups', `backup host lookup for storage copies failed: ${String(err)}`)
    return []
  }
}

/**
 * After that write: push every server captured before it, plus the current
 * server of each copy that still has a policy (a copy that moved gains its
 * timers on the new host; a deleted one's policies cascaded away, so its old
 * host drops them). Never throws.
 */
export async function reconcileBackupsAfterCopyChange(
  db: Db,
  queue: CommandQueue | undefined,
  params: {
    copyIds: readonly string[]
    previousServerIds: readonly string[]
    actor: BackupsReconcileActor
  }
): Promise<void> {
  if (!canEnqueue(queue)) return
  try {
    const current =
      params.copyIds.length === 0
        ? []
        : await readCopyBackupHosts(db, inArray(storageCopy.id, [...params.copyIds]))
    const servers = [...params.previousServerIds, ...current]
    if (servers.length === 0) return
    await enqueueBackupsReconcile(db, queue, params.actor, servers)
  } catch (err) {
    compatLogWarn('backups', `backups reconcile after a storage copy change: ${String(err)}`)
  }
}

/**
 * Reconnect trigger: push each connected server's set once after it
 * (re)connects — any server with a policy, or one that was ever sent a set
 * (its policies may all have been deleted while it was offline). "Once" is
 * enforced by the command table: a server is skipped when a backups
 * reconcile was already created since its `status_changed_at`, including a
 * policy write's own.
 *
 * Runs from the Workers cron and the Deno maintenance timer, never from
 * hello or a Durable Object handler (those must not enqueue).
 */
export async function runBackupsReconcileSweep(
  db: Db,
  queue: CommandQueue,
  params: Readonly<{ budget?: number }> = {}
): Promise<{ enqueued: number }> {
  if (!canEnqueue(queue)) return { enqueued: 0 }
  const budget = Math.min(
    Math.max(1, params.budget ?? BACKUPS_RECONCILE_SWEEP_CAP),
    BACKUPS_RECONCILE_SWEEP_CAP
  )
  const candidates = await db.execute<{ server_id: string }>(sql`
    SELECT srv.id AS server_id
    FROM server srv
    WHERE srv.is_connected = true
      AND srv.status_changed_at IS NOT NULL
      AND (
        EXISTS (
          SELECT 1
          FROM retention bp
          JOIN managed m ON m.id = bp.managed_id
          WHERE m.server_id = srv.id
        )
        OR EXISTS (
          SELECT 1
          FROM retention bp
          JOIN copy cp ON cp.id = bp.copy_id
          WHERE cp.server_id = srv.id
        )
        OR EXISTS (
          SELECT 1
          FROM command cmd
          WHERE cmd.server_id = srv.id
            AND cmd.name = ${BACKUPS_RECONCILE_COMMAND}
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM command cmd
        WHERE cmd.server_id = srv.id
          AND cmd.name = ${BACKUPS_RECONCILE_COMMAND}
          AND cmd.created_at >= srv.status_changed_at
      )
    ORDER BY srv.id
    LIMIT ${budget}
  `)
  let enqueued = 0
  await forEachSequential(candidates, async (row) => {
    const result = await enqueueBackupsReconcile(
      db,
      queue,
      { actorType: 'system', actorId: row.server_id },
      [row.server_id]
    )
    enqueued += result.queuedServerIds.length
  })
  return { enqueued }
}
