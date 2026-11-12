import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core'
import { base64urlDecode, base64urlEncode } from '../encoding/base64url.ts'
import { isPanelFingerprint } from './fingerprint.ts'

/**
 * HPKE (RFC 9180) base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 * ChaCha20-Poly1305. Used to seal secrets from the panel to one daemon.
 * `aad` is the UTF-8 recipient server id. Nothing here runs at module load;
 * the suite is built on first use so the module is safe in the Workers bundle.
 */
export type HpkeEnvelope = { v: 1; kid: string; enc: string; ct: string }

const X25519_KEY_BYTES = 32
const encoder = new TextEncoder()

let cachedSuite: CipherSuite | undefined

function suite(): CipherSuite {
  cachedSuite ??= new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  })
  return cachedSuite
}

function exactBytes(value: Uint8Array, label: string): Uint8Array {
  if (value.length !== X25519_KEY_BYTES) {
    throw new TypeError(`${label} must be ${X25519_KEY_BYTES} bytes`)
  }
  return value
}

/** Seal `plaintext` to the recipient's raw 32-byte X25519 public key. */
export async function sealToRecipient(
  recipientPubRaw: Uint8Array,
  kid: string,
  aad: string,
  plaintext: Uint8Array
): Promise<HpkeEnvelope> {
  const recipientPublicKey = await suite().kem.deserializePublicKey(
    exactBytes(recipientPubRaw, 'recipient public key') as BufferSource
  )
  const sealed = await suite().seal(
    { recipientPublicKey },
    plaintext as BufferSource,
    encoder.encode(aad) as BufferSource
  )
  return {
    v: 1,
    kid,
    enc: base64urlEncode(new Uint8Array(sealed.enc)),
    ct: base64urlEncode(new Uint8Array(sealed.ct)),
  }
}

/**
 * Open an envelope with the recipient's private key: raw 32 bytes, or a native
 * X25519 `CryptoKey` (the panel's own sealing key stays non-extractable).
 * Throws on any mismatch.
 */
export async function openFromSender(
  recipientPriv: Uint8Array | CryptoKey,
  aad: string,
  envelope: HpkeEnvelope
): Promise<Uint8Array> {
  const recipientKey =
    recipientPriv instanceof Uint8Array
      ? await suite().kem.deserializePrivateKey(
          exactBytes(recipientPriv, 'recipient private key') as BufferSource
        )
      : recipientPriv
  const opened = await suite().open(
    { recipientKey, enc: base64urlDecode(envelope.enc) as BufferSource },
    base64urlDecode(envelope.ct) as BufferSource,
    encoder.encode(aad) as BufferSource
  )
  return new Uint8Array(opened)
}

export function isHpkeEnvelope(value: unknown): value is HpkeEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    candidate.v === 1 &&
    typeof candidate.kid === 'string' &&
    isPanelFingerprint(candidate.kid) &&
    typeof candidate.enc === 'string' &&
    candidate.enc.length > 0 &&
    typeof candidate.ct === 'string' &&
    candidate.ct.length > 0
  )
}
