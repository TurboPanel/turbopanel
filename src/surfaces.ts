/** Versioned API/WS surface prefixes. */
export const HEALTH_PATH = '/api/health'
export const CLIENT_API_PREFIX = '/api/client/v1'
export const DEVELOPER_API_PREFIX = '/api/developer/v1'
export const DAEMON_API_PREFIX = '/api/daemon/v1'
export const INSTALL_API_PREFIX = '/api/install/v1'
export const ADMIN_API_PREFIX = '/api/admin/v1'
/**
 * Inbound Git provider webhooks. Deliberately **outside**
 * {@link CLIENT_API_PREFIX}: the sender is GitHub, not a browser session and
 * not an enrolled daemon, so the surface authenticates itself with an HMAC
 * signature (`X-Hub-Signature-256`) instead of a session cookie or daemon JWT.
 * See `src/client/git/AGENTS.md`.
 */
export const GITHUB_WEBHOOK_PATH = '/api/git/v1/github/webhook'
/**
 * GitLab's sibling surface. Same reasoning as {@link GITHUB_WEBHOOK_PATH} and
 * the same gate order, with one weaker credential: GitLab does not sign
 * deliveries, so the route authenticates on the static `X-Gitlab-Token` header
 * instead of an HMAC over the body (`src/lib/git/gitlab-webhook.ts`).
 */
export const GITLAB_WEBHOOK_PATH = '/api/git/v1/gitlab/webhook'
export const CLIENT_WS_PATH = '/ws/client/v1'
export const DEVELOPER_WS_PATH = '/ws/developer/v1'
export const DAEMON_WS_PATH = '/ws/daemon/v1'
