/**
 * Key-set statements: the only way a server's pinned control plane key, key
 * set number or rotation passkeys change after install. A statement is exact
 * JSON bytes built once here; the owner's rotation passkeys approve it with a
 * WebAuthn assertion whose challenge is SHA-256 of those bytes, and (except
 * for an emergency revoke) the key being replaced signs the same bytes, so a
 * passkey assertion alone moves no server. Servers check
 * the same rules in `tp-host panel-identity-write statement` (python and
 * openssl), over the shared vectors in `src/test-fixtures/keyset-statement-vectors.json`.
 *
 * Workers-bundle safe: no I/O and no crypto at module load.
 */
import { base64urlDecode, base64urlEncode } from '../encoding/base64url.ts'
import { fingerprintRawPublicKey, isPanelFingerprint } from './fingerprint.ts'

export const KEYSET_STATEMENT_TYPE = 'tp-keyset'
export const KEYSET_STATEMENT_KINDS = ['rotate', 'revoke', 'passkeys'] as const
export type KeysetStatementKind = (typeof KEYSET_STATEMENT_KINDS)[number]
export const ROTATION_PASSKEY_ALGS = ['ES256', 'EdDSA'] as const
export type RotationPasskeyAlg = (typeof ROTATION_PASSKEY_ALGS)[number]
/** `rotation.state`: `awaiting_key` until a High Availability secret holds the new key. */
export const KEYSET_STATEMENT_STATES = ['awaiting_key', 'live'] as const
export type KeysetStatementState = (typeof KEYSET_STATEMENT_STATES)[number]
/** Envelope cap; tp-host refuses anything larger. */
export const KEYSET_ENVELOPE_MAX_BYTES = 16 * 1024
export const MAX_ROTATION_PASSKEYS = 5
/** Prefix of the bytes the replaced key signs: `"tp-keyset\n"` + statement bytes. */
export const KEYSET_KEY_SIGNATURE_PREFIX = 'tp-keyset\n'
/** A revoke has no signature by the replaced key, so it needs this many pinned passkeys. */
export const MIN_REVOKE_APPROVALS = 2
/** How far in the future a statement's `iat` may be. There is no lower bound: offline servers apply old statements. */
export const KEYSET_STATEMENT_MAX_FUTURE_SECONDS = 300

const B64URL = /^[A-Za-z0-9_-]+$/
const FLAG_UP = 0x01
const FLAG_UV = 0x04
const AUTH_DATA_MIN_BYTES = 37
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

/** One pinned rotation passkey: `id` is base64url SHA-256 of the raw credential id. */
export type RotationPasskey = { id: string; alg: RotationPasskeyAlg; pub: string }

export type KeysetStatement = {
  type: typeof KEYSET_STATEMENT_TYPE
  v: 1
  keyset: number
  prev: string
  kind: KeysetStatementKind
  rpId: string
  current: { kid: string; pub: string }
  passkeys: RotationPasskey[]
  iat: number
}

export type KeysetApproval = {
  id: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

/** Signature by the replaced key (`prev`): its raw public key and an Ed25519 signature. */
export type KeysetKeySig = { pub: string; sig: string }

export type KeysetEnvelope = {
  statement: string
  approvals: KeysetApproval[]
  /** Absent on a revoke (the old key may be lost) and before the control plane signs. */
  keySig?: KeysetKeySig
}

/** What a server pinned (or, before any mark, the control plane's genesis state with no passkeys). */
export type KeysetPin = {
  current: string
  keyset: number
  rpId: string
  passkeys: RotationPasskey[]
}

/** Why an envelope is refused. Internal words: the admin route turns them into owner-facing text. */
export const KEYSET_REFUSAL_REASONS = [
  'statement is not base64url',
  'statement is malformed',
  'current kid is not the fingerprint of its key',
  'prev is not the pinned key',
  'keyset is not above the pinned one',
  'iat is in the future',
  'kind does not match whether the key changes',
  'an approval is repeated',
  'an approval does not verify',
  'no rotation passkey is pinned',
  'every marked passkey must prove possession',
  'no pinned passkey approved',
  'every passkey under the new rpId must prove possession',
  'a removal needs a passkey that stays',
  'an added passkey must prove possession',
  'the previous key did not sign',
  'a revoke needs two pinned passkeys',
  'a key change must keep the passkeys',
] as const
export type KeysetRefusalReason = (typeof KEYSET_REFUSAL_REASONS)[number]

export type KeysetVerification =
  | {
      ok: true
      statement: KeysetStatement
      bytes: Uint8Array
      /** Ids of pinned passkeys whose approval verified. */
      pinnedApprovals: string[]
      /** Ids of statement passkeys that proved possession. */
      possessionApprovals: string[]
    }
  | { ok: false; reason: KeysetRefusalReason }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortPasskeys(passkeys: readonly RotationPasskey[]): RotationPasskey[] {
  return [...passkeys].sort((a, b) => {
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}

/** The exact statement text. Members in this fixed order; passkeys sorted by id. */
export function serializeKeysetStatement(statement: Omit<KeysetStatement, 'type' | 'v'>): string {
  return JSON.stringify({
    type: KEYSET_STATEMENT_TYPE,
    v: 1,
    keyset: statement.keyset,
    prev: statement.prev,
    kind: statement.kind,
    rpId: statement.rpId,
    current: { kid: statement.current.kid, pub: statement.current.pub },
    passkeys: sortPasskeys(statement.passkeys).map((p) => ({ id: p.id, alg: p.alg, pub: p.pub })),
    iat: statement.iat,
  })
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** The WebAuthn challenge for a statement: base64url SHA-256 of its exact bytes. */
export async function keysetStatementChallenge(bytes: Uint8Array): Promise<string> {
  return base64urlEncode(await sha256(bytes))
}

/** `pkid` for a credential id given as base64url (the sign-in table's form). */
export async function rotationPasskeyId(credentialIdB64url: string): Promise<string> {
  return base64urlEncode(await sha256(base64urlDecode(credentialIdB64url)))
}

/** Canonical rotation passkey set for comparisons (pin reports, mismatch checks). */
export function rotationPasskeysLine(passkeys: readonly RotationPasskey[]): string {
  return sortPasskeys(passkeys)
    .map((p) => `${p.id}.${p.alg === 'ES256' ? 'es256' : 'eddsa'}.${p.pub}`)
    .join(',')
}

/** base64url SHA-256 of {@link rotationPasskeysLine}: what a daemon reports of its pin. */
export async function rotationPasskeysHash(passkeys: readonly RotationPasskey[]): Promise<string> {
  return base64urlEncode(await sha256(textEncoder.encode(rotationPasskeysLine(passkeys))))
}

/** Decode unpadded base64url; null for anything else (never throws). */
export function decodeBase64urlStrict(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !B64URL.test(value)) return null
  try {
    return base64urlDecode(value)
  } catch {
    return null
  }
}

function parsePasskey(value: unknown): RotationPasskey | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null
  const { id, alg, pub } = value
  if (typeof id !== 'string' || !isPanelFingerprint(id)) return null
  const raw = decodeBase64urlStrict(pub)
  if (!raw || typeof pub !== 'string') return null
  if (alg === 'ES256' && raw.length === 65 && raw[0] === 0x04) return { id, alg, pub }
  if (alg === 'EdDSA' && raw.length === 32) return { id, alg, pub }
  return null
}

function parsePasskeyList(value: unknown): RotationPasskey[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROTATION_PASSKEYS) {
    return null
  }
  const parsed: RotationPasskey[] = []
  for (const entry of value) {
    const passkey = parsePasskey(entry)
    if (!passkey) return null
    const last = parsed.at(-1)
    if (last && last.id >= passkey.id) return null
    parsed.push(passkey)
  }
  return parsed
}

const STATEMENT_KEYS = 'type,v,keyset,prev,kind,rpId,current,passkeys,iat'

function isRpId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) &&
    !value.includes('..')
  )
}

/** Parse statement bytes; null when anything is out of shape. */
export function parseKeysetStatement(bytes: Uint8Array): KeysetStatement | null {
  let doc: unknown
  try {
    doc = JSON.parse(textDecoder.decode(bytes))
  } catch {
    return null
  }
  if (!isRecord(doc) || Object.keys(doc).join(',') !== STATEMENT_KEYS) return null
  const { keyset, prev, kind, rpId, current, passkeys, iat } = doc
  if (doc.type !== KEYSET_STATEMENT_TYPE || doc.v !== 1) return null
  if (typeof keyset !== 'number' || !Number.isSafeInteger(keyset) || keyset < 2) return null
  if (typeof prev !== 'string' || !isPanelFingerprint(prev)) return null
  if (!(KEYSET_STATEMENT_KINDS as readonly unknown[]).includes(kind)) return null
  if (!isRpId(rpId)) return null
  if (!isRecord(current) || Object.keys(current).join(',') !== 'kid,pub') return null
  if (typeof current.kid !== 'string' || !isPanelFingerprint(current.kid)) return null
  if (typeof current.pub !== 'string' || decodeBase64urlStrict(current.pub)?.length !== 32)
    return null
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat < 0) return null
  const list = parsePasskeyList(passkeys)
  if (!list) return null
  return {
    type: KEYSET_STATEMENT_TYPE,
    v: 1,
    keyset,
    prev,
    kind: kind as KeysetStatementKind,
    rpId,
    current: { kid: current.kid, pub: current.pub },
    passkeys: list,
    iat,
  }
}

/** The `keySig` member: exactly `pub` and `sig`, both strings; undefined when absent, null when out of shape. */
function parseKeySig(value: unknown): KeysetKeySig | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).join(',') !== 'pub,sig') return null
  const { pub, sig } = value
  return typeof pub === 'string' && typeof sig === 'string' ? { pub, sig } : null
}

/** Parse an envelope from untrusted JSON (the size cap applies to the serialized form). */
export function parseKeysetEnvelope(value: unknown): KeysetEnvelope | null {
  if (!isRecord(value) || typeof value.statement !== 'string') return null
  const keySig = parseKeySig(value.keySig)
  if (keySig === null) return null
  if (!Array.isArray(value.approvals) || value.approvals.length > MAX_ROTATION_PASSKEYS * 2) {
    return null
  }
  const approvals: KeysetApproval[] = []
  for (const entry of value.approvals) {
    if (!isRecord(entry)) return null
    const { id, authenticatorData, clientDataJSON, signature } = entry
    if (
      typeof id !== 'string' ||
      typeof authenticatorData !== 'string' ||
      typeof clientDataJSON !== 'string' ||
      typeof signature !== 'string'
    ) {
      return null
    }
    approvals.push({ id, authenticatorData, clientDataJSON, signature })
  }
  const envelope: KeysetEnvelope = { statement: value.statement, approvals }
  if (keySig) envelope.keySig = keySig
  return serializeKeysetEnvelope(envelope).length <= KEYSET_ENVELOPE_MAX_BYTES ? envelope : null
}

/** The serialized envelope as served: `statement`, `approvals` in order, then `keySig` when present. */
export function serializeKeysetEnvelope(envelope: KeysetEnvelope): string {
  return JSON.stringify({
    statement: envelope.statement,
    approvals: envelope.approvals.map((a) => ({
      id: a.id,
      authenticatorData: a.authenticatorData,
      clientDataJSON: a.clientDataJSON,
      signature: a.signature,
    })),
    ...(envelope.keySig ? { keySig: { pub: envelope.keySig.pub, sig: envelope.keySig.sig } } : {}),
  })
}

/** Whether a statement of this kind must carry a signature by the key it replaces. */
export function needsKeySignature(kind: KeysetStatementKind): boolean {
  return kind !== 'revoke'
}

/** The bytes the replaced key signs: the fixed prefix, then the exact statement bytes. */
export function keysetKeySignatureMessage(bytes: Uint8Array): Uint8Array {
  const prefix = textEncoder.encode(KEYSET_KEY_SIGNATURE_PREFIX)
  const message = new Uint8Array(prefix.length + bytes.length)
  message.set(prefix, 0)
  message.set(bytes, prefix.length)
  return message
}

/** `keySig` is by the key `prev` names and signs these exact bytes. */
export async function keySignatureVerifies(
  keySig: KeysetKeySig | undefined,
  statement: KeysetStatement,
  bytes: Uint8Array
): Promise<boolean> {
  if (!keySig) return false
  const pub = decodeBase64urlStrict(keySig.pub)
  const sig = decodeBase64urlStrict(keySig.sig)
  if (pub?.length !== 32 || sig?.length !== 64) return false
  if ((await fingerprintRawPublicKey(pub)) !== statement.prev) return false
  return await signatureVerifies(
    { id: statement.prev, alg: 'EdDSA', pub: keySig.pub },
    keysetKeySignatureMessage(bytes),
    sig
  )
}

function derLength(der: Uint8Array, at: number): { length: number; next: number } | null {
  const first = der[at]
  if (first === undefined) return null
  if (first < 0x80) return { length: first, next: at + 1 }
  if (first !== 0x81) return null
  const length = der[at + 1]
  return length !== undefined && length >= 0x80 ? { length, next: at + 2 } : null
}

function derInteger(der: Uint8Array, at: number): { value: Uint8Array; next: number } | null {
  if (der[at] !== 0x02) return null
  const len = derLength(der, at + 1)
  if (!len || len.length < 1 || len.length > 33) return null
  const value = der.subarray(len.next, len.next + len.length)
  if (value.length !== len.length) return null
  // Minimal encoding: no leading zero unless the next byte has its top bit set; positive only.
  if (value[0]! & 0x80) return null
  if (value[0] === 0 && value.length > 1 && !(value[1]! & 0x80)) return null
  return { value, next: len.next + len.length }
}

function component(value: Uint8Array): Uint8Array | null {
  const stripped = value[0] === 0 ? value.subarray(1) : value
  if (stripped.length > 32) return null
  const out = new Uint8Array(32)
  out.set(stripped, 32 - stripped.length)
  return out
}

/** Strict DER ECDSA-Sig-Value to raw r‖s (what WebCrypto verifies); null for anything else. */
export function derEcdsaToRaw(der: Uint8Array): Uint8Array | null {
  if (der[0] !== 0x30) return null
  const seq = derLength(der, 1)
  if (seq?.next === undefined || seq.next + seq.length !== der.length) return null
  const r = derInteger(der, seq.next)
  if (!r) return null
  const s = derInteger(der, r.next)
  if (s?.next !== der.length) return null
  const rr = component(r.value)
  const ss = component(s.value)
  if (!rr || !ss) return null
  const raw = new Uint8Array(64)
  raw.set(rr, 0)
  raw.set(ss, 32)
  return raw
}

async function signatureVerifies(
  passkey: RotationPasskey,
  signed: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const pub = base64urlDecode(passkey.pub)
  try {
    if (passkey.alg === 'EdDSA') {
      if (signature.length !== 64) return false
      const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
      return await crypto.subtle.verify(
        'Ed25519',
        key,
        signature as BufferSource,
        signed as BufferSource
      )
    }
    const raw = derEcdsaToRaw(signature)
    if (!raw) return false
    const key = await crypto.subtle.importKey(
      'raw',
      pub,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      raw as BufferSource,
      signed as BufferSource
    )
  } catch {
    return false
  }
}

function originMatches(origin: unknown, rpId: string): boolean {
  if (typeof origin !== 'string') return false
  const match = /^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(origin)
  if (!match) return false
  const host = match[1]!
  return host === rpId || host.endsWith(`.${rpId}`)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** One WebAuthn assertion over `challenge`, by `passkey`, under `rpId`. */
export async function assertionVerifies(
  approval: KeysetApproval,
  passkey: RotationPasskey,
  rpId: string,
  challenge: string
): Promise<boolean> {
  const authData = decodeBase64urlStrict(approval.authenticatorData)
  const clientDataBytes = decodeBase64urlStrict(approval.clientDataJSON)
  const signature = decodeBase64urlStrict(approval.signature)
  if (!authData || !clientDataBytes || !signature) return false
  if (authData.length < AUTH_DATA_MIN_BYTES) return false
  if (!bytesEqual(authData.subarray(0, 32), await sha256(textEncoder.encode(rpId)))) return false
  const flags = authData[32]!
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) return false
  let clientData: unknown
  try {
    clientData = JSON.parse(textDecoder.decode(clientDataBytes))
  } catch {
    return false
  }
  if (!isRecord(clientData)) return false
  if (clientData.type !== 'webauthn.get' || clientData.challenge !== challenge) return false
  if (!originMatches(clientData.origin, rpId) || clientData.crossOrigin === true) return false
  const clientHash = await sha256(clientDataBytes)
  const signed = new Uint8Array(authData.length + clientHash.length)
  signed.set(authData, 0)
  signed.set(clientHash, authData.length)
  return await signatureVerifies(passkey, signed, signature)
}

function samePasskey(a: RotationPasskey, b: RotationPasskey): boolean {
  return a.id === b.id && a.alg === b.alg && a.pub === b.pub
}

/** The same passkeys, in any order. */
export function samePasskeySet(
  a: readonly RotationPasskey[],
  b: readonly RotationPasskey[]
): boolean {
  return a.length === b.length && a.every((p) => b.some((q) => samePasskey(p, q)))
}

function fail(reason: KeysetRefusalReason): KeysetVerification {
  return { ok: false, reason }
}

function checkHeader(
  statement: KeysetStatement,
  pin: KeysetPin,
  nowSeconds: number
): KeysetRefusalReason | null {
  if (statement.prev !== pin.current) return 'prev is not the pinned key'
  if (statement.keyset <= pin.keyset) return 'keyset is not above the pinned one'
  if (statement.iat > nowSeconds + KEYSET_STATEMENT_MAX_FUTURE_SECONDS) {
    return 'iat is in the future'
  }
  const keeps = statement.current.kid === statement.prev
  if (statement.kind === 'passkeys' ? !keeps : keeps) {
    return 'kind does not match whether the key changes'
  }
  return null
}

type ApprovalOutcome =
  { pinned: Set<string>; possession: Set<string> } | { reason: KeysetRefusalReason }

async function checkApprovals(
  envelope: KeysetEnvelope,
  statement: KeysetStatement,
  pin: KeysetPin,
  challenge: string
): Promise<ApprovalOutcome> {
  const pinned = new Set<string>()
  const possession = new Set<string>()
  const seen = new Set<string>()
  for (const approval of envelope.approvals) {
    if (seen.has(approval.id)) return { reason: 'an approval is repeated' }
    seen.add(approval.id)
    // An id the pin holds is checked as a pinned approval only; any other id
    // must be a passkey of the statement proving possession. tp-host decides
    // the same way.
    const pinnedKey = pin.passkeys.find((p) => p.id === approval.id)
    if (pinnedKey) {
      if (await assertionVerifies(approval, pinnedKey, pin.rpId, challenge)) {
        pinned.add(approval.id)
        continue
      }
      return { reason: 'an approval does not verify' }
    }
    const added = statement.passkeys.find((p) => p.id === approval.id)
    if (added && (await assertionVerifies(approval, added, statement.rpId, challenge))) {
      possession.add(approval.id)
      continue
    }
    return { reason: 'an approval does not verify' }
  }
  return { pinned, possession }
}

function checkRules(
  statement: KeysetStatement,
  pin: KeysetPin,
  approvals: { pinned: Set<string>; possession: Set<string> }
): KeysetRefusalReason | null {
  const isGenesis = pin.passkeys.length === 0
  if (isGenesis) {
    if (statement.kind !== 'passkeys') return 'no rotation passkey is pinned'
    return statement.passkeys.every((p) => approvals.possession.has(p.id))
      ? null
      : 'every marked passkey must prove possession'
  }
  if (approvals.pinned.size === 0) return 'no pinned passkey approved'
  if (statement.kind !== 'passkeys') {
    // A key change moves the key only: the passkeys and their rp id stay as
    // pinned, so two approvals that revoke cannot also add a passkey.
    if (statement.rpId !== pin.rpId || !samePasskeySet(statement.passkeys, pin.passkeys)) {
      return 'a key change must keep the passkeys'
    }
    return statement.kind === 'revoke' && approvals.pinned.size < MIN_REVOKE_APPROVALS
      ? 'a revoke needs two pinned passkeys'
      : null
  }
  if (statement.rpId !== pin.rpId) {
    return statement.passkeys.every((p) => approvals.possession.has(p.id))
      ? null
      : 'every passkey under the new rpId must prove possession'
  }
  const removed = pin.passkeys.filter((p) => !statement.passkeys.some((q) => samePasskey(p, q)))
  const added = statement.passkeys.filter((p) => !pin.passkeys.some((q) => samePasskey(p, q)))
  const removedIds = new Set(removed.map((p) => p.id))
  if (removed.length > 0 && ![...approvals.pinned].some((id) => !removedIds.has(id))) {
    return 'a removal needs a passkey that stays'
  }
  if (!added.every((p) => approvals.possession.has(p.id))) {
    return 'an added passkey must prove possession'
  }
  return null
}

/**
 * Verify an envelope against a pin, the way servers do: passkey approvals
 * and, for `rotate` and `passkeys`, the replaced key's `keySig`. With a pin
 * holding no passkeys only a genesis `passkeys` statement can pass (the
 * control plane's first marks); servers never call this with an empty set.
 */
export async function verifyKeysetEnvelope(
  envelope: KeysetEnvelope,
  pin: KeysetPin,
  nowSeconds: number
): Promise<KeysetVerification> {
  return await verifyEnvelope(envelope, pin, nowSeconds, true)
}

/**
 * Every rule except `keySig`: what the control plane checks on the browser's
 * approvals before it signs with its own key (the browser cannot sign).
 */
export async function verifyKeysetApprovals(
  envelope: KeysetEnvelope,
  pin: KeysetPin,
  nowSeconds: number
): Promise<KeysetVerification> {
  return await verifyEnvelope(envelope, pin, nowSeconds, false)
}

async function verifyEnvelope(
  envelope: KeysetEnvelope,
  pin: KeysetPin,
  nowSeconds: number,
  checkKeySig: boolean
): Promise<KeysetVerification> {
  const bytes = decodeBase64urlStrict(envelope.statement)
  if (!bytes || base64urlEncode(bytes) !== envelope.statement) {
    return fail('statement is not base64url')
  }
  const statement = parseKeysetStatement(bytes)
  if (!statement) return fail('statement is malformed')
  // Servers take only the exact bytes this control plane builds: no other
  // number form (`4.0`), member order, spacing, escape or leading mark. The
  // comparison is on bytes, because decoding drops a byte order mark.
  if (!bytesEqual(bytes, textEncoder.encode(serializeKeysetStatement(statement)))) {
    return fail('statement is malformed')
  }
  if (
    (await fingerprintRawPublicKey(base64urlDecode(statement.current.pub))) !==
    statement.current.kid
  ) {
    return fail('current kid is not the fingerprint of its key')
  }
  const header = checkHeader(statement, pin, nowSeconds)
  if (header) return fail(header)
  const challenge = await keysetStatementChallenge(bytes)
  const approvals = await checkApprovals(envelope, statement, pin, challenge)
  if ('reason' in approvals) return fail(approvals.reason)
  if (
    checkKeySig &&
    needsKeySignature(statement.kind) &&
    !(await keySignatureVerifies(envelope.keySig, statement, bytes))
  ) {
    return fail('the previous key did not sign')
  }
  const rule = checkRules(statement, pin, approvals)
  if (rule) return fail(rule)
  return {
    ok: true,
    statement,
    bytes,
    pinnedApprovals: [...approvals.pinned],
    possessionApprovals: [...approvals.possession],
  }
}

/** The pin a statement leaves behind (what the next one in the chain is checked against). */
export function pinAfter(statement: KeysetStatement): KeysetPin {
  return {
    current: statement.current.kid,
    keyset: statement.keyset,
    rpId: statement.rpId,
    passkeys: statement.passkeys,
  }
}
