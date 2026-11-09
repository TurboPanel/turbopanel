import { base64urlDecode, base64urlEncode } from '../encoding/base64url.ts'
import { fingerprintRawPublicKey } from './fingerprint.ts'
import { httpSigningInput } from './frame-envelope.ts'
import { signWithCurrent, type PanelIdentity } from './identity.ts'
import type { RotationPasskey } from './keyset-statement.ts'

export const IDENTITY_DOCUMENT_PATH = '/api/daemon/v1/instance/identity'
export const IDENTITY_SIGNATURE_HEADER = 'X-TurboPanel-Signature'
export const IDENTITY_DOCUMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const IDENTITY_DOCUMENT_RESIGN_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type IdentityDocumentKey = {
  kid: string
  alg: 'Ed25519'
  pub: string
  role: 'current' | 'next'
}

export type IdentityDocument = {
  v: 1
  keys: IdentityDocumentKey[]
  seal: { kid: string; alg: 'X25519'; pub: string }
  keyset: number
  /** The rotation passkeys servers pin once (first fill); absent until one is marked. */
  rotation?: { rpId: string; passkeys: RotationPasskey[] }
  urls: string[]
  issued: string
  expires: string
  /** 1: this control plane takes the license sealed on enroll (`sealed-enroll.ts`). */
  sealedLicense: 1
}

/** Key-set chain facts the document carries: the live key set and the marked passkeys. */
export type IdentityChainState = {
  keyset: number
  rotation: { rpId: string; passkeys: RotationPasskey[] } | null
}

/**
 * The document for `identity`. Only the current key is listed: the `next`
 * key is retired (key changes are key-set statements), so a stored one is no
 * longer written here and servers stop accepting it at their next read.
 * Readers still take a document that lists `role: "next"`.
 */
export function buildIdentityDocument(
  identity: PanelIdentity,
  urls: string[],
  now: Date,
  chain?: IdentityChainState
): IdentityDocument {
  const keys: IdentityDocumentKey[] = [
    {
      kid: identity.current.kid,
      alg: 'Ed25519',
      pub: base64urlEncode(identity.current.publicRaw),
      role: 'current',
    },
  ]
  return {
    v: 1,
    keys,
    seal: {
      kid: identity.seal.kid,
      alg: 'X25519',
      pub: base64urlEncode(identity.seal.publicRaw),
    },
    keyset: Math.max(identity.keyset, chain?.keyset ?? 0),
    ...(chain?.rotation ? { rotation: chain.rotation } : {}),
    urls,
    issued: now.toISOString(),
    expires: new Date(now.getTime() + IDENTITY_DOCUMENT_TTL_MS).toISOString(),
    sealedLicense: 1,
  }
}

/** The exact response body: keys written out in the declared order, no canonicaliser. */
export function serializeIdentityDocument(doc: IdentityDocument): string {
  return JSON.stringify({
    v: doc.v,
    keys: doc.keys.map((k) => ({ kid: k.kid, alg: k.alg, pub: k.pub, role: k.role })),
    seal: { kid: doc.seal.kid, alg: doc.seal.alg, pub: doc.seal.pub },
    keyset: doc.keyset,
    ...(doc.rotation
      ? {
          rotation: {
            rpId: doc.rotation.rpId,
            passkeys: doc.rotation.passkeys.map((p) => ({ id: p.id, alg: p.alg, pub: p.pub })),
          },
        }
      : {}),
    urls: doc.urls,
    issued: doc.issued,
    expires: doc.expires,
    sealedLicense: doc.sealedLicense,
  })
}

/** Bytes signed for a state-driving HTTP response: `"tp-http\n" + path + "\n" + body`. */
export function httpSigningBytes(path: string, body: string): Uint8Array {
  return httpSigningInput(path, body)
}

export type SignedIdentityResponse = { body: string; signature: string; issued: string }

/** Serialize and sign; `signature` is the `X-TurboPanel-Signature` header value `<kid>:<sig>`. */
export async function signIdentityDocument(
  identity: PanelIdentity,
  urls: string[],
  now: Date,
  chain?: IdentityChainState
): Promise<SignedIdentityResponse> {
  const doc = buildIdentityDocument(identity, urls, now, chain)
  const body = serializeIdentityDocument(doc)
  const sig = await signWithCurrent(identity, httpSigningBytes(IDENTITY_DOCUMENT_PATH, body))
  return { body, signature: `${identity.current.kid}:${sig}`, issued: doc.issued }
}

export type IdentityVerification = { ok: true; currentKid: string } | { ok: false; reason: string }

function fail(reason: string): IdentityVerification {
  return { ok: false, reason }
}

function findCurrent(doc: IdentityDocument): IdentityDocumentKey | undefined {
  const current = doc.keys.filter((k) => k.role === 'current')
  return current.length === 1 ? current[0] : undefined
}

async function verifySignature(
  pub: Uint8Array,
  sig: Uint8Array,
  message: Uint8Array
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    pub as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify']
  )
  return await crypto.subtle.verify('Ed25519', key, sig as BufferSource, message as BufferSource)
}

/**
 * Check a served document the way a daemon does: one `current` key whose kid
 * is the fingerprint of its `pub`, a header naming that kid, a valid
 * signature over the exact body bytes, and a lifetime of at most 30 days.
 */
export async function verifyIdentityResponse(
  body: string,
  signatureHeader: string
): Promise<IdentityVerification> {
  let doc: IdentityDocument
  try {
    doc = JSON.parse(body) as IdentityDocument
  } catch {
    return fail('body is not JSON')
  }
  const current = findCurrent(doc)
  if (!current) return fail('document needs exactly one current key')
  const [headerKid, sigText, ...rest] = signatureHeader.split(':')
  if (!headerKid || !sigText || rest.length > 0) return fail('malformed signature header')
  let pub: Uint8Array
  let sig: Uint8Array
  try {
    pub = base64urlDecode(current.pub)
    sig = base64urlDecode(sigText)
  } catch {
    return fail('key or signature is not base64url')
  }
  if (pub.length !== 32 || (await fingerprintRawPublicKey(pub)) !== current.kid) {
    return fail('current kid is not the fingerprint of its public key')
  }
  if (headerKid !== current.kid) return fail('signature header names a different key')
  const issued = Date.parse(doc.issued)
  const expires = Date.parse(doc.expires)
  if (
    Number.isNaN(issued) ||
    Number.isNaN(expires) ||
    expires <= issued ||
    expires - issued > IDENTITY_DOCUMENT_TTL_MS
  ) {
    return fail('lifetime is longer than 30 days')
  }
  const valid = await verifySignature(pub, sig, httpSigningBytes(IDENTITY_DOCUMENT_PATH, body))
  return valid ? { ok: true, currentKid: current.kid } : fail('signature does not verify')
}
