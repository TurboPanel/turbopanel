/**
 * Minimal AWS SigV4 request signer for the S3 execution-log driver.
 *
 * Hand-rolled rather than pulling in an AWS SDK: this driver issues four verbs
 * (GET / PUT / DELETE / list-objects-v2) against one bucket, and the repo's
 * existing narrow-HTTP-client precedent is to speak the protocol directly
 * instead of adding a dependency that would also have to survive the Workers
 * bundle check.
 *
 * Uses WebCrypto only, so the same code runs under Deno and workerd.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'

export type S3Credentials = {
  accessKeyId: string
  secretAccessKey: string
  region: string
}

export type S3SignedRequest = {
  method: 'GET' | 'PUT' | 'DELETE' | 'POST'
  /** Absolute URL including any query string. */
  url: URL
  body?: Uint8Array
  /** Extra headers to sign (lowercase names). */
  headers?: Record<string, string>
}

const encoder = new TextEncoder()

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const byte of view) out += byte.toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', data as BufferSource))
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

/** `20260821T134500Z` / `20260821` pair required by the signing scheme. */
export function sigV4Timestamps(at: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${at.toISOString().replaceAll(/[:-]/g, '').slice(0, 15)}Z`
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` unescaped, which SigV4
 * canonicalization does not tolerate.
 */
export function sigV4Encode(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`
  )
}

/**
 * SigV4 canonicalization sorts by **code point**, not locale. `localeCompare`
 * would reorder some pairs and produce a signature the endpoint rejects, so
 * every sort in this file goes through this comparator.
 */
function byCodePoint(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** Canonical URI: each path segment encoded, separators preserved. */
function canonicalUri(pathname: string): string {
  return pathname.split('/').map(sigV4Encode).join('/') || '/'
}

/** Canonical query string: sorted by encoded key, then encoded value. */
function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = []
  for (const [key, value] of url.searchParams) {
    pairs.push([sigV4Encode(key), sigV4Encode(value)])
  }
  pairs.sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]))
  return pairs.map(([key, value]) => `${key}=${value}`).join('&')
}

/**
 * Sign a request and return the headers to send (including `Authorization`).
 * Always uses a payload hash — S3 rejects `UNSIGNED-PAYLOAD` on some
 * S3-compatible endpoints, and transcripts are small enough to hash in memory.
 */
export async function signS3Request(
  credentials: S3Credentials,
  request: S3SignedRequest,
  at: Date = new Date()
): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = sigV4Timestamps(at)
  const body = request.body ?? new Uint8Array(0)
  const payloadHash = await sha256Hex(body)

  const headers: Record<string, string> = {
    host: request.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = value
  }

  const signedHeaderNames = Object.keys(headers).sort(byCodePoint)
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join('')
  const signedHeaders = signedHeaderNames.join(';')

  const canonicalRequest = [
    request.method,
    canonicalUri(request.url.pathname),
    canonicalQuery(request.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join('\n')

  let signingKey: Uint8Array<ArrayBuffer> = encoder.encode(
    `AWS4${credentials.secretAccessKey}`
  )
  for (const part of [dateStamp, credentials.region, SERVICE, 'aws4_request']) {
    signingKey = await hmac(signingKey, part)
  }
  const signature = toHex(await hmac(signingKey, stringToSign))

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
