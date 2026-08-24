/**
 * Pure parse / serialize helpers for the `source` CRUD surface.
 *
 * Same split as `../storage/routes-helpers.ts`: everything here is
 * database-free so it can be unit-tested without a live Postgres.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { isSafeRoot } from '../../lib/compose/service-kind.ts'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Kept as a literal rather than imported from `src/lib/git/git-provider.ts`
 * (which holds the canonical `GIT_PROVIDERS`) so this module stays free of the
 * provider implementations — and therefore free of the database — the way the
 * comment above promises. The two lists and the `source_provider_check`
 * constraint in `schema.ts` must move together.
 */
export const SOURCE_PROVIDERS = ['github', 'gitlab', 'git'] as const
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number]

export const SOURCE_AUTO_DEPLOY_MODES = [
  'immediate',
  'checks_passed',
  'disabled',
] as const
export type SourceAutoDeploy = (typeof SOURCE_AUTO_DEPLOY_MODES)[number]

export const SOURCE_REPOSITORY_URL_MAX_LENGTH = 2048
export const SOURCE_BRANCH_MAX_LENGTH = 255

/** 409 body when a compose document still references the source being deleted. */
export const SOURCE_REFERENCED_BY_COMPOSE_ERROR = 'source_referenced_by_compose'

export type SourceCreateFields = {
  provider: SourceProvider
  repositoryUrl: string
  repositoryExternalId: string | null
  defaultBranch: string | null
  subdirectory: string | null
  autoDeploy: SourceAutoDeploy
  installationId: string | null
  credentialId: string | null
  serviceId: string | null
  environmentId: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

export type SourcePatchFields = {
  installationId?: string | null
  credentialId?: string | null
  repositoryUrl?: string
  repositoryExternalId?: string | null
  defaultBranch?: string | null
  subdirectory?: string | null
  autoDeploy?: SourceAutoDeploy
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

export type SourceListFilter = {
  serviceId?: string
  environmentId?: string
}

function isProvider(value: unknown): value is SourceProvider {
  return typeof value === 'string' && SOURCE_PROVIDERS.includes(value as SourceProvider)
}

function isAutoDeploy(value: unknown): value is SourceAutoDeploy {
  return (
    typeof value === 'string' &&
    SOURCE_AUTO_DEPLOY_MODES.includes(value as SourceAutoDeploy)
  )
}

/** `git@host:owner/repo.git` — the scp-like form git accepts. */
const SCP_LIKE_SSH_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/

/**
 * Repository URL policy.
 *
 * - `github` sources are App-authorized clones: **https only**. They never carry
 *   a `credentialId` (see {@link assertProviderAuthShape}), so the SSH branch
 *   below is unreachable for them.
 * - `gitlab` sources are https when they clone through the OAuth connection
 *   (the minted access token is an HTTPS credential), and may additionally be
 *   an SSH form when they clone with a generated deploy key — the same rule
 *   `git` gets, for the same reason: a deploy key authenticates publickey auth,
 *   not an askpass password prompt.
 * - `git` sources may be https, or an SSH form (`ssh://…` / `git@host:path`)
 *   — the SSH form needs a `credentialId` (the deploy key) to be usable. The
 *   deploy path carries that credential to the daemon tagged
 *   `credentialKind: 'ssh_key'`, which installs it as a temporary identity file
 *   for the clone; an https source's credential is a token instead.
 *
 * Callers must settle the auth shape **before** calling this, so the
 * `credentialId` passed in is always one the provider is allowed to use.
 */
export function validateRepositoryUrl(
  provider: SourceProvider,
  raw: string,
  credentialId: string | null,
): { ok: true; url: string } | { ok: false; error: string } {
  const url = raw.trim()
  if (url.length === 0 || url.length > SOURCE_REPOSITORY_URL_MAX_LENGTH) {
    return { ok: false, error: 'source_repository_url_invalid' }
  }

  if (url.startsWith('https://')) {
    try {
      const parsed = new URL(url)
      if (!parsed.hostname || parsed.username || parsed.password) {
        return { ok: false, error: 'source_repository_url_invalid' }
      }
    } catch {
      return { ok: false, error: 'source_repository_url_invalid' }
    }
    return { ok: true, url }
  }

  // Only the credential-bearing lanes may use SSH: `git` always, and `gitlab`
  // when it clones with a deploy key rather than through its OAuth connection.
  if (provider === 'github') {
    return { ok: false, error: 'source_repository_url_must_be_https' }
  }

  const isSsh = url.startsWith('ssh://') || SCP_LIKE_SSH_RE.test(url)
  if (!isSsh) {
    return { ok: false, error: 'source_repository_url_invalid' }
  }
  if (!credentialId) {
    return { ok: false, error: 'source_ssh_requires_credential' }
  }
  return { ok: true, url }
}

function parseOptionalUuid(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !UUID_RE.test(value)) return { ok: false }
  return { ok: true, value }
}

function parseOptionalTrimmed(
  value: unknown,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (trimmed.length > maxLength) return { ok: false }
  return { ok: true, value: trimmed }
}

function parseOptionalSubdirectory(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  const parsed = parseOptionalTrimmed(value, 200)
  if (!parsed.ok) return { ok: false }
  if (parsed.value === null) return parsed
  return isSafeRoot(parsed.value) ? parsed : { ok: false }
}

function parseOptionalJsonb(
  value: unknown,
): { ok: true; value: Record<string, unknown> | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false }
  return { ok: true, value: value as Record<string, unknown> }
}

/**
 * Provider decides the clone auth path, and the paths are mutually exclusive.
 *
 * - `github` clones with an installation token minted from the App: an
 *   installation is required and a credential is meaningless.
 * - `gitlab` has **two** lanes and must pick one — the OAuth connection
 *   (`installationId`) or a generated read-only deploy key (`credentialId`).
 *   Both set is the case worth rejecting loudly: deploy-prep would have to
 *   guess which one to clone with, and the wrong guess is a failure that
 *   surfaces on the host rather than here.
 * - `git` clones with a deploy key held in `credential` and has no
 *   installation concept at all.
 *
 * Persisting an incoherent pair leaves a row later deploy-prep cannot read
 * unambiguously, so it is rejected at the write boundary instead of being
 * guessed at clone time.
 *
 * Returns an error code, or `null` when the pair is coherent.
 */
/**
 * `credential.provider` value for a generated read-only SSH deploy key.
 *
 * The one credential kind a `source` may point at: its sealed plaintext is the
 * OpenSSH private key verbatim (see `credential` in `lib/db/schema.ts`), which
 * is what the daemon writes to a `0600` identity file. Every other value in
 * that table is a storage credential holding provider-specific JSON.
 */
export const GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER = 'git_deploy_key'

/**
 * Source providers whose clone may be authorized by a stored deploy key.
 *
 * `github` is absent on purpose — it clones with an App installation token and
 * has no key lane at all ({@link assertProviderAuthShape} says the same thing
 * from the other direction).
 */
export const SOURCE_DEPLOY_KEY_PROVIDERS: ReadonlySet<SourceProvider> = new Set<
  SourceProvider
>(['git', 'gitlab'])

export function assertProviderAuthShape(
  provider: SourceProvider,
  installationId: string | null,
  credentialId: string | null,
): string | null {
  if (provider === 'github') {
    if (!installationId) return 'source_installation_required'
    if (credentialId) return 'source_credential_not_supported'
    return null
  }
  if (provider === 'gitlab') {
    if (!installationId && !credentialId) return 'source_installation_required'
    if (installationId && credentialId) return 'source_auth_ambiguous'
    return null
  }
  if (installationId) return 'source_installation_not_supported'
  return null
}

export function parseSourceCreateBody(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): SourceCreateFields | Response {
  const provider = body.provider === undefined ? 'github' : body.provider
  if (!isProvider(provider)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const installationId = parseOptionalUuid(body.installationId)
  const credentialId = parseOptionalUuid(body.credentialId)
  const serviceId = parseOptionalUuid(body.serviceId)
  const environmentId = parseOptionalUuid(body.environmentId)
  if (
    !installationId.ok ||
    !credentialId.ok ||
    !serviceId.ok ||
    !environmentId.ok
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (serviceId.value && environmentId.value) {
    return c.json({ error: 'source_single_parent_required' }, 400)
  }

  // Settled before the URL check so the credential handed to
  // `validateRepositoryUrl` is one this provider may actually clone with.
  const authError = assertProviderAuthShape(
    provider,
    installationId.value,
    credentialId.value,
  )
  if (authError) return c.json({ error: authError }, 400)

  if (typeof body.repositoryUrl !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const repositoryUrl = validateRepositoryUrl(
    provider,
    body.repositoryUrl,
    credentialId.value,
  )
  if (!repositoryUrl.ok) {
    return c.json({ error: repositoryUrl.error }, 400)
  }

  const repositoryExternalId = parseOptionalTrimmed(body.repositoryExternalId, 64)
  const defaultBranch = parseOptionalTrimmed(
    body.defaultBranch,
    SOURCE_BRANCH_MAX_LENGTH,
  )
  const subdirectory = parseOptionalSubdirectory(body.subdirectory)
  if (!repositoryExternalId.ok || !defaultBranch.ok || !subdirectory.ok) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const autoDeploy = body.autoDeploy === undefined ? 'disabled' : body.autoDeploy
  if (!isAutoDeploy(autoDeploy)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadata = parseOptionalJsonb(body.metadata)
  const options = parseOptionalJsonb(body.options)
  if (!metadata.ok || !options.ok) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return {
    provider,
    repositoryUrl: repositoryUrl.url,
    repositoryExternalId: repositoryExternalId.value,
    defaultBranch: defaultBranch.value,
    subdirectory: subdirectory.value,
    autoDeploy,
    installationId: installationId.value,
    credentialId: credentialId.value,
    serviceId: serviceId.value,
    environmentId: environmentId.value,
    metadata: metadata.value,
    options: options.value,
  }
}

type ParsedPatchField = { ok: true; value: unknown } | { ok: false }

/**
 * The mutable scalar fields, each with the parser that validates it.
 *
 * Table-driven rather than a run of near-identical `if (key in body)` blocks:
 * the shape is uniform — absent means "leave it alone", present means "parse or
 * reject" — and every rejection is the same generic 400. Order is preserved for
 * readability only; all entries fail the same way.
 *
 * `installationId` / `credentialId` are absent on purpose: they also feed the
 * auth-shape and URL re-checks below, so they are parsed ahead of the loop.
 */
const SOURCE_PATCH_FIELD_PARSERS: ReadonlyArray<
  [keyof SourcePatchFields, (value: unknown) => ParsedPatchField]
> = [
  ['repositoryExternalId', (value) => parseOptionalTrimmed(value, 64)],
  ['defaultBranch', (value) => parseOptionalTrimmed(value, SOURCE_BRANCH_MAX_LENGTH)],
  ['subdirectory', parseOptionalSubdirectory],
  ['autoDeploy', (value) => (isAutoDeploy(value) ? { ok: true, value } : { ok: false })],
  ['metadata', parseOptionalJsonb],
  ['options', parseOptionalJsonb],
]

/**
 * Resolve one of the two auth ids to its post-patch value, recording it on
 * `patch` when the body actually carries it. An omitted field keeps `fallback`
 * (the stored value) so the caller can check the pair as a whole.
 */
function resolvePatchedAuthId(
  body: Record<string, unknown>,
  key: 'installationId' | 'credentialId',
  fallback: string | null,
  patch: SourcePatchFields,
): { ok: true; value: string | null } | { ok: false } {
  if (!(key in body)) return { ok: true, value: fallback }
  const parsed = parseOptionalUuid(body[key])
  if (!parsed.ok) return { ok: false }
  patch[key] = parsed.value
  return parsed
}

/**
 * URL and credential are one decision — an SSH URL is only clonable with a
 * deploy key — so a credential change re-checks the stored URL too. Without
 * that, clearing `credentialId` would strip the key off an ssh source and slip
 * past the `source_ssh_requires_credential` gate the create path enforces.
 *
 * Returns an error code, or `null` when the pair is coherent.
 */
function applyRepositoryUrlPatch(
  body: Record<string, unknown>,
  existing: { provider: SourceProvider; credentialId: string | null; repositoryUrl: string },
  credentialId: string | null,
  patch: SourcePatchFields,
): string | null {
  const changed = 'repositoryUrl' in body
  if (!changed && credentialId === existing.credentialId) return null

  const raw = changed ? body.repositoryUrl : existing.repositoryUrl
  if (typeof raw !== 'string') return 'Invalid request'

  const parsed = validateRepositoryUrl(existing.provider, raw, credentialId)
  if (!parsed.ok) return parsed.error
  if (changed) patch.repositoryUrl = parsed.url
  return null
}

/**
 * PATCH accepts only the mutable fields. Scope (`serviceId` / `environmentId`)
 * and `provider` are immutable — rebind by creating a new source, mirroring how
 * `network` rejects scope patches.
 */
export function parseSourcePatchBody(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  existing: {
    provider: SourceProvider
    installationId: string | null
    credentialId: string | null
    repositoryUrl: string
  },
): SourcePatchFields | Response {
  if ('serviceId' in body || 'environmentId' in body || 'provider' in body) {
    return c.json({ error: 'source_scope_immutable' }, 400)
  }

  const patch: SourcePatchFields = { updatedAt: new Date().toISOString() }

  const installationId = resolvePatchedAuthId(
    body,
    'installationId',
    existing.installationId,
    patch,
  )
  const credentialId = resolvePatchedAuthId(
    body,
    'credentialId',
    existing.credentialId,
    patch,
  )
  if (!installationId.ok || !credentialId.ok) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  // `provider` is immutable, so the pairing is checked against the post-patch
  // values: a field the body omits keeps whatever the row holds, which the
  // create path already validated under this same rule.
  const authError = assertProviderAuthShape(
    existing.provider,
    installationId.value,
    credentialId.value,
  )
  if (authError) return c.json({ error: authError }, 400)

  const urlError = applyRepositoryUrlPatch(body, existing, credentialId.value, patch)
  if (urlError) return c.json({ error: urlError }, 400)

  for (const [key, parse] of SOURCE_PATCH_FIELD_PARSERS) {
    if (!(key in body)) continue
    const parsed = parse(body[key])
    if (!parsed.ok) return c.json({ error: 'Invalid request' }, 400)
    Object.assign(patch, { [key]: parsed.value })
  }

  return patch
}

/** At most one scope filter; anything else is a bad request. */
export function parseSourceListFilter(
  c: Context<AppEnv>,
): SourceListFilter | Response {
  const serviceId = c.req.query('serviceId')
  const environmentId = c.req.query('environmentId')

  if (serviceId && environmentId) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (serviceId !== undefined) {
    if (!UUID_RE.test(serviceId)) return c.json({ error: 'Invalid request' }, 400)
    return { serviceId }
  }
  if (environmentId !== undefined) {
    if (!UUID_RE.test(environmentId)) return c.json({ error: 'Invalid request' }, 400)
    return { environmentId }
  }
  return {}
}

/**
 * Compose stores `services.<name>.x-turbopanel.source.sourceId` in jsonb, but a
 * `!override` / `!reset` tag can wrap **any** node on that path as a
 * `{ __turbopanelComposeTag, value }` sentinel (`src/lib/compose/tags.ts`) — the
 * scalar id, the whole `source` mapping, `x-turbopanel`, or the service itself.
 * Enumerating those shapes one by one is how tagged mappings were missed, so the
 * lookup uses recursive `**` hops between the anchor keys instead: every
 * intervening `value` wrapper is absorbed, while the match still has to sit on a
 * literal `x-turbopanel` → `source` → `sourceId` chain (a stray `sourceId`
 * elsewhere in the service does not count).
 *
 * Two readers share it, and they must agree: delete refuses to drop a source a
 * compose document still names (409), and the webhook trigger resolver
 * (`./webhook-trigger.ts`) treats that same reference as an attachment, so a
 * source bound only through the Services form still auto-deploys. Bind the
 * `$sid` variable via `jsonb_build_object('sid', <uuid>::text)`.
 */
export const COMPOSE_SOURCE_JSONPATH =
  '$."compose"."data"."services".**."x-turbopanel".**."source".**."sourceId".**' +
  ' ? (@ == $sid)'

export type SourceRowLike = {
  id: string
  organizationId: string
  installationId: string | null
  serviceId: string | null
  environmentId: string | null
  credentialId: string | null
  provider: string
  repositoryUrl: string
  repositoryExternalId: string | null
  defaultBranch: string | null
  subdirectory: string | null
  autoDeploy: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

/**
 * Instance-wide webhook facts folded onto a single source read.
 *
 * They are properties of the *instance*, not of the row, so they are only
 * attached by `GET /sources/:id` — the list endpoint would repeat the identical
 * pair on every entry. `webhookUrl` is what the operator pastes into the App's
 * webhook settings; `reachabilityNote` is non-null exactly when this instance
 * looks unreachable from the public internet (see
 * `src/lib/git/webhook-reachability.ts`).
 */
export type SourceWebhookInfo = {
  webhookUrl: string | null
  webhookReachable: boolean
  reachabilityNote: string | null
}

export function serializeSourceRow(row: SourceRowLike, webhook?: SourceWebhookInfo) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationId: row.installationId,
    serviceId: row.serviceId,
    environmentId: row.environmentId,
    credentialId: row.credentialId,
    provider: row.provider,
    repositoryUrl: row.repositoryUrl,
    repositoryExternalId: row.repositoryExternalId,
    defaultBranch: row.defaultBranch,
    subdirectory: row.subdirectory,
    autoDeploy: row.autoDeploy,
    metadata: row.metadata ?? null,
    options: row.options ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...webhook,
  }
}

export type InstallationRowLike = {
  id: string
  organizationId: string
  provider: string
  externalInstallationId: string
  accountLogin: string | null
  accountType: string | null
  suspendedAt: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export function serializeInstallationRow(row: InstallationRowLike) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    externalInstallationId: row.externalInstallationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    suspendedAt: row.suspendedAt,
    suspended: row.suspendedAt !== null,
    metadata: row.metadata ?? null,
    options: row.options ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * The repository shape the picker renders, for every provider.
 *
 * The narrowing itself is provider-specific and lives with each implementation
 * (`toGithubRepositorySummary`, `toGitlabRepositorySummary`); only the result
 * type is shared, and it is defined once in `src/lib/git/git-provider.ts`.
 * Re-exported here under its old name so callers of the sources surface keep
 * one import.
 */
export type { RepositorySummary } from '../../lib/git/git-provider.ts'
export type { RepositorySummary as GithubRepositorySummary } from '../../lib/git/git-provider.ts'
