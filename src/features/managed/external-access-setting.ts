/**
 * The stored shape of the per-server "allow external access to the databases on
 * this server" setting. Pure, so low-level server option parsing can use it.
 * See `external-access.ts` for what it means.
 */

/** Key on `server.options`. */
export const MANAGED_EXTERNAL_ACCESS_KEY = 'managedExternalAccess'

/**
 * The stored setting. `enabled` absent or malformed reads as `false`.
 * `pendingSince` is when the server was last asked to listen this way and has
 * not yet confirmed.
 */
export type ManagedExternalAccess = { enabled: boolean; pendingSince?: string }

/** Lenient jsonb read: anything but `{ enabled: true }` is "no". */
export function parseManagedExternalAccess(value: unknown): ManagedExternalAccess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { enabled: false }
  }
  const raw = value as { enabled?: unknown; pendingSince?: unknown }
  const setting: ManagedExternalAccess = { enabled: raw.enabled === true }
  if (typeof raw.pendingSince === 'string' && !Number.isNaN(Date.parse(raw.pendingSince))) {
    setting.pendingSince = raw.pendingSince
  }
  return setting
}

/** Read the setting out of a `server.options` blob. */
export function readManagedExternalAccess(serverOptions: unknown): ManagedExternalAccess {
  if (typeof serverOptions !== 'object' || serverOptions === null) return { enabled: false }
  return parseManagedExternalAccess(
    (serverOptions as Record<string, unknown>)[MANAGED_EXTERNAL_ACCESS_KEY]
  )
}
