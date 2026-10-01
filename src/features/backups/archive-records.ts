/**
 * `archive` rows: completed storage-copy backup artifacts, recorded from
 * a daemon's `storage.backup` result (manual) or `backup-run-report`
 * (scheduled, `retention_id` set). The id keeps the daemon's `bk_<hex>` format,
 * unique per copy, exactly like the managed-engine `backup` table.
 */

import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { archive } from '../../db/schema.ts'

export type ArchiveRecord = {
  id: string
  createdAt: string
  copyId: string
  policyId: string | null
  sizeBytes: number
  checksum: string
  path: string
}

function toRecord(row: typeof archive.$inferSelect): ArchiveRecord {
  return {
    id: row.backupId,
    createdAt: row.createdAt,
    copyId: row.copyId,
    policyId: row.retentionId,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    path: row.path,
  }
}

/**
 * Insert one artifact. A redelivered result (the same `(copy, id)`) returns
 * the row already there instead of erroring; scoped by copy on purpose, so
 * another copy reporting the same string is a different row.
 */
export async function insertArchive(
  db: Db,
  params: {
    id: string
    copyId: string
    sizeBytes: number
    checksum: string
    path: string
    /** Daemon-reported completion time, when available; defaults to now(). */
    createdAt?: string
    /** The `retention` whose scheduled run made it; omitted for a manual backup. */
    retentionId?: string
  }
): Promise<ArchiveRecord> {
  const [row] = await db
    .insert(archive)
    .values({
      backupId: params.id,
      copyId: params.copyId,
      sizeBytes: params.sizeBytes,
      checksum: params.checksum,
      path: params.path,
      retentionId: params.retentionId ?? null,
      ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
    })
    .onConflictDoNothing({ target: [archive.copyId, archive.backupId] })
    .returning()
  if (row) return toRecord(row)

  const existing = await findArchiveById(db, params.copyId, params.id)
  if (!existing) throw new Error(`volume backup insert failed (id=${params.id})`)
  return existing
}

/** Newest first. */
export async function listArchives(db: Db, copyId: string): Promise<ArchiveRecord[]> {
  const rows = await db
    .select()
    .from(archive)
    .where(eq(archive.copyId, copyId))
    .orderBy(desc(archive.createdAt))
  return rows.map(toRecord)
}

export async function findArchiveById(
  db: Db,
  copyId: string,
  backupId: string
): Promise<ArchiveRecord | undefined> {
  const [row] = await db
    .select()
    .from(archive)
    .where(and(eq(archive.copyId, copyId), eq(archive.backupId, backupId)))
    .limit(1)
  return row ? toRecord(row) : undefined
}

export async function deleteArchive(db: Db, copyId: string, backupId: string): Promise<void> {
  await db.delete(archive).where(and(eq(archive.copyId, copyId), eq(archive.backupId, backupId)))
}

/** Drop the rows one policy's retention pruned on the host — that policy's own, for that copy only. */
export async function deletePrunedArchives(
  db: Db,
  params: { copyId: string; retentionId: string; backupIds: readonly string[] }
): Promise<void> {
  if (params.backupIds.length === 0) return
  await db
    .delete(archive)
    .where(
      and(
        eq(archive.copyId, params.copyId),
        eq(archive.retentionId, params.retentionId),
        inArray(archive.backupId, [...params.backupIds])
      )
    )
}
