import { isConnectionClosedError, type Db } from '../db/connection.ts'
import { logWarn } from '../lib/logger.ts'
import { isApprovedReadModelId } from './approved-read-models.ts'
import type { ApprovedReadModelCacheOpts, QueryCache } from './contracts.ts'
import { recordReadModel, type DbUsage } from './db-usage.ts'
import { UncacheableStatementError } from './statement-guard.ts'

export type HyperdriveQueryCacheOptions = {
  usage?: DbUsage
  /** Tests set this so a refused statement fails loudly instead of falling back. */
  strict?: boolean
}

/**
 * Hyperdrive-backed QueryCache for Cloudflare Workers.
 *
 * Unlike Deno/Redis, where `ttlSeconds` is honored exactly per cache key,
 * Hyperdrive caches SQL at the connection level. TTL is advisory only here —
 * effective cache lifetime is governed by the Hyperdrive binding's `max_age`
 * (60 seconds in production), not by the `key` or `ttlSeconds` arguments.
 *
 * The cached client refuses anything but a registered read-only SELECT. When
 * it refuses, or its connection is closed, the same SELECT is run once on the
 * primary connection. A closed connection on the primary connection too is
 * left to propagate, so the request-level retry still sees it.
 */
class HyperdriveQueryCache implements QueryCache {
  constructor(
    private readonly cachedDb: Db,
    private readonly options: HyperdriveQueryCacheOptions
  ) {}

  async getReadModel<T>(opts: ApprovedReadModelCacheOpts<T>): Promise<T> {
    if (!isApprovedReadModelId(opts.readModel)) {
      throw new Error(`Unapproved read model for cached database: ${opts.readModel}`)
    }
    const { usage } = this.options
    try {
      const value = await opts.load(this.cachedDb)
      recordReadModel(usage, opts.readModel, 'cached')
      return value
    } catch (err) {
      const refused = err instanceof UncacheableStatementError
      if (!opts.primaryDb || (!refused && !isConnectionClosedError(err))) throw err
      if (refused && this.options.strict) throw err
      logWarn(
        'query-cache',
        `${opts.readModel} fell back to the primary connection (${refused ? err.reason : 'cached connection closed'})`
      )
      recordReadModel(usage, opts.readModel, 'fallback')
      if (usage) usage.rerunning = true
      try {
        return await opts.load(opts.primaryDb)
      } finally {
        if (usage) usage.rerunning = false
      }
    }
  }
}

export function createHyperdriveQueryCache(
  cachedDb: Db,
  options: HyperdriveQueryCacheOptions = {}
): QueryCache {
  return new HyperdriveQueryCache(cachedDb, options)
}
