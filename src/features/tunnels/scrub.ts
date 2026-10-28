/**
 * Keeps credentials out of anything that is logged, audited, stored or shown.
 * Provider messages pass through here before they leave the tunnels feature.
 */

const REDACTED = '[redacted]'
/** A bearer header value, however it was echoed. */
const BEARER = /\bBearer\s+[a-z0-9._~+/=-]+/gi
/** A long unbroken run of token characters: API tokens, run tokens and base64 blobs. */
const TOKEN_LIKE = /[A-Za-z0-9_+/=-]{32,}/g

/** Replace every known secret and anything token-shaped in `text`. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const value of secrets) {
    if (value.length >= 4) out = out.split(value).join(REDACTED)
  }
  return out.replace(BEARER, `Bearer ${REDACTED}`).replace(TOKEN_LIKE, REDACTED)
}

/** Cut a message to a length the screens and audit rows can carry. */
export function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
