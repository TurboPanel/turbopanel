import { base64urlDecode, base64urlEncode } from '../encoding/base64url.ts'

/** A fingerprint is base64url (no padding) of SHA-256 over the raw 32-byte public key: 43 characters. */
export const PANEL_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isPanelFingerprint(value: string): boolean {
  return PANEL_FINGERPRINT_PATTERN.test(value)
}

export async function fingerprintRawPublicKey(raw: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', raw as BufferSource)
  return base64urlEncode(new Uint8Array(digest))
}

/** The raw 32-byte public key out of a JWK `x` member. Throws a TypeError for any other length. */
export function rawPublicKeyFromJwkX(x: string | undefined): Uint8Array {
  const raw = base64urlDecode(x ?? '')
  if (raw.length !== 32) {
    throw new TypeError('public key must be 32 bytes')
  }
  return raw
}
