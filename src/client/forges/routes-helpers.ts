/**
 * Pure parsing and serialization for the git-app CRUD surfaces.
 *
 * Two routers mount this logic — the admin one for instance-wide apps and the
 * client one for organization-owned apps — and the only thing that differs
 * between them is the scope they write into and who is allowed to. Keeping the
 * body grammar here means the two cannot drift into accepting different shapes
 * for the same resource.
 *
 * **Partial updates keep sealed material.** An omitted secret field leaves the
 * stored envelope alone; an explicit `null` clears it. That is what lets a
 * settings form save a name change without the operator re-pasting a private
 * key it was never shown.
 */

import {
  type GitAppCreate,
  GITHUB_DEFAULT_BASE_URL,
  type GitAppProvider,
  type GitAppSummary,
  type GitAppUpdate,
  GIT_APP_PROVIDERS,
} from '../../lib/git/git-app-records.ts'
import { stripTrailingSlashes } from '../../lib/git/origin.ts'
import {
  webhookPathFor,
  type WebhookProvider,
} from '../../lib/git/webhook-reachability.ts'

export const GIT_APP_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GitHub sends the operator's browser to the manifest callback. After the
 * instance stores the App, that GET must land back on the console — not on a
 * JSON body. These codes stay short and secret-free so they can ride the
 * query string.
 */
export const GITHUB_MANIFEST_RETURN_ERRORS = [
  'unavailable',
  'invalid_request',
  'state_invalid',
  'forbidden',
  'conversion_failed',
  'conflict',
  'create_failed',
] as const

export type GithubManifestReturnError =
  (typeof GITHUB_MANIFEST_RETURN_ERRORS)[number]

/**
 * Where the console lists Git applications.
 *
 * Every provider redirect in this feature ends here or one level below it, and
 * the provider controls the URL it sends the browser to — so this is the one
 * place the console's own layout is written down on the server side.
 */
export function gitSourcesUiBasePath(organizationId: string | null): string {
  return organizationId === null
    ? '/admin/git'
    : `/${organizationId}/projects/git-sources`
}

/** One registered app's detail screen, where installation is completed. */
export function gitAppUiPath(organizationId: string | null, appId: string): string {
  return `${gitSourcesUiBasePath(organizationId)}/${encodeURIComponent(appId)}`
}

function withQuery(base: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

export function githubManifestUiReturnPath(
  organizationId: string | null,
  query: { created?: string; error?: GithubManifestReturnError },
): string {
  // A freshly converted app goes straight to its own screen, which is where the
  // "repository access has not been installed yet" step lives — that is the
  // operator's actual next action, not the list.
  const base = query.created
    ? gitAppUiPath(organizationId, query.created)
    : gitSourcesUiBasePath(organizationId)
  return withQuery(base, { created: query.created, error: query.error })
}

/**
 * Short, secret-free codes for the *installation* return trip.
 *
 * Separate from {@link GITHUB_MANIFEST_RETURN_ERRORS} because they describe a
 * different hop: the manifest codes are about creating an app, these are about
 * granting one access to repositories.
 */
export const PROVIDER_INSTALL_RETURN_ERRORS = [
  'unavailable',
  'invalid_request',
  'state_invalid',
  'forbidden',
  'not_configured',
  'claimed',
  'provider_failed',
] as const

export type ProviderInstallReturnError =
  (typeof PROVIDER_INSTALL_RETURN_ERRORS)[number]

/**
 * Where a provider's install/consent redirect lands the operator.
 *
 * The alternative is what this replaces: GitHub bounced the browser to a route
 * that answered `200 {"ok":true,…}`, leaving the operator staring at JSON on an
 * API path with no way back. Worse, `setup_on_update` means that happens again
 * on every repository-selection change.
 */
export function providerInstallUiReturnPath(
  organizationId: string | null,
  appId: string | null,
  query: { installed?: string; error?: ProviderInstallReturnError },
): string {
  const base = appId
    ? gitAppUiPath(organizationId, appId)
    : gitSourcesUiBasePath(organizationId)
  return withQuery(base, { installed: query.installed, error: query.error })
}

/**
 * What the "create a GitHub App" wizard sends.
 *
 * Every field here is **creation-only** on GitHub's side — the name, the
 * origin, the webhook URL, the permission set — so this is the one chance to
 * get them right. That is why the wizard asks rather than defaulting, and why
 * a malformed body is rejected instead of being silently normalized: an app
 * registered with the wrong webhook origin cannot be corrected from here.
 */
export type GithubManifestStartInput = {
  name: string
  baseUrl: string
  apiUrl: string | null
  organizationLogin: string | null
  webhookOrigin: string | null
  pullRequestAccess: 'read' | 'write'
  customGitUser: string | null
  customGitPort: number | null
}

/** GitHub caps App names at 34 characters. */
export const GITHUB_APP_NAME_MAX_LENGTH = 34

function optionalTrimmed(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The optional string fields, all sharing the same grammar: absent, `null`,
 * or a non-empty string.
 */
const MANIFEST_OPTIONAL_FIELDS = [
  'apiUrl',
  'organizationLogin',
  'webhookOrigin',
  'customGitUser',
] as const

type ManifestOptionalField = (typeof MANIFEST_OPTIONAL_FIELDS)[number]

/**
 * Read every optional field in one pass, or reject the body.
 *
 * A field that is present but not a string is a client bug, not an omission,
 * so the whole body is refused rather than the field being quietly dropped —
 * see the note on {@link GithubManifestStartInput} for why a half-applied
 * manifest cannot be corrected afterwards.
 */
function readManifestOptionals(
  raw: Record<string, unknown>,
): Record<ManifestOptionalField, string | null> | null {
  const out = {} as Record<ManifestOptionalField, string | null>
  for (const key of MANIFEST_OPTIONAL_FIELDS) {
    const value = optionalTrimmed(raw[key])
    if (value === undefined) return null
    out[key] = value
  }
  return out
}

/** `undefined` means "reject the body"; `null` means the operator left it unset. */
function readCustomGitPort(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

export function parseGithubManifestStartBody(
  body: unknown,
): GithubManifestStartInput | null {
  const raw = isPlainObject(body) ? body : {}

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0 || name.length > GITHUB_APP_NAME_MAX_LENGTH) return null

  const baseUrlRaw = optionalTrimmed(raw.baseUrl)
  if (baseUrlRaw === undefined) return null

  const optionals = readManifestOptionals(raw)
  if (optionals === null) return null

  const customGitPort = readCustomGitPort(raw.customGitPort)
  if (customGitPort === undefined) return null

  const access = raw.pullRequestAccess
  if (access !== undefined && access !== 'read' && access !== 'write') return null

  const { apiUrl, organizationLogin, webhookOrigin, customGitUser } = optionals
  return {
    name,
    baseUrl: stripTrailingSlashes(baseUrlRaw ?? GITHUB_DEFAULT_BASE_URL),
    apiUrl,
    organizationLogin,
    webhookOrigin: webhookOrigin ? stripTrailingSlashes(webhookOrigin) : null,
    pullRequestAccess: access === 'write' ? 'write' : 'read',
    customGitUser,
    customGitPort,
  }
}

/** Plain fields that accept a value or an explicit `null` to clear. */
const NULLABLE_TEXT_FIELDS = ['apiUrl', 'appSlug', 'clientId', 'redirectUri'] as const

/** Sealed fields; same nullable grammar, never echoed back. */
const SECRET_FIELDS = ['privateKeyPem', 'clientSecret', 'webhookSecret'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Apply the nullable-field grammar to one key.
 *
 * Three states, and the distinction matters: **absent** keeps the stored value,
 * an explicit **null** clears it, and a **string** replaces it. An empty string
 * is none of those and is rejected rather than folded into "clear" — otherwise
 * a form that submitted a blank private-key box would silently wipe a key the
 * operator was never shown, which is exactly the accident the write-only fields
 * exist to prevent. Clearing is available, but you have to mean it.
 *
 * Returns `false` on a type error so the caller can reject the whole body
 * rather than silently dropping a field the operator meant to set.
 */
function applyNullable(
  raw: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): boolean {
  if (!(key in raw)) return true
  const value = raw[key]
  if (value === null) {
    target[key] = null
    return true
  }
  if (typeof value !== 'string') return false
  if (value.trim().length === 0) return false
  target[key] = value
  return true
}

export function parseGitAppCreateBody(
  body: unknown,
  organizationId: string | null,
): GitAppCreate | null {
  if (!isPlainObject(body)) return null

  const provider = readRequiredString(body.provider)
  if (!provider || !GIT_APP_PROVIDERS.includes(provider as GitAppProvider)) return null

  const name = readRequiredString(body.name)
  if (!name) return null

  const externalAppId = readRequiredString(body.externalAppId)
  if (!externalAppId) return null

  const parsed: Record<string, unknown> = {
    organizationId,
    provider: provider as GitAppProvider,
    name,
    externalAppId,
  }

  if ('baseUrl' in body) {
    const baseUrl = readRequiredString(body.baseUrl)
    if (!baseUrl) return null
    parsed.baseUrl = baseUrl
  }
  for (const key of [...NULLABLE_TEXT_FIELDS, ...SECRET_FIELDS]) {
    if (!applyNullable(body, parsed, key)) return null
  }

  return parsed as GitAppCreate
}

export function parseGitAppPatchBody(body: unknown): GitAppUpdate | null {
  if (!isPlainObject(body)) return null

  const parsed: Record<string, unknown> = {}

  for (const key of ['name', 'externalAppId', 'baseUrl'] as const) {
    if (!(key in body)) continue
    const value = readRequiredString(body[key])
    if (!value) return null
    parsed[key] = value
  }
  for (const key of [...NULLABLE_TEXT_FIELDS, ...SECRET_FIELDS]) {
    if (!applyNullable(body, parsed, key)) return null
  }

  // `provider` and `organizationId` are immutable: changing either would move
  // the app to a different verification lane or a different tenant while its
  // installations kept pointing at it.
  if ('provider' in body || 'organizationId' in body) return null

  return parsed as GitAppUpdate
}

export type SerializedGitApp = GitAppSummary & {
  /** Ingress path this app's deliveries should arrive on. */
  webhookPath: string
  /** Absolute URL, when the instance knows a public origin. */
  webhookUrl: string | null
  /** `true` when this app is instance-wide and the caller is org-scoped. */
  readOnly: boolean
}

/**
 * Fold the routing URL onto a summary.
 *
 * The app's **own** `webhookOrigin` wins over the instance default. The
 * provider stored one specific URL at registration and never revisits it, so on
 * an instance publishing several origins the default would show the operator an
 * address their deliveries do not use. The instance default is the fallback for
 * an app registered before the choice was offered.
 *
 * `readOnly` is computed rather than stored: the same instance-wide row is
 * editable through the admin surface and read-only through an organization's,
 * so it is a property of the view, not of the record.
 */
export function serializeGitApp(
  app: GitAppSummary,
  opts: { publicOrigin: string | null; viewerOrganizationId: string | null },
): SerializedGitApp {
  const webhookPath = webhookPathFor(
    app.provider as WebhookProvider,
    app.webhookRef,
    app.baseUrl,
  )
  const origin = app.webhookOrigin ?? opts.publicOrigin
  return {
    ...app,
    webhookPath,
    webhookUrl: origin ? `${origin.replace(/\/$/, '')}${webhookPath}` : null,
    readOnly: opts.viewerOrganizationId !== null && app.organizationId === null,
  }
}
