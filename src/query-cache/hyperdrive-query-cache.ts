import { isConnectionClosedError, type Db } from '../db/connection.ts'
import { logWarn } from '../lib/logger.ts'
import { isApprovedReadModelId } from './approved-read-models.ts'
import type { ApprovedReadModelCacheOpts, QueryCache } from './contracts.ts'
import { recordReadModel, type DbUsage } from './db-usage.ts'
import { findUncacheableStatementError } from './statement-guard.ts'

/** Driver codes for a cached connection that could not be reached in time. */
const UNREACHABLE_CODES = new Set(['CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH'])

/** What the pooled connection reports when it cannot hand out a connection to the database. */
const POOL_FAILURE_MESSAGE =
  /failed to acquire a connection|network connection lost|connection (?:terminated|closed)/i

/**
 * True when the cached connection could not reach the database: it was closed,
 * timed out connecting, was refused, or the pool could not hand out a
 * connection. A query that ran and failed (bad statement, statement timeout,
 * constraint) is not one of these and is never retried on the primary.
 */
export function isCachedConnectionFailure(err: unknown): boolean {
  if (isConnectionClosedError(err)) return true
  let current: unknown = err
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true
    if (POOL_FAILURE_MESSAGE.test(current.message)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function describeFailure(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause
  const code = (err as { code?: unknown } | null)?.code ?? cause?.code
  return typeof code === 'string' ? `cached connection failed: ${code}` : 'cached connection failed'
}

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
      // The query driver wraps what the cached client throws, so look at the cause too.
      const refusal = findUncacheableStatementError(err)
      if (!opts.primaryDb || (!refusal && !isCachedConnectionFailure(err))) throw err
      if (refusal && this.options.strict) throw err
      logWarn(
        'query-cache',
        `${opts.readModel} fell back to the primary connection (${refusal ? refusal.reason : describeFailure(err)})`
      )
      recordReadModel(usage, opts.readModel, 'fallback')
      if (usage) usage.rerunning += 1
      try {
        return await opts.load(opts.primaryDb)
      } finally {
        if (usage) usage.rerunning -= 1
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
