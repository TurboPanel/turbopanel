/**
 * GitLab webhook authentication (Workers-safe).
 *
 * GitLab does **not** sign deliveries. Where GitHub sends an HMAC over the
 * exact bytes (`X-Hub-Signature-256`), GitLab sends the configured secret back
 * verbatim in `X-Gitlab-Token` and expects a plain equality check. That is a
 * weaker contract and it changes two things here:
 *
 *  - **The body is not covered.** Nothing about the payload is authenticated,
 *    only the caller's possession of the shared token. The route therefore
 *    still reads raw bytes first (so the two ingress paths stay identical in
 *    shape), but the token is what admits the request.
 *  - **The comparison must not leak.** A naive `a === b` on a secret is a
 *    timing oracle. Since the token is not itself a MAC, the compare is done
 *    over fixed-length HMAC-SHA256 digests of both sides using
 *    `crypto.subtle.verify`, which is constant time for a fixed-length tag —
 *    the same primitive `./github-webhook.ts` leans on, applied to a value that
 *    did not arrive as a tag.
 *
 * Web APIs only (`crypto.subtle`, `TextEncoder`) so the module stays reachable
 * from `src/workers.ts`.
 */

const textEncoder = new TextEncoder()

/** Header GitLab echoes the configured secret in. */
export const GITLAB_TOKEN_HEADER = 'x-gitlab-token'
/** Header carrying the event name (`Push Hook`, `Pipeline Hook`, …). */
export const GITLAB_EVENT_HEADER = 'x-gitlab-event'
/**
 * Per-delivery id.
 *
 * Newer GitLab versions send `X-Gitlab-Event-UUID`; older ones send nothing at
 * all, which is why {@link gitlabDeliveryId} can fall back to hashing the body.
 */
export const GITLAB_EVENT_UUID_HEADER = 'x-gitlab-event-uuid'

/**
 * Random per-isolate key: only ever used to compare two local digests.
 *
 * Minted on first use, never at module load. Cloudflare Workers reject
 * `crypto.getRandomValues` and async SubtleCrypto I/O in isolate global
 * scope (error 10021), and `src/workers.ts` imports this module on boot.
 */
let comparisonKeyPromise: Promise<CryptoKey> | undefined

function comparisonKey(): Promise<CryptoKey> {
  comparisonKeyPromise ??= crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return comparisonKeyPromise
}

/**
 * Constant-time equality for two secrets of unequal, attacker-visible length.
 *
 * Both sides are MAC'd under one ephemeral key, so the comparison happens on
 * two 32-byte tags rather than on the raw strings — length and prefix are no
 * longer observable through timing. The key never leaves this process and
 * authenticates nothing; it exists only to give `crypto.subtle.verify` a
 * fixed-length pair to compare.
 */
export async function timingSafeSecretEquals(
  expected: string,
  presented: string,
): Promise<boolean> {
  const key = await comparisonKey()
  const expectedTag = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(expected),
  )
  return await crypto.subtle.verify(
    'HMAC',
    key,
    expectedTag,
    textEncoder.encode(presented) as BufferSource,
  )
}

/**
 * Verify one delivery's token.
 *
 * An empty or missing configured secret is a configuration failure, not a
 * pass: it returns `false` so an instance whose GitLab integration was set up
 * without a webhook secret rejects deliveries rather than accepting
 * unauthenticated ones — same rule as `verifyGithubWebhookSignature`.
 */
export async function verifyGitlabWebhookToken(
  secret: string | null | undefined,
  headerValue: string | null | undefined,
): Promise<boolean> {
  if (typeof secret !== 'string' || secret.length === 0) return false
  if (typeof headerValue !== 'string' || headerValue.length === 0) return false
  return await timingSafeSecretEquals(secret, headerValue)
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * A stable id for one delivery, for the replay ledger.
 *
 * GitLab has no guaranteed `X-GitHub-Delivery` equivalent: `X-Gitlab-Event-UUID`
 * exists on recent versions and is used when present. Otherwise the body is
 * hashed — a redelivery of the *same* event carries byte-identical JSON, so the
 * digest is exactly the dedupe key the ledger wants, while a genuinely new push
 * (different SHA, different timestamp) hashes differently.
 */
export async function gitlabDeliveryId(
  headerValue: string | null | undefined,
  rawBody: Uint8Array,
): Promise<string> {
  const header = typeof headerValue === 'string' ? headerValue.trim() : ''
  if (header.length > 0) return header
  const digest = await crypto.subtle.digest('SHA-256', rawBody as BufferSource)
  return `sha256:${toHex(new Uint8Array(digest))}`
}

/** GitLab event header (`Push Hook`) → the short name the ledger records. */
export function gitlabEventName(headerValue: string | null | undefined): string {
  if (typeof headerValue !== 'string') return ''
  return headerValue.trim().toLowerCase().replaceAll(' ', '_')
}
