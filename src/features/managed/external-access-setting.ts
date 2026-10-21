/**
 * The stored shape of the per-server "allow external access to the databases on
 * this server" setting. Pure, so low-level server option parsing can use it.
 * See `external-access.ts` for what it means.
 */

/** Key on `server.options`. */
export const MANAGED_EXTERNAL_ACCESS_KEY = 'managedExternalAccess'

/**
 * The setting. `enabled` (stored in `server.options`) absent or malformed
 * reads as `false`. `pendingSince` (the column `server.external_access_pending_at`)
 * is when the server was last asked to listen this way and has not yet confirmed.
 */
export type ManagedExternalAccess = { enabled: boolean; pendingSince?: string }

/** Lenient jsonb read: anything but `{ enabled: true }` is "no". */
export function parseManagedExternalAccess(value: unknown): ManagedExternalAccess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { enabled: false }
  }
  const raw = value as { enabled?: unknown }
  return { enabled: raw.enabled === true }
}

/** Read the setting out of a `server.options` blob plus the pending column. */
export function readManagedExternalAccess(
  serverOptions: unknown,
  pendingAt?: string | null
): ManagedExternalAccess {
  const setting: ManagedExternalAccess =
    typeof serverOptions !== 'object' || serverOptions === null
      ? { enabled: false }
      : parseManagedExternalAccess(
          (serverOptions as Record<string, unknown>)[MANAGED_EXTERNAL_ACCESS_KEY]
        )
  if (pendingAt && !Number.isNaN(Date.parse(pendingAt))) {
    // The column reads back in the database's own text form; callers compare ISO marks.
    setting.pendingSince = new Date(pendingAt).toISOString()
  }
  return setting
}
