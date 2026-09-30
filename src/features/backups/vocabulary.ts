/**
 * Checked vocabularies for `retention` / `snapshot`.
 *
 * The `CHECK` lists in `src/db/schema.ts` are pinned to these arrays by
 * `src/db/enum-checks.test.ts`. Add a member in both places.
 */

/** What a backup policy points at: a managed engine or one local storage copy. */
export const BACKUP_TARGET_KINDS = ['managed', 'copy'] as const

export type BackupTargetKind = (typeof BACKUP_TARGET_KINDS)[number]

/** How a scheduled run ended, as the host reported it. */
export const BACKUP_RUN_STATUSES = ['succeeded', 'failed'] as const

export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number]

/** Bound on a policy's `retention_keep`; matches `retention_retention_keep_check`. */
export const MAX_BACKUP_POLICY_RETENTION_KEEP = 100
