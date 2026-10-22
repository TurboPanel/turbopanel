import type { ManagedPermissionsProbeOutcome } from './permissions-probe.ts'

/**
 * A MySQL or MariaDB login that still owns views, triggers, routines or events
 * cannot be deleted: they stop working and a view with a missing owner breaks
 * every later backup. The host lists them in its permissions read; this turns
 * that answer into a plain refusal, a plain "could not check", or a go-ahead.
 */

/** A short wait: the operator is clicking Delete, not reading a report. */
export const MANAGED_LOGIN_CHECK_TIMEOUT_MS = 5_000

export type LoginDeleteCheck =
  | {
      kind: 'refuse'
      status: 409 | 503
      body: { error: string; message: string; objects?: string[] }
    }
  | { kind: 'proceed'; note?: string }

const checkFailed = (): LoginDeleteCheck => ({
  kind: 'refuse',
  status: 503,
  body: {
    error: 'managed_login_check_failed',
    message:
      'Could not check whether this login still owns views or routines. Try again in a moment.',
  },
})

const quoted = (names: readonly string[]) => names.map((name) => `'${name}'`).join(', ')

/**
 * Decide whether a login may be deleted. Fails closed when the host was asked
 * and did not answer (timeout, error, unreadable answer). Proceeds, with a
 * plain note, when the host is offline or too old to ask (it refuses the drop
 * itself), and silently for Postgres, which has no such check.
 */
export async function checkLoginMayBeDeleted(
  engine: string,
  appliedUsername: string,
  probe: () => Promise<ManagedPermissionsProbeOutcome>
): Promise<LoginDeleteCheck> {
  if (engine === 'postgres') return { kind: 'proceed' }
  const outcome = await probe()
  if (outcome.status === 'observed') {
    const found = outcome.permissions.logins.find((entry) => entry.username === appliedUsername)
    const objects = found?.definesObjects
    if (found?.definesObjectsUnread && (!objects || objects.length === 0)) {
      return checkFailed()
    }
    if (!objects || objects.length === 0) return { kind: 'proceed' }
    return {
      kind: 'refuse',
      status: 409,
      body: {
        error: 'managed_login_defines_objects',
        message: `The login '${appliedUsername}' still owns views, routines, triggers or events (${quoted(objects)}). Move or drop them first, then delete the login.`,
        objects,
      },
    }
  }
  if (
    outcome.status === 'unsupported' ||
    (outcome.status === 'unavailable' &&
      (outcome.reason === 'offline' || outcome.reason === 'no_registry'))
  ) {
    return {
      kind: 'proceed',
      note: 'Could not check whether this login still owns views or routines because the server could not be asked; the server refuses the delete itself if it does.',
    }
  }
  return checkFailed()
}
