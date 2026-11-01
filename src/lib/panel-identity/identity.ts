import { eq } from 'drizzle-orm'
import { setting } from '../../db/schema.ts'
import type { Db } from '../../db/connection.ts'
import { base64urlEncode } from '../encoding/base64url.ts'
import { decryptSecret, encryptSecret } from '../secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../secrets/secrets.ts'
import { isPanelFingerprint } from './fingerprint.ts'
import {
  decodeSeed,
  generateIdentitySeeds,
  importEd25519Signer,
  importX25519Sealer,
  type ImportedIdentityKey,
} from './keys.ts'

/** The panel's identity: Ed25519 `current`, the `next` fingerprint (private key stays offline), and the X25519 sealing key. */
export type PanelIdentity = {
  keyset: number
  current: ImportedIdentityKey
  next: { kid: string } | null
  seal: ImportedIdentityKey
}

/**
 * Workers secret binding `TURBOPANEL_IDENTITY_KEYS`. `priv` is a base64url
 * 32-byte seed; the public key is derived from it and `kid` must equal its
 * fingerprint. `next` carries a fingerprint only.
 */
export type IdentityBindingJson = {
  keyset: number
  current: { kid: string; priv: string }
  seal: { kid: string; priv: string }
  next?: { kid: string } | null
}

export const PANEL_IDENTITY_SETTING_KEY = 'PANEL_IDENTITY_KEYS'

const BINDING_NAME = 'TURBOPANEL_IDENTITY_KEYS'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireKeyset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError('keyset must be a positive integer')
  }
  return value
}

function requireKeyEntry(value: unknown, label: string): { kid: string; priv: string } {
  if (!isRecord(value) || typeof value.kid !== 'string' || typeof value.priv !== 'string') {
    throw new TypeError(`${label} needs kid and priv`)
  }
  return { kid: value.kid, priv: value.priv }
}

function parseNext(value: unknown): { kid: string } | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || typeof value.kid !== 'string' || !isPanelFingerprint(value.kid)) {
    throw new TypeError('next needs a 43-character kid fingerprint')
  }
  return { kid: value.kid }
}

/** JSON.parse with a fixed message: the engine's own message echoes the first characters of the input, which may be key material. */
function parseJsonFixedError(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new TypeError('not valid JSON')
  }
}

function parseBindingJson(raw: string): IdentityBindingJson {
  const parsed = parseJsonFixedError(raw)
  if (!isRecord(parsed)) {
    throw new TypeError('must be a JSON object')
  }
  return {
    keyset: requireKeyset(parsed.keyset),
    current: requireKeyEntry(parsed.current, 'current'),
    seal: requireKeyEntry(parsed.seal, 'seal'),
    next: parseNext(parsed.next),
  }
}

async function buildIdentity(input: {
  keyset: number
  ed25519Seed: Uint8Array
  x25519Seed: Uint8Array
  next: { kid: string } | null
}): Promise<PanelIdentity> {
  const [current, seal] = await Promise.all([
    importEd25519Signer(input.ed25519Seed),
    importX25519Sealer(input.x25519Seed),
  ])
  return { keyset: input.keyset, current, next: input.next, seal }
}

function assertKids(identity: PanelIdentity, binding: IdentityBindingJson): void {
  if (identity.current.kid !== binding.current.kid) {
    throw new TypeError('current.kid does not match the fingerprint of current.priv')
  }
  if (identity.seal.kid !== binding.seal.kid) {
    throw new TypeError('seal.kid does not match the fingerprint of seal.priv')
  }
  if (binding.next?.kid === identity.current.kid) {
    throw new TypeError('next.kid must differ from current.kid')
  }
}

/**
 * Identity from the Workers secret binding. Unset or blank means the feature
 * is off (`null`); a malformed value throws so a typo is a boot error, not a
 * silent off. Never logs the value.
 */
export async function resolvePanelIdentityFromBinding(
  raw: string | undefined
): Promise<PanelIdentity | null> {
  if (raw === undefined || raw.trim() === '') return null
  try {
    const binding = parseBindingJson(raw)
    const identity = await buildIdentity({
      keyset: binding.keyset,
      ed25519Seed: decodeSeed(binding.current.priv, 'current.priv'),
      x25519Seed: decodeSeed(binding.seal.priv, 'seal.priv'),
      next: binding.next ?? null,
    })
    assertKids(identity, binding)
    return identity
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'invalid'
    throw new Error(`${BINDING_NAME} is malformed: ${reason}`, { cause: err })
  }
}

/** The `setting.value` shape for the self-hosted store. Seeds live only inside `sealed`. */
export type StoredIdentityValue = {
  v: 1
  keyset: number
  currentKid: string
  sealKid: string
  nextKid: string | null
  sealed: string
}

function parseStoredValue(value: unknown): StoredIdentityValue {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.currentKid !== 'string' ||
    typeof value.sealKid !== 'string' ||
    typeof value.sealed !== 'string'
  ) {
    throw new TypeError(`${PANEL_IDENTITY_SETTING_KEY} setting is malformed`)
  }
  return {
    v: 1,
    keyset: requireKeyset(value.keyset),
    currentKid: value.currentKid,
    sealKid: value.sealKid,
    nextKid: typeof value.nextKid === 'string' ? value.nextKid : null,
    sealed: value.sealed,
  }
}

async function openStored(
  stored: StoredIdentityValue,
  secrets: DerivedSecretsConfig
): Promise<PanelIdentity> {
  const seeds = parseJsonFixedError(await decryptSecret(secrets, stored.sealed))
  if (!isRecord(seeds)) {
    throw new TypeError(`${PANEL_IDENTITY_SETTING_KEY} seeds are malformed`)
  }
  const identity = await buildIdentity({
    keyset: stored.keyset,
    ed25519Seed: decodeSeed(seeds.ed25519Seed, 'ed25519Seed'),
    x25519Seed: decodeSeed(seeds.x25519Seed, 'x25519Seed'),
    next: stored.nextKid ? { kid: stored.nextKid } : null,
  })
  if (identity.current.kid !== stored.currentKid || identity.seal.kid !== stored.sealKid) {
    throw new TypeError(`${PANEL_IDENTITY_SETTING_KEY} fingerprints do not match the sealed seeds`)
  }
  return identity
}

async function readStored(db: Db): Promise<StoredIdentityValue | null> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    .limit(1)
  return rows[0] ? parseStoredValue(rows[0].value) : null
}

export async function resolvePanelIdentityFromDb(
  db: Db,
  dataEncryption: DerivedSecretsConfig
): Promise<PanelIdentity | null> {
  const stored = await readStored(db)
  return stored ? await openStored(stored, dataEncryption) : null
}

async function createStoredValue(
  secrets: DerivedSecretsConfig
): Promise<{ value: StoredIdentityValue; identity: PanelIdentity }> {
  const seeds = generateIdentitySeeds()
  const identity = await buildIdentity({ keyset: 1, ...seeds, next: null })
  const sealed = await encryptSecret(
    secrets,
    JSON.stringify({
      ed25519Seed: base64urlEncode(seeds.ed25519Seed),
      x25519Seed: base64urlEncode(seeds.x25519Seed),
    })
  )
  const value: StoredIdentityValue = {
    v: 1,
    keyset: 1,
    currentKid: identity.current.kid,
    sealKid: identity.seal.kid,
    nextKid: null,
    sealed,
  }
  return { value, identity }
}

/**
 * Self-hosted identity: read the stored row, or generate and insert it on the
 * first start. Never regenerates an existing row. The seeds are random and
 * sealed under the data-encryption key; nothing is derived from
 * `TURBOPANEL_SECRET`. A concurrent first start loses the insert and reads
 * the winner's row.
 */
export async function ensurePanelIdentity(
  db: Db,
  dataEncryption: DerivedSecretsConfig
): Promise<PanelIdentity> {
  const existing = await resolvePanelIdentityFromDb(db, dataEncryption)
  if (existing) return existing
  const created = await createStoredValue(dataEncryption)
  await db
    .insert(setting)
    .values({ key: PANEL_IDENTITY_SETTING_KEY, value: created.value })
    .onConflictDoNothing({ target: setting.key })
  const winner = await resolvePanelIdentityFromDb(db, dataEncryption)
  if (!winner) {
    throw new Error('panel identity could not be stored')
  }
  return winner
}

/** Store (or clear with `null`) the `next` fingerprint. Only the fingerprint is stored. */
export async function setPanelIdentityNext(db: Db, nextKid: string | null): Promise<void> {
  if (nextKid !== null && !isPanelFingerprint(nextKid)) {
    throw new TypeError('next must be a 43-character fingerprint')
  }
  const stored = await readStored(db)
  if (!stored) {
    throw new Error('no panel identity yet; start the panel once first')
  }
  if (nextKid !== null && nextKid === stored.currentKid) {
    throw new TypeError('next must differ from the current key')
  }
  await db
    .update(setting)
    .set({ value: { ...stored, nextKid } })
    .where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
}

/** Base64url Ed25519 signature by the `current` key. */
export async function signWithCurrent(identity: PanelIdentity, bytes: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign(
    'Ed25519',
    identity.current.privateKey,
    bytes as BufferSource
  )
  return base64urlEncode(new Uint8Array(sig))
}
