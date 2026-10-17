import { isCacheableStatement } from './statement-guard.ts'

/** How one cached read model was served in a request. */
export type ReadModelOutcome = 'cached' | 'primary' | 'fallback'

/**
 * Statement counts for one request. One of these is made per request with its
 * database clients and read once, when the request ends.
 */
export type DbUsage = {
  /** Statements sent on the primary connection (re-runs after a fallback included). */
  primary: number
  /** Statements sent on the cached connection. */
  cached: number
  /** Primary statements that the cached connection would have accepted. */
  primaryCacheable: number
  /** Cached read models that had to be re-run on the primary connection. */
  fallback: number
  readModels: Array<{ id: string; outcome: ReadModelOutcome }>
  /** True while a fallback re-run is in progress, so it is not counted as missed. */
  rerunning: boolean
}

export function createDbUsage(): DbUsage {
  return {
    primary: 0,
    cached: 0,
    primaryCacheable: 0,
    fallback: 0,
    readModels: [],
    rerunning: false,
  }
}

export function recordReadModel(
  usage: DbUsage | undefined,
  id: string,
  outcome: ReadModelOutcome
): void {
  if (!usage) return
  usage.readModels.push({ id, outcome })
  if (outcome === 'fallback') usage.fallback += 1
}

/**
 * Count the statements a postgres.js client sends. No behaviour change: the
 * call is forwarded untouched.
 */
export function withPrimaryStatementCount<T extends object>(client: T, usage: DbUsage): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, ...rest: unknown[]) => {
          usage.primary += 1
          if (!usage.rerunning && isCacheableStatement(query)) usage.primaryCacheable += 1
          return (target as never as { unsafe: (...a: unknown[]) => unknown }).unsafe(
            query,
            ...rest
          )
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export type DbUsageLine = {
  route: string
  readModel: string
  cached: number
  primary: number
  primaryCacheable: number
  fallback: number
}

/** The single log line for a request, or `null` when it did not touch the database. */
export function dbUsageLine(route: string, usage: DbUsage): DbUsageLine | null {
  if (usage.primary === 0 && usage.cached === 0) return null
  return {
    route,
    readModel: usage.readModels.map((m) => `${m.id}:${m.outcome}`).join(',') || '-',
    cached: usage.cached,
    primary: usage.primary,
    primaryCacheable: usage.primaryCacheable,
    fallback: usage.fallback,
  }
}

/** Requests on cached routes and every fallback are always logged; the rest 1 in `every`. */
export function shouldLogDbUsage(
  usage: DbUsage,
  random: () => number = Math.random,
  every = 20
): boolean {
  if (usage.cached > 0 || usage.fallback > 0 || usage.readModels.length > 0) return true
  return random() * every < 1
}
