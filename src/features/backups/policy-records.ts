/**
 * `retention` / `snapshot` reads and writes for managed-engine targets.
 *
 * A policy belongs to one managed engine; its host is that engine's
 * `managed.server_id`, resolved when the policy set is pushed
 * (`./reconcile.ts`), never stored on the policy.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { retention, snapshot } from '../../db/schema.ts'
import { isUuid } from '../principals/store.ts'
import type { BackupRunStatus } from './vocabulary.ts'

/** Policies one managed engine may carry; far above any real schedule list. */
export const MAX_BACKUP_POLICIES_PER_MANAGED = 20

/** Rows a run-history read returns at most. */
export const MAX_BACKUP_RUNS_PAGE = 100

export type BackupPolicyRow = typeof retention.$inferSelect

export type BackupRunRecord = {
  runId: string
  serverId: string
  startedAt: string
  finishedAt: string
  status: BackupRunStatus
  error: string | null
  backupId: string | null
}

export type NewManagedBackupPolicy = {
  organizationId: string
  managedId: string
  name: string
  schedule: string
  timezone: string | null
  retentionKeep: number
  isEnabled: boolean
  createdBy: string | null
}

export type BackupPolicyPatch = Partial<
  Pick<BackupPolicyRow, 'name' | 'schedule' | 'timezone' | 'retentionKeep' | 'isEnabled'>
>

function toRunRecord(row: typeof snapshot.$inferSelect): BackupRunRecord {
  return {
    runId: row.runId,
    serverId: row.serverId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    status: row.status as BackupRunStatus,
    error: row.error,
    backupId: row.backupRef,
  }
}

export async function listBackupPoliciesForManaged(
  db: Db,
  managedId: string
): Promise<BackupPolicyRow[]> {
  return await db
    .select()
    .from(retention)
    .where(and(eq(retention.managedId, managedId), eq(retention.targetKind, 'managed')))
    .orderBy(asc(retention.createdAt))
}

/** A path id that is not a uuid is simply not found (Postgres would reject the cast). */
export async function findBackupPolicyForManaged(
  db: Db,
  managedId: string,
  policyId: string
): Promise<BackupPolicyRow | null> {
  if (!isUuid(policyId)) return null
  const [row] = await db
    .select()
    .from(retention)
    .where(and(eq(retention.id, policyId), eq(retention.managedId, managedId)))
    .limit(1)
  return row ?? null
}

/** Whether any policy targets this engine — decides if its host needs a new set. */
export async function managedHasBackupPolicies(db: Db, managedId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: retention.id })
    .from(retention)
    .where(eq(retention.managedId, managedId))
    .limit(1)
  return row !== undefined
}

export async function insertManagedBackupPolicy(
  db: Db,
  values: NewManagedBackupPolicy
): Promise<BackupPolicyRow> {
  const [row] = await db
    .insert(retention)
    .values({ ...values, targetKind: 'managed' })
    .returning()
  if (!row) throw new Error('backup policy insert returned no row')
  return row
}

export async function updateBackupPolicy(
  db: Db,
  policyId: string,
  patch: BackupPolicyPatch
): Promise<BackupPolicyRow | null> {
  const [row] = await db.update(retention).set(patch).where(eq(retention.id, policyId)).returning()
  return row ?? null
}

export async function deleteBackupPolicy(db: Db, policyId: string): Promise<void> {
  await db.delete(retention).where(eq(retention.id, policyId))
}

/** A policy's runs, newest first. */
export async function listBackupRuns(
  db: Db,
  policyId: string,
  limit: number
): Promise<BackupRunRecord[]> {
  const rows = await db
    .select()
    .from(snapshot)
    .where(eq(snapshot.retentionId, policyId))
    .orderBy(desc(snapshot.startedAt))
    .limit(Math.min(Math.max(1, limit), MAX_BACKUP_RUNS_PAGE))
  return rows.map(toRunRecord)
}

/** The newest run of each policy, keyed by policy id; policies without a run are absent. */
export async function latestBackupRuns(
  db: Db,
  policyIds: readonly string[]
): Promise<Map<string, BackupRunRecord>> {
  const latest = new Map<string, BackupRunRecord>()
  if (policyIds.length === 0) return latest
  const rows = await db
    .selectDistinctOn([snapshot.retentionId])
    .from(snapshot)
    .where(inArray(snapshot.retentionId, [...policyIds]))
    .orderBy(snapshot.retentionId, desc(snapshot.startedAt))
  for (const row of rows) latest.set(row.retentionId, toRunRecord(row))
  return latest
}
