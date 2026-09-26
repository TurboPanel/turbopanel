/**
 * RFC 4648 §5 base64url without padding. Local rather than
 * `@std/encoding/base64url`, which the Workers bundle cannot include.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Inverse of {@link base64urlEncode}; padding is optional. Throws on bad input. */
export function base64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0
  }
  return bytes
}
