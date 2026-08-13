/**
 * SHA-256 hex of a compiled runtime compose file. Workers-safe (Web Crypto).
 */

const textEncoder = new TextEncoder()

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Lowercase hex SHA-256 of UTF-8 `content`. */
export async function sha256HexUtf8(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(content))
  return encodeHex(new Uint8Array(digest))
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/
