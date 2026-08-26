/**
 * GitLab OAuth token lifecycle (Workers-safe).
 *
 * This is the one place GitLab genuinely differs from GitHub. A GitHub App
 * mints installation tokens *statelessly*: sign a JWT with the App key, trade
 * it in, discard the result. GitLab hands out an **access token + refresh
 * token pair** at connect time, and rotates the refresh token every time it is
 * used — so the pair has to be stored, and a refresh has to be **written back**
 * or the connection is dead on the next deploy.
 *
 * The pair therefore lives sealed (`tpsecret`) on the installation row's
 * `oauthEnvelope` column. Nothing else about it is stored: no scope soup, no
 * plaintext, no copy in the source row.
 *
 * Web APIs only (`fetch`, `crypto.subtle` via `encryptSecret`) so the module
 * stays reachable from `src/workers.ts`.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { gitProviderInstallation } from '../db/schema.ts'
import {
  decryptSecret,
  encryptSecret,
  isSealedEnvelope,
} from '../../client/authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'
import {
  type GitApp,
  GITLAB_OAUTH_SCOPES,
  loadGitAppForInstallation,
} from './git-app-records.ts'

/**
 * The application-level material every GitLab grant is minted through.
 *
 * A narrow structural type rather than the whole app row: these functions do
 * token exchange and nothing else, and keeping them off `GitApp` means the
 * connect flow can pass credentials it assembled from a form just as easily as
 * ones it read from the table.
 */
export type GitlabOauthCredentials = {
  clientId: string
  clientSecret: string
  /** Instance root (`https://gitlab.com` or a self-managed origin). */
  baseUrl: string
}

/**
 * Narrow a registered app to its OAuth credentials.
 *
 * Throws rather than returning null: a GitLab app without a client id and
 * secret cannot mint anything, and every caller here is already on a path that
 * needs a token.
 */
export function gitlabOauthCredentials(app: GitApp): GitlabOauthCredentials {
  if (app.provider !== 'gitlab') {
    throw new GitlabOauthTokenError(`app "${app.name}" is not a gitlab application`)
  }
  if (!app.clientId || !app.clientSecret) {
    throw new GitlabOauthTokenError('gitlab oauth application is not configured')
  }
  return { clientId: app.clientId, clientSecret: app.clientSecret, baseUrl: app.baseUrl }
}

export class GitlabOauthTokenError extends Error {
  /** HTTP status from GitLab, when the failure came from the API. */
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GitlabOauthTokenError'
    this.status = status
  }
}

/** An access token with the moment it stops being usable. */
export type GitlabAccessToken = {
  token: string
  /** ISO-8601 expiry, derived from GitLab's `expires_in`. */
  expiresAt: string
}

/** The full pair as GitLab returned it — both halves must be persisted. */
export type GitlabTokenPair = GitlabAccessToken & {
  /** GitLab rotates this on every refresh; the new value must be stored. */
  refreshToken: string | null
  scope: string | null
}

/** Sealed shape stored in `installation.oauth_envelope`. */
type StoredGitlabOauth = {
  accessTokenEnvelope?: string
  refreshTokenEnvelope?: string
  expiresAt?: string
  scope?: string
}

/**
 * Refresh this long before the recorded expiry.
 *
 * A deploy that starts with a token about to lapse would fail mid-clone, and
 * the clone happens on the host seconds after prepare seals the credential.
 */
const GITLAB_TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000
/** GitLab access tokens are short-lived; assume the documented default. */
const GITLAB_DEFAULT_TOKEN_LIFETIME_SECONDS = 7200

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStored(value: unknown): StoredGitlabOauth {
  if (!isPlainObject(value)) return {}
  const stored: StoredGitlabOauth = {}
  if (typeof value.accessTokenEnvelope === 'string') {
    stored.accessTokenEnvelope = value.accessTokenEnvelope
  }
  if (typeof value.refreshTokenEnvelope === 'string') {
    stored.refreshTokenEnvelope = value.refreshTokenEnvelope
  }
  if (typeof value.expiresAt === 'string') stored.expiresAt = value.expiresAt
  if (typeof value.scope === 'string') stored.scope = value.scope
  return stored
}

/** The URL the connect flow redirects the operator to. */
export function gitlabAuthorizeUrl(
  config: Pick<GitlabOauthCredentials, 'baseUrl' | 'clientId'>,
  params: { redirectUri: string; state: string },
): string {
  const target = new URL(`${config.baseUrl}/oauth/authorize`)
  target.searchParams.set('client_id', config.clientId)
  target.searchParams.set('redirect_uri', params.redirectUri)
  target.searchParams.set('response_type', 'code')
  target.searchParams.set('state', params.state)
  target.searchParams.set('scope', GITLAB_OAUTH_SCOPES)
  return target.toString()
}

async function readGitlabError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) return `gitlab request failed (${response.status})`
  try {
    const parsed = JSON.parse(body) as {
      error_description?: unknown
      error?: unknown
      message?: unknown
    }
    for (const field of [parsed.error_description, parsed.message, parsed.error]) {
      if (typeof field === 'string' && field.length > 0) {
        return `gitlab request failed (${response.status}): ${field}`
      }
    }
  } catch {
    // Non-JSON error body — fall through to the status-only message.
  }
  return `gitlab request failed (${response.status})`
}

function expiresAtFrom(expiresIn: unknown, nowMs: number): string {
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn)
    ? expiresIn
    : GITLAB_DEFAULT_TOKEN_LIFETIME_SECONDS
  return new Date(nowMs + seconds * 1000).toISOString()
}

/**
 * `POST /oauth/token`, shared by the authorization-code and refresh grants.
 *
 * Deliberately a bare `fetch` with explicit error mapping, exactly like
 * `exchangeInstallationToken` — the codebase has no generic third-party HTTP
 * client and inventing one here would be a larger change than this call needs.
 */
async function postTokenGrant(
  config: GitlabOauthCredentials,
  form: Record<string, string>,
): Promise<GitlabTokenPair> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...form,
  })

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (error) {
    throw new GitlabOauthTokenError(
      `gitlab token exchange failed: ${
        error instanceof Error ? error.message : 'network error'
      }`,
    )
  }

  if (!response.ok) {
    throw new GitlabOauthTokenError(await readGitlabError(response), response.status)
  }

  const payload = (await response.json().catch(() => null)) as
    | {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
      scope?: unknown
    }
    | null
  if (
    !payload || typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0
  ) {
    throw new GitlabOauthTokenError('gitlab token exchange returned no token')
  }

  return {
    token: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' &&
        payload.refresh_token.length > 0
      ? payload.refresh_token
      : null,
    expiresAt: expiresAtFrom(payload.expires_in, Date.now()),
    scope: typeof payload.scope === 'string' ? payload.scope : null,
  }
}

/** Trade the callback's `code` for the initial token pair. */
export async function exchangeGitlabAuthorizationCode(
  config: GitlabOauthCredentials,
  params: { code: string; redirectUri: string },
): Promise<GitlabTokenPair> {
  return await postTokenGrant(config, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  })
}

/** Trade a refresh token for a new pair. GitLab rotates the refresh half. */
export async function refreshGitlabAccessToken(
  config: GitlabOauthCredentials,
  refreshToken: string,
): Promise<GitlabTokenPair> {
  return await postTokenGrant(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}

/**
 * Seal a token pair onto the installation row.
 *
 * A refresh that returns no new refresh token keeps the stored one — GitLab
 * only rotates when it issues a replacement, and discarding the old value on a
 * response that omitted it would strand the connection.
 */
export async function persistGitlabTokenPair(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  installationId: string,
  pair: GitlabTokenPair,
): Promise<void> {
  const [row] = await db
    .select({ oauthEnvelope: gitProviderInstallation.oauthEnvelope })
    .from(gitProviderInstallation)
    .where(eq(gitProviderInstallation.id, installationId))
    .limit(1)
  const stored = readStored(row?.oauthEnvelope)

  const next: StoredGitlabOauth = {
    accessTokenEnvelope: await encryptSecret(dataEncryptionSecrets, pair.token),
    expiresAt: pair.expiresAt,
  }
  if (pair.refreshToken) {
    next.refreshTokenEnvelope = await encryptSecret(
      dataEncryptionSecrets,
      pair.refreshToken,
    )
  } else if (stored.refreshTokenEnvelope) {
    next.refreshTokenEnvelope = stored.refreshTokenEnvelope
  }
  if (pair.scope) next.scope = pair.scope

  await db
    .update(gitProviderInstallation)
    .set({ oauthEnvelope: next, updatedAt: new Date().toISOString() })
    .where(eq(gitProviderInstallation.id, installationId))
}

function isExpired(expiresAt: string | undefined, nowMs: number): boolean {
  if (!expiresAt) return true
  const parsed = Date.parse(expiresAt)
  if (!Number.isFinite(parsed)) return true
  return parsed - GITLAB_TOKEN_REFRESH_SKEW_MS <= nowMs
}

/**
 * The access token for one GitLab connection, refreshed if it is about to
 * lapse.
 *
 * Mirrors `mintGithubInstallationToken`'s per-request shape — callers get a
 * token they use once and drop — with one unavoidable difference: when a
 * refresh happens, the **rotated pair is written back** before the token is
 * returned. Skipping that write would hand out a working token and leave the
 * next deploy holding a refresh token GitLab has already invalidated.
 */
export async function mintGitlabAccessToken(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  installationId: string,
): Promise<GitlabAccessToken> {
  const [row] = await db
    .select({
      provider: gitProviderInstallation.provider,
      suspendedAt: gitProviderInstallation.suspendedAt,
      oauthEnvelope: gitProviderInstallation.oauthEnvelope,
    })
    .from(gitProviderInstallation)
    .where(eq(gitProviderInstallation.id, installationId))
    .limit(1)

  if (!row) throw new GitlabOauthTokenError('installation not found', 404)
  if (row.provider !== 'gitlab') {
    throw new GitlabOauthTokenError(
      `unsupported installation provider "${row.provider}"`,
    )
  }
  if (row.suspendedAt) {
    throw new GitlabOauthTokenError('installation is suspended', 409)
  }

  const stored = readStored(row.oauthEnvelope)
  const nowMs = Date.now()

  if (stored.accessTokenEnvelope && !isExpired(stored.expiresAt, nowMs)) {
    if (!isSealedEnvelope(stored.accessTokenEnvelope)) {
      throw new GitlabOauthTokenError('gitlab access token is not sealed')
    }
    return {
      token: await decryptSecret(dataEncryptionSecrets, stored.accessTokenEnvelope),
      expiresAt: stored.expiresAt ?? new Date(nowMs).toISOString(),
    }
  }

  if (!stored.refreshTokenEnvelope) {
    throw new GitlabOauthTokenError(
      'gitlab connection has no refresh token — reconnect the account',
      409,
    )
  }
  if (!isSealedEnvelope(stored.refreshTokenEnvelope)) {
    throw new GitlabOauthTokenError('gitlab refresh token is not sealed')
  }

  const refreshToken = await decryptSecret(
    dataEncryptionSecrets,
    stored.refreshTokenEnvelope,
  )
  // Resolved from `installation.app_id`, not from a single instance-wide row:
  // two connections may legitimately be minted through different applications,
  // on different GitLab origins.
  const app = await loadGitAppForInstallation(db, dataEncryptionSecrets, installationId)
  if (!app) {
    throw new GitlabOauthTokenError('gitlab oauth application is not configured')
  }
  const pair = await refreshGitlabAccessToken(gitlabOauthCredentials(app), refreshToken)
  // Write back *before* returning: the rotated refresh token is the only thing
  // that keeps this connection alive past the current token's lifetime.
  await persistGitlabTokenPair(db, dataEncryptionSecrets, installationId, pair)
  return { token: pair.token, expiresAt: pair.expiresAt }
}
