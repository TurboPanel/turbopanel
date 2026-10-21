import type { Db } from '../db/connection.ts'
import {
  DEFAULT_QUERY_CACHE_TTL_SECONDS,
  type ApprovedReadModelCacheOpts,
  type QueryCache,
} from './contracts.ts'
import { queryCacheKey } from './keys.ts'
import type { ApprovedReadModelId } from './approved-read-models.ts'

/**
 * Internal entry point for `defineCachedRead`. Routes and read-model helpers
 * must not call this; the boundary check (`check:query-cache-boundaries`)
 * fails the build if they do.
 *
 * `keyParts` come from the statement itself (see `defineCachedRead`).
 */
export async function runApprovedCachedReadModel<T>(
  cache: QueryCache | undefined,
  db: Db,
  readModel: ApprovedReadModelId,
  keyParts: string[],
  load: (db: Db) => Promise<T>,
  ttlSeconds = DEFAULT_QUERY_CACHE_TTL_SECONDS
): Promise<T> {
  if (!cache) {
    return load(db)
  }

  const opts: ApprovedReadModelCacheOpts<T> = {
    readModel,
    key: queryCacheKey(readModel, ...keyParts),
    ttlSeconds,
    load,
    primaryDb: db,
  }
  return cache.getReadModel(opts)
}
