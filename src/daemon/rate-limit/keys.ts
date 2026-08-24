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

/**
 * Key for the inbound GitHub webhook surface.
 *
 * The rest of this file keys on `serverId` / `licenseId` and never on IP,
 * because an enrolled daemon always has an identity to spend. A webhook has
 * none: the limiter has to run **before** the HMAC is verified (that is the
 * point — verification is the expensive work being protected), and at that
 * moment the only thing distinguishing one caller from another is where it
 * dialed from. The bucket is therefore per-peer and deliberately generous
 * enough for GitHub's own delivery bursts; it exists to cap a flood, not to
 * pace a healthy sender.
 *
 * `peer` is the resolved client address, or the literal `unknown` when the
 * runtime cannot report one — every anonymous caller then shares one bucket,
 * which is the conservative direction.
 */
export function githubWebhookRateLimitKey(peer: string): string {
  return gitWebhookRateLimitKey("github", peer);
}

/**
 * Key for the inbound GitLab webhook surface.
 *
 * A separate bucket from GitHub's on purpose: the two surfaces are independent
 * senders, and a burst from one must not spend the other's budget — a GitLab
 * runner fanning out pipeline hooks should never be able to make GitHub
 * deliveries start bouncing.
 */
export function gitlabWebhookRateLimitKey(peer: string): string {
  return gitWebhookRateLimitKey("gitlab", peer);
}

function gitWebhookRateLimitKey(provider: string, peer: string): string {
  const id = peer.trim().length > 0 ? peer.trim() : "unknown";
  return `git:webhook:${provider}:${id}`;
}
