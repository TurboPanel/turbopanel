import {
  createWorkersDb,
  endDbConnection,
  type Db,
  type HyperdriveBinding,
} from './db.ts'
import { createHyperdriveQueryCache } from './query-cache/hyperdrive-query-cache.ts'
import { createPassthroughQueryCache } from './query-cache/passthrough-query-cache.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import type { RateLimiter } from './daemon/rate-limit/contracts.ts'
import {
  createFailClosedRateLimiter,
  createNoopRateLimiter,
} from './daemon/rate-limit/contracts.ts'
import { createWorkersRateLimiter } from './daemon/rate-limit/workers-rate-limiter.ts'
import {
  type AuthRateLimiter,
  createDurableAuthRateLimiter,
  createFailClosedAuthRateLimiter,
  getSharedAuthRateLimiter,
} from './client/authn/auth-rate-limit.ts'

/**
 * Per-invocation Hyperdrive handles for the main Worker (`fetch` / `queue`).
 *
 * Create with {@link openWorkersRequestDb}, use for that one invocation only,
 * then {@link closeWorkersRequestDb} in `finally` / `ctx.waitUntil` — never
 * cache across requests (Hyperdrive I/O context) and never leave clients open
 * (postgres.js pools stack until the isolate hits the 128 MB limit).
 */
export type WorkersRequestDbHandles = {
  db: Db | undefined
  /** Distinct `HYPERDRIVE_CACHED` client when present; ended separately. */
  cachedDb: Db | undefined
  queryCache: QueryCache | undefined
}

type WorkersDbFactory = (binding: HyperdriveBinding) => Db | undefined

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

/**
 * Resolve the primary Workers database (Hyperdrive or URL fallback).
 *
 * Creates a **new** postgres.js client per call. On Cloudflare Workers a DB
 * client (and its underlying socket) is an I/O object bound to the request that
 * created it — reusing one across requests throws "Cannot perform I/O on behalf
 * of a different request" and 500s. Hyperdrive already pools connections, so
 * per-request creation carries no connection-startup cost and must not be cached
 * in isolate/global scope. Always pair with {@link endDbConnection} /
 * {@link closeWorkersRequestDb} when the invocation finishes. See Cloudflare
 * Hyperdrive troubleshooting.
 */
export function resolveWorkersDb(
  env: CloudflareBindings,
): ReturnType<typeof createWorkersDb> | undefined {
  if (env.HYPERDRIVE) {
    return workersDbFactory(env.HYPERDRIVE) ?? undefined
  }
  const databaseUrl = env.TURBOPANEL_DATABASE_URL?.trim()
  if (databaseUrl) {
    return workersDbFactory({ connectionString: databaseUrl }) ?? undefined
  }
  return undefined
}

/**
 * Returns a database only when the dedicated cached Hyperdrive binding is present.
 * Creates a new client per call — same per-request rule as {@link resolveWorkersDb}.
 */
export function resolveWorkersCachedDb(
  env: CloudflareBindings,
): ReturnType<typeof createWorkersDb> | undefined {
  if (env.HYPERDRIVE_CACHED) {
    return workersDbFactory(env.HYPERDRIVE_CACHED) ?? undefined
  }
  return undefined
}

/**
 * Resolve the query-cache adapter for a request. Wraps a per-request client —
 * never cached across requests (see {@link resolveWorkersDb}).
 *
 * Prefer {@link openWorkersRequestDb} on the Worker entry paths so primary +
 * cached clients are created once and closed together. Pass `cachedDb` when
 * the caller already resolved {@link resolveWorkersCachedDb} to avoid minting
 * a second cached client.
 */
export function resolveWorkersQueryCache(
  env: CloudflareBindings,
  db: Db | undefined,
  cachedDb?: Db | null,
): QueryCache | undefined {
  const resolvedCached =
    cachedDb === undefined ? resolveWorkersCachedDb(env) : cachedDb ?? undefined
  if (resolvedCached) {
    return createHyperdriveQueryCache(resolvedCached)
  }
  if (db) {
    return createPassthroughQueryCache(db)
  }
  return undefined
}

/**
 * Open fresh primary (+ optional cached) Hyperdrive clients for one Worker
 * invocation. Pair with {@link closeWorkersRequestDb} — never reuse across
 * requests.
 */
export function openWorkersRequestDb(
  env: CloudflareBindings,
): WorkersRequestDbHandles {
  const db = resolveWorkersDb(env)
  const cachedDb = resolveWorkersCachedDb(env)
  return {
    db,
    cachedDb,
    queryCache: resolveWorkersQueryCache(env, db, cachedDb ?? null),
  }
}

/**
 * Force-close per-invocation postgres.js clients. Safe to call when handles
 * are undefined/missing; swallows nothing — callers may `.catch(() => {})`
 * when scheduling via `waitUntil`.
 */
export async function closeWorkersRequestDb(
  handles: WorkersRequestDbHandles,
): Promise<void> {
  const endings: Promise<void>[] = []
  if (handles.db) endings.push(endDbConnection(handles.db))
  if (handles.cachedDb) endings.push(endDbConnection(handles.cachedDb))
  if (endings.length === 0) return
  await Promise.all(endings)
}

/**
 * Resolve Workers Rate Limit bindings for daemon WS-upgrade, REST, metrics, and
 * container-log ingest.
 *
 * - Binding present → durable limiter over the Cloudflare `RateLimit` binding.
 * - Binding absent on a **dev** surface / tests → noop (routes stay usable).
 * - Binding absent on **production-like** Workers → fail-closed (429) so a
 *   misconfigured deploy cannot silently run unrestricted.
 */
export function resolveWorkersDaemonRateLimiters(
  env: CloudflareBindings,
): {
  connect: RateLimiter
  rest: RateLimiter
  metrics: RateLimiter
  containerLogs: RateLimiter
} {
  const allowNoop = isWorkersDevSurface(env)
  return {
    connect: resolveDaemonLimiterBinding(
      env.DAEMON_CONNECT_RATE_LIMITER,
      allowNoop,
    ),
    rest: resolveDaemonLimiterBinding(env.DAEMON_REST_RATE_LIMITER, allowNoop),
    metrics: resolveDaemonLimiterBinding(
      env.DAEMON_METRICS_RATE_LIMITER,
      allowNoop,
    ),
    containerLogs: resolveDaemonLimiterBinding(
      env.CONTAINER_LOGS_RATE_LIMITER,
      allowNoop,
    ),
  }
}

function resolveDaemonLimiterBinding(
  binding: { limit(options: { key: string }): Promise<{ success: boolean }> } | undefined,
  allowNoop: boolean,
): RateLimiter {
  if (binding) return createWorkersRateLimiter(binding)
  return allowNoop ? createNoopRateLimiter() : createFailClosedRateLimiter()
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

/** @internal Reset one-shot production warning flags — tests only. */
export function resetWorkersBindingWarningsForTests(): void {
  cachedHyperdriveWarningLogged = false
  daemonRateLimiterWarningLogged = false
  clientAuthRateLimiterWarningLogged = false
}

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
 * Missing bindings fail closed (429); the warning explains why traffic is denied.
 */
export function warnIfDaemonRateLimitersMissing(env: CloudflareBindings): void {
  if (daemonRateLimiterWarningLogged) return
  if (
    env.DAEMON_CONNECT_RATE_LIMITER &&
    env.DAEMON_REST_RATE_LIMITER &&
    env.DAEMON_METRICS_RATE_LIMITER &&
    env.CONTAINER_LOGS_RATE_LIMITER
  ) {
    return
  }
  if (isWorkersDevSurface(env)) return

  daemonRateLimiterWarningLogged = true
  console.warn(
    'DAEMON_CONNECT_RATE_LIMITER / DAEMON_REST_RATE_LIMITER / DAEMON_METRICS_RATE_LIMITER / ' +
      'CONTAINER_LOGS_RATE_LIMITER binding(s) missing; daemon rate limits fail closed (429) until bound.',
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
