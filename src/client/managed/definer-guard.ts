import type { ManagedPermissionsProbeOutcome } from './permissions-probe.ts'

/**
 * A MySQL or MariaDB login that is still the definer of views, triggers,
 * routines or events cannot be deleted: the things it defines stop working
 * and a view with a missing definer breaks every later backup. The host lists
 * them in its permissions read; this turns that list into the plain 409 body.
 *
 * Returns `null` when nothing blocks the delete, including when the host could
 * not be asked (offline, older version, timeout): the host refuses the drop
 * itself in that case.
 */
export function loginDefinesObjectsRefusal(
  outcome: ManagedPermissionsProbeOutcome,
  appliedUsername: string
): { error: string; message: string; objects: string[] } | null {
  if (outcome.status !== 'observed') return null
  const found = outcome.permissions.logins.find((entry) => entry.username === appliedUsername)
  const objects = found?.definesObjects
  if (!objects || objects.length === 0) return null
  return {
    error: 'managed_login_defines_objects',
    message: `The login '${appliedUsername}' is still the definer of ${objects.join(', ')}. Those stop working once the login is gone, and a view whose definer is gone breaks every later backup. Drop them or recreate them under another login, then delete the login again.`,
    objects,
  }
}
