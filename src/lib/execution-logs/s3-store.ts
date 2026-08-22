/**
 * S3-compatible execution logs — opt-in driver for self-hosted (Deno) installs
 * that already run object storage (MinIO, Ceph, Wasabi, AWS S3) and would
 * rather not keep transcripts on the instance filesystem.
 *
 * Same key layout and index model as the R2 driver; only the transport differs.
 */

import { ObjectExecutionLogStore } from './object-store.ts'
import type { ExecutionLogObjectBackend } from './object-store.ts'
import { signS3Request, sigV4Encode, type S3Credentials } from './s3-sigv4.ts'

export type S3ExecutionLogConfig = S3Credentials & {
  /** Endpoint origin, e.g. `https://s3.us-east-1.amazonaws.com` or a MinIO URL. */
  endpoint: string
  bucket: string
  /**
   * Address objects as `<endpoint>/<bucket>/<key>` (MinIO and most
   * S3-compatible servers) rather than virtual-hosted style. Default `true`.
   */
  forcePathStyle?: boolean
}

/** S3 `DeleteObjects` accepts at most 1000 keys per request. */
const S3_DELETE_BATCH = 1000

/** `ListObjectsV2` caps one page at 1000 keys. */
const S3_LIST_PAGE = 1000

function objectUrl(config: S3ExecutionLogConfig, key: string): URL {
  const base = new URL(config.endpoint)
  const encodedKey = key.split('/').map(sigV4Encode).join('/')
  if (config.forcePathStyle === false) {
    base.host = `${config.bucket}.${base.host}`
    base.pathname = `/${encodedKey}`
    return base
  }
  base.pathname = `/${config.bucket}/${encodedKey}`
  return base
}

function bucketUrl(config: S3ExecutionLogConfig): URL {
  const base = new URL(config.endpoint)
  if (config.forcePathStyle === false) {
    base.host = `${config.bucket}.${base.host}`
    base.pathname = '/'
    return base
  }
  base.pathname = `/${config.bucket}`
  return base
}

async function send(
  config: S3ExecutionLogConfig,
  method: 'GET' | 'PUT' | 'DELETE' | 'POST',
  url: URL,
  body?: Uint8Array,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const headers = await signS3Request(config, {
    method,
    url,
    ...(body ? { body } : {}),
    ...(extraHeaders ? { headers: extraHeaders } : {}),
  })
  return fetch(url.toString(), {
    method,
    headers,
    ...(body ? { body: body as BodyInit } : {}),
  })
}

/** Extract `<Key>` values from a `ListObjectsV2` response body. */
export function parseS3ListKeys(xml: string): {
  keys: string[]
  nextContinuationToken: string | null
} {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) =>
    decodeXmlText(match[1])
  )
  const token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)
  return { keys, nextContinuationToken: token ? decodeXmlText(token[1]) : null }
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function createS3Backend(config: S3ExecutionLogConfig): ExecutionLogObjectBackend {
  return {
    async get(key) {
      const response = await send(config, 'GET', objectUrl(config, key))
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        return null
      }
      if (!response.ok) {
        throw new Error(`S3 GET ${key} failed: ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    },
    async put(key, body, contentType) {
      const response = await send(config, 'PUT', objectUrl(config, key), body, {
        'content-type': contentType,
      })
      if (!response.ok) {
        throw new Error(`S3 PUT ${key} failed: ${response.status}`)
      }
      await response.body?.cancel().catch(() => {})
    },
    async delete(keys) {
      // One request per key: `DeleteObjects` needs a Content-MD5 header that
      // WebCrypto cannot produce (no MD5 digest in either runtime), and delete
      // volume here is bounded by the sweep limit.
      for (let index = 0; index < keys.length; index += S3_DELETE_BATCH) {
        const batch = keys.slice(index, index + S3_DELETE_BATCH)
        await Promise.all(
          batch.map(async (key) => {
            const response = await send(config, 'DELETE', objectUrl(config, key))
            await response.body?.cancel().catch(() => {})
            if (!response.ok && response.status !== 404) {
              throw new Error(`S3 DELETE ${key} failed: ${response.status}`)
            }
          })
        )
      }
    },
    async list(prefix, limit) {
      const out: string[] = []
      let token: string | null = null
      while (out.length < limit) {
        const url = bucketUrl(config)
        url.searchParams.set('list-type', '2')
        url.searchParams.set('prefix', prefix)
        url.searchParams.set('max-keys', String(Math.min(S3_LIST_PAGE, limit - out.length)))
        if (token) url.searchParams.set('continuation-token', token)
        const response = await send(config, 'GET', url)
        if (!response.ok) {
          throw new Error(`S3 LIST ${prefix} failed: ${response.status}`)
        }
        const page = parseS3ListKeys(await response.text())
        out.push(...page.keys)
        if (!page.nextContinuationToken) break
        token = page.nextContinuationToken
      }
      return out.slice(0, limit)
    },
  }
}

/** Execution-log store backed by an S3-compatible bucket. */
export class S3ExecutionLogStore extends ObjectExecutionLogStore {
  constructor(config: S3ExecutionLogConfig, opts: { now?: () => Date } = {}) {
    super(createS3Backend(config), opts)
  }
}
