import type { Context } from 'hono'
import { drizzle } from 'drizzle-orm/postgres-js'
import { getDb, getQueryCache, type Db } from '../db/connection.ts'
import * as schema from '../db/schema.ts'
import { logWarn } from '../lib/logger.ts'
import { CACHED_READ_REGISTRY, type ApprovedReadModelId } from './approved-read-models.ts'
import { DEFAULT_QUERY_CACHE_TTL_SECONDS } from './contracts.ts'
import { runApprovedCachedReadModel } from './cached-query.ts'
import { queryCacheKey } from './keys.ts'
import { statementFingerprint, statementKeyHash, uncacheableReason } from './statement-guard.ts'

/**
 * The only database surface a cached read can build with: `select()`. There is
 * no `execute`, `insert`, `update`, `delete`, `transaction` or raw `sql`, so a
 * loader cannot write, and the statement it builds is a SELECT by construction.
 */
export type CachedReadDb = Pick<Db, 'select'>

/** What `build` must return: a select that can show its SQL before it is sent. */
export type CachedReadQuery<Row> = PromiseLike<Row[]> & {
  toSQL(): { sql: string; params: unknown[] }
}

export type CachedReadDefinition<Input, Row, Out> = {
  id: ApprovedReadModelId
  /** Build the one statement. Must not run it; the helper runs it. */
  build: (db: CachedReadDb, input: Input) => CachedReadQuery<Row>
  /** Shape the rows (for example hide option keys). What this returns is what gets cached on self-hosted. */
  transform: (rows: Row[], input: Input) => Out
  /** Example inputs the registry test builds the statement from. */
  samples: readonly Input[]
  ttlSeconds?: number
}

/**
 * A statement builder with no connection. It exists only to read the SQL text
 * and parameters a loader would send, so the cache key and the registry check
 * come from the statement itself and not from hand-written key parts.
 */
const offlineDb = (drizzle as unknown as { mock(c: { schema: typeof schema }): Db }).mock({
  schema,
})

export type PreparedCachedRead = {
  sql: string
  params: unknown[]
  fingerprint: string
  /** Hash of the text and parameters; the only part of the cache key after the id. */
  keyHash: string
  key: string
}

export function inspectCachedRead<Input, Row, Out>(
  def: CachedReadDefinition<Input, Row, Out>,
  input: Input
): PreparedCachedRead {
  const { sql, params } = def.build(offlineDb, input).toSQL()
  const keyHash = statementKeyHash(sql, params)
  return {
    sql,
    params,
    fingerprint: statementFingerprint(sql),
    keyHash,
    key: queryCacheKey(def.id, keyHash),
  }
}

export type CachedRead<Input, Out> = (c: Context, input: Input) => Promise<Out>

/**
 * Define a cached read. The returned function:
 *  1. builds the statement offline and derives the cache key from its text and
 *     parameters (so no input that changes the answer can be left out of the key);
 *  2. checks the statement is a plain SELECT and matches the fingerprint the
 *     registry holds for this id; if not, it runs on the primary connection
 *     and is never cached;
 *  3. otherwise reads through the query cache.
 */
export function defineCachedRead<Input, Row, Out>(
  def: CachedReadDefinition<Input, Row, Out>
): CachedRead<Input, Out> & { definition: CachedReadDefinition<Input, Row, Out> } {
  const run = async (c: Context, input: Input): Promise<Out> => {
    const db = getDb(c)
    if (!db) throw new Error('Database unavailable')

    const load = async (readDb: Db): Promise<Out> =>
      def.transform(await def.build(readDb, input), input)

    const prepared = inspectCachedRead(def, input)
    const reason = uncacheableReason(prepared.sql)
    const registered = CACHED_READ_REGISTRY[def.id].fingerprint
    if (reason || prepared.fingerprint !== registered) {
      logWarn(
        'query-cache',
        `${def.id} statement refused for the cached connection (${reason ?? 'fingerprint differs from the registry'}); using the primary connection`
      )
      return load(db)
    }

    return runApprovedCachedReadModel(
      getQueryCache(c),
      db,
      def.id,
      [prepared.keyHash],
      load,
      def.ttlSeconds ?? DEFAULT_QUERY_CACHE_TTL_SECONDS
    )
  }
  return Object.assign(run, { definition: def })
}
