/**
 * `Server-Timing` header for request timing. Carries durations and a database
 * statement count only: no paths, SQL, parameters, hosts or identifiers.
 */
export const SERVER_TIMING_HEADER = 'Server-Timing'

export type ServerTimingInput = {
  /** Isolate init time; present only on the request that ran init. */
  initMs?: number
  /** Statements sent on the request's database clients. */
  dbStatements: number
  /** Request time spent after init. */
  appMs: number
}

function ms(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  return safe.toFixed(1)
}

export function formatServerTiming(input: ServerTimingInput): string {
  const count =
    Number.isSafeInteger(input.dbStatements) && input.dbStatements > 0 ? input.dbStatements : 0
  const parts = [`db;desc="${String(count)} stmts"`, `app;dur=${ms(input.appMs)}`]
  if (input.initMs !== undefined) parts.unshift(`init;dur=${ms(input.initMs)}`)
  return parts.join(', ')
}

/**
 * Routes that may carry Server-Timing. An allowlist, never a denylist: timings
 * and statement counts on an identity-sensitive route (sign-in, password
 * reset, sign-up) would show whether an account exists. Add a route here only
 * with an argument that its work does not depend on who is asking.
 */
const SERVER_TIMING_ROUTES: ReadonlySet<string> = new Set(['GET /api/client/v1/status'])

export function isServerTimingRoute(method: string, path: string): boolean {
  return SERVER_TIMING_ROUTES.has(`${method} ${path}`)
}
