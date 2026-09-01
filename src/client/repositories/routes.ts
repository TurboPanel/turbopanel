/**
 * Git `repository` CRUD plus the provider connect flows (GitHub App installation,
 * GitLab OAuth) and the deploy-key minter.
 *
 * `repository` is an org-owned registry like `network` / `datacenter`, so authz is
 * a direct `organization_id` match plus an organization-level manage/read gate
 * — not the workspace→project ancestry walk used by the compose tree.
 * `assertNotSystemOwnedOr403` does not apply: repositories are never part of the
 * system-owned project tree.
 *
 * The inbound half of this feature is **not** here. Each provider's webhook
 * surface lives at `GITHUB_WEBHOOK_PATH` / `GITLAB_WEBHOOK_PATH`, outside
 * `CLIENT_API_PREFIX`, and authenticates with a provider secret rather than
 * a session or a daemon JWT — see `src/webhook/AGENTS.md`. What this file
 * contributes to it is {@link resolveSourceWebhookInfo}: the endpoint URL to
 * configure, plus a warning when this instance's public URL is one the provider
 * cannot reach.
 *
 * **Provider-specific handlers stay provider-specific.** The connect flows are
 * genuinely different shapes (an App install redirect versus an OAuth code
 * exchange) and are written out separately rather than forced through one
 * abstraction. What *is* shared runs through {@link resolveGitProvider}: the
 * repository picker, and everything deploy-prep does.
 */

import { and, eq, sql } from 'drizzle-orm'
import { inspectRepository } from './inspect.ts'
import { isSafeRoot } from '../../lib/compose/index.ts'
import { getDaemonCellRegistry } from '../../db.ts'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { getDb, type Db } from '../../db.ts'
import { logWarn } from '../../logger.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import {
  secret,
  forge,
  gitConnection,
  server,
  repository,
} from '../../lib/db/schema.ts'
import {
  type Forge,
  loadForge,
  visibleForgesCondition,
} from '../../lib/git/forge-records.ts'
import {
  webhookReachability,
  type WebhookProvider,
} from '../../lib/git/webhook-reachability.ts'
import {
  getPublicUrls,
  publicUrlEntryToInstallOrigin,
} from '../../admin/public-urls.ts'
import {
  GITHUB_API_BASE,
  githubApiBaseFor,
  githubApiHeaders,
  GithubAppTokenError,
  signGithubAppJwt,
} from '../../lib/git/github-app-token.ts'
import { resolveGitProvider } from '../../lib/git/git-provider.ts'
import { canonicalizeRepositoryUrl } from '../../lib/git/clone-url.ts'
import {
  exchangeGitlabAuthorizationCode,
  gitlabAuthorizeUrl,
  gitlabOauthCredentials,
  GitlabOauthTokenError,
  persistGitlabTokenPair,
} from '../../lib/git/gitlab-oauth-token.ts'
import { fetchGitlabAccount } from '../../lib/git/gitlab-provider.ts'
import { GitlabApiError } from '../../lib/git/gitlab-api.ts'
import { generateSshDeployKeypair } from '../../lib/git/ssh-keypair.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { canAccessOrganization } from '../org-context.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import {
  signGithubInstallState,
  signGitlabConnectState,
  verifyGithubInstallState,
  verifyGitlabConnectState,
} from './provider-install-state.ts'
import {
  providerInstallUiReturnPath,
  type ProviderInstallReturnError,
} from '../forges/routes-helpers.ts'
import {
  COMPOSE_SOURCE_JSONPATH,
  parseSourceAttachBody,
  GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER,
  parseSourceCreateBody,
  parseSourcePatchBody,
  readSourceMetadata,
  serializeConnectionRow,
  serializeSourceRow,
  type SourceWebhookInfo,
  SOURCE_DEPLOY_KEY_PROVIDERS,
  SOURCE_REFERENCED_BY_COMPOSE_ERROR,
  UUID_RE,
  type SourceProvider,
} from './routes-helpers.ts'

const SOURCE_SELECT = {
  id: repository.id,
  organizationId: repository.organizationId,
  connectionId: repository.connectionId,
  secretId: repository.secretId,
  provider: repository.provider,
  repositoryUrl: repository.repositoryUrl,
  repositoryExternalId: repository.repositoryExternalId,
  defaultBranch: repository.defaultBranch,
  subdirectory: repository.subdirectory,
  autoDeploy: repository.autoDeploy,
  metadata: repository.metadata,
  options: repository.options,
  createdAt: repository.createdAt,
  updatedAt: repository.updatedAt,
}

const CONNECTION_SELECT = {
  id: gitConnection.id,
  organizationId: gitConnection.organizationId,
  forgeId: gitConnection.forgeId,
  provider: gitConnection.provider,
  externalInstallationId: gitConnection.externalInstallationId,
  accountLogin: gitConnection.accountLogin,
  accountType: gitConnection.accountType,
  suspendedAt: gitConnection.suspendedAt,
  metadata: gitConnection.metadata,
  options: gitConnection.options,
  createdAt: gitConnection.createdAt,
  updatedAt: gitConnection.updatedAt,
}

type SourceSessionContext = {
  db: Db
  userId: string
  organizationId: string
}

export async function resolveSourceSession(
  c: Context<AppEnv>,
): Promise<SourceSessionContext | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  return { db, userId: session.userId, organizationId: orgResult }
}

/**
 * Callback-only session: db, the signed-in user, and signing/encryption
 * secrets — no organization header.
 *
 * GitHub's `setup_url` and GitLab's OAuth redirect are top-level browser
 * navigations. They carry a session cookie and a signed `state`, not
 * `X-Turbopanel-Organization-Id`. Organization comes from verified claims.
 */
type ProviderCallbackSession = {
  db: Db
  userId: string
  secretsConfig: SecretsConfig | undefined
  dataEncryptionSecrets: DerivedSecretsConfig | undefined
}

export async function resolveProviderCallbackSession(
  c: Context<AppEnv>,
): Promise<ProviderCallbackSession | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  return {
    db,
    userId: session.userId,
    secretsConfig: c.get('secretsConfig'),
    dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
  }
}

async function authorizeClaimedOrganization(
  c: Context<AppEnv>,
  db: Db,
  userId: string,
  organizationId: string,
): Promise<Response | null> {
  const allowed = await canAccessOrganization(db, userId, organizationId)
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)
  return assertCanManageOr403(c, 'organization', organizationId)
}

/**
 * Deleting a still-referenced repository would make every later save of that compose
 * fail the `knownSourceIds` lint, so it is a 409 instead. Reference detection
 * itself lives in {@link COMPOSE_SOURCE_JSONPATH}.
 */
export async function composeReferencesRepository(
  db: Db,
  organizationId: string,
  sourceId: string,
): Promise<boolean> {
  const rows = await db.execute<{ referenced: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM project p
      JOIN workspace w ON w.id = p.workspace_id
      WHERE w.organization_id = ${organizationId}::uuid
        AND jsonb_path_exists(p.options, ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
          jsonb_build_object('sid', ${sourceId}::text))
      UNION ALL
      SELECT 1
      FROM environment e
      JOIN project p ON p.id = e.project_id
      JOIN workspace w ON w.id = p.workspace_id
      WHERE w.organization_id = ${organizationId}::uuid
        AND jsonb_path_exists(e.options, ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
          jsonb_build_object('sid', ${sourceId}::text))
      UNION ALL
      -- project.repository_id is the binding itself, and its foreign key is
      -- ON DELETE RESTRICT. Checking it here is what turns a Postgres 23503
      -- into the same 409 every other reference already answers with.
      -- (No backticks in here: this is inside a JS template literal.)
      SELECT 1
      FROM project p
      JOIN workspace w ON w.id = p.workspace_id
      WHERE w.organization_id = ${organizationId}::uuid
        AND p.repository_id = ${sourceId}::uuid
      UNION ALL
      -- options.composeSource.sourceId records where a project compose was
      -- seeded from. Deleting the repository would silently orphan that
      -- provenance, and drift detection would go permanently unreadable.
      -- (No backticks in here: this is inside a JS template literal.)
      SELECT 1
      FROM project p
      JOIN workspace w ON w.id = p.workspace_id
      WHERE w.organization_id = ${organizationId}::uuid
        AND p.options -> 'composeSource' ->> 'sourceId' = ${sourceId}::text
    ) AS referenced
  `)
  return rows[0]?.referenced === true
}

/**
 * Ownership **and** provider compatibility for a named installation.
 *
 * Ownership is the security check: the FK alone would happily bind another
 * organization's connection to this repository, so a foreign row is reported as
 * `Not found` rather than `Forbidden` — the check leaks no existence signal.
 *
 * The provider check is the coherence one. A `provider: 'gitlab'` repository
 * pointing at a GitHub installation (or the reverse) is a row nothing can
 * clone: deploy-prep dispatches on `repository.provider`, so
 * `mintGitlabAccessToken` would be handed a row with no `oauth_envelope`, and
 * the operator would learn about it as a failed deploy on a host rather than as
 * a rejected write. The pair is settled here, at the write boundary, for the
 * same reason `assertProviderAuthShape` settles the installation/secret
 * exclusivity there. A mismatch is the caller's own
 * row, so it answers `400` with a specific code rather than hiding as a `404`.
 */
export async function assertConnectionInOrganization(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  connectionId: string | null,
  sourceProvider?: SourceProvider,
): Promise<Response | null> {
  if (!connectionId) return null
  const [row] = await db
    .select({
      organizationId: gitConnection.organizationId,
      provider: gitConnection.provider,
    })
    .from(gitConnection)
    .where(eq(gitConnection.id, connectionId))
    .limit(1)
  if (row?.organizationId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (sourceProvider !== undefined && row.provider !== sourceProvider) {
    return c.json({ error: 'source_installation_provider_mismatch' }, 400)
  }
  return null
}

/**
 * Ownership **and** secret-lane compatibility for a named secret.
 *
 * `secret` has no public CRUD, so a caller can only ever name a row it
 * learned about elsewhere — the id is still attacker-controlled, and the FK
 * alone would happily bind another organization's sealed deploy key to this
 * repository. Deploy-prep reads `repository.secretId` to clone, so ownership is
 * checked here, exactly like `connectionId`. A foreign row is reported as
 * `Not found` rather than `Forbidden` so the check leaks no existence signal.
 *
 * Ownership is not enough, though: `secret` is one table for every sealed
 * secret the organization holds, so an org-owned **storage** secret (an S3
 * key, an SFTP password) passes the ownership test and is still nothing a git
 * clone can use. Only the deploy-key lane may name one at all — `git` always,
 * and `gitlab` when it clones with a key instead of its OAuth connection — and
 * within that lane the row must be a `git_deploy_key`, because the daemon
 * writes the sealed plaintext straight to an identity file without parsing it.
 * Anything else stores a row whose first symptom is a checkout failure on a
 * host; rejecting it here keeps that a write-time `400`.
 */
export async function assertSecretInOrganization(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  secretId: string | null,
  sourceProvider: SourceProvider,
): Promise<Response | null> {
  if (!secretId) return null
  const [row] = await db
    .select({
      organizationId: secret.organizationId,
      provider: secret.provider,
    })
    .from(secret)
    .where(eq(secret.id, secretId))
    .limit(1)
  if (row?.organizationId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  // `assertProviderAuthShape` already refuses a secret on a `github`
  // repository; restated here so this function is safe to call on its own.
  if (!SOURCE_DEPLOY_KEY_PROVIDERS.has(sourceProvider)) {
    return c.json({ error: 'source_credential_not_supported' }, 400)
  }
  if (row.provider !== GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER) {
    return c.json({ error: 'source_credential_provider_mismatch' }, 400)
  }
  return null
}

/**
 * Map a provider-side failure onto an HTTP answer.
 *
 * `404` / `409` are ours to repeat (an unknown or suspended connection); every
 * other provider status collapses to `502`, because the caller asked *this*
 * instance for something and the upstream is what failed. Anything that is not
 * a recognised provider error rethrows — a bug here should surface as a 500,
 * not be laundered into a plausible-looking 502.
 */
export function providerErrorResponse(c: Context<AppEnv>, error: unknown): Response {
  const known = error instanceof GithubAppTokenError ||
    error instanceof GitlabOauthTokenError ||
    error instanceof GitlabApiError
  if (!known) throw error
  const status = error.status === 404 || error.status === 409 ? error.status : 502
  return c.json({ error: 'git_provider_request_failed', detail: error.message }, status)
}

/**
 * The registered app a connect flow was asked to run against.
 *
 * `?forgeId=` is required rather than defaulted, because "the" app no longer
 * exists: an instance may hold several per provider, and silently picking one
 * would connect the operator's account to an application they did not choose.
 * The lookup is scoped by {@link visibleForgesCondition}, so an organization
 * can only name its own apps or instance-wide ones — a 404 for anything else,
 * which is also what hides the existence of another organization's app.
 */
export async function resolveConnectApp(
  c: Context<AppEnv>,
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  organizationId: string,
  provider: 'github' | 'gitlab',
): Promise<Forge | Response> {
  const forgeId = c.req.query('forgeId')?.trim() ?? ''
  if (!UUID_RE.test(forgeId)) return c.json({ error: 'git_app_required' }, 400)

  const [row] = await db
    .select({ id: forge.id })
    .from(forge)
    .where(
      and(
        eq(forge.id, forgeId),
        eq(forge.provider, provider),
        visibleForgesCondition(organizationId),
      ),
    )
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const app = await loadForge(db, dataEncryptionSecrets, row.id)
  if (!app) return c.json({ error: 'Not found' }, 404)
  return app
}

/** Postgres `unique_violation`; see the attach route's race note. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  )
}

/** The existing binding for one repository, keyed exactly like the unique index. */
export async function findAttachedSource(
  db: Db,
  organizationId: string,
  fields: { connectionId: string; repositoryExternalId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ id: repository.id })
    .from(repository)
    .where(
      and(
        eq(repository.organizationId, organizationId),
        eq(repository.connectionId, fields.connectionId),
        eq(repository.repositoryExternalId, fields.repositoryExternalId),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/**
 * The organization's row for one repository, keyed by canonical URL — the
 * other unique index, and the one that holds across lanes (attach, manual
 * create, deploy-key) because every lane canonicalizes before writing.
 */
export async function findSourceByUrl(
  db: Db,
  organizationId: string,
  repositoryUrl: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: repository.id })
    .from(repository)
    .where(
      and(
        eq(repository.organizationId, organizationId),
        eq(repository.repositoryUrl, repositoryUrl),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/**
 * Send the operator's browser back into the console.
 *
 * Provider install and consent redirects are **top-level navigations**: the
 * operator is looking at the result. Answering them with JSON — which is what
 * these routes used to do — parks them on an API path with no way back, and
 * because GitHub's `setup_on_update` re-runs the redirect on every
 * repository-selection change, it happens again and again.
 */
export function redirectToForgeUi(
  c: Context<AppEnv>,
  organizationId: string | null,
  forgeId: string | null,
  query: { installed?: string; error?: ProviderInstallReturnError },
): Response {
  return c.redirect(providerInstallUiReturnPath(organizationId, forgeId, query), 302)
}

/**
 * Refuse an installation another organization already holds.
 *
 * The unique key is `(organization_id, app_id, external_installation_id)`, so
 * the same provider-side installation *can* be recorded by two organizations —
 * and for an instance-wide app that is a cross-tenant hole rather than a
 * feature: the App's key mints tokens for that installation regardless of which
 * organization asked, so the second claimant would read the first one's
 * repositories, and a push would fan out to both.
 *
 * The provider cannot tell us who is entitled to an account, so the rule is
 * first-come: one connection belongs to one organization per forge, and a
 * second claim is a `409` rather than a silent duplicate. Reconnecting from the
 * organization that already owns it still works, because that is an update.
 */
export async function assertConnectionUnclaimed(
  c: Context<AppEnv>,
  db: Db,
  params: {
    forgeId: string
    externalInstallationId: string
    provider: 'github' | 'gitlab'
    organizationId: string
  },
): Promise<Response | null> {
  const [claimed] = await db
    .select({ organizationId: gitConnection.organizationId })
    .from(gitConnection)
    .where(
      and(
        eq(gitConnection.forgeId, params.forgeId),
        eq(gitConnection.provider, params.provider),
        eq(
          gitConnection.externalInstallationId,
          params.externalInstallationId,
        ),
      ),
    )
    .limit(1)

  if (claimed && claimed.organizationId !== params.organizationId) {
    return c.json({ error: 'installation_claimed_by_another_organization' }, 409)
  }
  return null
}

/**
 * Confirm the installation exists under this App, and read its account.
 *
 * **This is an authorization check, not decoration.** `installation_id` arrives
 * as a query parameter on a URL the caller can retype, so nothing about it is
 * trusted: the signed `state` proves which organization started the flow, not
 * which installation the operator actually approved. A caller who names an
 * installation belonging to somebody else would otherwise get a row bound to
 * *their* organization, and the App's private key really can mint a token for
 * it — so a swallowed lookup failure is a cross-tenant repository read.
 *
 * A non-OK answer therefore throws rather than degrading to null metadata. It
 * covers exactly the case that matters: `404` is what GitHub returns for an
 * installation this App cannot see.
 */
export async function fetchInstallationAccount(
  appJwt: string,
  externalInstallationId: string,
  apiBase: string = GITHUB_API_BASE,
): Promise<{ accountLogin: string | null; accountType: string | null }> {
  const id = encodeURIComponent(externalInstallationId)
  let response: Response
  try {
    response = await fetch(`${apiBase}/app/installations/${id}`, {
      headers: githubApiHeaders(appJwt, 'Bearer'),
    })
  } catch (error) {
    throw new GithubAppTokenError(
      `github installation lookup failed: ${
        error instanceof Error ? error.message : 'network error'
      }`,
    )
  }
  if (!response.ok) {
    throw new GithubAppTokenError(
      'github installation not found for this app',
      response.status === 404 ? 404 : response.status,
    )
  }
  const payload = (await response.json().catch(() => null)) as
    | { account?: { login?: unknown; type?: unknown } }
    | null
  const account = payload?.account
  return {
    accountLogin: typeof account?.login === 'string' ? account.login : null,
    accountType: typeof account?.type === 'string' ? account.type : null,
  }
}

/**
 * Where this instance tells the provider to deliver, and whether that can work.
 *
 * Read from the operator-managed public URL list rather than the request URL:
 * behind the local Caddy → Unix socket the request origin is not an address
 * anything outside the box can dial, so echoing it back would produce a webhook
 * URL that looks fine and never receives anything.
 *
 * The path is provider-specific (the two ingress surfaces authenticate
 * differently and are mounted separately), so a `gitlab` repository is told about
 * `GITLAB_WEBHOOK_PATH`. A `git` repository has no webhook surface at all and is
 * given none.
 *
 * The URL is **per app**, not per instance: it carries the `webhook_ref` of the
 * app behind this repository's installation, which is what lets a delivery name its
 * app before any secret is consulted. A repository with no installation (a GitLab
 * deploy-key repository) has no app, and falls back to the bare path.
 */
export async function resolveSourceWebhookInfo(
  db: Db,
  provider: string,
  connectionId: string | null,
): Promise<SourceWebhookInfo | undefined> {
  if (provider !== 'github' && provider !== 'gitlab') return undefined
  const origins = (await getPublicUrls(db))
    .map((entry) => publicUrlEntryToInstallOrigin(entry))
    .filter((origin): origin is string => origin !== null)

  // The app behind this repository decides both halves of the URL: whether the ref
  // belongs in the path (self-hosted only), and which origin the provider was
  // actually told to deliver to.
  let webhookRef: string | null = null
  let appBaseUrl: string | null = null
  let appOrigin: string | null = null
  if (connectionId) {
    const rows = await db
      .select({
        webhookRef: forge.webhookRef,
        baseUrl: forge.baseUrl,
        webhookOrigin: forge.webhookOrigin,
      })
      .from(gitConnection)
      .innerJoin(forge, eq(gitConnection.forgeId, forge.id))
      .where(eq(gitConnection.id, connectionId))
      .limit(1)
    webhookRef = rows[0]?.webhookRef ?? null
    appBaseUrl = rows[0]?.baseUrl ?? null
    appOrigin = rows[0]?.webhookOrigin ?? null
  }

  const reachability = webhookReachability(
    appOrigin ? [appOrigin, ...origins] : origins,
    provider as WebhookProvider,
    webhookRef,
    appBaseUrl,
  )
  return {
    webhookUrl: reachability.webhookUrl,
    webhookReachable: reachability.reachable,
    reachabilityNote: reachability.note,
  }
}

/**
 * Absolute callback URL for the GitLab OAuth flow.
 *
 * GitLab requires the `redirect_uri` on the authorize hop and on the token
 * exchange to be byte-identical, and it must be one registered on the OAuth
 * application — so the configured value wins whenever the operator set one.
 * Otherwise it is derived from the same public URL list the webhook endpoint
 * uses, for the same reason: behind the local Caddy → Unix socket the request
 * origin is not an address GitLab could ever redirect a browser back to.
 */
export async function resolveGitlabRedirectUri(
  db: Db,
  configured: string | null,
): Promise<string | null> {
  if (configured) return configured
  const origin = (await getPublicUrls(db))
    .map((entry) => publicUrlEntryToInstallOrigin(entry))
    .find((entry): entry is string => entry !== null)
  if (!origin) return null
  return `${origin.replace(/\/$/, '')}${CLIENT_API_PREFIX}/repositories/gitlab/oauth/callback`
}

export function registerRepositoryRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for repository routes')
  }
  const secrets = opts.secrets

  router.use('/repositories', createSessionMiddleware(secrets))
  // Listed explicitly even though `/repositories/:id` would also match it — relying
  // on a param pattern to cover a literal route is how a surface quietly loses
  // its session gate when the patterns are reordered.
  router.use('/repositories/attach', createSessionMiddleware(secrets))
  router.use('/repositories/:id', createSessionMiddleware(secrets))
  // `/repositories/:id` does not match a child segment. Inspect would otherwise
  // skip this gate and resolveSourceSession would 401 even with a valid cookie.
  router.use('/repositories/:id/inspect', createSessionMiddleware(secrets))
  router.use('/repositories/:id/refresh', createSessionMiddleware(secrets))
  router.use('/repositories/connections', createSessionMiddleware(secrets))
  router.use('/repositories/connections/:id/repositories', createSessionMiddleware(secrets))
  router.use('/repositories/github/install', createSessionMiddleware(secrets))
  router.use('/repositories/github/callback', createSessionMiddleware(secrets))
  router.use('/repositories/gitlab/oauth', createSessionMiddleware(secrets))
  router.use('/repositories/gitlab/oauth/callback', createSessionMiddleware(secrets))
  router.use('/repositories/gitlab/deploy-keys', createSessionMiddleware(secrets))

  // Static segments are registered before `/repositories/:id` so they are not
  // swallowed by the parameterized route.
  router.get('/repositories/connections', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const rows = await db
      .select(CONNECTION_SELECT)
      .from(gitConnection)
      .where(eq(gitConnection.organizationId, organizationId))
      .orderBy(gitConnection.createdAt)

    return c.json({ connections: rows.map(serializeConnectionRow) })
  })

  router.get('/repositories/connections/:id/repositories', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Invalid request' }, 400)

    const scopeDenied = await assertConnectionInOrganization(c, db, organizationId, id)
    if (scopeDenied) return scopeDenied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    // The connection row says which provider to ask; every provider mints its
    // own short-lived secret per request, uses it once, and discards it.
    const [installation] = await db
      .select({ provider: gitConnection.provider })
      .from(gitConnection)
      .where(eq(gitConnection.id, id))
      .limit(1)
    if (!installation) return c.json({ error: 'Not found' }, 404)

    try {
      const repositories = await resolveGitProvider(installation.provider)
        .listRepositories({ db, dataEncryptionSecrets }, id)
      return c.json({ repositories })
    } catch (error) {
      return providerErrorResponse(c, error)
    }
  })

  router.get('/repositories/github/install', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const secretsConfig = c.get('secretsConfig')
    if (!secretsConfig) {
      return c.json({ error: 'Signing unavailable — no root secret configured' }, 503)
    }

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    const app = await resolveConnectApp(
      c,
      db,
      dataEncryptionSecrets,
      organizationId,
      'github',
    )
    if (app instanceof Response) return app
    if (!app.appSlug) return c.json({ error: 'github_app_not_configured' }, 503)

    const state = await signGithubInstallState(secretsConfig, {
      organizationId,
      forgeId: app.id,
    })
    // The install page lives on the App's own origin, so a GitHub Enterprise
    // App sends the operator to that server rather than to github.com.
    const target = new URL(
      `${app.baseUrl}/apps/${encodeURIComponent(app.appSlug)}/installations/new`,
    )
    target.searchParams.set('state', state)
    return c.redirect(target.toString(), 302)
  })

  /**
   * Where GitHub sends the operator after they install the App.
   *
   * This is the App's `setup_url`, and `setup_on_update: true` means GitHub
   * re-runs it whenever the repository selection changes — so it has to be
   * idempotent and it has to land in the console, never on a JSON body.
   */
  router.get('/repositories/github/callback', async (c) => {
    const ctx = await resolveProviderCallbackSession(c)
    if (ctx instanceof Response) return ctx
    const { db, userId, secretsConfig, dataEncryptionSecrets } = ctx

    const fail = (
      organizationId: string | null,
      error: ProviderInstallReturnError,
      forgeId: string | null = null,
    ) => redirectToForgeUi(c, organizationId, forgeId, { error })

    if (!secretsConfig) return fail(null, 'unavailable')

    const state = c.req.query('state')
    const externalInstallationId = c.req.query('installation_id')
    if (!state || !externalInstallationId) return fail(null, 'invalid_request')

    const claims = await verifyGithubInstallState(secretsConfig, state)
    if (!claims) return fail(null, 'state_invalid')

    const denied = await authorizeClaimedOrganization(
      c,
      db,
      userId,
      claims.organizationId,
    )
    if (denied) return fail(claims.organizationId, 'forbidden', claims.forgeId)

    const organizationId = claims.organizationId
    if (!dataEncryptionSecrets) return fail(organizationId, 'unavailable', claims.forgeId)

    // The app comes from the signed state, not from a query param on the
    // provider's redirect — the callback URL is one GitHub controls.
    const app = await loadForge(db, dataEncryptionSecrets, claims.forgeId)
    if (app?.provider !== 'github' || !app.privateKeyPem) {
      return fail(organizationId, 'not_configured', claims.forgeId)
    }

    const claimed = await assertConnectionUnclaimed(c, db, {
      forgeId: app.id,
      externalInstallationId,
      provider: 'github',
      organizationId,
    })
    if (claimed) return fail(organizationId, 'claimed', app.id)

    let account: { accountLogin: string | null; accountType: string | null }
    try {
      const appJwt = await signGithubAppJwt(app.externalAppId, app.privateKeyPem)
      account = await fetchInstallationAccount(
        appJwt,
        externalInstallationId,
        githubApiBaseFor(app),
      )
    } catch (error) {
      logWarn(
        'git-sources',
        `github installation lookup failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
      return fail(organizationId, 'provider_failed', app.id)
    }

    const [row] = await db
      .insert(gitConnection)
      .values({
        organizationId,
        forgeId: app.id,
        provider: 'github',
        externalInstallationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
      })
      .onConflictDoUpdate({
        target: [
          gitConnection.organizationId,
          gitConnection.forgeId,
          gitConnection.externalInstallationId,
        ],
        set: {
          accountLogin: account.accountLogin,
          accountType: account.accountType,
          suspendedAt: null,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning({ id: gitConnection.id })

    return redirectToForgeUi(c, organizationId, app.id, {
      installed: row?.id ?? 'ok',
    })
  })

  /**
   * Start the GitLab OAuth connect flow.
   *
   * GitLab has no App-install redirect, so this is an ordinary authorization
   * code grant: bounce the operator to GitLab with a signed `state`, and take
   * the code back on the callback below. The `state` is minted under GitLab's
   * own HKDF purpose, so a state issued for the GitHub flow cannot be replayed
   * here (see `./provider-install-state.ts`).
   */
  router.get('/repositories/gitlab/oauth', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const secretsConfig = c.get('secretsConfig')
    if (!secretsConfig) {
      return c.json({ error: 'Signing unavailable — no root secret configured' }, 503)
    }
    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    const app = await resolveConnectApp(
      c,
      db,
      dataEncryptionSecrets,
      organizationId,
      'gitlab',
    )
    if (app instanceof Response) return app
    if (!app.clientId) return c.json({ error: 'gitlab_oauth_not_configured' }, 503)

    const redirectUri = await resolveGitlabRedirectUri(db, app.redirectUri)
    if (!redirectUri) return c.json({ error: 'gitlab_redirect_uri_unknown' }, 503)

    const state = await signGitlabConnectState(secretsConfig, {
      organizationId,
      forgeId: app.id,
    })
    return c.redirect(
      gitlabAuthorizeUrl(
        { baseUrl: app.baseUrl, clientId: app.clientId },
        { redirectUri, state },
      ),
      302,
    )
  })

  /**
   * Finish the GitLab OAuth connect flow.
   *
   * Trades the code for the initial token pair and records the connection as a
   * `gitConnection` row — the same table GitHub installs land in, so
   * every downstream reader (the repository picker, the webhook trigger
   * resolver, deploy-prep) keeps one lookup. The pair itself is sealed onto that
   * row rather than returned: it is the only long-lived secret in this
   * feature, and GitLab rotates its refresh half on every use.
   */
  /**
   * Where GitLab sends the operator after they approve the OAuth grant.
   *
   * A top-level navigation like the GitHub install callback, so it redirects
   * into the console rather than answering with a JSON body.
   */
  router.get('/repositories/gitlab/oauth/callback', async (c) => {
    const ctx = await resolveProviderCallbackSession(c)
    if (ctx instanceof Response) return ctx
    const { db, userId, secretsConfig, dataEncryptionSecrets } = ctx

    const fail = (
      organizationId: string | null,
      error: ProviderInstallReturnError,
      forgeId: string | null = null,
    ) => redirectToForgeUi(c, organizationId, forgeId, { error })

    if (!secretsConfig) return fail(null, 'unavailable')

    const state = c.req.query('state')
    const code = c.req.query('code')
    if (!state || !code) return fail(null, 'invalid_request')

    const claims = await verifyGitlabConnectState(secretsConfig, state)
    if (!claims) return fail(null, 'state_invalid')

    const denied = await authorizeClaimedOrganization(
      c,
      db,
      userId,
      claims.organizationId,
    )
    if (denied) return fail(claims.organizationId, 'forbidden', claims.forgeId)

    const organizationId = claims.organizationId
    if (!dataEncryptionSecrets) return fail(organizationId, 'unavailable', claims.forgeId)

    const app = await loadForge(db, dataEncryptionSecrets, claims.forgeId)
    if (app?.provider !== 'gitlab') {
      return fail(organizationId, 'not_configured', claims.forgeId)
    }

    const redirectUri = await resolveGitlabRedirectUri(db, app.redirectUri)
    if (!redirectUri) return fail(organizationId, 'not_configured', app.id)

    let credentials
    let pair
    let account
    try {
      credentials = gitlabOauthCredentials(app)
      pair = await exchangeGitlabAuthorizationCode(credentials, { code, redirectUri })
      account = await fetchGitlabAccount(app.baseUrl, pair.token)
    } catch (error) {
      logWarn(
        'git-sources',
        `gitlab connect failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
      return fail(organizationId, 'provider_failed', app.id)
    }

    // GitLab's own account id is the stable handle for the connection. When the
    // API declined to answer it, the row still has to be addressable and unique
    // within the organization, so the client id stands in — one connection per
    // OAuth application per organization, which is what a re-connect should be.
    const externalInstallationId = account.externalId ?? `client:${credentials.clientId}`

    const claimed = await assertConnectionUnclaimed(c, db, {
      forgeId: app.id,
      externalInstallationId,
      provider: 'gitlab',
      organizationId,
    })
    if (claimed) return fail(organizationId, 'claimed', app.id)

    const [row] = await db
      .insert(gitConnection)
      .values({
        organizationId,
        forgeId: app.id,
        provider: 'gitlab',
        externalInstallationId,
        accountLogin: account.login,
        accountType: 'User',
      })
      .onConflictDoUpdate({
        target: [
          gitConnection.organizationId,
          gitConnection.forgeId,
          gitConnection.externalInstallationId,
        ],
        set: {
          accountLogin: account.login,
          // Reconnecting is how an operator recovers a revoked grant, so it
          // must clear the suspension the failed refresh recorded.
          suspendedAt: null,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning({ id: gitConnection.id })

    const connectionId = row?.id
    if (!connectionId) return fail(organizationId, 'provider_failed', app.id)

    await persistGitlabTokenPair(db, dataEncryptionSecrets, connectionId, pair)

    return redirectToForgeUi(c, organizationId, app.id, { installed: connectionId })
  })

  /**
   * Mint a read-only deploy keypair for a repository that will not use OAuth.
   *
   * This is the one endpoint that creates a `secret` row, and it exists
   * against the grain of that table's "no public CRUD" rule for a specific
   * reason: the alternative is an operator running `ssh-keygen` and pasting a
   * private key into a form, which is how private keys end up in chat logs and
   * how passphrase-protected keys end up hanging a clone forever.
   *
   * **The public half is returned exactly once**, in this response, for the
   * operator to add to the project as a *read-only* Deploy Key. The private half
   * is sealed on the way in and never leaves the instance again except resealed
   * to a specific daemon at deploy time. This is the recommended non-human path:
   * the key belongs to the project, not to a person whose account leaving the
   * organization would break every deploy.
   */
  router.post('/repositories/gitlab/deploy-keys', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const rawName = typeof body.name === 'string' ? body.name.trim() : ''
    if (rawName.length === 0 || rawName.length > 255) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const keypair = await generateSshDeployKeypair(rawName)
    const [inserted] = await db
      .insert(secret)
      .values({
        organizationId,
        provider: GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER,
        name: rawName,
        // Sealed plaintext is the OpenSSH private key verbatim — deploy-prep
        // reseals this envelope for the daemon without ever opening it.
        secretEnvelope: await encryptSecret(
          dataEncryptionSecrets,
          keypair.privateKeyOpenssh,
        ),
        metadata: {
          publicKey: keypair.publicKeyOpenssh,
          fingerprint: keypair.fingerprint,
          keyType: 'ed25519',
        },
      })
      .returning({ id: secret.id })

    const secretId = inserted?.id
    if (!secretId) return c.json({ error: 'Failed to create deploy key' }, 500)

    return c.json({
      ok: true as const,
      secretId,
      publicKey: keypair.publicKeyOpenssh,
      fingerprint: keypair.fingerprint,
    })
  })

  router.get('/repositories', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, userId, organizationId } = ctx

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const visibleIds = await listVisible(db, {
      kind: 'repository',
      userId,
      organizationId,
    })
    if (visibleIds.length === 0) return c.json({ repositories: [] })

    const visible = new Set(visibleIds)
    const rows = await db
      .select(SOURCE_SELECT)
      .from(repository)
      .where(eq(repository.organizationId, organizationId))
      .orderBy(repository.createdAt)

    return c.json({
      repositories: rows
        .filter((row) => visible.has(row.id))
        .map((row) => serializeSourceRow(row)),
    })
  })

  router.get('/repositories/:id', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const [row] = await db
      .select(SOURCE_SELECT)
      .from(repository)
      .where(and(eq(repository.id, id), eq(repository.organizationId, organizationId)))
      .limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({
      repository: serializeSourceRow(
        row,
        await resolveSourceWebhookInfo(db, row.provider, row.connectionId),
      ),
    })
  })

  /**
   * Read a connected repository so the wizard can see what is in it.
   *
   * Provider-first with a daemon fallback — see `inspectRepository` for why the
   * fallback rule keys on the *presence of an HTTP status* rather than on a
   * configuration toggle.
   *
   * The probe set is fixed (`INSPECT_PROBE_PATHS`), not caller-supplied: this
   * is reachable by any org member, so a fixed list bounds what a compromised
   * session can learn to "do these filenames exist". The optional `listPath`
   * query names which directory the `entries` listing reads (default: the
   * repository root) — a directory listing was always returned, so this widens
   * *which* directory, not *what kind* of data; the value is held to the same
   * relative-path rule as `x-turbopanel.root`.
   */
  router.get('/repositories/:id/inspect', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const [row] = await db
      .select(SOURCE_SELECT)
      .from(repository)
      .where(and(eq(repository.id, id), eq(repository.organizationId, organizationId)))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const ref = (c.req.query('ref') ?? row.defaultBranch ?? '').trim()
    if (ref.length === 0) {
      return c.json({
        error: 'ref_required',
        message:
          'This repository records no default branch; name a ref to inspect.',
      }, 400)
    }

    const listPath = (c.req.query('listPath') ?? '').trim()
    if (listPath.length > 0 && !isSafeRoot(listPath)) {
      return c.json({
        error: 'invalid_list_path',
        message:
          'listPath must be a relative path without ".." (e.g. "apps/web").',
      }, 400)
    }

    const outcome = await inspectRepository({
      db,
      registry: getDaemonCellRegistry(c) ?? null,
      dataEncryptionSecrets: c.get('dataEncryptionSecrets') ?? null,
      organizationId,
      row: {
        id: row.id,
        provider: row.provider,
        repositoryUrl: row.repositoryUrl,
        defaultBranch: row.defaultBranch,
        subdirectory: row.subdirectory,
        connectionId: row.connectionId,
        secretId: row.secretId,
      },
      ref,
      listPath,
      serverIds: (await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.organizationId, organizationId)))
        .map((entry) => entry.id),
    })

    if (!outcome.ok) {
      return c.json(
        { error: outcome.error, message: outcome.message },
        outcome.status as 400,
      )
    }

    // Bookkeeping, not the answer: remember what this successful read saw so
    // the repositories screen can say when the repo was last reachable and at
    // which commit. A failed write must not fail a read that succeeded.
    try {
      const metadata = readSourceMetadata(row.metadata)
      metadata.lastInspectedAt = new Date().toISOString()
      metadata.lastInspectedCommitSha = outcome.commitSha
      await db
        .update(repository)
        .set({ metadata, updatedAt: new Date().toISOString() })
        .where(eq(repository.id, row.id))
    } catch (error) {
      logWarn('repository inspect metadata update failed', { error })
    }

    return c.json({
      commitSha: outcome.commitSha,
      via: outcome.via,
      files: outcome.files,
      entries: outcome.entries,
    })
  })

  /**
   * Bind a repository to this organization, reusing the binding if it exists.
   *
   * A `repository` row is created here implicitly when the operator picks
   * **app -> account -> repository** in a project flow; the org-level
   * repositories screen lists and manages the rows afterwards.
   *
   * **Idempotent by construction.** One row per repository per organization,
   * whichever lane created it first: the connection-keyed unique dedupes
   * repeat attaches, and the URL-keyed unique plus the adopt-by-URL step below
   * fold a manually created row for the same repository into this binding
   * instead of duplicating it. That matters because `auto_deploy` and
   * `default_branch` live on the row: duplicates would let one repository hold
   * two different policies while a single push fanned out to both. The unique
   * indexes are what make the insert-then-fall-back safe under concurrency
   * instead of a check-then-insert race.
   *
   * It commits **before** the project save that references it, because
   * `loadOrganizationRepositoryIds` feeds `knownSourceIds` into the compose lint and
   * an unknown `sourceId` fails the whole document.
   */
  router.post('/repositories/attach', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fields = parseSourceAttachBody(body)
    if (!fields) {
      return c.json({
        error: 'expected { connectionId, repositoryExternalId, repositoryUrl, defaultBranch? }',
      }, 400)
    }

    const connectionDenied = await assertConnectionInOrganization(
      c,
      db,
      organizationId,
      fields.connectionId,
    )
    if (connectionDenied) return connectionDenied

    const [installation] = await db
      .select({ provider: gitConnection.provider })
      .from(gitConnection)
      .where(eq(gitConnection.id, fields.connectionId))
      .limit(1)
    if (!installation) return c.json({ error: 'Not found' }, 404)

    const existing = await findAttachedSource(db, organizationId, fields)
    if (existing) return c.json({ ok: true as const, id: existing, reused: true })

    // Same repository, different lane: a row created from the clone URL (a
    // manual or deploy-key source) is the same repository this attach names, so
    // it is adopted — the connection becomes its clone authority — rather than
    // duplicated. The connection lane supersedes a stored deploy key because
    // `assertProviderAuthShape` forbids holding both; the `secret` row itself
    // is untouched and can be re-bound later.
    const sameUrl = await findSourceByUrl(db, organizationId, fields.repositoryUrl)
    if (sameUrl) {
      await db
        .update(repository)
        .set({
          connectionId: fields.connectionId,
          provider: installation.provider,
          repositoryExternalId: fields.repositoryExternalId,
          secretId: null,
          defaultBranch: sql`COALESCE(${repository.defaultBranch}, ${fields.defaultBranch})`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(repository.id, sameUrl))
      return c.json({ ok: true as const, id: sameUrl, reused: true })
    }

    try {
      const [inserted] = await db
        .insert(repository)
        .values({
          organizationId,
          connectionId: fields.connectionId,
          provider: installation.provider,
          repositoryUrl: fields.repositoryUrl,
          repositoryExternalId: fields.repositoryExternalId,
          defaultBranch: fields.defaultBranch,
        })
        .returning({ id: repository.id })
      const id = inserted?.id
      if (!id) return c.json({ error: 'Failed to attach repository' }, 500)
      return c.json({ ok: true as const, id, reused: false }, 201)
    } catch (error) {
      // Lost the race against a concurrent attach of the same repository. A
      // unique index did its job; read back the winner rather than failing an
      // operation that has already achieved what the caller asked for.
      if (!isUniqueViolation(error)) throw error
      const winner = (await findAttachedSource(db, organizationId, fields)) ??
        (await findSourceByUrl(db, organizationId, fields.repositoryUrl))
      if (!winner) throw error
      return c.json({ ok: true as const, id: winner, reused: true })
    }
  })

  router.post('/repositories', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fields = parseSourceCreateBody(c, body)
    if (fields instanceof Response) return fields

    const connectionDenied = await assertConnectionInOrganization(
      c,
      db,
      organizationId,
      fields.connectionId,
      fields.provider,
    )
    if (connectionDenied) return connectionDenied

    const secretDenied = await assertSecretInOrganization(
      c,
      db,
      organizationId,
      fields.secretId,
      fields.provider,
    )
    if (secretDenied) return secretDenied

    // Find-or-create, keyed by canonical URL: pasting the same clone URL twice
    // — same wizard run or a different one — answers with the existing row
    // instead of minting a duplicate, exactly like `/repositories/attach` does
    // for provider-picked repositories. The existing row's policy fields are
    // deliberately left alone: a reuse must not silently rewrite the
    // credential or auto-deploy of a repository other projects already ride.
    const existing = await findSourceByUrl(db, organizationId, fields.repositoryUrl)
    if (existing) return c.json({ ok: true as const, id: existing, reused: true })

    try {
      const [inserted] = await db
        .insert(repository)
        .values({ organizationId, ...fields })
        .returning({ id: repository.id })

      const id = inserted?.id
      if (!id) return c.json({ error: 'Failed to create repository' }, 500)

      return c.json({ ok: true as const, id, reused: false }, 201)
    } catch (error) {
      // Lost the create race; the unique index held. Answer with the winner.
      if (!isUniqueViolation(error)) throw error
      const winner = await findSourceByUrl(db, organizationId, fields.repositoryUrl)
      if (!winner) throw error
      return c.json({ ok: true as const, id: winner, reused: true })
    }
  })

  router.patch('/repositories/:id', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    // The stored auth fields and URL are inputs to the patch validation: a
    // partial body has to be checked against the row it lands on, not on its own.
    const [existing] = await db
      .select({
        provider: repository.provider,
        connectionId: repository.connectionId,
        secretId: repository.secretId,
        repositoryUrl: repository.repositoryUrl,
      })
      .from(repository)
      .where(and(eq(repository.id, id), eq(repository.organizationId, organizationId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patch = parseSourcePatchBody(c, body, {
      provider: existing.provider as SourceProvider,
      connectionId: existing.connectionId,
      secretId: existing.secretId,
      repositoryUrl: existing.repositoryUrl,
    })
    if (patch instanceof Response) return patch

    // `provider` is immutable on patch, so the row's own provider is what a
    // newly named installation or secret has to be compatible with.
    const existingProvider = existing.provider as SourceProvider

    if (patch.connectionId !== undefined) {
      const connectionDenied = await assertConnectionInOrganization(
        c,
        db,
        organizationId,
        patch.connectionId,
        existingProvider,
      )
      if (connectionDenied) return connectionDenied
    }

    if (patch.secretId !== undefined) {
      const secretDenied = await assertSecretInOrganization(
        c,
        db,
        organizationId,
        patch.secretId,
        existingProvider,
      )
      if (secretDenied) return secretDenied
    }

    try {
      await db.update(repository).set(patch).where(eq(repository.id, id))
    } catch (error) {
      // A patched URL canonicalizes onto a row this organization already has.
      // The caller meant *that* repository — point them at it instead of
      // holding two rows for one repo.
      if (!isUniqueViolation(error)) throw error
      return c.json({ error: 'source_url_conflict' }, 409)
    }

    return c.json({ ok: true as const })
  })

  /**
   * Re-read provider facts for one repository — the default branch above all.
   *
   * `default_branch` is written once at attach time and the upstream value can
   * change afterwards; a deploy that omits a branch and a webhook filter that
   * names one would then quietly track the wrong ref. The refresh reads the
   * provider's current listing and records what it saw in `metadata`
   * (`detectedDefaultBranch`, `defaultBranchCheckedAt`).
   *
   * The `default_branch` **column** is updated only while it still tracks the
   * provider: when it is null, or equals the previously detected value. An
   * operator who set an explicit branch keeps it — the column doubles as the
   * webhook branch filter, and a refresh must not widen or retarget a policy a
   * human wrote down.
   *
   * Deploy-key and generic-git rows have no provider listing to consult and
   * answer 400: their branch is operator-owned by construction.
   */
  router.post('/repositories/:id/refresh', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const [row] = await db
      .select(SOURCE_SELECT)
      .from(repository)
      .where(and(eq(repository.id, id), eq(repository.organizationId, organizationId)))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    if (!row.connectionId) {
      return c.json({
        error: 'source_refresh_not_supported',
        message:
          'Only provider-connected repositories can be refreshed; deploy-key and generic git sources have no provider to ask.',
      }, 400)
    }

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Data encryption unavailable' }, 503)
    }

    let listing
    try {
      listing = await resolveGitProvider(row.provider).listRepositories(
        { db, dataEncryptionSecrets },
        row.connectionId,
      )
    } catch (error) {
      return providerErrorResponse(c, error)
    }

    const match = row.repositoryExternalId
      ? listing.find((entry) => entry.id === row.repositoryExternalId)
      : undefined
    if (!match) {
      return c.json({
        error: 'source_not_visible_to_connection',
        message:
          'The connection can no longer see this repository — it may have been removed from the installation.',
      }, 404)
    }

    const metadata = readSourceMetadata(row.metadata)
    const previouslyDetected = typeof metadata.detectedDefaultBranch === 'string'
      ? metadata.detectedDefaultBranch
      : null
    metadata.detectedDefaultBranch = match.defaultBranch
    metadata.defaultBranchCheckedAt = new Date().toISOString()

    const tracksProvider = row.defaultBranch === null ||
      row.defaultBranch === previouslyDetected
    const patch: Record<string, unknown> = {
      metadata,
      updatedAt: new Date().toISOString(),
    }
    if (tracksProvider && match.defaultBranch) {
      patch.defaultBranch = match.defaultBranch
    }
    // A rename upstream shows up as a changed clone URL; adopt it so the
    // canonical-URL dedupe keeps matching what operators paste today.
    if (match.cloneUrl) {
      const canonical = canonicalizeRepositoryUrl(match.cloneUrl)
      if (canonical !== row.repositoryUrl) patch.repositoryUrl = canonical
    }

    try {
      await db.update(repository).set(patch).where(eq(repository.id, id))
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // The renamed URL collides with another row this organization holds;
      // keep the stored URL and still record the refreshed branch facts.
      delete patch.repositoryUrl
      await db.update(repository).set(patch).where(eq(repository.id, id))
    }

    const [updated] = await db
      .select(SOURCE_SELECT)
      .from(repository)
      .where(eq(repository.id, id))
      .limit(1)
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true as const, repository: serializeSourceRow(updated) })
  })

  router.delete('/repositories/:id', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const [existing] = await db
      .select({ id: repository.id })
      .from(repository)
      .where(and(eq(repository.id, id), eq(repository.organizationId, organizationId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    if (await composeReferencesRepository(db, organizationId, id)) {
      return c.json({ error: SOURCE_REFERENCED_BY_COMPOSE_ERROR }, 409)
    }

    await db.delete(repository).where(eq(repository.id, id))

    return c.json({ ok: true as const })
  })
}
