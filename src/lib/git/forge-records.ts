/**
 * Registered Git provider applications — GitHub Apps and GitLab OAuth
 * applications — as rows in `forge`.
 *
 * This replaces the two singleton `setting` rows (`TURBOPANEL_GITHUB_APP`,
 * `TURBOPANEL_GITLAB_OAUTH`) that previously allowed exactly one app of each
 * kind per instance. The sealing rules are unchanged: the App private key, the
 * OAuth client secret, and the webhook secret are sealed with `encryptSecret`
 * (`tpsecret`) before they are written, and are never plaintext at rest. Only
 * the shape moved — from one key/value row to a table with a scope column.
 *
 * **`organizationId === null` means instance-wide.** Any organization may
 * connect through such an app; only an instance admin may edit it. A non-null
 * value means the app belongs to that organization alone. `visibleForges`
 * is the one query that encodes "what may this organization use", and every
 * org-facing caller should go through it rather than filtering by hand.
 *
 * **Tokens are not stored here.** GitHub installation tokens are minted on
 * demand (`./github-app-token.ts`); GitLab's per-connection OAuth pair lives
 * sealed on the connection row (`./gitlab-oauth-token.ts`). This table holds
 * only the application-level material every connection is minted through.
 */

import { and, eq, isNull, or, type SQL } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { forge, gitConnection } from '../db/schema.ts'
import {
  decryptSecret,
  encryptSecret,
  isSealedEnvelope,
} from '../../client/authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'
import { normalizeOrigin } from './origin.ts'

/** Providers that have a registerable application. `git` (generic SSH) has none. */
export const FORGE_PROVIDERS = ['github', 'gitlab'] as const
export type ForgeProvider = (typeof FORGE_PROVIDERS)[number]

/** github.com, unless the operator points at a GitHub Enterprise Server. */
export const GITHUB_DEFAULT_BASE_URL = 'https://github.com'

/** gitlab.com, unless the operator points at a self-managed instance. */
export const GITLAB_DEFAULT_BASE_URL = 'https://gitlab.com'

/** Scopes the GitLab connect flow requests. `api` covers repository + webhook reads. */
export const GITLAB_OAUTH_SCOPES = 'api read_repository'

/**
 * Minimum accepted length for a GitLab webhook token.
 *
 * The token is looked up by digest (see {@link hashWebhookToken}), so a
 * low-entropy value would be brute-forceable offline by anyone who obtained the
 * table. Tokens we generate are 32 random bytes; this floor only constrains
 * hand-entered ones.
 */
export const MIN_GITLAB_WEBHOOK_TOKEN_LENGTH = 24

export class ForgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForgeError'
  }
}

/**
 * A registration that collides with one already stored.
 *
 * Raised in place of the raw Postgres unique violation so callers answer `409`
 * rather than `500`. **The message is deliberately the same for every
 * constraint and says nothing about who holds the existing row.** All three
 * unique keys here are instance-global — they have to be, because webhook
 * routing resolves a delivery without knowing its tenant first — so a
 * distinguishable error would let one organization probe another's
 * registrations. For `webhook_token_hash` that would be worse than an existence
 * leak: the token is the *whole* credential on a GitLab delivery, so a
 * distinguishable response is an online guessing oracle for it.
 */
export class ForgeConflictError extends Error {
  constructor() {
    super('a git application with these details is already registered')
    this.name = 'ForgeConflictError'
  }
}

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

/** Run a write, mapping a unique violation to the opaque conflict above. */
async function withConflictMapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isUniqueViolation(error)) throw new ForgeConflictError()
    throw error
  }
}

/** Sealed material, held together in the row's `envelopes` jsonb. */
type StoredEnvelopes = {
  /** GitHub App private key (PEM). */
  privateKeyEnvelope?: string
  /** GitLab OAuth application secret. */
  clientSecretEnvelope?: string
  /** GitHub HMAC secret, or the GitLab `X-Gitlab-Token` value. */
  webhookSecretEnvelope?: string
}

/** Non-secret columns, shared by every view of a row. */
export type ForgeRecord = {
  id: string
  /** `null` = instance-wide. */
  organizationId: string | null
  provider: ForgeProvider
  name: string
  baseUrl: string
  /** Explicit API origin (GHES); `null` means derive it from `baseUrl`. */
  apiUrl: string | null
  externalAppId: string
  appSlug: string | null
  clientId: string | null
  redirectUri: string | null
  webhookRef: string
  /** Public origin this app's deliveries were registered against; null = unset. */
  webhookOrigin: string | null
  /** What the provider was told about installability beyond the owning account. */
  isPublic: boolean
  /** SSH clone identity; inert for token-cloned GitHub App sources. */
  customGitUser: string | null
  customGitPort: number | null
  syncedAt: string | null
}

/** Safe to return over the API: reports only whether sealed material exists. */
export type ForgeSummary = ForgeRecord & {
  hasPrivateKey: boolean
  hasClientSecret: boolean
  hasWebhookSecret: boolean
}

/** Unsealed. Callers must keep the result in memory only. */
export type Forge = ForgeRecord & {
  privateKeyPem: string | null
  clientSecret: string | null
  webhookSecret: string | null
}

export type ForgeCreate = {
  organizationId: string | null
  provider: ForgeProvider
  name: string
  baseUrl?: string | null
  apiUrl?: string | null
  externalAppId: string
  appSlug?: string | null
  clientId?: string | null
  redirectUri?: string | null
  webhookOrigin?: string | null
  isPublic?: boolean
  customGitUser?: string | null
  customGitPort?: number | null
  privateKeyPem?: string | null
  clientSecret?: string | null
  webhookSecret?: string | null
  /**
   * Adopt a ref minted before the row existed.
   *
   * The manifest flow has to know the webhook URL *before* GitHub creates the
   * App, so it generates the ref up front and bakes it into the manifest. The
   * row must then be born with that same ref — writing a different one and
   * correcting it afterwards would leave a window where the App's configured
   * URL resolves to nothing.
   */
  webhookRef?: string
}

/** Partial update; omitted fields keep their stored value, `null` clears. */
export type ForgeUpdate = {
  name?: string
  baseUrl?: string
  apiUrl?: string | null
  externalAppId?: string
  appSlug?: string | null
  clientId?: string | null
  redirectUri?: string | null
  webhookOrigin?: string | null
  isPublic?: boolean
  customGitUser?: string | null
  customGitPort?: number | null
  privateKeyPem?: string | null
  clientSecret?: string | null
  webhookSecret?: string | null
  /** Set by the provider reconcile in `./github-app-metadata.ts`. */
  syncedAt?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function defaultBaseUrlFor(provider: ForgeProvider): string {
  return provider === 'github' ? GITHUB_DEFAULT_BASE_URL : GITLAB_DEFAULT_BASE_URL
}

function readEnvelopes(value: unknown): StoredEnvelopes {
  if (!isPlainObject(value)) return {}
  const stored: StoredEnvelopes = {}
  for (const key of ['privateKeyEnvelope', 'clientSecretEnvelope', 'webhookSecretEnvelope'] as const) {
    const held = value[key]
    if (typeof held === 'string' && held.length > 0) stored[key] = held
  }
  return stored
}

function encodeUrlSafe(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * Opaque routing token for this app's webhook URL.
 *
 * Not a credential — the HMAC (GitHub) or the token compare (GitLab) still
 * authenticates the delivery. Unguessable so the surface cannot be enumerated.
 */
export function generateWebhookRef(): string {
  return encodeUrlSafe(crypto.getRandomValues(new Uint8Array(24)))
}

/** A GitLab webhook token, when we are the one minting it. */
export function generateGitlabWebhookToken(): string {
  return encodeUrlSafe(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Digest a GitLab webhook token so a delivery arriving on the unscoped path can
 * be resolved with one indexed lookup instead of a table scan.
 *
 * This is a routing index, not the authentication step: the resolved app's
 * sealed secret is still compared against the presented token in constant time
 * (`timingSafeSecretEquals`). Domain-separated so the digest cannot be confused
 * with any other hash of the same value.
 */
export async function hashWebhookToken(token: string): Promise<string> {
  const material = new TextEncoder().encode(`turbopanel:gitlab-webhook-token:${token}`)
  const digest = await crypto.subtle.digest('SHA-256', material)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

type Row = typeof forge.$inferSelect

function toRecord(row: Row): ForgeRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider as ForgeProvider,
    name: row.name,
    baseUrl: row.baseUrl,
    apiUrl: row.apiUrl,
    externalAppId: row.externalAppId,
    appSlug: row.appSlug,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    webhookRef: row.webhookRef,
    webhookOrigin: row.webhookOrigin,
    isPublic: row.isPublic,
    customGitUser: row.customGitUser,
    customGitPort: row.customGitPort,
    syncedAt: row.syncedAt,
  }
}

export function summarizeForge(row: Row): ForgeSummary {
  const envelopes = readEnvelopes(row.envelopes)
  return {
    ...toRecord(row),
    hasPrivateKey: Boolean(envelopes.privateKeyEnvelope),
    hasClientSecret: Boolean(envelopes.clientSecretEnvelope),
    hasWebhookSecret: Boolean(envelopes.webhookSecretEnvelope),
  }
}

async function unsealOne(
  envelope: string | undefined,
  label: string,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<string | null> {
  if (!envelope) return null
  if (!isSealedEnvelope(envelope)) {
    throw new ForgeError(`git app ${label} is not sealed`)
  }
  return await decryptSecret(dataEncryptionSecrets, envelope)
}

async function unsealForge(
  row: Row,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<Forge> {
  const envelopes = readEnvelopes(row.envelopes)
  return {
    ...toRecord(row),
    privateKeyPem: await unsealOne(
      envelopes.privateKeyEnvelope,
      'private key',
      dataEncryptionSecrets,
    ),
    clientSecret: await unsealOne(
      envelopes.clientSecretEnvelope,
      'client secret',
      dataEncryptionSecrets,
    ),
    webhookSecret: await unsealOne(
      envelopes.webhookSecretEnvelope,
      'webhook secret',
      dataEncryptionSecrets,
    ),
  }
}

/**
 * Apps this organization may connect through: its own, plus every instance-wide
 * one. Pass `organizationId: null` for the instance-admin view, which lists only
 * instance-wide rows.
 */
export function visibleForgesCondition(organizationId: string | null): SQL {
  if (organizationId === null) return isNull(forge.organizationId)
  // Never `undefined`: callers pass this straight into `and(...)`, which
  // *silently drops* undefined operands — a nullable return would degrade a
  // scoped lookup into an unscoped one, which is a cross-tenant read.
  return or(
    isNull(forge.organizationId),
    eq(forge.organizationId, organizationId),
  ) as SQL
}

export async function listForges(
  db: Db,
  opts: { organizationId: string | null; provider?: ForgeProvider },
): Promise<ForgeSummary[]> {
  const conditions: SQL[] = [visibleForgesCondition(opts.organizationId)]
  if (opts.provider) conditions.push(eq(forge.provider, opts.provider))

  const rows = await db
    .select()
    .from(forge)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(forge.createdAt)
  return rows.map(summarizeForge)
}

export async function getForgeSummary(db: Db, id: string): Promise<ForgeSummary | null> {
  const rows = await db.select().from(forge).where(eq(forge.id, id)).limit(1)
  return rows[0] ? summarizeForge(rows[0]) : null
}

/** Unsealed load by id. `null` when the row is gone. */
export async function loadForge(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  id: string,
): Promise<Forge | null> {
  const rows = await db.select().from(forge).where(eq(forge.id, id)).limit(1)
  return rows[0] ? await unsealForge(rows[0], dataEncryptionSecrets) : null
}

/**
 * Unsealed load of the forge a connection was granted through.
 *
 * This is the replacement for the old org-blind `getGithubAppConfig(db, …)` /
 * `getGitlabOauthConfig(db, …)` calls: the connection row names its forge, so
 * token minting no longer has to assume there is only one.
 */
export async function loadForgeForConnection(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  connectionId: string,
): Promise<Forge | null> {
  const rows = await db
    .select({ app: forge })
    .from(gitConnection)
    .innerJoin(forge, eq(gitConnection.forgeId, forge.id))
    .where(eq(gitConnection.id, connectionId))
    .limit(1)
  return rows[0] ? await unsealForge(rows[0].app, dataEncryptionSecrets) : null
}

/** Webhook routing: the authoritative lookup, by the ref in the delivery URL. */
export async function findForgeByWebhookRef(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  webhookRef: string,
): Promise<Forge | null> {
  const rows = await db
    .select()
    .from(forge)
    .where(eq(forge.webhookRef, webhookRef))
    .limit(1)
  return rows[0] ? await unsealForge(rows[0], dataEncryptionSecrets) : null
}

/**
 * Webhook routing fallback for GitHub: the App id from
 * `X-GitHub-Hook-Installation-Target-ID`.
 *
 * Returns every match rather than the first. A numeric App id is unique per
 * origin, not globally, so github.com and a GHES instance can both hold one —
 * the caller tries each candidate's secret. Taking `.first()` here is precisely
 * the bug that makes multi-forge routing fail elsewhere.
 */
export async function findGithubForgesByExternalAppId(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  externalAppId: string,
): Promise<Forge[]> {
  const rows = await db
    .select()
    .from(forge)
    .where(
      and(eq(forge.provider, 'github'), eq(forge.externalAppId, externalAppId)),
    )
    .orderBy(forge.createdAt)
  return await Promise.all(rows.map((row) => unsealForge(row, dataEncryptionSecrets)))
}

/** Webhook routing fallback for GitLab: digest of the presented `X-Gitlab-Token`. */
export async function findGitlabForgeByWebhookTokenHash(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  tokenHash: string,
): Promise<Forge | null> {
  const rows = await db
    .select()
    .from(forge)
    .where(eq(forge.webhookTokenHash, tokenHash))
    .limit(1)
  return rows[0] ? await unsealForge(rows[0], dataEncryptionSecrets) : null
}

function assertProvider(provider: string): ForgeProvider {
  if (provider !== 'github' && provider !== 'gitlab') {
    throw new ForgeError(`unsupported git app provider: ${provider}`)
  }
  return provider
}

async function sealInto(
  envelopes: StoredEnvelopes,
  key: keyof StoredEnvelopes,
  value: string | null | undefined,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<void> {
  if (value === undefined) return
  const trimmed = trimOrNull(value)
  if (trimmed === null) delete envelopes[key]
  else envelopes[key] = await encryptSecret(dataEncryptionSecrets, trimmed)
}

/**
 * The GitLab webhook token is the one secret we also index. Keep the digest in
 * lockstep with the sealed value so the fallback lookup can never resolve to an
 * app whose stored secret would then fail the constant-time compare.
 */
async function resolveGitlabTokenHash(
  provider: ForgeProvider,
  webhookSecret: string | null | undefined,
): Promise<string | null | undefined> {
  if (provider !== 'gitlab' || webhookSecret === undefined) return undefined
  const trimmed = trimOrNull(webhookSecret)
  if (trimmed === null) return null
  if (trimmed.length < MIN_GITLAB_WEBHOOK_TOKEN_LENGTH) {
    throw new ForgeError(
      `gitlab webhook token must be at least ${MIN_GITLAB_WEBHOOK_TOKEN_LENGTH} characters`,
    )
  }
  return await hashWebhookToken(trimmed)
}

export async function createForge(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: ForgeCreate,
): Promise<ForgeSummary> {
  const provider = assertProvider(input.provider)
  const name = trimOrNull(input.name)
  if (!name) throw new ForgeError('name must not be empty')
  const externalAppId = trimOrNull(input.externalAppId)
  if (!externalAppId) throw new ForgeError('externalAppId must not be empty')

  const envelopes: StoredEnvelopes = {}
  await sealInto(envelopes, 'privateKeyEnvelope', input.privateKeyPem, dataEncryptionSecrets)
  await sealInto(envelopes, 'clientSecretEnvelope', input.clientSecret, dataEncryptionSecrets)
  await sealInto(envelopes, 'webhookSecretEnvelope', input.webhookSecret, dataEncryptionSecrets)

  const tokenHash = await resolveGitlabTokenHash(provider, input.webhookSecret)

  const rows = await withConflictMapped(() =>
    db
      .insert(forge)
      .values({
        organizationId: input.organizationId,
        provider,
        name,
        baseUrl: normalizeOrigin(
          trimOrNull(input.baseUrl) ?? defaultBaseUrlFor(provider),
        ),
        apiUrl: trimOrNull(input.apiUrl),
        externalAppId,
        appSlug: trimOrNull(input.appSlug),
        clientId: trimOrNull(input.clientId),
        redirectUri: trimOrNull(input.redirectUri),
        webhookOrigin: trimOrNull(input.webhookOrigin),
        isPublic: input.isPublic ?? false,
        customGitUser: trimOrNull(input.customGitUser),
        customGitPort: input.customGitPort ?? null,
        envelopes,
        webhookRef: input.webhookRef ?? generateWebhookRef(),
        webhookTokenHash: tokenHash ?? null,
      })
      .returning()
  )
  return summarizeForge(rows[0])
}

function requireNonEmpty(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  const trimmed = trimOrNull(value)
  if (!trimmed) throw new ForgeError(`${field} must not be empty`)
  return trimmed
}

const NULLABLE_STRING_COLUMNS = [
  'apiUrl',
  'appSlug',
  'clientId',
  'redirectUri',
  'webhookOrigin',
  'customGitUser',
] as const

function applyForgeColumnUpdates(
  next: Partial<typeof forge.$inferInsert>,
  updates: ForgeUpdate,
): void {
  const name = requireNonEmpty(updates.name, 'name')
  if (name !== undefined) next.name = name
  const externalAppId = requireNonEmpty(updates.externalAppId, 'externalAppId')
  if (externalAppId !== undefined) next.externalAppId = externalAppId
  const baseUrl = requireNonEmpty(updates.baseUrl, 'baseUrl')
  if (baseUrl !== undefined) next.baseUrl = normalizeOrigin(baseUrl)

  for (const column of NULLABLE_STRING_COLUMNS) {
    const value = updates[column]
    if (value !== undefined) next[column] = trimOrNull(value)
  }
  if (updates.isPublic !== undefined) next.isPublic = updates.isPublic
  if (updates.customGitPort !== undefined) next.customGitPort = updates.customGitPort
  if (updates.syncedAt !== undefined) next.syncedAt = updates.syncedAt
}

export async function updateForge(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  id: string,
  updates: ForgeUpdate,
): Promise<ForgeSummary | null> {
  const existing = await db
    .select()
    .from(forge)
    .where(eq(forge.id, id))
    .limit(1)
  const row = existing[0]
  if (!row) return null

  const provider = assertProvider(row.provider)
  const envelopes = readEnvelopes(row.envelopes)
  await sealInto(envelopes, 'privateKeyEnvelope', updates.privateKeyPem, dataEncryptionSecrets)
  await sealInto(envelopes, 'clientSecretEnvelope', updates.clientSecret, dataEncryptionSecrets)
  await sealInto(envelopes, 'webhookSecretEnvelope', updates.webhookSecret, dataEncryptionSecrets)

  const next: Partial<typeof forge.$inferInsert> = {
    envelopes,
    updatedAt: new Date().toISOString(),
  }
  applyForgeColumnUpdates(next, updates)

  const tokenHash = await resolveGitlabTokenHash(provider, updates.webhookSecret)
  if (tokenHash !== undefined) next.webhookTokenHash = tokenHash

  const rows = await withConflictMapped(() =>
    db
      .update(forge)
      .set(next)
      .where(eq(forge.id, id))
      .returning()
  )
  return rows[0] ? summarizeForge(rows[0]) : null
}

export async function deleteForge(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(forge)
    .where(eq(forge.id, id))
    .returning({ id: forge.id })
  return rows.length > 0
}
