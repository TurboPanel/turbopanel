import type { Context } from 'hono'
import { isDeveloperSurfaceEnabled } from '../dev-mode.ts'
import { parseSecretsEnv } from '../client/authn/secrets.ts'

export const LOCAL_CONSOLE_SCHEME = 'Local-Console'
export const LOCAL_CONSOLE_MAX_SKEW_MS = 60_000
export const LOCAL_CONSOLE_INFO = 'local-console-v1'
/** SHA-256 (base64url) of the request body; included in the HMAC payload. */
export const LOCAL_CONSOLE_CONTENT_SHA256_HEADER = 'X-Local-Console-Content-SHA256'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isLocalConsoleAuthEnabled(): boolean {
  return typeof Deno !== 'undefined' && isDeveloperSurfaceEnabled()
}

function resolveLocalConsoleRootSecret(): string | undefined {
  if (typeof Deno === 'undefined') return undefined
  try {
    // Share the same validated parse/selection as the rest of the process.
    // Order-as-written is authoritative: `parseSecretsEnv` keeps versioned
    // entries in list order, so entry [0] is the current signing secret.
    // Invalid/weak configurations throw and disable local-console auth rather
    // than falling back to a loose parse.
    const config = parseSecretsEnv(
      Deno.env.get('TURBOPANEL_SECRET'),
      Deno.env.get('TURBOPANEL_SECRETS'),
      'deno',
    )
    return config.versioned[0]?.value
  } catch {
    return undefined
  }
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.codePointAt(i) ?? 0
    }
    return bytes
  } catch {
    return null
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

async function hmacSha256(keyMaterial: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )
  return new Uint8Array(signature)
}

async function sha256Base64Url(data: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view for SubtleCrypto typing.
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const digest = await crypto.subtle.digest('SHA-256', copy)
  return encodeBase64Url(new Uint8Array(digest))
}

/**
 * Canonical Local-Console HMAC payload.
 *
 * Format (NUL-separated):
 * `local-console-v1\0<timestamp>\0<METHOD>\0<requestTarget>\0<contentSha256>`
 *
 * `requestTarget` is pathname + query string (e.g. `/api/developer/v1/x?y=1`).
 * `contentSha256` is base64url(SHA-256(body bytes)); empty body uses the empty digest.
 */
export function buildLocalConsoleCanonicalPayload(
  timestamp: string,
  method: string,
  requestTarget: string,
  contentSha256: string,
): string {
  return `${LOCAL_CONSOLE_INFO}\0${timestamp}\0${method.toUpperCase()}\0${requestTarget}\0${contentSha256}`
}

/** Pathname + search from a request URL (query included; hash excluded). */
export function localConsoleRequestTarget(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url
  return `${parsed.pathname}${parsed.search}`
}

export async function hashLocalConsoleContent(
  body: Uint8Array | string,
): Promise<string> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return sha256Base64Url(bytes)
}

/** Build `Authorization: Local-Console …` for the co-located dev console. */
export async function buildLocalConsoleAuthorization(
  method: string,
  requestTarget: string,
  secret: string,
  contentSha256: string,
  timestamp: string = new Date().toISOString(),
): Promise<string> {
  const payload = buildLocalConsoleCanonicalPayload(
    timestamp,
    method,
    requestTarget,
    contentSha256,
  )
  const signature = await hmacSha256(secret, payload)
  const timestampPart = encodeBase64Url(new TextEncoder().encode(timestamp))
  return `${LOCAL_CONSOLE_SCHEME} ${timestampPart}.${encodeBase64Url(signature)}`
}

async function bodyMatchesContentDigest(
  c: Context,
  expectedDigest: string,
): Promise<boolean> {
  // Clone so route handlers can still read the original body stream.
  const bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer())
  const actual = await sha256Base64Url(bytes)
  const expectedBytes = new TextEncoder().encode(expectedDigest)
  const actualBytes = new TextEncoder().encode(actual)
  return constantTimeEqual(expectedBytes, actualBytes)
}

/** Verify HMAC local-console auth presented by the co-located dev terminal console. */
export async function verifyLocalConsoleAuthorization(
  c: Context,
  rootSecret?: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!isLocalConsoleAuthEnabled()) return false
  const secret = rootSecret ?? resolveLocalConsoleRootSecret()
  if (!secret) return false

  const header = c.req.header('Authorization')?.trim()
  if (!header?.startsWith(`${LOCAL_CONSOLE_SCHEME} `)) return false

  const token = header.slice(LOCAL_CONSOLE_SCHEME.length + 1)
  const dot = token.indexOf('.')
  if (dot <= 0) return false

  const timestampBytes = decodeBase64Url(token.slice(0, dot))
  const signatureBytes = decodeBase64Url(token.slice(dot + 1))
  if (!timestampBytes || !signatureBytes) return false

  const timestamp = new TextDecoder().decode(timestampBytes)
  const issuedAt = Date.parse(timestamp)
  if (!Number.isFinite(issuedAt)) return false
  const skew = Math.abs(nowMs - issuedAt)
  if (skew > LOCAL_CONSOLE_MAX_SKEW_MS) return false

  const contentSha256 = c.req.header(LOCAL_CONSOLE_CONTENT_SHA256_HEADER)?.trim()
  if (!contentSha256) return false

  let requestTarget: string
  try {
    requestTarget = localConsoleRequestTarget(c.req.url)
  } catch {
    return false
  }

  const payload = buildLocalConsoleCanonicalPayload(
    timestamp,
    c.req.method,
    requestTarget,
    contentSha256,
  )
  const expected = await hmacSha256(secret, payload)
  if (!constantTimeEqual(expected, signatureBytes)) return false

  if (WRITE_METHODS.has(c.req.method.toUpperCase())) {
    return bodyMatchesContentDigest(c, contentSha256)
  }

  return true
}
