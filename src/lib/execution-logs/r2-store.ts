/**
 * R2-backed execution logs (Workers runtime).
 *
 * R2 is the only storage in the Workers stack that holds arbitrary-size blobs
 * cheaply with no egress fee, and a transcript is always fetched by key — never
 * queried across commands — so a plain keyed object beats any table.
 */

import { ObjectExecutionLogStore } from './object-store.ts'
import type { ExecutionLogObjectBackend } from './object-store.ts'

/**
 * Structural subset of Cloudflare's `R2Bucket` this driver uses. Declared here
 * so the Deno type-check (no Workers types) and the conformance fake both
 * satisfy it without pulling in `worker-configuration.d.ts`.
 */
export type R2BucketLike = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(key: string, value: ArrayBuffer | Uint8Array, options?: unknown): Promise<unknown>
  delete(keys: string | string[]): Promise<void>
  list(options: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{
    objects: { key: string }[]
    truncated: boolean
    cursor?: string
  }>
}

/** R2 caps one `delete` call at 1000 keys. */
const R2_DELETE_BATCH = 1000

/** R2 caps one `list` page at 1000 keys. */
const R2_LIST_PAGE = 1000

function createR2Backend(bucket: R2BucketLike): ExecutionLogObjectBackend {
  return {
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return null
      return new Uint8Array(await object.arrayBuffer())
    },
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } })
    },
    async delete(keys) {
      for (let index = 0; index < keys.length; index += R2_DELETE_BATCH) {
        await bucket.delete(keys.slice(index, index + R2_DELETE_BATCH))
      }
    },
    async list(prefix, limit) {
      const out: string[] = []
      let cursor: string | undefined
      while (out.length < limit) {
        const page = await bucket.list({
          prefix,
          limit: Math.min(R2_LIST_PAGE, limit - out.length),
          ...(cursor ? { cursor } : {}),
        })
        for (const object of page.objects) out.push(object.key)
        if (!page.truncated || !page.cursor) break
        cursor = page.cursor
      }
      return out.slice(0, limit)
    },
  }
}

/** Execution-log store backed by an R2 bucket binding. */
export class R2ExecutionLogStore extends ObjectExecutionLogStore {
  constructor(bucket: R2BucketLike, opts: { now?: () => Date } = {}) {
    super(createR2Backend(bucket), opts)
  }
}
