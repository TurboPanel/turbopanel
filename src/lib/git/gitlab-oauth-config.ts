/**
 * Instance-wide GitLab OAuth application credentials, stored as a single
 * `setting` row.
 *
 * Exactly the shape of `./github-app-config.ts`: one key, one jsonb value, and
 * every secret field sealed with `encryptSecret` (`tpsecret`) before it is
 * written — never plaintext at rest.
 *
 * **Why an OAuth application and not an "app installation".** GitLab has no
 * per-repository App install the way GitHub does. The operator registers one
 * OAuth application (on gitlab.com or on their self-managed instance), and each
 * organization then *connects* an account or group through it. That connection
 * — not a GitHub-style installation — is what a `gitProviderInstallation` row
 * with `provider: 'gitlab'` records.
 *
 * **Access tokens are not stored here.** Per-connection OAuth tokens live
 * sealed on the installation row (`./gitlab-oauth-token.ts`); this row holds
 * only the application-level client id / secret every connection is minted
 * through.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'
import {
  decryptSecret,
  encryptSecret,
  isSealedEnvelope,
} from '../../client/authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'

/** DB key for the single JSON row that stores the GitLab OAuth application. */
export const GITLAB_OAUTH_SETTING_KEY = 'TURBOPANEL_GITLAB_OAUTH'

/** gitlab.com, unless the operator points at a self-managed instance. */
export const GITLAB_DEFAULT_BASE_URL = 'https://gitlab.com'

/** Scopes the connect flow requests. `api` covers repository + webhook reads. */
export const GITLAB_OAUTH_SCOPES = 'api read_repository'

/** Stored (sealed) representation. Secret fields hold `tpsecret` envelopes. */
type StoredGitlabOauth = {
  clientId?: string
  clientSecretEnvelope?: string
  redirectUri?: string
  baseUrl?: string
  webhookSecretEnvelope?: string
}

/** Decrypted config handed to the token exchange. */
export type GitlabOauthConfig = {
  clientId: string
  clientSecret: string
  /** Absolute callback URL registered on the GitLab application. */
  redirectUri: string | null
  /** Instance root (`https://gitlab.com` or a self-managed origin). */
  baseUrl: string
  /**
   * Shared token every GitLab webhook must present in `X-Gitlab-Token`.
   *
   * GitLab does not sign deliveries, so this is the *whole* credential — see
   * `./gitlab-webhook.ts`.
   */
  webhookSecret: string | null
}

/** Non-secret view safe to return over the admin API. */
export type GitlabOauthConfigSummary = {
  clientId: string | null
  redirectUri: string | null
  baseUrl: string
  hasClientSecret: boolean
  hasWebhookSecret: boolean
}

/** Partial update payload; omitted fields keep their stored value. */
export type GitlabOauthConfigUpdate = {
  clientId?: string
  clientSecret?: string
  redirectUri?: string | null
  baseUrl?: string | null
  webhookSecret?: string | null
}

export class GitlabOauthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitlabOauthConfigError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStored(value: unknown): StoredGitlabOauth {
  if (!isPlainObject(value)) return {}
  const stored: StoredGitlabOauth = {}
  if (typeof value.clientId === 'string') stored.clientId = value.clientId
  if (typeof value.clientSecretEnvelope === 'string') {
    stored.clientSecretEnvelope = value.clientSecretEnvelope
  }
  if (typeof value.redirectUri === 'string') stored.redirectUri = value.redirectUri
  if (typeof value.baseUrl === 'string') stored.baseUrl = value.baseUrl
  if (typeof value.webhookSecretEnvelope === 'string') {
    stored.webhookSecretEnvelope = value.webhookSecretEnvelope
  }
  return stored
}

async function loadStored(db: Db): Promise<StoredGitlabOauth> {
  const rows = await db
    .select()
    .from(setting)
    .where(eq(setting.key, GITLAB_OAUTH_SETTING_KEY))
    .limit(1)
  return readStored(rows[0]?.value)
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Strip a trailing slash so `${baseUrl}/api/v4/…` never doubles it. */
function normalizeBaseUrl(value: string | null): string {
  if (!value) return GITLAB_DEFAULT_BASE_URL
  const trimmed = value.trim().replace(/(?<!\/)\/+$/, '')
  if (trimmed.length === 0) return GITLAB_DEFAULT_BASE_URL
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new GitlabOauthConfigError('gitlab baseUrl must be http(s)')
    }
  } catch (error) {
    if (error instanceof GitlabOauthConfigError) throw error
    throw new GitlabOauthConfigError('gitlab baseUrl is not a valid URL')
  }
  return trimmed
}

/**
 * Non-secret summary (never decrypts). Safe for a configuration screen: it
 * reports only whether the sealed material is present.
 */
export async function getGitlabOauthConfigSummary(
  db: Db,
): Promise<GitlabOauthConfigSummary> {
  const stored = await loadStored(db)
  return {
    clientId: trimOrNull(stored.clientId),
    redirectUri: trimOrNull(stored.redirectUri),
    baseUrl: normalizeBaseUrl(trimOrNull(stored.baseUrl)),
    hasClientSecret: Boolean(stored.clientSecretEnvelope),
    hasWebhookSecret: Boolean(stored.webhookSecretEnvelope),
  }
}

/**
 * Full config with the client secret / webhook secret unsealed. Returns `null`
 * when the OAuth application has not been configured.
 *
 * Callers must keep the result in memory only.
 */
export async function getGitlabOauthConfig(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<GitlabOauthConfig | null> {
  const stored = await loadStored(db)
  const clientId = trimOrNull(stored.clientId)
  if (!clientId || !stored.clientSecretEnvelope) return null

  if (!isSealedEnvelope(stored.clientSecretEnvelope)) {
    throw new GitlabOauthConfigError('gitlab oauth client secret is not sealed')
  }
  const clientSecret = await decryptSecret(
    dataEncryptionSecrets,
    stored.clientSecretEnvelope,
  )

  let webhookSecret: string | null = null
  if (stored.webhookSecretEnvelope) {
    if (!isSealedEnvelope(stored.webhookSecretEnvelope)) {
      throw new GitlabOauthConfigError('gitlab webhook secret is not sealed')
    }
    webhookSecret = await decryptSecret(
      dataEncryptionSecrets,
      stored.webhookSecretEnvelope,
    )
  }

  return {
    clientId,
    clientSecret,
    redirectUri: trimOrNull(stored.redirectUri),
    baseUrl: normalizeBaseUrl(trimOrNull(stored.baseUrl)),
    webhookSecret,
  }
}

/**
 * Apply one optional nullable plain field: an explicit `null` clears it, a
 * value replaces it (after `normalize`), and `undefined` leaves the stored
 * value alone.
 */
function applyOptionalField(
  next: StoredGitlabOauth,
  key: 'redirectUri' | 'baseUrl',
  value: string | null | undefined,
  normalize: (value: string) => string = (raw) => raw,
): void {
  if (value === undefined) return
  const trimmed = trimOrNull(value)
  if (trimmed === null) delete next[key]
  else next[key] = normalize(trimmed)
}

/** Same, for a field held as a sealed `tpsecret` envelope. */
async function applyOptionalSecret(
  next: StoredGitlabOauth,
  key: 'webhookSecretEnvelope',
  value: string | null | undefined,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<void> {
  if (value === undefined) return
  const trimmed = trimOrNull(value)
  if (trimmed === null) delete next[key]
  else next[key] = await encryptSecret(dataEncryptionSecrets, trimmed)
}

/**
 * Seal and persist the OAuth application credentials. Partial: omitted fields
 * are preserved, and an explicit `null` clears the nullable ones. Every write
 * re-seals under the current key version (lazy re-seal-on-write).
 */
export async function setGitlabOauthConfig(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  updates: GitlabOauthConfigUpdate,
): Promise<void> {
  const stored = await loadStored(db)
  const next: StoredGitlabOauth = { ...stored }

  if (updates.clientId !== undefined) {
    const clientId = trimOrNull(updates.clientId)
    if (!clientId) throw new GitlabOauthConfigError('clientId must not be empty')
    next.clientId = clientId
  }
  if (updates.clientSecret !== undefined) {
    const secret = updates.clientSecret.trim()
    if (secret.length === 0) {
      throw new GitlabOauthConfigError('clientSecret must not be empty')
    }
    next.clientSecretEnvelope = await encryptSecret(dataEncryptionSecrets, secret)
  }
  applyOptionalField(next, 'redirectUri', updates.redirectUri)
  applyOptionalField(next, 'baseUrl', updates.baseUrl, normalizeBaseUrl)
  await applyOptionalSecret(
    next,
    'webhookSecretEnvelope',
    updates.webhookSecret,
    dataEncryptionSecrets,
  )

  if (Object.keys(next).length === 0) {
    await db.delete(setting).where(eq(setting.key, GITLAB_OAUTH_SETTING_KEY))
    return
  }

  await db
    .insert(setting)
    .values({ key: GITLAB_OAUTH_SETTING_KEY, value: next })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value: next, updatedAt: new Date().toISOString() },
    })
}
