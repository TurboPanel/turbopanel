import type { Db } from '../db.ts'
import {
  DEFAULT_QUERY_CACHE_TTL_SECONDS,
  type ApprovedReadModelCacheOpts,
  type QueryCache,
} from './contracts.ts'
import { queryCacheKey } from './keys.ts'
import type { ApprovedReadModelId } from './approved-read-models.ts'

/**
 * Internal entry point for approved read-model helpers in `read-models/`.
 * Call sites must not import this — use the named helpers instead.
 */
export async function runApprovedCachedReadModel<T>(
  cache: QueryCache | undefined,
  db: Db,
  readModel: ApprovedReadModelId,
  keyParts: string[],
  load: (db: Db) => Promise<T>,
  ttlSeconds = DEFAULT_QUERY_CACHE_TTL_SECONDS,
): Promise<T> {
  if (!cache) {
    return load(db)
  }

  const opts: ApprovedReadModelCacheOpts<T> = {
    readModel,
    key: queryCacheKey(readModel, ...keyParts),
    ttlSeconds,
    load,
  }
  return cache.getReadModel(opts)
}
