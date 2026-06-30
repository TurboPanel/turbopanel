import type { Db } from '../db.ts'

/** Matches the Hyperdrive cached binding `max_age` (60 seconds in production). */
export const MAX_QUERY_CACHE_TTL_SECONDS = 60

export const DEFAULT_QUERY_CACHE_TTL_SECONDS = 60

export function clampQueryCacheTtlSeconds(ttl?: number): number {
  return Math.min(
    Math.max(ttl ?? DEFAULT_QUERY_CACHE_TTL_SECONDS, 1),
    MAX_QUERY_CACHE_TTL_SECONDS,
  )
}

/**
 * QueryCache — read-through cache for expensive Postgres reads.
 *
 * Runtime asymmetry:
 *   Workers → Hyperdrive-backed cache; `load` runs against the cached Hyperdrive
 *             connection and TTL is bounded by the binding `max_age` config.
 *   Deno    → Redis read-through honoring `ttlSeconds` exactly (clamped to
 *             `MAX_QUERY_CACHE_TTL_SECONDS`).
 *
 * Loader results must be JSON-serializable.
 */
export interface QueryCache {
  cached<T>(opts: {
    key: string
    ttlSeconds?: number
    load: (db: Db) => Promise<T>
  }): Promise<T>
}
