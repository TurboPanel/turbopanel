/**
 * Stable rate-limit keys shared by Workers and the Deno Redis limiter.
 * Key on serverId / licenseId — never IP (Cloudflare Rate Limiting best practice).
 * Anonymous enrollment challenges (`POST /auth/challenge` with no serverId/keyId)
 * use {@link DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID} via
 * {@link daemonEnrollChallengeRateLimitKey}.
 * Metrics uses a dedicated limiter + {@link daemonMetricsRateLimitKey}, and
 * container-log ingest uses its own limiter +
 * {@link daemonContainerLogsRateLimitKey} — batched container output is far
 * burstier than any other daemon REST route and must not spend the shared REST
 * budget that enroll/session/decrypt depend on.
 */

export type DaemonRestRateLimitRoute =
  | "auth-challenge"
  | "enroll"
  | "auth-session"
  | "commands-lease"
  | "secrets-decrypt"
  | "secrets-rehydrate"
  | "commands-log";

/** Sentinel id for anonymous enrollment-challenge REST limiting (no serverId). */
export const DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID = "enroll-challenge";

export function daemonConnectRateLimitKey(serverId: string): string {
  return `daemon:connect:${serverId}`;
}

export function daemonRestRateLimitKey(
  id: string,
  route: DaemonRestRateLimitRoute,
): string {
  return `daemon:rest:${route}:${id}`;
}

/** Per-server key for `POST /metrics` (dedicated metrics limiter). */
export function daemonMetricsRateLimitKey(serverId: string): string {
  return `daemon:metrics:${serverId}`;
}

/** Per-server key for `POST /logs/containers` (dedicated container-log limiter). */
export function daemonContainerLogsRateLimitKey(serverId: string): string {
  return `daemon:container-logs:${serverId}`;
}

/** Global key for empty-body / enrollment-style `POST /auth/challenge`. */
export function daemonEnrollChallengeRateLimitKey(): string {
  return daemonRestRateLimitKey(
    DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID,
    "auth-challenge",
  );
}
