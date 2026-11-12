/**
 * Sign-in passkey public keys as stored in `passkey.public_key` (a JWK): EC
 * P-256 (ES256), RSA (RS256) and OKP Ed25519 (EdDSA, COSE alg -8). The
 * CBOR and EC/RSA handling stays in `webauthn.ts`; this adds Ed25519 and the
 * raw form a rotation passkey is pinned with. Workers-bundle safe.
 */
import type { RotationPasskeyAlg } from '../../lib/panel-identity/keyset-statement.ts'
import {
  base64urlDecode,
  base64urlEncode,
  coseKeyToJwk,
  type CosePublicJwk,
  decodeCbor,
  verifyAssertion,
} from './webauthn.ts'

const COSE_KTY_OKP = 1
const COSE_ALG_EDDSA = -8
const COSE_OKP_CRV_ED25519 = 6

export type CoseOkpJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string }
export type StoredPasskeyJwk = CosePublicJwk | CoseOkpJwk

/** COSE algorithms sign-in registration offers, in order: ES256, EdDSA, RS256. */
export const PASSKEY_REGISTRATION_ALGS = [-7, -8, -257] as const

function okpFromCose(coseKeyBytes: Uint8Array): CoseOkpJwk | null {
  const decoded = decodeCbor(coseKeyBytes).value
  if (!(decoded instanceof Map)) return null
  if (decoded.get(1) !== COSE_KTY_OKP || decoded.get(3) !== COSE_ALG_EDDSA) return null
  const x = decoded.get(-2)
  if (decoded.get(-1) !== COSE_OKP_CRV_ED25519 || !(x instanceof Uint8Array) || x.length !== 32) {
    throw new TypeError('unsupported COSE OKP key')
  }
  return { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(x) }
}

/** The JWK to store for a credential's COSE public key. */
export function coseKeyToStoredJwk(coseKeyBytes: Uint8Array): StoredPasskeyJwk {
  return okpFromCose(coseKeyBytes) ?? coseKeyToJwk(coseKeyBytes)
}

/** Parse `passkey.public_key`; null for anything unknown. */
export function parseStoredPasskeyJwk(raw: string): StoredPasskeyJwk | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.kty === 'EC' && record.crv === 'P-256') {
    if (typeof record.x !== 'string' || typeof record.y !== 'string') return null
    return { kty: 'EC', crv: 'P-256', x: record.x, y: record.y }
  }
  if (record.kty === 'RSA') {
    if (typeof record.n !== 'string' || typeof record.e !== 'string') return null
    return { kty: 'RSA', n: record.n, e: record.e, alg: 'RS256' }
  }
  if (record.kty === 'OKP' && record.crv === 'Ed25519' && typeof record.x === 'string') {
    return { kty: 'OKP', crv: 'Ed25519', x: record.x }
  }
  return null
}

/** Verify a sign-in assertion with a stored key of any supported kind. */
export async function verifyStoredPasskeyAssertion(params: {
  jwk: StoredPasskeyJwk
  authData: Uint8Array
  clientDataJSON: Uint8Array
  signature: Uint8Array
}): Promise<boolean> {
  const { jwk } = params
  if (jwk.kty !== 'OKP') {
    return await verifyAssertion({ ...params, jwk })
  }
  if (params.signature.length !== 64) return false
  const key = await crypto.subtle.importKey(
    'raw',
    base64urlDecode(jwk.x),
    { name: 'Ed25519' },
    false,
    ['verify']
  )
  const clientHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', params.clientDataJSON as BufferSource)
  )
  const signed = new Uint8Array(params.authData.length + clientHash.length)
  signed.set(params.authData, 0)
  signed.set(clientHash, params.authData.length)
  return await crypto.subtle.verify(
    'Ed25519',
    key,
    params.signature as BufferSource,
    signed as BufferSource
  )
}

/**
 * The raw key a server pins for a rotation passkey, or null when this kind
 * cannot approve key changes (RS256, or a malformed record).
 */
export function rotationKeyFromJwk(
  jwk: StoredPasskeyJwk | null
): { alg: RotationPasskeyAlg; pub: string } | null {
  if (!jwk) return null
  try {
    if (jwk.kty === 'OKP') {
      const x = base64urlDecode(jwk.x)
      return x.length === 32 ? { alg: 'EdDSA', pub: base64urlEncode(x) } : null
    }
    if (jwk.kty === 'EC') {
      const x = base64urlDecode(jwk.x)
      const y = base64urlDecode(jwk.y)
      if (x.length !== 32 || y.length !== 32) return null
      return { alg: 'ES256', pub: base64urlEncode(Uint8Array.of(0x04, ...x, ...y)) }
    }
  } catch {
    return null
  }
  return null
}
