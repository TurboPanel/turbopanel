/**
 * Git `source` CRUD plus the provider connect flows (GitHub App installation,
 * GitLab OAuth) and the deploy-key minter.
 *
 * `source` is an org-owned registry like `network` / `datacenter`, so authz is
 * a direct `organization_id` match plus an organization-level manage/read gate
 * — not the workspace→project ancestry walk used by the compose tree.
 * `assertNotSystemOwnedOr403` does not apply: sources are never part of the
 * system-owned project tree.
 *
 * The inbound half of this feature is **not** here. Each provider's webhook
 * surface lives at `GITHUB_WEBHOOK_PATH` / `GITLAB_WEBHOOK_PATH`, outside
 * `CLIENT_API_PREFIX`, and authenticates with a provider credential rather than
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
import { getDaemonCellRegistry } from '../../db.ts'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { logWarn } from '../../logger.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import {
  credential,
  gitProviderApp,
  gitProviderInstallation,
  server,
  source,
} from '../../lib/db/schema.ts'
import {
  type GitApp,
  loadGitApp,
  visibleGitAppsCondition,
} from '../../lib/git/git-app-records.ts'
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
} from '../git-apps/routes-helpers.ts'
import {
  COMPOSE_SOURCE_JSONPATH,
  parseSourceAttachBody,
  GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER,
  parseSourceCreateBody,
  parseSourceListFilter,
  parseSourcePatchBody,
  serializeInstallationRow,
  serializeSourceRow,
  type SourceWebhookInfo,
  SOURCE_DEPLOY_KEY_PROVIDERS,
  SOURCE_REFERENCED_BY_COMPOSE_ERROR,
  UUID_RE,
  type SourceProvider,
} from './routes-helpers.ts'

const SOURCE_SELECT = {
  id: source.id,
  organizationId: source.organizationId,
  installationId: source.installationId,
  serviceId: source.serviceId,
  environmentId: source.environmentId,
  credentialId: source.credentialId,
  provider: source.provider,
  repositoryUrl: source.repositoryUrl,
  repositoryExternalId: source.repositoryExternalId,
  defaultBranch: source.defaultBranch,
  subdirectory: source.subdirectory,
  autoDeploy: source.autoDeploy,
  metadata: source.metadata,
  options: source.options,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
}

const INSTALLATION_SELECT = {
  id: gitProviderInstallation.id,
  organizationId: gitProviderInstallation.organizationId,
  appId: gitProviderInstallation.appId,
  provider: gitProviderInstallation.provider,
  externalInstallationId: gitProviderInstallation.externalInstallationId,
  accountLogin: gitProviderInstallation.accountLogin,
  accountType: gitProviderInstallation.accountType,
  suspendedAt: gitProviderInstallation.suspendedAt,
  metadata: gitProviderInstallation.metadata,
  options: gitProviderInstallation.options,
  createdAt: gitProviderInstallation.createdAt,
  updatedAt: gitProviderInstallation.updatedAt,
}

type SourceSessionContext = {
  db: Db
  userId: string
  organizationId: string
}

async function resolveSourceSession(
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
 * Deleting a still-referenced source would make every later save of that compose
 * fail the `knownSourceIds` lint, so it is a 409 instead. Reference detection
 * itself lives in {@link COMPOSE_SOURCE_JSONPATH}.
 */
async function composeReferencesSource(
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
      -- options.composeSource.sourceId records where a project compose was
      -- seeded from. Deleting the source would silently orphan that
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

async function assertScopeInOrganization(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  kind: 'service' | 'environment',
  entityId: string | null,
): Promise<Response | null> {
  if (!entityId) return null
  const entityOrgId = await resolveEntityOrganizationId(db, kind, entityId)
  if (!entityOrgId || entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return null
}

/**
 * Ownership **and** provider compatibility for a named installation.
 *
 * Ownership is the security check: the FK alone would happily bind another
 * organization's connection to this source, so a foreign row is reported as
 * `Not found` rather than `Forbidden` — the check leaks no existence signal.
 *
 * The provider check is the coherence one. A `provider: 'gitlab'` source
 * pointing at a GitHub installation (or the reverse) is a row nothing can
 * clone: deploy-prep dispatches on `source.provider`, so
 * `mintGitlabAccessToken` would be handed a row with no `oauth_envelope`, and
 * the operator would learn about it as a failed deploy on a host rather than as
 * a rejected write. The pair is settled here, at the write boundary, for the
 * same reason `assertProviderAuthShape` settles the installation/credential
 * exclusivity there. A mismatch is the caller's own
 * row, so it answers `400` with a specific code rather than hiding as a `404`.
 */
async function assertInstallationInOrganization(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  installationId: string | null,
  sourceProvider?: SourceProvider,
): Promise<Response | null> {
  if (!installationId) return null
  const [row] = await db
    .select({
      organizationId: gitProviderInstallation.organizationId,
      provider: gitProviderInstallation.provider,
    })
    .from(gitProviderInstallation)
    .where(eq(gitProviderInstallation.id, installationId))
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
 * Ownership **and** credential-lane compatibility for a named credential.
 *
 * `credential` has no public CRUD, so a caller can only ever name a row it
 * learned about elsewhere — the id is still attacker-controlled, and the FK
 * alone would happily bind another organization's sealed deploy key to this
 * source. Deploy-prep reads `source.credentialId` to clone, so ownership is
 * checked here, exactly like `installationId`. A foreign row is reported as
 * `Not found` rather than `Forbidden` so the check leaks no existence signal.
 *
 * Ownership is not enough, though: `credential` is one table for every sealed
 * secret the organization holds, so an org-owned **storage** credential (an S3
 * key, an SFTP password) passes the ownership test and is still nothing a git
 * clone can use. Only the deploy-key lane may name one at all — `git` always,
 * and `gitlab` when it clones with a key instead of its OAuth connection — and
 * within that lane the row must be a `git_deploy_key`, because the daemon
 * writes the sealed plaintext straight to an identity file without parsing it.
 * Anything else stores a row whose first symptom is a checkout failure on a
 * host; rejecting it here keeps that a write-time `400`.
 */
async function assertCredentialInOrganization(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  credentialId: string | null,
  sourceProvider: SourceProvider,
): Promise<Response | null> {
  if (!credentialId) return null
  const [row] = await db
    .select({
      organizationId: credential.organizationId,
      provider: credential.provider,
    })
    .from(credential)
    .where(eq(credential.id, credentialId))
    .limit(1)
  if (row?.organizationId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  // `assertProviderAuthShape` already refuses a credential on a `github`
  // source; restated here so this function is safe to call on its own.
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
function providerErrorResponse(c: Context<AppEnv>, error: unknown): Response {
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
 * `?appId=` is required rather than defaulted, because "the" app no longer
 * exists: an instance may hold several per provider, and silently picking one
 * would connect the operator's account to an application they did not choose.
 * The lookup is scoped by {@link visibleGitAppsCondition}, so an organization
 * can only name its own apps or instance-wide ones — a 404 for anything else,
 * which is also what hides the existence of another organization's app.
 */
async function resolveConnectApp(
  c: Context<AppEnv>,
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  organizationId: string,
  provider: 'github' | 'gitlab',
): Promise<GitApp | Response> {
  const appId = c.req.query('appId')?.trim() ?? ''
  if (!UUID_RE.test(appId)) return c.json({ error: 'git_app_required' }, 400)

  const [row] = await db
    .select({ id: gitProviderApp.id })
    .from(gitProviderApp)
    .where(
      and(
        eq(gitProviderApp.id, appId),
        eq(gitProviderApp.provider, provider),
        visibleGitAppsCondition(organizationId),
      ),
    )
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const app = await loadGitApp(db, dataEncryptionSecrets, row.id)
  if (!app) return c.json({ error: 'Not found' }, 404)
  return app
}

/** Postgres `unique_violation`; see the attach route's race note. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  )
}

/** The existing binding for one repository, keyed exactly like the unique index. */
async function findAttachedSource(
  db: Db,
  organizationId: string,
  fields: { installationId: string; repositoryExternalId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ id: source.id })
    .from(source)
    .where(
      and(
        eq(source.organizationId, organizationId),
        eq(source.installationId, fields.installationId),
        eq(source.repositoryExternalId, fields.repositoryExternalId),
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
function redirectToGitAppUi(
  c: Context<AppEnv>,
  organizationId: string | null,
  appId: string | null,
  query: { installed?: string; error?: ProviderInstallReturnError },
): Response {
  return c.redirect(providerInstallUiReturnPath(organizationId, appId, query), 302)
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
 * first-come: one installation belongs to one organization per app, and a
 * second claim is a `409` rather than a silent duplicate. Reconnecting from the
 * organization that already owns it still works, because that is an update.
 */
async function assertInstallationUnclaimed(
  c: Context<AppEnv>,
  db: Db,
  params: {
    appId: string
    externalInstallationId: string
    provider: 'github' | 'gitlab'
    organizationId: string
  },
): Promise<Response | null> {
  const [claimed] = await db
    .select({ organizationId: gitProviderInstallation.organizationId })
    .from(gitProviderInstallation)
    .where(
      and(
        eq(gitProviderInstallation.appId, params.appId),
        eq(gitProviderInstallation.provider, params.provider),
        eq(
          gitProviderInstallation.externalInstallationId,
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
async function fetchInstallationAccount(
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
 * differently and are mounted separately), so a `gitlab` source is told about
 * `GITLAB_WEBHOOK_PATH`. A `git` source has no webhook surface at all and is
 * given none.
 *
 * The URL is **per app**, not per instance: it carries the `webhook_ref` of the
 * app behind this source's installation, which is what lets a delivery name its
 * app before any secret is consulted. A source with no installation (a GitLab
 * deploy-key source) has no app, and falls back to the bare path.
 */
async function resolveSourceWebhookInfo(
  db: Db,
  provider: string,
  installationId: string | null,
): Promise<SourceWebhookInfo | undefined> {
  if (provider !== 'github' && provider !== 'gitlab') return undefined
  const origins = (await getPublicUrls(db))
    .map((entry) => publicUrlEntryToInstallOrigin(entry))
    .filter((origin): origin is string => origin !== null)

  // The app behind this source decides both halves of the URL: whether the ref
  // belongs in the path (self-hosted only), and which origin the provider was
  // actually told to deliver to.
  let webhookRef: string | null = null
  let appBaseUrl: string | null = null
  let appOrigin: string | null = null
  if (installationId) {
    const rows = await db
      .select({
        webhookRef: gitProviderApp.webhookRef,
        baseUrl: gitProviderApp.baseUrl,
        webhookOrigin: gitProviderApp.webhookOrigin,
      })
      .from(gitProviderInstallation)
      .innerJoin(gitProviderApp, eq(gitProviderInstallation.appId, gitProviderApp.id))
      .where(eq(gitProviderInstallation.id, installationId))
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
async function resolveGitlabRedirectUri(
  db: Db,
  configured: string | null,
): Promise<string | null> {
  if (configured) return configured
  const origin = (await getPublicUrls(db))
    .map((entry) => publicUrlEntryToInstallOrigin(entry))
    .find((entry): entry is string => entry !== null)
  if (!origin) return null
  return `${origin.replace(/\/$/, '')}${CLIENT_API_PREFIX}/sources/gitlab/callback`
}

export function registerSourceRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for source routes')
  }
  const secrets = opts.secrets

  router.use('/sources', createSessionMiddleware(secrets))
  // Listed explicitly even though `/sources/:id` would also match it — relying
  // on a param pattern to cover a literal route is how a surface quietly loses
  // its session gate when the patterns are reordered.
  router.use('/sources/attach', createSessionMiddleware(secrets))
  router.use('/sources/:id', createSessionMiddleware(secrets))
  router.use('/sources/installations', createSessionMiddleware(secrets))
  router.use('/sources/installations/:id/repositories', createSessionMiddleware(secrets))
  router.use('/sources/github/install', createSessionMiddleware(secrets))
  router.use('/sources/github/callback', createSessionMiddleware(secrets))
  router.use('/sources/gitlab/oauth', createSessionMiddleware(secrets))
  router.use('/sources/gitlab/callback', createSessionMiddleware(secrets))
  router.use('/sources/gitlab/deploy-keys', createSessionMiddleware(secrets))

  // Static segments are registered before `/sources/:id` so they are not
  // swallowed by the parameterized route.
  router.get('/sources/installations', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const rows = await db
      .select(INSTALLATION_SELECT)
      .from(gitProviderInstallation)
      .where(eq(gitProviderInstallation.organizationId, organizationId))
      .orderBy(gitProviderInstallation.createdAt)

    return c.json({ installations: rows.map(serializeInstallationRow) })
  })

  router.get('/sources/installations/:id/repositories', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Invalid request' }, 400)

    const scopeDenied = await assertInstallationInOrganization(c, db, organizationId, id)
    if (scopeDenied) return scopeDenied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    // The installation row says which provider to ask; every provider mints its
    // own short-lived credential per request, uses it once, and discards it.
    const [installation] = await db
      .select({ provider: gitProviderInstallation.provider })
      .from(gitProviderInstallation)
      .where(eq(gitProviderInstallation.id, id))
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

  router.get('/sources/github/install', async (c) => {
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
      appId: app.id,
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
  router.get('/sources/github/callback', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const fail = (error: ProviderInstallReturnError, appId: string | null = null) =>
      redirectToGitAppUi(c, organizationId, appId, { error })

    const secretsConfig = c.get('secretsConfig')
    if (!secretsConfig) return fail('unavailable')

    const state = c.req.query('state')
    const externalInstallationId = c.req.query('installation_id')
    if (!state || !externalInstallationId) return fail('invalid_request')

    const claims = await verifyGithubInstallState(secretsConfig, state)
    if (!claims) return fail('state_invalid')
    // The signed state is the authority; the live session must agree with it.
    if (claims.organizationId !== organizationId) return fail('forbidden')

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return fail('forbidden', claims.appId)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) return fail('unavailable', claims.appId)

    // The app comes from the signed state, not from a query param on the
    // provider's redirect — the callback URL is one GitHub controls.
    const app = await loadGitApp(db, dataEncryptionSecrets, claims.appId)
    if (app?.provider !== 'github' || !app.privateKeyPem) {
      return fail('not_configured', claims.appId)
    }

    const claimed = await assertInstallationUnclaimed(c, db, {
      appId: app.id,
      externalInstallationId,
      provider: 'github',
      organizationId,
    })
    if (claimed) return fail('claimed', app.id)

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
      return fail('provider_failed', app.id)
    }

    const [row] = await db
      .insert(gitProviderInstallation)
      .values({
        organizationId,
        appId: app.id,
        provider: 'github',
        externalInstallationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
      })
      .onConflictDoUpdate({
        target: [
          gitProviderInstallation.organizationId,
          gitProviderInstallation.appId,
          gitProviderInstallation.externalInstallationId,
        ],
        set: {
          accountLogin: account.accountLogin,
          accountType: account.accountType,
          suspendedAt: null,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning({ id: gitProviderInstallation.id })

    return redirectToGitAppUi(c, organizationId, app.id, {
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
  router.get('/sources/gitlab/oauth', async (c) => {
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
      appId: app.id,
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
   * `gitProviderInstallation` row — the same table GitHub installs land in, so
   * every downstream reader (the repository picker, the webhook trigger
   * resolver, deploy-prep) keeps one lookup. The pair itself is sealed onto that
   * row rather than returned: it is the only long-lived credential in this
   * feature, and GitLab rotates its refresh half on every use.
   */
  /**
   * Where GitLab sends the operator after they approve the OAuth grant.
   *
   * A top-level navigation like the GitHub install callback, so it redirects
   * into the console rather than answering with a JSON body.
   */
  router.get('/sources/gitlab/callback', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const fail = (error: ProviderInstallReturnError, appId: string | null = null) =>
      redirectToGitAppUi(c, organizationId, appId, { error })

    const secretsConfig = c.get('secretsConfig')
    if (!secretsConfig) return fail('unavailable')

    const state = c.req.query('state')
    const code = c.req.query('code')
    if (!state || !code) return fail('invalid_request')

    const claims = await verifyGitlabConnectState(secretsConfig, state)
    if (!claims) return fail('state_invalid')
    // The signed state is the authority; the live session must agree with it.
    if (claims.organizationId !== organizationId) return fail('forbidden')

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return fail('forbidden', claims.appId)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) return fail('unavailable', claims.appId)

    const app = await loadGitApp(db, dataEncryptionSecrets, claims.appId)
    if (app?.provider !== 'gitlab') return fail('not_configured', claims.appId)

    const redirectUri = await resolveGitlabRedirectUri(db, app.redirectUri)
    if (!redirectUri) return fail('not_configured', app.id)

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
      return fail('provider_failed', app.id)
    }

    // GitLab's own account id is the stable handle for the connection. When the
    // API declined to answer it, the row still has to be addressable and unique
    // within the organization, so the client id stands in — one connection per
    // OAuth application per organization, which is what a re-connect should be.
    const externalInstallationId = account.externalId ?? `client:${credentials.clientId}`

    const claimed = await assertInstallationUnclaimed(c, db, {
      appId: app.id,
      externalInstallationId,
      provider: 'gitlab',
      organizationId,
    })
    if (claimed) return fail('claimed', app.id)

    const [row] = await db
      .insert(gitProviderInstallation)
      .values({
        organizationId,
        appId: app.id,
        provider: 'gitlab',
        externalInstallationId,
        accountLogin: account.login,
        accountType: 'User',
      })
      .onConflictDoUpdate({
        target: [
          gitProviderInstallation.organizationId,
          gitProviderInstallation.appId,
          gitProviderInstallation.externalInstallationId,
        ],
        set: {
          accountLogin: account.login,
          // Reconnecting is how an operator recovers a revoked grant, so it
          // must clear the suspension the failed refresh recorded.
          suspendedAt: null,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning({ id: gitProviderInstallation.id })

    const installationId = row?.id
    if (!installationId) return fail('provider_failed', app.id)

    await persistGitlabTokenPair(db, dataEncryptionSecrets, installationId, pair)

    return redirectToGitAppUi(c, organizationId, app.id, { installed: installationId })
  })

  /**
   * Mint a read-only deploy keypair for a source that will not use OAuth.
   *
   * This is the one endpoint that creates a `credential` row, and it exists
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
  router.post('/sources/gitlab/deploy-keys', async (c) => {
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
      .insert(credential)
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
      .returning({ id: credential.id })

    const credentialId = inserted?.id
    if (!credentialId) return c.json({ error: 'Failed to create deploy key' }, 500)

    return c.json({
      ok: true as const,
      credentialId,
      publicKey: keypair.publicKeyOpenssh,
      fingerprint: keypair.fingerprint,
    })
  })

  router.get('/sources', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, userId, organizationId } = ctx

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const filter = parseSourceListFilter(c)
    if (filter instanceof Response) return filter

    if (filter.serviceId) {
      const scopeDenied = await assertScopeInOrganization(
        c,
        db,
        organizationId,
        'service',
        filter.serviceId,
      )
      if (scopeDenied) return scopeDenied
    }
    if (filter.environmentId) {
      const scopeDenied = await assertScopeInOrganization(
        c,
        db,
        organizationId,
        'environment',
        filter.environmentId,
      )
      if (scopeDenied) return scopeDenied
    }

    const visibleIds = await listVisible(db, {
      kind: 'source',
      userId,
      organizationId,
    })
    if (visibleIds.length === 0) return c.json({ sources: [] })

    const visible = new Set(visibleIds)
    const conditions = [eq(source.organizationId, organizationId)]
    if (filter.serviceId) conditions.push(eq(source.serviceId, filter.serviceId))
    if (filter.environmentId) {
      conditions.push(eq(source.environmentId, filter.environmentId))
    }

    const rows = await db
      .select(SOURCE_SELECT)
      .from(source)
      .where(and(...conditions))
      .orderBy(source.createdAt)

    return c.json({
      sources: rows
        .filter((row) => visible.has(row.id))
        .map((row) => serializeSourceRow(row)),
    })
  })

  router.get('/sources/:id', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const [row] = await db
      .select(SOURCE_SELECT)
      .from(source)
      .where(and(eq(source.id, id), eq(source.organizationId, organizationId)))
      .limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({
      source: serializeSourceRow(
        row,
        await resolveSourceWebhookInfo(db, row.provider, row.installationId),
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
   * session can learn to "do these filenames exist".
   */
  router.get('/sources/:id/inspect', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const [row] = await db
      .select(SOURCE_SELECT)
      .from(source)
      .where(and(eq(source.id, id), eq(source.organizationId, organizationId)))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const ref = (c.req.query('ref') ?? row.defaultBranch ?? '').trim()
    if (ref.length === 0) {
      return c.json({
        error: 'ref_required',
        message:
          'This source records no default branch; name a ref to inspect.',
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
        installationId: row.installationId,
        credentialId: row.credentialId,
      },
      ref,
      listPath: '',
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
   * A `source` row is no longer something an operator creates and manages. It is
   * created here, implicitly, at the moment a repository is attached to a
   * project, and it never appears in the console as a thing of its own — the
   * operator picks **app -> account -> repository** and this is what that
   * resolves to underneath.
   *
   * **Idempotent by construction.** Two projects on the same repository share
   * one row rather than racing to make two, which matters because `auto_deploy`
   * and `default_branch` live on the row: duplicates would let one repository
   * hold two different policies while a single push fanned out to both. The
   * `uniq_source_organization_installation_repository` index is what makes the
   * insert-then-fall-back safe under concurrency instead of a check-then-insert
   * race.
   *
   * It commits **before** the project save that references it, because
   * `loadOrganizationSourceIds` feeds `knownSourceIds` into the compose lint and
   * an unknown `sourceId` fails the whole document.
   */
  router.post('/sources/attach', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanCreateOr403(c, 'source', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fields = parseSourceAttachBody(body)
    if (!fields) {
      return c.json({
        error: 'expected { installationId, repositoryExternalId, repositoryUrl, defaultBranch? }',
      }, 400)
    }

    const installationDenied = await assertInstallationInOrganization(
      c,
      db,
      organizationId,
      fields.installationId,
    )
    if (installationDenied) return installationDenied

    const [installation] = await db
      .select({ provider: gitProviderInstallation.provider })
      .from(gitProviderInstallation)
      .where(eq(gitProviderInstallation.id, fields.installationId))
      .limit(1)
    if (!installation) return c.json({ error: 'Not found' }, 404)

    const existing = await findAttachedSource(db, organizationId, fields)
    if (existing) return c.json({ ok: true as const, id: existing, reused: true })

    try {
      const [inserted] = await db
        .insert(source)
        .values({
          organizationId,
          installationId: fields.installationId,
          provider: installation.provider,
          repositoryUrl: fields.repositoryUrl,
          repositoryExternalId: fields.repositoryExternalId,
          defaultBranch: fields.defaultBranch,
        })
        .returning({ id: source.id })
      const id = inserted?.id
      if (!id) return c.json({ error: 'Failed to attach source' }, 500)
      return c.json({ ok: true as const, id, reused: false }, 201)
    } catch (error) {
      // Lost the race against a concurrent attach of the same repository. The
      // unique index did its job; read back the winner rather than failing an
      // operation that has already achieved what the caller asked for.
      if (!isUniqueViolation(error)) throw error
      const winner = await findAttachedSource(db, organizationId, fields)
      if (!winner) throw error
      return c.json({ ok: true as const, id: winner, reused: true })
    }
  })

  router.post('/sources', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fields = parseSourceCreateBody(c, body)
    if (fields instanceof Response) return fields

    const installationDenied = await assertInstallationInOrganization(
      c,
      db,
      organizationId,
      fields.installationId,
      fields.provider,
    )
    if (installationDenied) return installationDenied

    const credentialDenied = await assertCredentialInOrganization(
      c,
      db,
      organizationId,
      fields.credentialId,
      fields.provider,
    )
    if (credentialDenied) return credentialDenied

    const serviceDenied = await assertScopeInOrganization(
      c,
      db,
      organizationId,
      'service',
      fields.serviceId,
    )
    if (serviceDenied) return serviceDenied

    const environmentDenied = await assertScopeInOrganization(
      c,
      db,
      organizationId,
      'environment',
      fields.environmentId,
    )
    if (environmentDenied) return environmentDenied

    const [inserted] = await db
      .insert(source)
      .values({ organizationId, ...fields })
      .returning({ id: source.id })

    const id = inserted?.id
    if (!id) return c.json({ error: 'Failed to create source' }, 500)

    return c.json({ ok: true as const, id })
  })

  router.patch('/sources/:id', async (c) => {
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
        provider: source.provider,
        installationId: source.installationId,
        credentialId: source.credentialId,
        repositoryUrl: source.repositoryUrl,
      })
      .from(source)
      .where(and(eq(source.id, id), eq(source.organizationId, organizationId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patch = parseSourcePatchBody(c, body, {
      provider: existing.provider as SourceProvider,
      installationId: existing.installationId,
      credentialId: existing.credentialId,
      repositoryUrl: existing.repositoryUrl,
    })
    if (patch instanceof Response) return patch

    // `provider` is immutable on patch, so the row's own provider is what a
    // newly named installation or credential has to be compatible with.
    const existingProvider = existing.provider as SourceProvider

    if (patch.installationId !== undefined) {
      const installationDenied = await assertInstallationInOrganization(
        c,
        db,
        organizationId,
        patch.installationId,
        existingProvider,
      )
      if (installationDenied) return installationDenied
    }

    if (patch.credentialId !== undefined) {
      const credentialDenied = await assertCredentialInOrganization(
        c,
        db,
        organizationId,
        patch.credentialId,
        existingProvider,
      )
      if (credentialDenied) return credentialDenied
    }

    await db.update(source).set(patch).where(eq(source.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/sources/:id', async (c) => {
    const ctx = await resolveSourceSession(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const [existing] = await db
      .select({ id: source.id })
      .from(source)
      .where(and(eq(source.id, id), eq(source.organizationId, organizationId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    if (await composeReferencesSource(db, organizationId, id)) {
      return c.json({ error: SOURCE_REFERENCED_BY_COMPOSE_ERROR }, 409)
    }

    await db.delete(source).where(eq(source.id, id))

    return c.json({ ok: true as const })
  })
}
