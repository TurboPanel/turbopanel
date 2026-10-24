/**
 * `backup_copy` rows: how copying each backup to its target stands. Written
 * when a backup is recorded (`pending`, if a target applies) and when the
 * host reports (`backup-copy-report`).
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { backupCopy } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { BackupCopyState } from './vocabulary.ts'
import { resolveEffectiveTarget } from './targets.ts'

export type BackupCopyRecord = typeof backupCopy.$inferSelect

/** What the API shows about one backup's copy. */
export function toApiCopy(row: BackupCopyRecord) {
  return {
    state: row.state as BackupCopyState,
    destinationId: row.destinationId,
    destinationName: row.destinationName,
    error: row.error,
    objectKey: row.objectKey,
    attempts: row.attempts,
    copiedAt: row.copiedAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Note that a new backup is waiting to be copied, when a target applies to its
 * cluster. Never throws: it runs after the backup itself was recorded.
 */
export async function recordPendingCopy(
  db: Db,
  params: { managedId: string; backupId: string; organizationId?: string }
): Promise<void> {
  try {
    const choice = await resolveEffectiveTarget(db, params.managedId, params.organizationId)
    if (!choice.target) return
    await db
      .insert(backupCopy)
      .values({
        managedId: params.managedId,
        backupId: params.backupId,
        destinationId: choice.target.id,
        destinationName: choice.target.name,
        state: 'pending',
      })
      .onConflictDoNothing()
  } catch (err) {
    compatLogWarn(
      'backups',
      `could not note the pending copy of ${params.backupId}: ${String(err)}`
    )
  }
}

/** The copy rows of these backups, newest report first per backup. */
export async function listCopiesFor(
  db: Db,
  managedId: string,
  backupIds: readonly string[]
): Promise<Map<string, BackupCopyRecord>> {
  const out = new Map<string, BackupCopyRecord>()
  if (backupIds.length === 0) return out
  const rows = await db
    .select()
    .from(backupCopy)
    .where(and(eq(backupCopy.managedId, managedId), inArray(backupCopy.backupId, [...backupIds])))
    .orderBy(sql`${backupCopy.updatedAt} DESC`)
  for (const row of rows) if (!out.has(row.backupId)) out.set(row.backupId, row)
  return out
}

export async function findCopy(
  db: Db,
  managedId: string,
  backupId: string
): Promise<BackupCopyRecord | null> {
  return (await listCopiesFor(db, managedId, [backupId])).get(backupId) ?? null
}

export type CopyReportRecord = {
  managedId: string
  backupId: string
  destinationId: string
  destinationName: string
  serverId: string
  state: 'copied' | 'failed'
  error?: string
  objectKey?: string
  sizeBytes?: number
  attempts: number
  finishedAt: string
  pruned: string[]
}

/** Write one believed report: the copy's state, then mark whatever retention removed. One transaction. */
export async function recordCopyReport(db: Db, report: CopyReportRecord): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(backupCopy)
      .values({
        managedId: report.managedId,
        backupId: report.backupId,
        destinationId: report.destinationId,
        destinationName: report.destinationName,
        state: report.state,
        error: report.state === 'failed' ? (report.error ?? 'The copy failed') : null,
        objectKey: report.objectKey ?? null,
        sizeBytes: report.sizeBytes ?? null,
        attempts: report.attempts,
        copiedAt: report.state === 'copied' ? report.finishedAt : null,
        serverId: report.serverId,
      })
      .onConflictDoUpdate({
        target: [backupCopy.managedId, backupCopy.backupId, backupCopy.destinationId],
        set: {
          destinationName: report.destinationName,
          state: report.state,
          error: report.state === 'failed' ? (report.error ?? 'The copy failed') : null,
          objectKey: report.objectKey ?? null,
          sizeBytes: report.sizeBytes ?? null,
          attempts: report.attempts,
          copiedAt: report.state === 'copied' ? report.finishedAt : null,
          serverId: report.serverId,
        },
      })
    if (report.pruned.length > 0) {
      await tx
        .update(backupCopy)
        .set({ state: 'removed' })
        .where(
          and(
            eq(backupCopy.managedId, report.managedId),
            eq(backupCopy.destinationId, report.destinationId),
            inArray(backupCopy.backupId, report.pruned),
            eq(backupCopy.state, 'copied')
          )
        )
    }
  })
}
