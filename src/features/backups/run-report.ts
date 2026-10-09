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
 * a report is believed only for a policy whose target is placed on the
 * reporting server — the managed engine's `managed.server_id`, or the storage
 * copy's `copy.server_id`. That is the host the policy's timer is pushed to;
 * a server that merely hosts a replica of the engine, or that held the target
 * before a move, is refused. After an HA failover or a move, a run that
 * already finished on the old host is dropped, and its artifact stays on that
 * host's disk unrecorded — accepted for 0.2.x in exchange for one simple
 * ownership rule. Pruned rows are deleted only for this policy's own
 * artifacts of this target (`backup` rows for an engine, `archive` rows
 * for a copy), so a report cannot erase a manual backup's record or another
 * target's.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type {
  BackupRunReportMessage,
  BackupRunReportResultMessage,
} from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import { backup, retention, snapshot, managed, storageCopy } from '../../db/schema.ts'
import { COPY_BACKUP_ARTIFACT_EXTENSION } from '../../contracts/commands/schemas.ts'
import { isManagedBackupArtifactExtension } from '../managed/types.ts'
import { insertManagedBackup } from './backup-records.ts'
import { deletePrunedArchives, insertArchive } from './archive-records.ts'

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
  copyId: string | null
  /** The storage copy's server; null when it has none. */
  copyServerId: string | null
}

/** The target a believed report is recorded against. */
export type BackupRunTarget =
  { kind: 'managed'; managedId: string } | { kind: 'copy'; copyId: string }

/** One run as it is written, after it has been believed. */
export type BackupRunRecord = {
  policyId: string
  target: BackupRunTarget
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
 * The artifact must sit in this policy's own directory for this target:
 * `<backupDir>/<managedId>/policy-<policyId>/<backupId>.<ext>` for an engine,
 * `<backupDir>/copies/<copyId>/policy-<policyId>/<backupId>.tar.gz` for a copy.
 */
function checkArtifactPath(report: BackupRunReportMessage, target: BackupRunTarget): string | null {
  const path = report.path ?? ''
  if (!ARTIFACT_PATH_RE.test(path)) return 'invalid artifact path'
  const directory = target.kind === 'managed' ? `/${target.managedId}` : `/copies/${target.copyId}`
  const prefix = `${directory}/policy-${report.policyId}/${report.backupId}.`
  const cut = path.lastIndexOf(prefix)
  if (cut < 0) return 'artifact path is outside the policy directory'
  const extension = path.slice(cut + prefix.length)
  const valid =
    target.kind === 'managed'
      ? isManagedBackupArtifactExtension(extension)
      : extension === COPY_BACKUP_ARTIFACT_EXTENSION
  return valid ? null : 'invalid artifact extension'
}

function authorize(
  target: BackupPolicyTarget | undefined,
  reporterServerId: string
): BackupRunTarget | string {
  if (!target) return 'unknown backup policy'
  if (target.targetKind === 'managed' && target.managedId) {
    if (target.managedServerId !== reporterServerId) {
      return 'the policy targets an engine placed on another server'
    }
    return { kind: 'managed', managedId: target.managedId }
  }
  if (target.targetKind === 'copy' && target.copyId) {
    if (target.copyServerId !== reporterServerId) {
      return 'the policy targets a storage copy placed on another server'
    }
    return { kind: 'copy', copyId: target.copyId }
  }
  return 'the policy has no target'
}

function toRunRecord(
  report: BackupRunReportMessage,
  target: BackupRunTarget,
  serverId: string
): BackupRunRecord {
  const record: BackupRunRecord = {
    policyId: report.policyId,
    target,
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
    const pathIssue = checkArtifactPath(report, authorized)
    if (pathIssue) return refused(pathIssue)
  }

  await store.recordRun(toRunRecord(report, authorized, options.reporterServerId))
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
      targetKind: retention.targetKind,
      managedId: retention.managedId,
      managedServerId: managed.serverId,
      copyId: retention.copyId,
      copyServerId: storageCopy.serverId,
    })
    .from(retention)
    .leftJoin(managed, eq(managed.id, retention.managedId))
    .leftJoin(storageCopy, eq(storageCopy.id, retention.copyId))
    .where(eq(retention.id, policyId))
    .limit(1)
  return row
}

async function recordManagedArtifacts(
  tx: Db,
  record: BackupRunRecord,
  managedId: string
): Promise<void> {
  if (record.artifact) {
    await insertManagedBackup(tx, {
      id: record.artifact.backupId,
      managedId,
      sizeBytes: record.artifact.sizeBytes,
      checksum: record.artifact.checksum,
      path: record.artifact.path,
      createdAt: record.finishedAt,
      retentionId: record.policyId,
      serverId: record.serverId,
    })
  }
  if (record.pruned.length > 0) {
    await tx
      .delete(backup)
      .where(
        and(
          eq(backup.managedId, managedId),
          eq(backup.retentionId, record.policyId),
          inArray(backup.backupId, record.pruned)
        )
      )
  }
}

async function recordCopyArtifacts(tx: Db, record: BackupRunRecord, copyId: string): Promise<void> {
  if (record.artifact) {
    await insertArchive(tx, {
      id: record.artifact.backupId,
      copyId,
      sizeBytes: record.artifact.sizeBytes,
      checksum: record.artifact.checksum,
      path: record.artifact.path,
      createdAt: record.finishedAt,
      retentionId: record.policyId,
    })
  }
  await deletePrunedArchives(tx, {
    copyId,
    retentionId: record.policyId,
    backupIds: record.pruned,
  })
}

/**
 * One transaction, every query through `tx` (Workers has a single
 * connection per request). The run row goes first: when `(retention_id,
 * run_id)` already exists this is a resend, and nothing else is touched.
 */
export async function recordBackupRun(db: Db, record: BackupRunRecord): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(snapshot)
      .values({
        retentionId: record.policyId,
        serverId: record.serverId,
        runId: record.runId,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        status: record.status,
        error: record.error ?? null,
        backupRef: record.artifact?.backupId ?? null,
      })
      .onConflictDoNothing({ target: [snapshot.retentionId, snapshot.runId] })
      .returning({ id: snapshot.id })
    if (inserted.length === 0) return

    if (record.target.kind === 'managed') {
      await recordManagedArtifacts(tx, record, record.target.managedId)
    } else {
      await recordCopyArtifacts(tx, record, record.target.copyId)
    }
    if (record.nextRunAt !== undefined) {
      await tx
        .update(retention)
        // A report is not an edit: keep `updated_at` as the operator left it.
        .set({ nextRunAt: record.nextRunAt, updatedAt: sql`${retention.updatedAt}` })
        .where(eq(retention.id, record.policyId))
    }
  })
}

export function createBackupRunReportStore(db: Db): BackupRunReportStore {
  return {
    loadPolicyTarget: (policyId) => loadPolicyTarget(db, policyId),
    recordRun: (record) => recordBackupRun(db, record),
  }
}
