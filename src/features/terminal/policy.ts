/**
 * Who may open a container terminal, as one pure truth table.
 *
 * Every condition must hold, and they are checked in this order so the answer
 * does not leak more than the caller may know:
 *
 * 1. the server's own switch (`server.options.terminal.container === true`) is
 *    on. It is off by default and it always wins, for a platform administrator
 *    too;
 * 2. the caller holds `terminal:container` (organization owners and managers
 *    do; a platform administrator does not, only a superadmin);
 * 3. the container is a tenant container of the server's organization, on this
 *    server, and running;
 * 4. the connected daemon lists `terminal-container-v1`.
 *
 * The route gathers the four facts (one query each) and this function only
 * decides, so the table is tested without a database.
 */

export type TerminalGateFacts = {
  /** `server.options.terminal.container === true`. */
  switchOn: boolean
  /** The caller holds `terminal:container` on the server. */
  holdsPermission: boolean
  /** The container row is a service container on this server, owned by the server's organization. */
  containerOwned: boolean
  /** The container is running and has a Docker id. */
  containerRunning: boolean
  /** The daemon's hello lists `terminal-container-v1`. */
  daemonHasFeature: boolean
}

export type TerminalGateRefusal =
  | { status: 403; code: 'terminal_disabled' | 'forbidden' }
  | { status: 404; code: 'container_not_found' }
  | { status: 409; code: 'container_not_running' | 'daemon_feature_missing' }

export type TerminalGateVerdict = { ok: true } | ({ ok: false } & TerminalGateRefusal)

export function evaluateTerminalGate(facts: TerminalGateFacts): TerminalGateVerdict {
  if (!facts.switchOn) return { ok: false, status: 403, code: 'terminal_disabled' }
  if (!facts.holdsPermission) return { ok: false, status: 403, code: 'forbidden' }
  if (!facts.containerOwned) return { ok: false, status: 404, code: 'container_not_found' }
  if (!facts.containerRunning) return { ok: false, status: 409, code: 'container_not_running' }
  if (!facts.daemonHasFeature) return { ok: false, status: 409, code: 'daemon_feature_missing' }
  return { ok: true }
}

/** `^[a-z_][a-z0-9_-]{0,31}$` or numeric `uid[:gid]`, the daemon's own rule. */
const LOGIN_USER_RE = /^(?:[a-z_][a-z0-9_-]{0,31}|\d{1,10}(?::\d{1,10})?)$/

export function isValidLoginUser(value: unknown): value is string {
  return typeof value === 'string' && LOGIN_USER_RE.test(value)
}

export const TERMINAL_MIN_DIM = 1
export const TERMINAL_MAX_DIM = 1000

export function isValidTerminalSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TERMINAL_MIN_DIM &&
    value <= TERMINAL_MAX_DIM
  )
}
