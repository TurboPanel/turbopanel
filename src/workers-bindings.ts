import { createWorkersDb, type Db, type HyperdriveBinding } from './db.ts'
import { createHyperdriveQueryCache } from './query-cache/hyperdrive-query-cache.ts'
import { createPassthroughQueryCache } from './query-cache/passthrough-query-cache.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import type { RateLimiter } from './daemon/rate-limit/contracts.ts'
import { createNoopRateLimiter } from './daemon/rate-limit/contracts.ts'
import { createWorkersRateLimiter } from './daemon/rate-limit/workers-rate-limiter.ts'

type WorkersDbFactory = (binding: HyperdriveBinding) => Db

let workersDbFactory: WorkersDbFactory = createWorkersDb

/** @internal Test seam for Workers binding resolution without a live Hyperdrive pool. */
export function setWorkersDbFactoryForTests(factory: WorkersDbFactory | null): void {
  workersDbFactory = factory ?? createWorkersDb
}

/** Placeholder Hyperdrive config id — must not ship on exercised deploy envs. */
export const HYPERDRIVE_CACHED_PLACEHOLDER_ID = '0000000000000000000000000000dev0'

export function isPlaceholderHyperdriveCachedId(id: string | undefined): boolean {
  const trimmed = id?.trim()
  if (!trimmed) return false
  return trimmed === HYPERDRIVE_CACHED_PLACEHOLDER_ID
}

export function resolveWorkersDb(
  env: CloudflareBindings,
): ReturnType<typeof createWorkersDb> | undefined {
  if (env.HYPERDRIVE) {
    return workersDbFactory(env.HYPERDRIVE)
  }
  const databaseUrl = env.TURBOPANEL_DATABASE_URL?.trim()
  if (databaseUrl) {
    return workersDbFactory({ connectionString: databaseUrl })
  }
  return undefined
}

/** Returns a database only when the dedicated cached Hyperdrive binding is present. */
export function resolveWorkersCachedDb(
  env: CloudflareBindings,
): ReturnType<typeof createWorkersDb> | undefined {
  if (env.HYPERDRIVE_CACHED) {
    return workersDbFactory(env.HYPERDRIVE_CACHED)
  }
  return undefined
}

export function resolveWorkersQueryCache(
  env: CloudflareBindings,
  db: Db | undefined,
): QueryCache | undefined {
  const cachedDb = resolveWorkersCachedDb(env)
  if (cachedDb) {
    return createHyperdriveQueryCache(cachedDb)
  }
  if (db) {
    return createPassthroughQueryCache(db)
  }
  return undefined
}

/**
 * Resolve Workers Rate Limit bindings for daemon WS-upgrade and REST surfaces.
 * Missing bindings yield noops so route code stays runtime-agnostic (Deno/tests).
 */
export function resolveWorkersDaemonRateLimiters(
  env: CloudflareBindings,
): { connect: RateLimiter; rest: RateLimiter } {
  return {
    connect: env.DAEMON_CONNECT_RATE_LIMITER
      ? createWorkersRateLimiter(env.DAEMON_CONNECT_RATE_LIMITER)
      : createNoopRateLimiter(),
    rest: env.DAEMON_REST_RATE_LIMITER
      ? createWorkersRateLimiter(env.DAEMON_REST_RATE_LIMITER)
      : createNoopRateLimiter(),
  }
}

let cachedHyperdriveWarningLogged = false
let daemonRateLimiterWarningLogged = false

/**
 * Warn once when production-like Workers env has primary Hyperdrive but no cached
 * binding — approved read models will fall back to the primary connection.
 */
export function warnIfCachedHyperdriveMissing(env: CloudflareBindings): void {
  if (cachedHyperdriveWarningLogged) return
  if (env.HYPERDRIVE_CACHED) return
  if (!env.HYPERDRIVE) return
  if (isWorkersDevSurface(env)) return

  cachedHyperdriveWarningLogged = true
  console.warn(
    'HYPERDRIVE_CACHED binding is missing; query-cache read models use the primary database without Hyperdrive caching.',
  )
}

/**
 * Warn once when production-like Workers env is missing daemon rate-limit bindings.
 */
export function warnIfDaemonRateLimitersMissing(env: CloudflareBindings): void {
  if (daemonRateLimiterWarningLogged) return
  if (env.DAEMON_CONNECT_RATE_LIMITER && env.DAEMON_REST_RATE_LIMITER) return
  if (isWorkersDevSurface(env)) return

  daemonRateLimiterWarningLogged = true
  console.warn(
    'DAEMON_CONNECT_RATE_LIMITER / DAEMON_REST_RATE_LIMITER binding(s) missing; daemon rate limits are noops.',
  )
}

function isWorkersDevSurface(env: CloudflareBindings): boolean {
  const flag = env.TURBOPANEL_DEV_SURFACE?.trim().toLowerCase()
  return flag === '1' || flag === 'true'
}
