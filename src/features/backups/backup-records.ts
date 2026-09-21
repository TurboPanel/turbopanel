/**
 * Real-table backup records, promoted out of `managed.options.backups[]`
 * (schema-child-tables, Road-to-0.1.x). See the `backup` table's doc comment
 * in `schema.ts` for why the id keeps the daemon's `bk_<hex>` format.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { backup } from "../../db/schema.ts";

const CHECKSUM_SHA256_RE = /^[a-f0-9]{64}$/;
/** Mirrors the daemon `SAFE_MANAGED_ID_RE` (the id becomes a filename). */
const SAFE_BACKUP_ID_RE = /^[A-Za-z0-9_-]+$/;

export type ManagedBackupRecord = {
  id: string;
  createdAt: string;
  managedId: string;
  sizeBytes: number;
  checksum: string;
  database?: string;
  path: string;
};

function toRecord(row: typeof backup.$inferSelect): ManagedBackupRecord {
  return {
    id: row.backupId,
    createdAt: row.createdAt,
    managedId: row.managedId,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    ...(row.database !== null ? { database: row.database } : {}),
    path: row.path,
  };
}

/** Validate daemon-reported backup fields before they reach the DB's own CHECK constraints. */
export function isValidBackupId(id: string): boolean {
  return id.length > 0 && SAFE_BACKUP_ID_RE.test(id);
}

export function isValidBackupChecksum(checksum: string): boolean {
  return CHECKSUM_SHA256_RE.test(checksum);
}

export async function insertManagedBackup(
  db: Db,
  params: {
    id: string;
    managedId: string;
    sizeBytes: number;
    checksum: string;
    database?: string;
    path: string;
    /** Daemon-reported completion time, when available; defaults to now(). */
    createdAt?: string;
  },
): Promise<ManagedBackupRecord> {
  const [row] = await db
    .insert(backup)
    .values({
      backupId: params.id,
      managedId: params.managedId,
      sizeBytes: params.sizeBytes,
      checksum: params.checksum,
      database: params.database ?? null,
      path: params.path,
      ...(params.createdAt !== undefined
        ? { createdAt: params.createdAt }
        : {}),
    })
    .onConflictDoNothing({ target: [backup.managedId, backup.backupId] })
    .returning();
  if (row) return toRecord(row);

  // Idempotent retry of a completed create (e.g. a redelivered command) lands
  // on the same (engine, id) — return the existing row rather than erroring.
  // Scoped by engine on purpose: another organization's engine reporting the
  // same string is a different row, never this one.
  const [existing] = await db
    .select()
    .from(backup)
    .where(and(eq(backup.managedId, params.managedId), eq(backup.backupId, params.id)))
    .limit(1);
  if (!existing) throw new Error(`backup insert failed (id=${params.id})`);
  return toRecord(existing);
}

/** Newest first, matching `sortManagedBackupsDesc`'s prior ordering. */
export async function listManagedBackups(
  db: Db,
  managedId: string,
): Promise<ManagedBackupRecord[]> {
  const rows = await db
    .select()
    .from(backup)
    .where(eq(backup.managedId, managedId))
    .orderBy(desc(backup.createdAt));
  return rows.map(toRecord);
}

export async function findManagedBackupById(
  db: Db,
  managedId: string,
  backupId: string,
): Promise<ManagedBackupRecord | undefined> {
  const [row] = await db
    .select()
    .from(backup)
    .where(and(eq(backup.managedId, managedId), eq(backup.backupId, backupId)))
    .limit(1);
  return row ? toRecord(row) : undefined;
}

export async function deleteManagedBackup(
  db: Db,
  managedId: string,
  backupId: string,
): Promise<void> {
  await db
    .delete(backup)
    .where(and(eq(backup.managedId, managedId), eq(backup.backupId, backupId)));
}
