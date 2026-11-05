/** Deno-only — imports the Redis client type; not imported by the Workers bundle (only `src/deno.ts` may import it). */
import type { RedisCellClient } from '../daemon/cell/redis/client.ts'
import type { Db } from '../db/connection.ts'
import { logWarn } from '../lib/logger.ts'
import { isApprovedReadModelId } from './approved-read-models.ts'
import { type QueryCache, clampQueryCacheTtlSeconds } from './contracts.ts'

/**
 * Longest wait for one Redis `get` or `set` before the read falls back to the
 * database. The shared connection queues commands while Redis is down and
 * retries them without limit, so without a deadline a read would hang.
 */
export const REDIS_QUERY_CACHE_DEADLINE_MS = 150

function ignoreLateRejection(): void {
  // The deadline already settled the read; a later rejection has no one to tell.
}

/**
 * Settles with `promise`, or rejects once `ms` has passed. The timer is always
 * cleared, and a rejection of `promise` after the deadline is marked handled so
 * it never surfaces as an unhandled rejection.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  promise.catch(ignoreLateRejection)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis ${label} timed out after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Redis read-through QueryCache for self-hosted Deno.
 *
 * Loader results **must be JSON-serializable** (true for the API read models cached
 * here). `ttlSeconds` is honored exactly on Deno (clamped to
 * `MAX_QUERY_CACHE_TTL_SECONDS`), in contrast to the advisory TTL on the
 * Workers/Hyperdrive backend.
 */
export function createRedisQueryCache(opts: { client: RedisCellClient; db: Db }): QueryCache {
  const { client, db } = opts

  return {
    async getReadModel<T>({
      readModel,
      key,
      ttlSeconds,
      load,
    }: {
      readModel: string
      key: string
      ttlSeconds?: number
      load: (db: Db) => Promise<T>
    }): Promise<T> {
      if (!isApprovedReadModelId(readModel)) {
        throw new Error(`Unapproved read model for query cache: ${readModel}`)
      }

      try {
        const cached = await withDeadline(client.get(key), REDIS_QUERY_CACHE_DEADLINE_MS, 'get')
        if (cached !== null) {
          return JSON.parse(cached) as T
        }
      } catch (err) {
        logWarn('query-cache', `read failed for ${key}: ${String(err)}`)
      }

      const result = await load(db)

      try {
        await withDeadline(
          client.set(key, JSON.stringify(result), clampQueryCacheTtlSeconds(ttlSeconds) * 1000),
          REDIS_QUERY_CACHE_DEADLINE_MS,
          'set'
        )
      } catch (err) {
        logWarn('query-cache', `write failed for ${key}: ${String(err)}`)
      }

      return result
    },
  }
}
