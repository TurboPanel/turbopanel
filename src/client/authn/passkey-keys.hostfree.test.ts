import { assert, assertEquals, assertThrows } from '@std/assert'
import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import {
  coseKeyToStoredJwk,
  parseStoredPasskeyJwk,
  rotationKeyFromJwk,
  verifyStoredPasskeyAssertion,
} from './passkey-keys.ts'

const test = Deno.test.bind(Deno)

/** CBOR COSE_Key {1: 1 (OKP), 3: -8 (EdDSA), -1: crv, -2: x}. */
function coseOkp(x: Uint8Array, crv = 6): Uint8Array {
  return Uint8Array.of(0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, crv, 0x21, 0x58, x.length, ...x)
}

async function ed25519(): Promise<{ raw: Uint8Array; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  return {
    raw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: pair.privateKey,
  }
}

test('an Ed25519 COSE key is stored as an OKP JWK and verifies sign-in assertions', async () => {
  const key = await ed25519()
  const jwk = coseKeyToStoredJwk(coseOkp(key.raw))
  assertEquals(jwk, { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(key.raw) })
  assertEquals(parseStoredPasskeyJwk(JSON.stringify(jwk)), jwk)
  const authData = new Uint8Array(37).fill(7)
  const clientDataJSON = new TextEncoder().encode('{"type":"webauthn.get"}')
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON))
  const signed = Uint8Array.of(...authData, ...hash)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, signed))
  assert(await verifyStoredPasskeyAssertion({ jwk, authData, clientDataJSON, signature }))
  signature[0] ^= 1
  assertEquals(
    await verifyStoredPasskeyAssertion({ jwk, authData, clientDataJSON, signature }),
    false
  )
  assertEquals(rotationKeyFromJwk(jwk), { alg: 'EdDSA', pub: base64urlEncode(key.raw) })
})

test('an OKP key on another curve is refused', async () => {
  const key = await ed25519()
  assertThrows(() => coseKeyToStoredJwk(coseOkp(key.raw, 7)), TypeError)
})

test('only ES256 and EdDSA keys can become rotation passkeys', () => {
  const x = base64urlEncode(new Uint8Array(32).fill(1))
  const y = base64urlEncode(new Uint8Array(32).fill(2))
  const ec = rotationKeyFromJwk({ kty: 'EC', crv: 'P-256', x, y })
  assertEquals(ec?.alg, 'ES256')
  assertEquals(ec?.pub.length, 87)
  assertEquals(rotationKeyFromJwk({ kty: 'RSA', n: 'AQAB', e: 'AQAB', alg: 'RS256' }), null)
  assertEquals(rotationKeyFromJwk(null), null)
  assertEquals(parseStoredPasskeyJwk('not json'), null)
  assertEquals(parseStoredPasskeyJwk('{"kty":"OKP","crv":"X25519","x":"AA"}'), null)
})
