import { createWorkersDb, type Db } from './db.ts'
import { createHyperdriveQueryCache } from './query-cache/hyperdrive-query-cache.ts'
import { createPassthroughQueryCache } from './query-cache/passthrough-query-cache.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import type { HyperdriveBinding } from './db.ts'

type WorkersDbFactory = (binding: HyperdriveBinding) => Db

let workersDbFactory: WorkersDbFactory = createWorkersDb

/** @internal Test seam for Workers binding resolution without a live Hyperdrive pool. */
export function setWorkersDbFactoryForTests(factory: WorkersDbFactory | null): void {
  workersDbFactory = factory ?? createWorkersDb
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

let cachedHyperdriveWarningLogged = false

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

function isWorkersDevSurface(env: CloudflareBindings): boolean {
  const flag = env.TURBOPANEL_DEV_SURFACE?.trim().toLowerCase()
  return flag === '1' || flag === 'true'
}
