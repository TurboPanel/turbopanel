/**
 * When a server that failed to update is tried again. Host-free.
 *
 * Nobody retries a step by hand any more. A server whose step for a build ended
 * `failed`, `rolled_back` or `needs_attention` is tried again by a later
 * automatic run, but only once its backoff has passed: one hour after the
 * first failure for that build, then two, four, eight… capped at one day. The
 * count is per server, unit and target commit, so a new build starts the count
 * over. Retries never stop for good; the cap keeps a broken host to one try a
 * day.
 */

export const UPGRADE_RETRY_BASE_MS = 60 * 60 * 1000

export const UPGRADE_RETRY_MAX_MS = 24 * 60 * 60 * 1000

/** Earlier failed attempts of one server and unit at one target commit. */
export type UpgradeFailureHistory = {
  failures: number
  /** When the latest of them ended (ISO). */
  lastFailedAt: string | null
}

/** How long after the latest failure the next try may start. */
export function upgradeRetryDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures < 1) return 0
  const exponent = Math.min(Math.floor(failures) - 1, 10)
  return Math.min(UPGRADE_RETRY_BASE_MS * 2 ** exponent, UPGRADE_RETRY_MAX_MS)
}

/**
 * The time before which this server must not be tried again, or null when it
 * may be tried now (no failures, or an unreadable failure time).
 */
export function upgradeRetryNotBefore(
  history: UpgradeFailureHistory | undefined,
  now: Date
): Date | null {
  if (!history || history.failures < 1) return null
  const last = Date.parse(history.lastFailedAt ?? '')
  if (!Number.isFinite(last)) return null
  const notBefore = last + upgradeRetryDelayMs(history.failures)
  return notBefore > now.getTime() ? new Date(notBefore) : null
}

/** The key the store groups failure history by. */
export function upgradeFailureKey(serverId: string, unit: string): string {
  return `${serverId}:${unit}`
}
