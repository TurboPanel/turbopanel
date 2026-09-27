/**
 * Emailed one-time link tokens (email verification, password reset): 256 bits
 * of randomness, stored at rest only as a purpose-bound SHA-256 verifier.
 *
 * `verification.value` must never hold a raw token: a DB read (backup,
 * replica, log) would otherwise expose a live credential anyone could present.
 * The verifier is bound to its purpose by a domain-separation context, so a
 * token minted for one flow can never be consumed by another. With 256 bits of
 * entropy a fast preimage-resistant digest is enough (no salt or slow hash),
 * which lets the row be looked up directly by verifier.
 */

/** 32 random bytes encoded as lowercase hex (64 chars). */
export function generateLinkToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * The at-rest verifier for `token` under `context`. Bumping a context's
 * version suffix invalidates every previously stored verifier for that flow.
 */
export async function deriveLinkTokenVerifier(context: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${context}:${token}`)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
