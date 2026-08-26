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
 * ingress path (`/api/git/v1/github/webhook/<ref>`). That is what makes a
 * delivery self-identifying, and it is why {@link buildGithubAppManifest} takes
 * the `webhookRef` that will be written to the `gitapp` row rather than
 * generating one afterwards.
 *
 * **`public: true` is not a default we drifted into.** A private GitHub App can
 * only be installed on the account that owns it, so an App meant to serve
 * several organizations — the whole point of an instance-wide app — has to be
 * public.
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
 * Read-only throughout: TurboPanel clones, resolves refs, and reads compose
 * files. Nothing in the deploy path writes to a repository, and an App that
 * cannot write is one an operator can grant without auditing us first.
 */
export const GITHUB_MANIFEST_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
  pull_requests: 'read',
  checks: 'read',
} as const

/**
 * Events the App subscribes to.
 *
 * `check_suite` and `check_run` are both needed because `autoDeploy:
 * 'checks_passed'` releases on a *suite* result but GitHub only sends the
 * suite-level conclusion on some workflows; the run handler reads its nested
 * suite. `installation` / `installation_repositories` keep the connection's
 * lifecycle in step without polling.
 */
export const GITHUB_MANIFEST_EVENTS = [
  'push',
  'check_suite',
  'check_run',
  'installation',
  'installation_repositories',
] as const

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
}): GithubAppManifest {
  return {
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
    public: true,
    default_permissions: { ...GITHUB_MANIFEST_PERMISSIONS },
    default_events: [...GITHUB_MANIFEST_EVENTS],
  }
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
    throw new GithubManifestError(
      `github manifest conversion failed: ${
        error instanceof Error ? error.message : 'network error'
      }`,
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
