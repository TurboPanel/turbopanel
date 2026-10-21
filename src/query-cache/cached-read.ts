import type { Context } from 'hono'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { getDb, getQueryCache, type Db } from '../db/connection.ts'
import * as schema from '../db/schema.ts'
import { logWarn } from '../lib/logger.ts'
import { CACHED_READ_REGISTRY, type ApprovedReadModelId } from './approved-read-models.ts'
import { DEFAULT_QUERY_CACHE_TTL_SECONDS } from './contracts.ts'
import { runApprovedCachedReadModel } from './cached-query.ts'
import { queryCacheKey } from './keys.ts'
import {
  stampHash,
  statementFingerprint,
  statementKeyHash,
  uncacheableReason,
} from './statement-guard.ts'

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
  /** Extra key parts that do not change the statement (for example the organization), kept so cached copies stay partitioned. */
  scope?: (input: Input) => string[]
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
  const scope = def.scope?.(input) ?? []
  return {
    sql,
    params,
    fingerprint: statementFingerprint(sql),
    keyHash,
    key: queryCacheKey(def.id, ...scope, keyHash),
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
      [...(def.scope?.(input) ?? []), prepared.keyHash],
      load,
      def.ttlSeconds ?? DEFAULT_QUERY_CACHE_TTL_SECONDS
    )
  }
  return Object.assign(run, { definition: def })
}

/** Name of the selected column that carries the version stamp. */
export const VERSION_STAMP_COLUMN = '_v'

/**
 * The version stamp as a selected column. It is a bound parameter that only
 * rides along in the select list: it never appears in a WHERE clause, so it
 * cannot hide a row. Its job is to change the statement's parameters (and so
 * the cache key) when the rows it describes have changed.
 */
export function versionStampColumn(stamp: string) {
  return sql<string>`${stamp}::text`.as(VERSION_STAMP_COLUMN)
}

/**
 * Build a stamp from values the primary connection already returned for the
 * same rows in this request (for example `id` and `updated_at`).
 */
export function versionStamp(parts: readonly string[]): string {
  return stampHash(parts)
}

/** Remove the stamp column from a row before it is returned or cached. */
export function withoutVersionStamp<Row extends { _v?: unknown }>(row: Row): Omit<Row, '_v'> {
  const { _v: _stamp, ...rest } = row
  return rest
}
