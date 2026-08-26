/**
 * GitHub webhook signature verification (Workers-safe).
 *
 * GitHub signs every delivery with HMAC-SHA256 over the **exact bytes it sent**,
 * presented as `X-Hub-Signature-256: sha256=<hex>`. "Exact bytes" is the whole
 * contract: re-serializing a parsed body changes key order, unicode escapes, and
 * whitespace, and the MAC no longer matches. Callers must therefore read the
 * request body once as bytes (`c.req.arrayBuffer()`) and hand *those* here
 * **before** any `JSON.parse` — see `src/webhook/gate.ts`.
 *
 * Web APIs only (`crypto.subtle`, `TextEncoder`) so the module stays reachable
 * from `src/workers.ts`, same containment rule as `./github-app-token.ts`.
 *
 * The comparison is delegated to `crypto.subtle.verify`, which is constant-time
 * for a fixed-length tag — hand-rolling a hex compare is how timing oracles get
 * written.
 */

const textEncoder = new TextEncoder()

/** Header GitHub puts the HMAC in. */
export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256'
/** Header carrying the per-delivery id used for replay protection. */
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery'
/** Header carrying the event name (`push`, `check_suite`, …). */
export const GITHUB_EVENT_HEADER = 'x-github-event'

const SIGNATURE_PREFIX = 'sha256='
/** HMAC-SHA256 is 32 bytes → 64 hex characters. */
const SIGNATURE_HEX_LENGTH = 64

/**
 * Parse `sha256=<64 hex>` into raw MAC bytes.
 *
 * Returns `null` for anything that is not exactly that shape — a wrong prefix,
 * a truncated digest, or non-hex characters. Rejecting the shape up front means
 * `crypto.subtle.verify` only ever sees a correctly-sized tag, so a malformed
 * header cannot be distinguished from a wrong one by how long the check took.
 */
export function parseGithubSignatureHeader(value: string | null | undefined): Uint8Array | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith(SIGNATURE_PREFIX)) return null
  const hex = trimmed.slice(SIGNATURE_PREFIX.length)
  if (hex.length !== SIGNATURE_HEX_LENGTH) return null
  if (!/^[0-9a-f]+$/i.test(hex)) return null

  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function importWebhookKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

/**
 * Verify one delivery's signature.
 *
 * `rawBody` must be the bytes as received. An empty or missing secret is a
 * configuration failure, not a pass: it returns `false` so an instance whose
 * App was set up without a webhook secret rejects deliveries instead of
 * accepting unauthenticated ones.
 */
export async function verifyGithubWebhookSignature(
  secret: string | null | undefined,
  rawBody: Uint8Array,
  headerValue: string | null | undefined,
): Promise<boolean> {
  if (typeof secret !== 'string' || secret.length === 0) return false

  const signature = parseGithubSignatureHeader(headerValue)
  if (!signature) return false

  const key = await importWebhookKey(secret)
  return await crypto.subtle.verify(
    { name: 'HMAC' },
    key,
    signature as BufferSource,
    rawBody as BufferSource,
  )
}

/**
 * Ref and SHA helpers are provider-agnostic and live in `./clone-url.ts`; they
 * are re-exported here so the GitHub webhook route keeps one import.
 */
export { branchFromGitRef } from './clone-url.ts'
export { isCommitSha as isGithubCommitSha } from './clone-url.ts'
