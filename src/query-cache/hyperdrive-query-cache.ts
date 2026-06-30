import type { Db } from '../db.ts'
import type { QueryCache } from './contracts.ts'

/**
 * Hyperdrive-backed QueryCache for Cloudflare Workers.
 *
 * Unlike Deno/Redis, where `ttlSeconds` is honored exactly per cache key,
 * Hyperdrive caches SQL at the connection level. TTL is advisory only here —
 * effective cache lifetime is governed by the Hyperdrive binding's `max_age`
 * (60 seconds in production), not by the `key` or `ttlSeconds` arguments.
 */
class HyperdriveQueryCache implements QueryCache {
  constructor(private readonly cachedDb: Db) {}

  async cached<T>(opts: {
    key: string
    ttlSeconds?: number
    load: (db: Db) => Promise<T>
  }): Promise<T> {
    return opts.load(this.cachedDb)
  }
}

export function createHyperdriveQueryCache(cachedDb: Db): QueryCache {
  return new HyperdriveQueryCache(cachedDb)
}
