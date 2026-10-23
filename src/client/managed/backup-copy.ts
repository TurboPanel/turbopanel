/**
 * The off-server copy of a managed backup, seen from the managed routes: the
 * target a new backup is copied to, the target a delete should also clean,
 * and the bucket copy a restore can pull onto another host.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import type { BackupCopyTargetWire } from '../../contracts/commands/schemas.ts'
import { type BackupCopyRecord, findCopy } from '../../features/backups/copy-records.ts'
import {
  copyRecipientFor,
  findTarget,
  readAssignments,
  resolveEffectiveTarget,
  toWireTarget,
} from '../../features/backups/targets.ts'
import type { ManagedBackupRecord } from '../../features/backups/backup-records.ts'
import { copyDepsOf } from '../backup-copy-deps.ts'
import { refuseRestoreIfBackupOnOtherServer } from './backups.ts'
import { parseJsonBody } from '../shared.ts'

/** The wire target for a host, or undefined when no target applies or the host cannot take one yet. */
async function wireFor(
  c: Context<AppEnv>,
  db: Db,
  targetRow: Parameters<typeof toWireTarget>[0],
  serverId: string
): Promise<BackupCopyTargetWire | undefined> {
  const deps = copyDepsOf(c)
  const recipient = await copyRecipientFor(db, serverId)
  if (!deps || !recipient) return undefined
  return await toWireTarget(targetRow, recipient, deps)
}

/** The target a new manual backup of this cluster is copied to, if any. */
export async function copyTargetForNewBackup(
  c: Context<AppEnv>,
  db: Db,
  managedId: string,
  serverId: string
): Promise<BackupCopyTargetWire | undefined> {
  const choice = await resolveEffectiveTarget(db, managedId)
  return choice.target ? await wireFor(c, db, choice.target, serverId) : undefined
}

/** A bucket copy that exists (or is on its way), with the target it went to. */
export async function liveCopyOf(
  db: Db,
  organizationId: string,
  managedId: string,
  backupId: string
): Promise<{
  copy: BackupCopyRecord
  target: NonNullable<Awaited<ReturnType<typeof findTarget>>>
} | null> {
  const copy = await findCopy(db, managedId, backupId)
  if (!copy?.destinationId || copy.state === 'failed' || copy.state === 'removed') return null
  const target = await findTarget(db, organizationId, copy.destinationId)
  return target ? { copy, target } : null
}

/** The wire target for deleting a backup's bucket copy along with it. */
export async function copyTargetForDelete(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  managedId: string,
  backupId: string,
  serverId: string
): Promise<BackupCopyTargetWire | undefined> {
  const live = await liveCopyOf(db, organizationId, managedId, backupId)
  return live ? await wireFor(c, db, live.target, serverId) : undefined
}

export type RestoreFromCopy =
  | { ok: true; source: { target: BackupCopyTargetWire; key: string } }
  | { ok: false; error: 'backup_copy_not_ready' | 'backup_copy_unavailable'; message: string }

/** What a restore from the bucket needs: a finished copy, and a host that can open its key. */
export async function restoreSourceFromCopy(
  c: Context<AppEnv>,
  db: Db,
  params: { organizationId: string; managedId: string; backupId: string; serverId: string }
): Promise<RestoreFromCopy> {
  const live = await liveCopyOf(db, params.organizationId, params.managedId, params.backupId)
  if (live?.copy.state !== 'copied' || !live.copy.objectKey) {
    return {
      ok: false,
      error: 'backup_copy_not_ready',
      message: 'This backup has no finished copy in the bucket yet.',
    }
  }
  const target = await wireFor(c, db, live.target, params.serverId)
  if (!target) {
    return {
      ok: false,
      error: 'backup_copy_unavailable',
      message:
        'The server cannot read from the bucket yet. Update the server software, then try again.',
    }
  }
  return { ok: true, source: { target, key: live.copy.objectKey } }
}

/** Whether a restore request body asks for the bucket copy (`{ "fromCopy": true }`). An empty or unreadable body means no. */
export async function wantsRestoreFromCopy(c: Context<AppEnv>): Promise<boolean> {
  const body = await parseJsonBody(c)
  return !(body instanceof Response) && body.fromCopy === true
}

/** Where a cluster's backups are copied, in plain fields (never keys): its own choice, the organization default, or nowhere. */
export async function describeClusterBackupTarget(
  db: Db,
  managedId: string,
  organizationId: string
) {
  const [choice, assignments] = await Promise.all([
    resolveEffectiveTarget(db, managedId, organizationId),
    readAssignments(db, organizationId),
  ])
  const own = assignments.clusters.find((cluster) => cluster.managedId === managedId)
  const target = choice.target
  let ownChoice = 'inherit'
  if (own) ownChoice = own.destinationId ? 'target' : 'none'
  return {
    source: choice.source,
    /** `inherit` follows the organization default; `none` turns copying off for this cluster; `target` is its own pick. */
    choice: ownChoice,
    target: target
      ? {
          id: target.id,
          name: target.name,
          bucket: target.bucket,
          prefix: target.prefix,
          lastTestOk: target.isLastTestOk,
          lastTestedAt: target.lastTestedAt,
        }
      : null,
  }
}

/**
 * The 409 for a restore of a backup made on another host, or null. Skipped when
 * the request asks for the bucket copy; otherwise the refusal says whether a
 * finished copy could be restored here instead.
 */
export async function refuseWrongHostRestore(
  c: Context<AppEnv>,
  db: Db,
  params: {
    fromCopy: boolean
    organizationId: string
    managedId: string
    record: ManagedBackupRecord
    targetServerId: string
  }
): Promise<Response | null> {
  if (params.fromCopy) return null
  const copyLive = await liveCopyOf(db, params.organizationId, params.managedId, params.record.id)
  return await refuseRestoreIfBackupOnOtherServer(
    c,
    db,
    params.record,
    params.targetServerId,
    copyLive?.copy.state === 'copied'
  )
}

/** What a restore reads from the bucket, undefined when it is not asked for, or the 409 explaining why the copy cannot be used. */
export async function copySourceForRestore(
  c: Context<AppEnv>,
  db: Db,
  params: {
    fromCopy: boolean
    organizationId: string
    managedId: string
    backupId: string
    serverId: string
  }
): Promise<Response | { target: BackupCopyTargetWire; key: string } | undefined> {
  if (!params.fromCopy) return undefined
  const source = await restoreSourceFromCopy(c, db, params)
  if (!source.ok) return c.json({ error: source.error, message: source.message }, 409)
  return source.source
}
