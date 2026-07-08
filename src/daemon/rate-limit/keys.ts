/**
 * Stable rate-limit keys shared by Workers and the Deno Redis limiter.
 * Key on serverId / licenseId — never IP (Cloudflare Rate Limiting best practice).
 * Anonymous enrollment challenges (`POST /auth/challenge` with no serverId/keyId)
 * use {@link DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID} via
 * {@link daemonEnrollChallengeRateLimitKey}.
 */

export type DaemonRestRateLimitRoute =
  | 'auth-challenge'
  | 'enroll'
  | 'auth-session'
  | 'commands-lease'
  | 'secrets-decrypt'

/** Sentinel id for anonymous enrollment-challenge REST limiting (no serverId). */
export const DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID = 'enroll-challenge'

export function daemonConnectRateLimitKey(serverId: string): string {
  return `daemon:connect:${serverId}`
}

export function daemonRestRateLimitKey(
  id: string,
  route: DaemonRestRateLimitRoute,
): string {
  return `daemon:rest:${route}:${id}`
}

/** Global key for empty-body / enrollment-style `POST /auth/challenge`. */
export function daemonEnrollChallengeRateLimitKey(): string {
  return daemonRestRateLimitKey(
    DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID,
    'auth-challenge',
  )
}
