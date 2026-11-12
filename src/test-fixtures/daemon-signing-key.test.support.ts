/**
 * A throwaway daemon Ed25519 key for tests of daemon-signed requests and
 * attach proofs. Generated per call; tests assert only that signatures
 * verify or fail, never on the key bytes.
 */
import { base64urlEncode } from '../lib/encoding/base64url.ts'

const encoder = new TextEncoder()

export type TestDaemonKey = {
  publicJwk: JsonWebKey
  sign: (input: string) => Promise<string>
}

export async function testDaemonKey(): Promise<TestDaemonKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    sign: async (input) =>
      base64urlEncode(
        new Uint8Array(
          await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, encoder.encode(input))
        )
      ),
  }
}
