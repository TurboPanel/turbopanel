import { createWorkersDb, type Db, type HyperdriveBinding } from './db.ts'
import { createHyperdriveQueryCache } from './query-cache/hyperdrive-query-cache.ts'
import { createPassthroughQueryCache } from './query-cache/passthrough-query-cache.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import type { RateLimiter } from './daemon/rate-limit/contracts.ts'
import { createNoopRateLimiter } from './daemon/rate-limit/contracts.ts'
import { createWorkersRateLimiter } from './daemon/rate-limit/workers-rate-limiter.ts'
import {
  type AuthRateLimiter,
  createDurableAuthRateLimiter,
  createFailClosedAuthRateLimiter,
  getSharedAuthRateLimiter,
} from './client/authn/auth-rate-limit.ts'

type WorkersDbFactory = (binding: HyperdriveBinding) => Db

let workersDbFactory: WorkersDbFactory = createWorkersDb

/**
 * Isolate-scoped Hyperdrive/postgres.js clients keyed by connection string.
 *
 * Workers `fetch` / `queue` / cron share one V8 isolate across many invocations.
 * Creating a new `postgres(...)` pool per request (and never closing it) stacks
 * clients until the isolate hits the 128 MB memory limit and is recycled.
 * Durable Object projection still calls `createWorkersDb` directly and closes
 * each short-lived client in `finally` — do not route those through this cache.
 */
const isolateDbByConnectionString = new Map<string, Db>()

/** Hyperdrive query-cache wrappers keyed by the cached binding connection string. */
const isolateHyperdriveQueryCacheByConnectionString = new Map<string, QueryCache>()

/** Passthrough query-cache wrappers keyed by the primary Db instance. */
const isolatePassthroughQueryCacheByDb = new WeakMap<Db, QueryCache>()

function getOrCreateIsolateDb(binding: HyperdriveBinding): Db {
  const key = binding.connectionString
  const existing = isolateDbByConnectionString.get(key)
  if (existing) return existing
  const db = workersDbFactory(binding)
  isolateDbByConnectionString.set(key, db)
  return db
}

function clearWorkersDbIsolateCache(): void {
  isolateDbByConnectionString.clear()
  isolateHyperdriveQueryCacheByConnectionString.clear()
}

/** @internal Test seam for Workers binding resolution without a live Hyperdrive pool. */
export function setWorkersDbFactoryForTests(factory: WorkersDbFactory | null): void {
  workersDbFactory = factory ?? createWorkersDb
  clearWorkersDbIsolateCache()
}

/** @internal Clears isolate Db / query-cache singletons between tests. */
export function clearWorkersDbIsolateCacheForTests(): void {
  clearWorkersDbIsolateCache()
}

/** Placeholder Hyperdrive config id — must not ship on exercised deploy envs. */
export const HYPERDRIVE_CACHED_PLACEHOLDER_ID = '0000000000000000000000000000dev0'

export function isPlaceholderHyperdriveCachedId(id: string | undefined): boolean {
  const trimmed = id?.trim()
  if (!trimmed) return false
  return trimmed === HYPERDRIVE_CACHED_PLACEHOLDER_ID
}

/**
 * Resolve the isolate-scoped primary Workers database (Hyperdrive or URL fallback).
 * Reuses one postgres.js client per connection string for the isolate lifetime —
 * do not `endDbConnection` on the returned handle.
 */
export function resolveWorkersDb(
  env: CloudflareBindings,
): ReturnType<typeof createWorkersDb> | undefined {
  if (env.HYPERDRIVE) {
    return getOrCreateIsolateDb(env.HYPERDRIVE)
  }
  const databaseUrl = env.TURBOPANEL_DATABASE_URL?.trim()
  if (databaseUrl) {
    return getOrCreateIsolateDb({ connectionString: databaseUrl })
  }
  return undefined
}

/**
 * Returns a database only when the dedicated cached Hyperdrive binding is present.
 * Isolate-scoped singleton — same reuse rules as {@link resolveWorkersDb}.
 */
export function resolveWorkersCachedDb(
  env: CloudflareBindings,
): ReturnType<typeof createWorkersDb> | undefined {
  if (env.HYPERDRIVE_CACHED) {
    return getOrCreateIsolateDb(env.HYPERDRIVE_CACHED)
  }
  return undefined
}

/**
 * Resolve the query-cache adapter for this isolate. Wrappers are cached so
 * repeated resolves do not allocate per request.
 */
export function resolveWorkersQueryCache(
  env: CloudflareBindings,
  db: Db | undefined,
): QueryCache | undefined {
  const cachedBinding = env.HYPERDRIVE_CACHED
  if (cachedBinding) {
    const connectionString = cachedBinding.connectionString
    const existing = isolateHyperdriveQueryCacheByConnectionString.get(
      connectionString,
    )
    if (existing) return existing
    const cachedDb = getOrCreateIsolateDb(cachedBinding)
    const cache = createHyperdriveQueryCache(cachedDb)
    isolateHyperdriveQueryCacheByConnectionString.set(connectionString, cache)
    return cache
  }
  if (db) {
    const existing = isolatePassthroughQueryCacheByDb.get(db)
    if (existing) return existing
    const cache = createPassthroughQueryCache(db)
    isolatePassthroughQueryCacheByDb.set(db, cache)
    return cache
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

/**
 * Resolve the durable client-auth limiter for Workers.
 *
 * - Binding present → durable, globally-shared limiter over the `RateLimit`
 *   binding (counters shared across isolates).
 * - Binding absent on a **dev** surface → per-isolate limiter (acceptable for
 *   local `wrangler dev`).
 * - Binding absent on **production** → fail-closed limiter. Auth endpoints
 *   return 429 rather than silently degrading to a bypassable per-isolate
 *   counter. This is the configuration check that stops production Workers from
 *   quietly running without a shared throttle.
 */
export function resolveWorkersClientAuthRateLimiter(
  env: CloudflareBindings,
): AuthRateLimiter {
  if (env.CLIENT_AUTH_RATE_LIMITER) {
    return createDurableAuthRateLimiter(
      createWorkersRateLimiter(env.CLIENT_AUTH_RATE_LIMITER),
    )
  }
  if (isWorkersDevSurface(env)) {
    return getSharedAuthRateLimiter()
  }
  return createFailClosedAuthRateLimiter()
}

let cachedHyperdriveWarningLogged = false
let daemonRateLimiterWarningLogged = false
let clientAuthRateLimiterWarningLogged = false

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

/**
 * Warn once when production-like Workers env is missing the client-auth rate
 * limit binding — auth endpoints will fail closed until it is bound.
 */
export function warnIfClientAuthRateLimiterMissing(env: CloudflareBindings): void {
  if (clientAuthRateLimiterWarningLogged) return
  if (env.CLIENT_AUTH_RATE_LIMITER) return
  if (isWorkersDevSurface(env)) return

  clientAuthRateLimiterWarningLogged = true
  console.warn(
    'CLIENT_AUTH_RATE_LIMITER binding missing; client auth endpoints fail closed (429) until it is bound.',
  )
}

function isWorkersDevSurface(env: CloudflareBindings): boolean {
  const flag = env.TURBOPANEL_DEV_SURFACE?.trim().toLowerCase()
  return flag === '1' || flag === 'true'
}
