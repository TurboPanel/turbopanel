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

/** Engine series a cache can be created with, mapped by the daemon to its pinned patch release. */
export const CACHE_SERIES = ['8.1'] as const

export type CacheSeries = (typeof CACHE_SERIES)[number]

/** The series a new cache gets. */
export const CACHE_DEFAULT_SERIES: CacheSeries = '8.1'

/** Smallest and largest `maxmemory` the wire takes, in MiB. */
export const MIN_CACHE_MEMORY_MB = 16
export const MAX_CACHE_MEMORY_MB = 65536

/** What the API offers: the column allows more, so an operator cannot reserve a whole host by accident. */
export const MAX_CACHE_MEMORY_MB_API = 4096
export const DEFAULT_CACHE_MEMORY_MB = 64

/** The unit memory ceiling is twice `maxmemory` (a default snapshot forks and copies on write) plus this. */
export const CACHE_MEMORY_OVERHEAD_MB = 32

/** The loopback band a cache or helper port comes from (equal to the daemon's listen band). */
export const CACHE_PORT_MIN = 18080
export const CACHE_PORT_MAX = 18999

/** The most caches one deploy or one `cache.apply` carries, and the most helper ports one deploy opens. */
export const MAX_CACHES_PER_ENVIRONMENT = 16
export const MAX_HELPER_REACH_PER_DEPLOY = 32

/** Default variable prefix: the names Redis clients expect. */
export const DEFAULT_CACHE_KEY_PREFIX = 'REDIS'

/** Where a cache's login and socket live on the host (the host computes the folder; this is fixed by the unit). */
export const CACHE_LOGIN_USERNAME = 'app'

/** The unit memory ceiling in MiB for a cache that holds `maxMemoryMb`. */
export function cacheMemoryCeilingMb(maxMemoryMb: number): number {
  return maxMemoryMb * 2 + CACHE_MEMORY_OVERHEAD_MB
}

/** The private socket path for a cache id (a lower-case UUID). */
export function cacheSocketPath(cacheId: string): string {
  return `/run/turbopanel-cache-${cacheId}/valkey.sock`
}
