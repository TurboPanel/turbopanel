/** Deno-only — imports the Redis client type; not imported by the Workers bundle (only `src/deno.ts` may import it). */
import type { RedisCellClient } from '../daemon/cell/redis/client.ts'
import type { Db } from '../db.ts'
import { logWarn } from '../logger.ts'
import { isApprovedReadModelId } from './approved-read-models.ts'
import {
  type QueryCache,
  clampQueryCacheTtlSeconds,
} from './contracts.ts'

/**
 * Redis read-through QueryCache for self-hosted Deno.
 *
 * Loader results **must be JSON-serializable** (true for the API read models cached
 * here). `ttlSeconds` is honored exactly on Deno (clamped to
 * `MAX_QUERY_CACHE_TTL_SECONDS`), in contrast to the advisory TTL on the
 * Workers/Hyperdrive backend.
 */
export function createRedisQueryCache(opts: {
  client: RedisCellClient
  db: Db
}): QueryCache {
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
        const cached = await client.get(key)
        if (cached !== null) {
          return JSON.parse(cached) as T
        }
      } catch (err) {
        logWarn('query-cache', `read failed for ${key}: ${String(err)}`)
      }

      const result = await load(db)

      try {
        await client.set(
          key,
          JSON.stringify(result),
          clampQueryCacheTtlSeconds(ttlSeconds) * 1000,
        )
      } catch (err) {
        logWarn('query-cache', `write failed for ${key}: ${String(err)}`)
      }

      return result
    },
  }
}
