/**
 * Telling people when the place an organization's backups are copied to
 * changes.
 *
 * Moving a backup target to another endpoint, bucket or set of keys, or
 * pointing the organization default or a cluster at another target, sends
 * every later copy somewhere else. That is a security change, so it is
 * audited with what moved (never a secret or an access key value) and raised
 * as the urgent `backup.target_changed` notice for owners, managers and
 * instance administrators. A rename, or a setting that does not move the
 * data, is audited and raises nothing.
 *
 * The describe helpers are pure. `recordBackupTargetChange` writes the audit
 * row and, only when something moved, the notice; neither ever fails the
 * request.
 *
 * Workers-bundle safe: no `@std/*`, nothing evaluated at module load.
 */
import type { Context } from 'hono'
import type { AuditEntry } from '../audit/audit-records.ts'
import { recordAudit } from '../audit/audit-records.ts'
import { type AuditNotifyEnv, notifyFromAudit } from '../notifications/audit-bridge.ts'
import type { NotificationContext } from '../notifications/events.ts'
import { type BackupTargetRow, NO_COPY } from './targets.ts'

export const BACKUP_TARGET_CHANGED_EVENT = 'backup.target_changed' as const

/** The settings of a target that decide where its copies land and who can reach them. */
export type TargetPlace = {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  pathStyle: boolean
  accessKeyId: string
}

export function targetPlaceOf(row: BackupTargetRow): TargetPlace {
  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    pathStyle: row.isPathStyle,
    accessKeyId: row.accessKeyId,
  }
}

/** The host (and port) of an endpoint URL, never a user name or password; the raw text when it does not parse. */
export function endpointHost(endpoint: string): string {
  try {
    const host = new URL(endpoint).host
    return host.length > 0 ? host : endpoint
  } catch {
    return endpoint
  }
}

/**
 * What moved between two versions of a target, as small non-secret facts, or
 * null when nothing that moves the data changed (a rename alone, or the
 * encryption flag). The access key id itself is never included, only that it
 * changed; the secret is reported as replaced, never shown.
 */
export function describeBackupTargetChange(
  before: TargetPlace,
  after: TargetPlace,
  secretReplaced: boolean
): NotificationContext | null {
  const change: NotificationContext = {}
  const hostBefore = endpointHost(before.endpoint)
  const hostAfter = endpointHost(after.endpoint)
  if (before.endpoint !== after.endpoint) {
    change.endpointBefore = hostBefore
    change.endpointAfter = hostAfter
  }
  for (const field of ['bucket', 'region', 'prefix'] as const) {
    if (before[field] !== after[field]) {
      change[`${field}Before`] = before[field]
      change[`${field}After`] = after[field]
    }
  }
  if (before.pathStyle !== after.pathStyle) change.pathStyle = after.pathStyle
  const accessKeyChanged = before.accessKeyId !== after.accessKeyId
  if (Object.keys(change).length === 0 && !accessKeyChanged && !secretReplaced) return null
  return { ...change, accessKeyChanged, secretReplaced }
}

/** True when an assignment now names another target, or none where it named one (or the reverse). */
export function assignmentMoved(before: string | null, after: string | null): boolean {
  return (before?.toLowerCase() ?? null) !== (after?.toLowerCase() ?? null)
}

/**
 * The words for one side of an assignment: a target's name, "no copy", or
 * (for a cluster with no choice of its own) the organization default.
 */
export function assignmentLabel(
  choice: string | null,
  targetNames: ReadonlyMap<string, string>,
  scope: 'organization' | 'cluster'
): string {
  if (choice === null) return scope === 'cluster' ? 'the organization default' : 'no backup target'
  if (choice === NO_COPY) return 'no backup target'
  return targetNames.get(choice.toLowerCase()) ?? 'a backup target that no longer exists'
}

/**
 * The notice for an assignment, or null when it still names the same thing.
 * `before` and `after` are the stored choices: a target id, `none`, or null
 * (no default for the organization; the organization default for a cluster).
 */
export function assignmentNotice(params: {
  scope: 'organization' | 'cluster'
  before: string | null
  after: string | null
  targetNames: ReadonlyMap<string, string>
  clusterName?: string | null
}): NotificationContext | null {
  const { scope, before, after, targetNames } = params
  if (!assignmentMoved(before, after)) return null
  return {
    kind: 'assign',
    scope,
    ...(scope === 'cluster' ? { clusterName: params.clusterName ?? null } : {}),
    before: assignmentLabel(before, targetNames, scope),
    after: assignmentLabel(after, targetNames, scope),
    afterNone: after === NO_COPY || (scope === 'organization' && after === null),
  }
}

/**
 * Write the audit row; when `notice` is not null, raise `backup.target_changed`
 * with it. Never throws: the audit write and the emitter both swallow their
 * own failures, and anything else is caught here.
 */
export async function recordBackupTargetChange(
  c: Context<AuditNotifyEnv>,
  entry: AuditEntry,
  notice: NotificationContext | null
): Promise<void> {
  await recordAudit(c.get('db'), entry)
  if (notice === null) return
  await notifyFromAudit(c, BACKUP_TARGET_CHANGED_EVENT, entry, notice).catch(() => undefined)
}
