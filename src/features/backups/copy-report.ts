/**
 * `backup-copy-report`: how copying one finished backup to its S3-compatible
 * target ended, sent by the host that holds the backup. Same answer rules as
 * `backup-run-report`: `ok: true` recorded (or already recorded), `ok: false`
 * refused for good, no answer when the database is down (the host resends).
 *
 * Hostile-daemon rule: a report is believed only for an engine placed on the
 * reporting server, and only for a target of that engine's own organization.
 * The reported error text is stored cut to a bounded length and nothing else
 * from the host is stored as free text.
 */

import { eq } from 'drizzle-orm'
import type {
  BackupCopyReportMessage,
  BackupCopyReportResultMessage,
} from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import { backupTarget, managed } from '../../db/schema.ts'
import { resolveManagedHomeOrganizationId } from '../principals/store.ts'
import { type CopyReportRecord, recordCopyReport } from './copy-records.ts'

export const MAX_BACKUP_COPY_ERROR_CHARS = 1000

export type BackupCopyReportOutcome = { ok: true } | { ok: false; error: string }

export type BackupCopyReportStore = {
  /** The engine's placement server and organization; undefined when it is gone. */
  loadEngine(managedId: string): Promise<{ serverId: string | null; organizationId: string } | undefined>
  /** The target's organization and name; undefined when it is gone. */
  loadTarget(targetId: string): Promise<{ organizationId: string; name: string } | undefined>
  record(record: CopyReportRecord): Promise<void>
}

function refused(error: string): BackupCopyReportOutcome {
  return { ok: false, error }
}

function checkConsistency(report: BackupCopyReportMessage): string | null {
  if (report.state === 'failed') {
    return report.objectKey === undefined ? null : 'a failed copy cannot name an object'
  }
  if (report.objectKey === undefined) return 'a copied backup must name its object'
  if (report.error !== undefined) return 'a copied backup cannot carry an error'
  if (report.pruned?.includes(report.backupId)) return 'a copy cannot prune the backup it made'
  return null
}

export async function handleBackupCopyReport(
  store: BackupCopyReportStore,
  report: BackupCopyReportMessage,
  options: { reporterServerId: string }
): Promise<BackupCopyReportOutcome> {
  const consistency = checkConsistency(report)
  if (consistency) return refused(consistency)
  const engine = await store.loadEngine(report.managedId)
  if (!engine) return refused('unknown engine')
  if (engine.serverId !== options.reporterServerId) {
    return refused('the engine is placed on another server')
  }
  const target = await store.loadTarget(report.targetId)
  if (!target) return refused('the target no longer exists')
  if (target.organizationId !== engine.organizationId) {
    return refused('the target belongs to another organization')
  }
  const record: CopyReportRecord = {
    managedId: report.managedId,
    backupId: report.backupId,
    targetId: report.targetId,
    targetName: target.name,
    serverId: options.reporterServerId,
    state: report.state,
    attempts: report.attempts,
    finishedAt: report.finishedAt,
    pruned: report.pruned ?? [],
  }
  if (report.error !== undefined) record.error = report.error.slice(0, MAX_BACKUP_COPY_ERROR_CHARS)
  if (report.objectKey !== undefined) record.objectKey = report.objectKey
  if (report.sizeBytes !== undefined) record.sizeBytes = report.sizeBytes
  await store.record(record)
  return { ok: true }
}

export function backupCopyReportResultMessage(
  id: string,
  outcome: BackupCopyReportOutcome,
  at: string
): BackupCopyReportResultMessage {
  const message: BackupCopyReportResultMessage = {
    type: 'backup-copy-report-result',
    id,
    ok: outcome.ok,
    at,
  }
  if (!outcome.ok) message.error = outcome.error
  return message
}

export function createBackupCopyReportStore(db: Db): BackupCopyReportStore {
  return {
    async loadEngine(managedId) {
      const [row] = await db
        .select({ serverId: managed.serverId })
        .from(managed)
        .where(eq(managed.id, managedId))
        .limit(1)
      if (!row) return undefined
      return { serverId: row.serverId, organizationId: await resolveManagedHomeOrganizationId(db, managedId) }
    },
    async loadTarget(targetId) {
      const [row] = await db
        .select({ organizationId: backupTarget.organizationId, name: backupTarget.name })
        .from(backupTarget)
        .where(eq(backupTarget.id, targetId))
        .limit(1)
      return row
    },
    record: (record) => recordCopyReport(db, record),
  }
}
