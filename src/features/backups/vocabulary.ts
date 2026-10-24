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

/**
 * The folders of the backup root the host keeps (`managed/<id>`, `volumes/<id>`,
 * `panel/<id>`); a stored artifact path is relative to that root.
 */
export const BACKUP_ROOT_FOLDERS = { managed: 'managed', copy: 'volumes', panel: 'panel' } as const

/**
 * An artifact path relative to the backup root. A host may still report the
 * absolute spelling (`<root>/managed/<id>/...`); it is cut down to the part
 * below the root. Anything that is not under `<folder>/<id>/` comes back as it
 * was, so a refusal can name it.
 */
export function backupRelativePath(path: string, kind: 'managed' | 'copy', id: string): string {
  const marker = `${BACKUP_ROOT_FOLDERS[kind]}/${id}/`
  if (path.startsWith(marker)) return path
  const cut = path.lastIndexOf(`/${marker}`)
  return cut < 0 ? path : path.slice(cut + 1)
}

/** Where a backup can be copied to. Only S3-compatible object storage for now. */
export const BACKUP_TARGET_STORE_KINDS = ['s3'] as const

export type BackupTargetStoreKind = (typeof BACKUP_TARGET_STORE_KINDS)[number]

/**
 * How copying one backup to its target stands. `pending` waits for the host,
 * `copying` is uploading, `copied` is safe in the bucket, `failed` carries a
 * plain reason, `removed` was pruned from the bucket by retention.
 */
export const BACKUP_COPY_STATES = ['pending', 'copying', 'copied', 'failed', 'removed'] as const

export type BackupCopyState = (typeof BACKUP_COPY_STATES)[number]
