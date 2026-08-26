/**
 * GitHub App Manifest flow.
 *
 * Registering a GitHub App by hand means copying five values — app id, slug,
 * client id, a PEM private key, and a webhook secret — out of GitHub's UI and
 * into ours, and getting the webhook URL right by hand as well. The manifest
 * flow does the whole thing in one round trip: we POST a manifest describing
 * the App we want, GitHub creates it and redirects back with a temporary
 * `code`, and one exchange returns every credential at once.
 *
 * **The webhook URL is the reason this matters here.** The manifest sets
 * `hook_attributes.url`, so the App is born already pointing at its own scoped
 * ingress path (`/webhook/github`, or `/webhook/github/<ref>` on GitHub
 * Enterprise). That is what makes a
 * delivery self-identifying, and it is why {@link buildGithubAppManifest} takes
 * the `webhookRef` that will be written to the `gitapp` row rather than
 * generating one afterwards.
 *
 * **`public` tracks the instance-wide toggle.** A private GitHub App can only
 * be installed on the account that owns it, so an App meant to serve several
 * organizations — the whole point of an instance-wide app — has to be public,
 * while an App belonging to one organization should not be.
 */

import {
  GITHUB_API_ACCEPT,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from './github-app-token.ts'

export class GithubManifestError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GithubManifestError'
    this.status = status
  }
}

/**
 * Permissions the App requests.
 *
 * Read-only by default: TurboPanel clones, resolves refs, and reads compose
 * files. Nothing in the deploy path writes to a repository, and an App that
 * cannot write is one an operator can grant without auditing us first.
 *
 * **These are creation-only.** GitHub bakes them into the App and an existing
 * one keeps its old set until every installation manually accepts the new
 * permissions — which is why the choice below is offered up front rather than
 * as a setting to flip later.
 */
export const GITHUB_MANIFEST_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
  pull_requests: 'read',
  checks: 'read',
} as const

/**
 * How much access the App gets to pull requests.
 *
 * `read` is enough to observe a PR. `write` is what a preview deployment needs
 * to post its URL back onto the PR, and it is the one place this App is allowed
 * to write anything — so it is opt-in, and the wizard says plainly what it
 * grants.
 */
export const GITHUB_PULL_REQUEST_ACCESS = ['read', 'write'] as const
export type GithubPullRequestAccess = (typeof GITHUB_PULL_REQUEST_ACCESS)[number]

/**
 * Events the App subscribes to.
 *
 * `check_suite` and `check_run` are both needed because `autoDeploy:
 * 'checks_passed'` releases on a *suite* result but GitHub only sends the
 * suite-level conclusion on some workflows; the run handler reads its nested
 * suite.
 *
 * Do **not** list `installation` or `installation_repositories` here. GitHub
 * still delivers those to every App automatically, but they are not
 * subscribe-able `default_events` — a manifest that names them is rejected
 * ("Default events unsupported" / "not supported by permissions").
 */
export const GITHUB_MANIFEST_EVENTS = [
  'push',
  'check_suite',
  'check_run',
] as const

/**
 * Extra event delivered only when the App can act on pull requests.
 *
 * Subscribing without the write permission would deliver events the instance
 * has no way to respond to, so the two move together.
 */
export const GITHUB_PULL_REQUEST_EVENT = 'pull_request'

export type GithubAppManifest = {
  name: string
  url: string
  hook_attributes: { url: string; active: boolean }
  redirect_url: string
  /**
   * Where GitHub sends the operator after they *install* the App.
   *
   * Distinct from `redirect_url`, which only covers the one-shot manifest
   * conversion. Without a setup URL an install finishes on GitHub with no
   * redirect, `/sources/github/callback` never fires, and no `installation` row
   * is ever written — the App would exist and be installed while TurboPanel
   * showed no connected account, with nothing to recover from (the
   * `installation` webhook only updates rows that already exist).
   */
  setup_url: string
  /** Re-run the setup redirect when an installation's repositories change. */
  request_oauth_on_install: boolean
  setup_on_update: boolean
  public: boolean
  default_permissions: Record<string, string>
  default_events: string[]
}

/** Everything the callback needs back from GitHub, unsealed. */
export type GithubManifestConversion = {
  externalAppId: string
  appSlug: string | null
  clientId: string | null
  clientSecret: string | null
  privateKeyPem: string
  webhookSecret: string | null
}

export function buildGithubAppManifest(params: {
  name: string
  publicUrl: string
  webhookUrl: string
  redirectUrl: string
  setupUrl: string
  /**
   * Installable by GitHub accounts other than the one that creates it.
   *
   * Tracks the instance-wide toggle. A **private** GitHub App can only be
   * installed on its owning account, so an app meant to serve several
   * organizations has to be public — and an app meant for one organization
   * should not be, because public is the broader exposure.
   */
  publicApp: boolean
  /** `write` also subscribes the App to `pull_request`. */
  pullRequestAccess?: GithubPullRequestAccess
}): GithubAppManifest {
  const pullRequestAccess = params.pullRequestAccess ?? 'read'
  const manifest: GithubAppManifest = {
    name: params.name,
    url: params.publicUrl,
    hook_attributes: { url: params.webhookUrl, active: true },
    redirect_url: params.redirectUrl,
    setup_url: params.setupUrl,
    // The install redirect is the only way an `installation` row gets written,
    // so it has to fire on a repository-selection change too, not just on the
    // first install.
    setup_on_update: true,
    request_oauth_on_install: false,
    public: params.publicApp,
    default_permissions: {
      ...GITHUB_MANIFEST_PERMISSIONS,
      pull_requests: pullRequestAccess,
    },
    // Subscribing without the write permission would deliver events the
    // instance has no way to act on, so the two move together.
    default_events: pullRequestAccess === 'write'
      ? [...GITHUB_MANIFEST_EVENTS, GITHUB_PULL_REQUEST_EVENT]
      : [...GITHUB_MANIFEST_EVENTS],
  }
  return manifest
}

/**
 * Where the operator's browser posts the manifest.
 *
 * An organization-owned App is created under that organization's settings so it
 * belongs to the org rather than to whoever happened to click the button; a
 * personal App uses the account-level path.
 */
export function githubAppCreateUrl(
  baseUrl: string,
  state: string,
  organizationLogin?: string | null,
): string {
  const origin = baseUrl.replace(/\/+$/, '')
  const path = organizationLogin
    ? `/organizations/${encodeURIComponent(organizationLogin)}/settings/apps/new`
    : '/settings/apps/new'
  return `${origin}${path}?state=${encodeURIComponent(state)}`
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Exchange the callback's `code` for the App's credentials.
 *
 * One-shot and short-lived on GitHub's side: the code is valid for about an
 * hour and burns on use, so a failure here means starting the flow over rather
 * than retrying.
 */
export async function convertGithubAppManifest(
  apiBase: string,
  code: string,
): Promise<GithubManifestConversion> {
  let response: Response
  try {
    response = await fetch(
      `${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: 'POST',
        headers: {
          accept: GITHUB_API_ACCEPT,
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': GITHUB_USER_AGENT,
        },
      },
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'network error'
    throw new GithubManifestError(
      `github manifest conversion failed: ${errorMessage}`,
    )
  }

  if (!response.ok) {
    throw new GithubManifestError(
      `github manifest conversion failed (${response.status})`,
      response.status,
    )
  }

  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  if (!payload) {
    throw new GithubManifestError('github manifest conversion returned no body')
  }

  const externalAppId = payload.id === undefined || payload.id === null
    ? null
    : String(payload.id)
  const privateKeyPem = readString(payload.pem)
  if (!externalAppId || !privateKeyPem) {
    throw new GithubManifestError(
      'github manifest conversion returned no app id or private key',
    )
  }

  return {
    externalAppId,
    appSlug: readString(payload.slug),
    clientId: readString(payload.client_id),
    clientSecret: readString(payload.client_secret),
    privateKeyPem,
    webhookSecret: readString(payload.webhook_secret),
  }
}
