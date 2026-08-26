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
 * Per-app GitHub ingress, and the URL every registered App is actually handed.
 *
 * An instance may hold several GitHub Apps, so a delivery has to name its app
 * before the surface knows which secret to verify it with. The `:ref` segment
 * is the app's `gitapp.webhook_ref`, baked into the App's webhook URL at
 * registration (`hook_attributes.url` in the manifest, or
 * `PATCH /app/hook/config` afterwards).
 *
 * {@link GITHUB_WEBHOOK_PATH} stays registered as a fallback for an App that
 * was configured by hand against the bare URL: those resolve by
 * `X-GitHub-Hook-Installation-Target-ID` instead. See
 * `src/lib/git/resolve-webhook-app.ts`.
 */
export const GITHUB_WEBHOOK_SCOPED_PATH = '/api/git/v1/github/webhook/:ref'
/**
 * GitLab's sibling surface. Same reasoning as {@link GITHUB_WEBHOOK_PATH} and
 * the same gate order, with one weaker credential: GitLab does not sign
 * deliveries, so the route authenticates on the static `X-Gitlab-Token` header
 * instead of an HMAC over the body (`src/lib/git/gitlab-webhook.ts`).
 */
export const GITLAB_WEBHOOK_PATH = '/api/git/v1/gitlab/webhook'
/**
 * Per-app GitLab ingress; {@link GITHUB_WEBHOOK_SCOPED_PATH}'s counterpart.
 *
 * GitLab hooks are created per project, so this is the URL written into every
 * project hook. Deliveries on the bare path fall back to a digest lookup of the
 * presented `X-Gitlab-Token`.
 */
export const GITLAB_WEBHOOK_SCOPED_PATH = '/api/git/v1/gitlab/webhook/:ref'
export const CLIENT_WS_PATH = '/ws/client/v1'
export const DEVELOPER_WS_PATH = '/ws/developer/v1'
export const DAEMON_WS_PATH = '/ws/daemon/v1'
