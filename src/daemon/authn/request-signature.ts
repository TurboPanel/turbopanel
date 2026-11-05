/**
 * Daemon-signed requests (sender-constrained tokens). A daemon that pinned the
 * control plane's key signs each authenticated request with its own Ed25519
 * key, so a daemon token copied off the wire is useless without that key.
 *
 * Header `X-TurboPanel-Daemon-Signature: <keyId>:<nonce>:<iat>:<sig>`, where
 * `sig` is base64url Ed25519 over
 *
 *   "tp-request\n" + METHOD + "\n" + pathname + "\n" + panelFingerprint + "\n"
 *     + nonce + "\n" + base64url(SHA-256(body bytes)) + "\n" + iat
 *
 * `pathname` has no query string, `panelFingerprint` is the control plane key
 * the daemon pinned (current or next), `nonce` is 16 random bytes in base64url
 * and `iat` is Unix seconds. Twin of `turbopaneld/src/crypto/keys.ts`; the
 * prefix is pinned in both contract-drift scripts.
 *
 * Workers-safe: WebCrypto only, nothing at module load.
 */
import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import { verifyDaemonSignature } from './server-key.ts'

export const DAEMON_SIGNATURE_HEADER = 'X-TurboPanel-Daemon-Signature'
export const REQUEST_PREFIX = 'tp-request\n'
/** Seconds a request's `iat` may differ from the control plane clock. */
export const REQUEST_MAX_SKEW_SECONDS = 300
/** base64url SHA-256 of zero bytes: the body hash of a GET or an empty body. */
export const EMPTY_BODY_SHA256_B64U = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'

/** Answer to a request whose `iat` is too far off: a 400, so the daemon does not refresh its token. */
export const REQUEST_CLOCK_SKEW_ERROR = 'Request clock skew'
export const SIGNED_REQUEST_REQUIRED_ERROR = 'Signed request required'

const textEncoder = new TextEncoder()

export type DaemonSignatureHeader = {
  keyId: string
  nonce: string
  iat: number
  sig: string
}

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/
const NONCE = /^[A-Za-z0-9_-]{22}$/
const IAT = /^\d{1,12}$/
const SIG = /^[A-Za-z0-9_-]{86}$/

/** Parse the header value; null when it is absent or malformed. */
export function parseDaemonSignatureHeader(
  value: string | null | undefined
): DaemonSignatureHeader | null {
  if (!value) return null
  const parts = value.trim().split(':')
  if (parts.length !== 4) return null
  const [keyId, nonce, iat, sig] = parts
  if (!KEY_ID.test(keyId) || !NONCE.test(nonce) || !IAT.test(iat) || !SIG.test(sig)) {
    return null
  }
  return { keyId, nonce, iat: Number(iat), sig }
}

export function requestSigningInput(params: {
  method: string
  pathname: string
  panelFingerprint: string
  nonce: string
  bodySha256: string
  iat: number
}): string {
  return [
    `${REQUEST_PREFIX}${params.method.toUpperCase()}`,
    params.pathname,
    params.panelFingerprint,
    params.nonce,
    params.bodySha256,
    String(params.iat),
  ].join('\n')
}

export async function sha256B64u(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (bytes.byteLength === 0) return EMPTY_BODY_SHA256_B64U
  return base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

/**
 * `cnf.jkt` of a daemon key: base64url of the same SHA-256 digest that
 * `computePublicKeyFingerprint` writes in hex (RFC 7638 member order).
 */
export async function daemonKeyThumbprint(publicJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x })
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(canonical))
  return base64urlEncode(new Uint8Array(digest))
}

export type RequestSignatureRefusal = { status: 400 | 401; error: string }

export type VerifiedDaemonRequest = { nonce: string; iat: number }

/**
 * Check one signed request. `panelFingerprints` are the control plane keys a
 * daemon may have pinned (current, and next when set); `keyId` and
 * `publicJwk` are the server's current active daemon key.
 */
export async function verifyDaemonRequest(params: {
  header: string | null | undefined
  method: string
  pathname: string
  body: Uint8Array<ArrayBuffer>
  keyId: string
  publicJwk: JsonWebKey
  panelFingerprints: readonly string[]
  nowMs: number
}): Promise<
  { ok: true; value: VerifiedDaemonRequest } | ({ ok: false } & RequestSignatureRefusal)
> {
  const parsed = parseDaemonSignatureHeader(params.header)
  if (parsed?.keyId !== params.keyId) {
    return { ok: false, status: 401, error: SIGNED_REQUEST_REQUIRED_ERROR }
  }
  if (Math.abs(parsed.iat - Math.floor(params.nowMs / 1000)) > REQUEST_MAX_SKEW_SECONDS) {
    return { ok: false, status: 400, error: REQUEST_CLOCK_SKEW_ERROR }
  }
  const bodySha256 = await sha256B64u(params.body)
  for (const panelFingerprint of params.panelFingerprints) {
    const input = requestSigningInput({
      method: params.method,
      pathname: params.pathname,
      panelFingerprint,
      nonce: parsed.nonce,
      bodySha256,
      iat: parsed.iat,
    })
    if (await verifyDaemonSignature(params.publicJwk, input, parsed.sig)) {
      return { ok: true, value: { nonce: parsed.nonce, iat: parsed.iat } }
    }
  }
  return { ok: false, status: 401, error: 'Invalid request signature' }
}
