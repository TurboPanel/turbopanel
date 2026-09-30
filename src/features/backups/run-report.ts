/**
 * `backup-run-report`: one finished scheduled backup run, sent by the host
 * that ran it from its result spool (turbopaneld `src/backups/`). The daemon
 * deletes its spooled copy only when this answers, so:
 *
 * - `ok: true` — recorded, or already recorded (the same run sent twice).
 * - `ok: false` — refused for good: the report can never be believed, and
 *   resending it will not change that.
 * - no answer — a transient failure (database down, timeout); the daemon
 *   sends it again next tick. Callers get this by letting an error escape.
 *
 * Hostile-daemon rule (see the `backup` table's doc comment in `schema.ts`):
 * a report is believed only for a policy whose managed engine is placed on
 * the reporting server (`managed.server_id`). That is the host the policy's
 * timer is pushed to; a server that merely hosts a replica of the engine, or
 * that held it before a move, is refused. After an HA failover or a move, a
 * run that already finished on the old host is dropped, and its artifact
 * stays on that host's disk unrecorded — accepted for 0.2.x in exchange for
 * one simple ownership rule. Pruned rows are deleted only for this policy's
 * own artifacts of this engine, so a report cannot erase a manual backup's
 * record or another engine's.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type {
  BackupRunReportMessage,
  BackupRunReportResultMessage,
} from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import { backup, backupPolicy, backupRun, managed } from '../../db/schema.ts'
import { isManagedBackupArtifactExtension } from '../managed/types.ts'
import { insertManagedBackup } from './backup-records.ts'

/** Stored failure text is bounded; the daemon caps it at the same length. */
export const MAX_BACKUP_RUN_ERROR_CHARS = 2000

/** An absolute path in a charset a backup directory plausibly uses. */
const ARTIFACT_PATH_RE = /^\/[\w .@+/-]+$/

export type BackupRunReportOutcome = { ok: true } | { ok: false; error: string }

/** What a report's policy points at, read before anything is written. */
export type BackupPolicyTarget = {
  targetKind: string
  managedId: string | null
  /** The engine's placement server; null when it has none. */
  managedServerId: string | null
}

/** One run as it is written, after it has been believed. */
export type BackupRunRecord = {
  policyId: string
  managedId: string
  serverId: string
  runId: string
  startedAt: string
  finishedAt: string
  status: 'succeeded' | 'failed'
  error?: string
  artifact?: { backupId: string; sizeBytes: number; checksum: string; path: string }
  pruned: string[]
  nextRunAt?: string
}

export type BackupRunReportStore = {
  loadPolicyTarget(policyId: string): Promise<BackupPolicyTarget | undefined>
  /** Writes the run in one transaction; a run already recorded changes nothing. */
  recordRun(record: BackupRunRecord): Promise<void>
}

function refused(error: string): BackupRunReportOutcome {
  return { ok: false, error }
}

function hasArtifactFields(report: BackupRunReportMessage): boolean {
  return (
    report.backupId !== undefined ||
    report.sizeBytes !== undefined ||
    report.checksum !== undefined ||
    report.path !== undefined
  )
}

function checkRunConsistency(report: BackupRunReportMessage): string | null {
  if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) {
    return 'finishedAt is before startedAt'
  }
  if (report.status === 'failed') {
    return hasArtifactFields(report) ? 'a failed run cannot report an artifact' : null
  }
  if (
    report.backupId === undefined ||
    report.sizeBytes === undefined ||
    report.checksum === undefined ||
    report.path === undefined
  ) {
    return 'a succeeded run must report its artifact'
  }
  if (report.pruned?.includes(report.backupId)) {
    return 'a run cannot prune the artifact it made'
  }
  return null
}

/**
 * The artifact must sit in this policy's own directory for this engine:
 * `<backupDir>/<managedId>/policy-<policyId>/<backupId>.<ext>`.
 */
function checkArtifactPath(report: BackupRunReportMessage, managedId: string): string | null {
  const path = report.path ?? ''
  if (!ARTIFACT_PATH_RE.test(path)) return 'invalid artifact path'
  const prefix = `/${managedId}/policy-${report.policyId}/${report.backupId}.`
  const cut = path.lastIndexOf(prefix)
  if (cut < 0) return 'artifact path is outside the policy directory'
  const extension = path.slice(cut + prefix.length)
  return isManagedBackupArtifactExtension(extension) ? null : 'invalid artifact extension'
}

function authorize(
  target: BackupPolicyTarget | undefined,
  reporterServerId: string
): { managedId: string } | string {
  if (!target) return 'unknown backup policy'
  if (target.targetKind !== 'managed' || !target.managedId) {
    return 'storage-copy backups are not accepted yet'
  }
  if (target.managedServerId !== reporterServerId) {
    return 'the policy targets an engine placed on another server'
  }
  return { managedId: target.managedId }
}

function toRunRecord(
  report: BackupRunReportMessage,
  managedId: string,
  serverId: string
): BackupRunRecord {
  const record: BackupRunRecord = {
    policyId: report.policyId,
    managedId,
    serverId,
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    status: report.status,
    pruned: report.pruned ?? [],
  }
  if (report.error !== undefined) record.error = report.error.slice(0, MAX_BACKUP_RUN_ERROR_CHARS)
  if (report.nextRunAt !== undefined) record.nextRunAt = report.nextRunAt
  if (report.status === 'succeeded') {
    record.artifact = {
      backupId: report.backupId ?? '',
      sizeBytes: report.sizeBytes ?? 0,
      checksum: report.checksum ?? '',
      path: report.path ?? '',
    }
  }
  return record
}

/**
 * Decide whether to believe one report and record it. The frame's shape was
 * already checked (`validateDaemonInboundFrame`); this checks what only the
 * database can answer, plus consistency between fields. Store errors escape
 * so the caller sends no answer and the daemon retries.
 */
export async function handleBackupRunReport(
  store: BackupRunReportStore,
  report: BackupRunReportMessage,
  options: { reporterServerId: string }
): Promise<BackupRunReportOutcome> {
  const consistency = checkRunConsistency(report)
  if (consistency) return refused(consistency)

  const authorized = authorize(
    await store.loadPolicyTarget(report.policyId),
    options.reporterServerId
  )
  if (typeof authorized === 'string') return refused(authorized)

  if (report.status === 'succeeded') {
    const pathIssue = checkArtifactPath(report, authorized.managedId)
    if (pathIssue) return refused(pathIssue)
  }

  await store.recordRun(toRunRecord(report, authorized.managedId, options.reporterServerId))
  return { ok: true }
}

export function backupRunReportResultMessage(
  id: string,
  outcome: BackupRunReportOutcome,
  at: string
): BackupRunReportResultMessage {
  const message: BackupRunReportResultMessage = {
    type: 'backup-run-report-result',
    id,
    ok: outcome.ok,
    at,
  }
  if (!outcome.ok) message.error = outcome.error
  return message
}

async function loadPolicyTarget(db: Db, policyId: string): Promise<BackupPolicyTarget | undefined> {
  const [row] = await db
    .select({
      targetKind: backupPolicy.targetKind,
      managedId: backupPolicy.managedId,
      managedServerId: managed.serverId,
    })
    .from(backupPolicy)
    .leftJoin(managed, eq(managed.id, backupPolicy.managedId))
    .where(eq(backupPolicy.id, policyId))
    .limit(1)
  return row
}

/**
 * One transaction, every query through `tx` (Workers has a single
 * connection per request). The run row goes first: when `(policy_id,
 * run_id)` already exists this is a resend, and nothing else is touched.
 */
export async function recordBackupRun(db: Db, record: BackupRunRecord): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(backupRun)
      .values({
        policyId: record.policyId,
        serverId: record.serverId,
        runId: record.runId,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        status: record.status,
        error: record.error ?? null,
        backupRef: record.artifact?.backupId ?? null,
      })
      .onConflictDoNothing({ target: [backupRun.policyId, backupRun.runId] })
      .returning({ id: backupRun.id })
    if (inserted.length === 0) return

    if (record.artifact) {
      await insertManagedBackup(tx, {
        id: record.artifact.backupId,
        managedId: record.managedId,
        sizeBytes: record.artifact.sizeBytes,
        checksum: record.artifact.checksum,
        path: record.artifact.path,
        createdAt: record.finishedAt,
        policyId: record.policyId,
      })
    }
    if (record.pruned.length > 0) {
      await tx
        .delete(backup)
        .where(
          and(
            eq(backup.managedId, record.managedId),
            eq(backup.policyId, record.policyId),
            inArray(backup.backupId, record.pruned)
          )
        )
    }
    if (record.nextRunAt !== undefined) {
      await tx
        .update(backupPolicy)
        // A report is not an edit: keep `updated_at` as the operator left it.
        .set({ nextRunAt: record.nextRunAt, updatedAt: sql`${backupPolicy.updatedAt}` })
        .where(eq(backupPolicy.id, record.policyId))
    }
  })
}

export function createBackupRunReportStore(db: Db): BackupRunReportStore {
  return {
    loadPolicyTarget: (policyId) => loadPolicyTarget(db, policyId),
    recordRun: (record) => recordBackupRun(db, record),
  }
}
