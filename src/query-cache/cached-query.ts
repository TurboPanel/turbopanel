import type { Context } from 'hono'
import { getDb, getQueryCache, type Db } from '../db.ts'
import {
  DEFAULT_QUERY_CACHE_TTL_SECONDS,
  type QueryCache,
} from './contracts.ts'
import { queryCacheKey } from './keys.ts'

export async function cachedQuery<T>(
  c: Context,
  namespace: string,
  parts: string[],
  load: (db: Db) => Promise<T>,
  ttlSeconds = DEFAULT_QUERY_CACHE_TTL_SECONDS,
): Promise<T> {
  const db = getDb(c)
  if (!db) {
    throw new Error('Database unavailable')
  }

  const cache = getQueryCache(c)
  if (!cache) {
    return load(db)
  }

  return cache.cached({
    key: queryCacheKey(namespace, ...parts),
    ttlSeconds,
    load,
  })
}

/** Same as {@link cachedQuery} but accepts an explicit cache (for non-Hono callers). */
export async function cachedQueryWithCache<T>(
  cache: QueryCache | undefined,
  db: Db,
  namespace: string,
  parts: string[],
  load: (db: Db) => Promise<T>,
  ttlSeconds = DEFAULT_QUERY_CACHE_TTL_SECONDS,
): Promise<T> {
  if (!cache) {
    return load(db)
  }

  return cache.cached({
    key: queryCacheKey(namespace, ...parts),
    ttlSeconds,
    load,
  })
}
