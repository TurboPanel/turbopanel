import type postgres from 'postgres'
import type { DbUsage } from './db-usage.ts'
import { isRegisteredFingerprint } from './approved-read-models.ts'
import {
  UncacheableStatementError,
  statementFingerprint,
  uncacheableReason,
} from './statement-guard.ts'

export type CacheableClientOptions = {
  /** Counts each statement actually sent. */
  usage?: DbUsage
}

const BLOCKED_CLIENT_METHODS = new Set([
  'begin',
  'reserve',
  'listen',
  'notify',
  'subscribe',
  'file',
  'savepoint',
])

/**
 * Wrap the postgres.js client behind the cached connection.
 *
 * Every statement is sent as a named prepared statement (the only shape the
 * cache accepts) and is checked first: it must be a single read-only SELECT
 * with no volatile function, and its fingerprint must be one the registry
 * lists. Anything else throws {@link UncacheableStatementError} before a byte
 * leaves the Worker. Transactions, listeners and the tagged-template call form
 * are refused for the same reason.
 */
export function withCacheableUnsafe<T extends ReturnType<typeof postgres>>(
  client: T,
  options: CacheableClientOptions = {}
): T {
  return new Proxy(client, {
    apply() {
      throw new UncacheableStatementError('tagged-template queries bypass the statement check')
    },
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: Record<string, unknown>) => {
          const reason = uncacheableReason(query)
          if (reason) throw new UncacheableStatementError(reason)
          if (!isRegisteredFingerprint(statementFingerprint(query))) {
            throw new UncacheableStatementError('statement is not in the registry')
          }
          if (options.usage) options.usage.cached += 1
          return target.unsafe(query, (args ?? []) as never[], { ...opts, prepare: true })
        }
      }
      if (typeof prop === 'string' && BLOCKED_CLIENT_METHODS.has(prop)) {
        return () => {
          throw new UncacheableStatementError(`${prop} is not available on the cached connection`)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
