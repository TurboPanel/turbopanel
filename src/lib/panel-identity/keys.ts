import { base64urlDecode } from '../encoding/base64url.ts'
import { fingerprintRawPublicKey, rawPublicKeyFromJwkX } from './fingerprint.ts'

/**
 * Key import for the panel identity. Deliberately unrelated to
 * `daemon-jwt-keyring.ts`: that key is derived from `TURBOPANEL_SECRET`; the
 * identity key is never derived from it.
 */
export const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])
export const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

export type ImportedIdentityKey = {
  kid: string
  privateKey: CryptoKey
  publicRaw: Uint8Array
}

export function seedToPkcs8(prefix: Uint8Array, seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new TypeError('seed must be 32 bytes')
  }
  const pkcs8 = new Uint8Array(prefix.length + seed.length)
  pkcs8.set(prefix)
  pkcs8.set(seed, prefix.length)
  return pkcs8
}

/** Decode a base64url 32-byte seed; throws a TypeError naming `label` otherwise. */
export function decodeSeed(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a base64url string`)
  }
  let seed: Uint8Array
  try {
    seed = base64urlDecode(value)
  } catch {
    throw new TypeError(`${label} is not base64url`)
  }
  if (seed.length !== 32) {
    throw new TypeError(`${label} must be 32 bytes`)
  }
  return seed
}

async function importSeed(
  prefix: Uint8Array,
  algorithm: 'Ed25519' | 'X25519',
  usages: KeyUsage[],
  seed: Uint8Array
): Promise<ImportedIdentityKey> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    seedToPkcs8(prefix, seed) as BufferSource,
    { name: algorithm },
    true,
    usages
  )
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicRaw = rawPublicKeyFromJwkX(jwk.x)
  // Keep the private key non-extractable once the public half is known.
  const sealed = await crypto.subtle.importKey(
    'pkcs8',
    seedToPkcs8(prefix, seed) as BufferSource,
    { name: algorithm },
    false,
    usages
  )
  return { kid: await fingerprintRawPublicKey(publicRaw), privateKey: sealed, publicRaw }
}

export function importEd25519Signer(seed: Uint8Array): Promise<ImportedIdentityKey> {
  return importSeed(ED25519_PKCS8_PREFIX, 'Ed25519', ['sign'], seed)
}

export function importX25519Sealer(seed: Uint8Array): Promise<ImportedIdentityKey> {
  return importSeed(X25519_PKCS8_PREFIX, 'X25519', ['deriveBits'], seed)
}

/** Fresh random seeds; call only inside a handler or boot, never at module load. */
export function generateIdentitySeeds(): { ed25519Seed: Uint8Array; x25519Seed: Uint8Array } {
  return {
    ed25519Seed: crypto.getRandomValues(new Uint8Array(32)),
    x25519Seed: crypto.getRandomValues(new Uint8Array(32)),
  }
}
