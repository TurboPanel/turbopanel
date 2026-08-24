/**
 * Instance-wide GitHub App credentials, stored as a single `setting` row.
 *
 * Shape mirrors `src/admin/public-urls.ts` (one key, one jsonb value) and the
 * sealing rules of `src/lib/settings/email-settings.ts`: the App private key
 * and the webhook secret are sealed with `encryptSecret` (`tpsecret`) before
 * they are written, exactly like TLS private keys — never plaintext at rest.
 *
 * Installation access tokens are **not** stored here (or anywhere): they are
 * minted on demand in `./github-app-token.ts`.
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

/** DB key for the single JSON row that stores the GitHub App credentials. */
export const GITHUB_APP_SETTING_KEY = 'TURBOPANEL_GITHUB_APP'

/** Stored (sealed) representation. Secret fields hold `tpsecret` envelopes. */
type StoredGithubApp = {
  appId?: string
  appSlug?: string | null
  clientId?: string | null
  privateKeyEnvelope?: string
  webhookSecretEnvelope?: string
}

/** Decrypted config handed to the token minter. */
export type GithubAppConfig = {
  appId: string
  appSlug: string | null
  clientId: string | null
  privateKeyPem: string
  webhookSecret: string | null
}

/** Non-secret view safe to return over the admin API. */
export type GithubAppConfigSummary = {
  appId: string | null
  appSlug: string | null
  clientId: string | null
  hasPrivateKey: boolean
  hasWebhookSecret: boolean
}

/** Partial update payload; omitted fields keep their stored value. */
export type GithubAppConfigUpdate = {
  appId?: string
  appSlug?: string | null
  clientId?: string | null
  privateKeyPem?: string
  webhookSecret?: string | null
}

export class GithubAppConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubAppConfigError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStored(value: unknown): StoredGithubApp {
  if (!isPlainObject(value)) return {}
  const stored: StoredGithubApp = {}
  if (typeof value.appId === 'string') stored.appId = value.appId
  if (typeof value.appSlug === 'string') stored.appSlug = value.appSlug
  if (typeof value.clientId === 'string') stored.clientId = value.clientId
  if (typeof value.privateKeyEnvelope === 'string') {
    stored.privateKeyEnvelope = value.privateKeyEnvelope
  }
  if (typeof value.webhookSecretEnvelope === 'string') {
    stored.webhookSecretEnvelope = value.webhookSecretEnvelope
  }
  return stored
}

async function loadStored(db: Db): Promise<StoredGithubApp> {
  const rows = await db
    .select()
    .from(setting)
    .where(eq(setting.key, GITHUB_APP_SETTING_KEY))
    .limit(1)
  return readStored(rows[0]?.value)
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Non-secret summary (never decrypts). Safe for a configuration screen: it
 * reports only whether the sealed material is present.
 */
export async function getGithubAppConfigSummary(
  db: Db,
): Promise<GithubAppConfigSummary> {
  const stored = await loadStored(db)
  return {
    appId: trimOrNull(stored.appId),
    appSlug: trimOrNull(stored.appSlug),
    clientId: trimOrNull(stored.clientId),
    hasPrivateKey: Boolean(stored.privateKeyEnvelope),
    hasWebhookSecret: Boolean(stored.webhookSecretEnvelope),
  }
}

/**
 * Full config with the private key / webhook secret unsealed. Returns `null`
 * when the App has not been configured (no row, or no key material).
 *
 * Callers must keep the result in memory only.
 */
export async function getGithubAppConfig(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<GithubAppConfig | null> {
  const stored = await loadStored(db)
  const appId = trimOrNull(stored.appId)
  if (!appId || !stored.privateKeyEnvelope) return null

  if (!isSealedEnvelope(stored.privateKeyEnvelope)) {
    throw new GithubAppConfigError('github app private key is not sealed')
  }
  const privateKeyPem = await decryptSecret(
    dataEncryptionSecrets,
    stored.privateKeyEnvelope,
  )

  let webhookSecret: string | null = null
  if (stored.webhookSecretEnvelope) {
    if (!isSealedEnvelope(stored.webhookSecretEnvelope)) {
      throw new GithubAppConfigError('github app webhook secret is not sealed')
    }
    webhookSecret = await decryptSecret(
      dataEncryptionSecrets,
      stored.webhookSecretEnvelope,
    )
  }

  return {
    appId,
    appSlug: trimOrNull(stored.appSlug),
    clientId: trimOrNull(stored.clientId),
    privateKeyPem,
    webhookSecret,
  }
}

/**
 * Apply one optional nullable plain field: an explicit `null` clears it, a
 * value replaces it, and `undefined` leaves the stored value alone.
 */
function applyOptionalField(
  next: StoredGithubApp,
  key: 'appSlug' | 'clientId',
  value: string | null | undefined,
): void {
  if (value === undefined) return
  const trimmed = trimOrNull(value)
  if (trimmed === null) delete next[key]
  else next[key] = trimmed
}

/** Same, for a field held as a sealed `tpsecret` envelope. */
async function applyOptionalSecret(
  next: StoredGithubApp,
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
 * Seal and persist the App credentials. Partial: omitted fields are preserved,
 * and an explicit `null` on `webhookSecret` / `appSlug` / `clientId` clears it.
 * Every write re-seals under the current key version (lazy re-seal-on-write).
 */
export async function setGithubAppConfig(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  updates: GithubAppConfigUpdate,
): Promise<void> {
  const stored = await loadStored(db)
  const next: StoredGithubApp = { ...stored }

  if (updates.appId !== undefined) {
    const appId = trimOrNull(updates.appId)
    if (!appId) throw new GithubAppConfigError('appId must not be empty')
    next.appId = appId
  }
  applyOptionalField(next, 'appSlug', updates.appSlug)
  applyOptionalField(next, 'clientId', updates.clientId)
  if (updates.privateKeyPem !== undefined) {
    const pem = updates.privateKeyPem.trim()
    if (pem.length === 0) {
      throw new GithubAppConfigError('privateKeyPem must not be empty')
    }
    next.privateKeyEnvelope = await encryptSecret(dataEncryptionSecrets, pem)
  }
  await applyOptionalSecret(
    next,
    'webhookSecretEnvelope',
    updates.webhookSecret,
    dataEncryptionSecrets,
  )

  if (Object.keys(next).length === 0) {
    await db.delete(setting).where(eq(setting.key, GITHUB_APP_SETTING_KEY))
    return
  }

  await db
    .insert(setting)
    .values({ key: GITHUB_APP_SETTING_KEY, value: next })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value: next,
        updatedAt: new Date().toISOString(),
      },
    })
}
