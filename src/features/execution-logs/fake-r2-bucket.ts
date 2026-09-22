/**
 * In-memory `R2Bucket` stand-in for the execution-log conformance suites.
 *
 * Not a `*.test.ts` file so both the Workers/Vitest R2 suite and the Deno
 * object-store suite can import it.
 */

import type { R2BucketLike } from './r2-store.ts'

export type FakeR2Bucket = R2BucketLike & {
  /** Live view of stored keys, for assertions about compaction/cleanup. */
  keys(): string[]
}

/**
 * R2 lists keys in **code point** order. `localeCompare` would put `_` and `-`
 * in the wrong place relative to real R2, so the fake keeps byte order.
 */
function byKeyOrder(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

export function createFakeR2Bucket(): FakeR2Bucket {
  const objects = new Map<string, Uint8Array>()

  return {
    get(key) {
      const value = objects.get(key)
      if (!value) return Promise.resolve(null)
      // Copy so a caller cannot mutate stored bytes through the returned buffer.
      const copy = value.slice()
      return Promise.resolve({
        arrayBuffer: () =>
          Promise.resolve(
            copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
          ),
      })
    },
    put(key, value) {
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0))
      objects.set(key, bytes)
      return Promise.resolve(undefined)
    },
    delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key)
      }
      return Promise.resolve()
    },
    list({ prefix = '', limit = 1000, cursor }) {
      const matching = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort(byKeyOrder)
      const start = cursor ? matching.indexOf(cursor) + 1 : 0
      const page = matching.slice(start, start + limit)
      const truncated = start + page.length < matching.length
      return Promise.resolve({
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated && page.length > 0 ? { cursor: page.at(-1) } : {}),
      })
    },
    keys() {
      return [...objects.keys()].sort(byKeyOrder)
    },
  }
}
