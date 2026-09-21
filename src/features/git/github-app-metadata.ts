/**
 * Read a GitHub App's own record back from GitHub.
 *
 * **Why this exists.** An operator can rename an App on GitHub, change its
 * visibility, or accept a new permission set — and nothing in the App's webhook
 * vocabulary announces any of it. Until now the console showed whatever was
 * true at registration and drifted silently: a renamed App still appeared under
 * its old name, and a stale `app_slug` broke the install redirect outright,
 * because that slug is what builds `/apps/<slug>/installations/new`.
 *
 * `GET /app` is the App asking about itself, authenticated with the same App
 * JWT the token minter already signs. It is the only GitHub endpoint that
 * answers for the *application* rather than for one of its installations, which
 * is why it is the one reconcile point.
 */

import { stringifyGithubAppId } from './github-app-id.ts'
import {
  githubApiBaseFor,
  githubApiHeaders,
  GithubAppTokenError,
  signGithubAppJwt,
} from './github-app-token.ts'
import type { Forge } from './forge-records.ts'

/** The subset of `GET /app` worth storing. */
export type GithubAppMetadata = {
  externalAppId: string
  name: string
  /** Builds the install URL, so a stale one is a broken flow rather than cosmetic. */
  slug: string | null
  /** `null` when GitHub did not report it — see the note at the read site. */
  isPublic: boolean | null
  /**
   * Permission and event sets as GitHub currently holds them.
   *
   * Kept as a snapshot rather than compared here: what counts as drift is a
   * product question (see `GITHUB_MANIFEST_PERMISSIONS`), and this module's job
   * is to report what is true, not to judge it.
   */
  permissions: Record<string, string>
  events: string[]
}

function readStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : []
}

/**
 * Fetch the App's own record.
 *
 * Throws rather than degrading: this is called from an explicit "sync" action,
 * so a failure is something the operator asked to see. Silently keeping the
 * stale name would defeat the point of the button.
 */
export async function fetchGithubAppMetadata(app: Forge): Promise<GithubAppMetadata> {
  if (app.provider !== 'github') {
    throw new GithubAppTokenError(`app "${app.name}" is not a github app`)
  }
  if (!app.privateKeyPem) {
    throw new GithubAppTokenError('github app has no private key configured')
  }

  const appJwt = await signGithubAppJwt(app.externalAppId, app.privateKeyPem)
  let response: Response
  try {
    response = await fetch(`${githubApiBaseFor(app)}/app`, {
      headers: githubApiHeaders(appJwt, 'Bearer'),
    })
  } catch (error) {
    throw new GithubAppTokenError(
      `github app lookup failed: ${
        error instanceof Error ? error.message : 'network error'
      }`,
    )
  }
  if (!response.ok) {
    throw new GithubAppTokenError(
      `github app lookup failed (${response.status})`,
      response.status,
    )
  }

  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  if (!payload) throw new GithubAppTokenError('github app lookup returned no body')

  const externalAppId = stringifyGithubAppId(payload.id)
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!externalAppId || name.length === 0) {
    throw new GithubAppTokenError('github app lookup returned no id or name')
  }

  return {
    externalAppId,
    name,
    slug: typeof payload.slug === 'string' && payload.slug.length > 0
      ? payload.slug
      : null,
    // Absent means "GitHub did not say", not "private". Coercing a missing
    // value to false would flip a shared App to private in our record and make
    // the console tell operators it cannot be installed elsewhere when it can.
    isPublic: typeof payload.public === 'boolean' ? payload.public : null,
    permissions: readStringRecord(payload.permissions),
    events: readStringArray(payload.events),
  }
}
