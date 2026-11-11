/**
 * Checked vocabularies for the `cache` table (project caches).
 *
 * The `CHECK` lists in `src/db/schema.ts` are pinned to these arrays by
 * `src/db/enum-checks.test.ts`. Add a member in both places.
 */

/** Engine binary. `redis` is reserved for a later choice; the API refuses it until it is offered. */
export const CACHE_ENGINES = ['valkey', 'redis'] as const

export type CacheEngine = (typeof CACHE_ENGINES)[number]

/** How the process is reached: a private unix socket, or a loopback port opened to one account. */
export const CACHE_ACCESS = ['socket', 'port'] as const

export type CacheAccess = (typeof CACHE_ACCESS)[number]

/** Last known state, written from apply results. */
export const CACHE_STATUSES = ['pending', 'applying', 'ready', 'stopped', 'failed'] as const

export type CacheStatus = (typeof CACHE_STATUSES)[number]
