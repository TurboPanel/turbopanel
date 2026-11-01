/**
 * Fixed key seeds for panel identity tests. Non-production: the Ed25519 seed is
 * the published RFC 8032 section 7.1 test vector 1, so the public key and
 * fingerprint are known constants. Never use outside unit tests.
 */
import { base64urlEncode } from '../lib/encoding/base64url.ts'
import { importEd25519Signer, importX25519Sealer } from '../lib/panel-identity/keys.ts'

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)))
}

export const FIXTURE_ED25519_SEED = fromHex(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
)
export const FIXTURE_ED25519_PUBLIC_HEX =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
export const FIXTURE_X25519_SEED = new Uint8Array(32).fill(7)
/** A well-formed `next` fingerprint (43 base64url characters); nobody holds a key for it. */
export const FIXTURE_NEXT_FINGERPRINT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

export async function fixtureBindingJson(
  overrides: { next?: { kid: string } | null; keyset?: number; currentKid?: string } = {}
): Promise<string> {
  const current = await importEd25519Signer(FIXTURE_ED25519_SEED)
  const seal = await importX25519Sealer(FIXTURE_X25519_SEED)
  return JSON.stringify({
    keyset: overrides.keyset ?? 1,
    current: {
      kid: overrides.currentKid ?? current.kid,
      priv: base64urlEncode(FIXTURE_ED25519_SEED),
    },
    seal: { kid: seal.kid, priv: base64urlEncode(FIXTURE_X25519_SEED) },
    ...(overrides.next === undefined ? {} : { next: overrides.next }),
  })
}
