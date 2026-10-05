/**
 * Per-service run state the daemon reports on `hello` and change-detected
 * `heartbeat` (`services`). Twin of
 * `turbopaneld/src/contracts/service-run-state.ts` (checked by
 * `scripts/check-contract-drift.mjs`): keep field names and optionality
 * aligned.
 *
 * One entry per TurboPanel service with at least one container on the host.
 * `asOf` is when the daemon last saw this exact state change, not a sample
 * time, so an idle service reports a stable value.
 */
export type ServiceRunState = {
  serviceId: string
  /**
   * `running` only after the container has stayed up for the settle window;
   * `crashing` while Docker keeps restarting it; `stopped_after_crashes` once it
   * is down at or past the restart limit.
   */
  state:
    | 'starting'
    | 'running'
    | 'unhealthy'
    | 'crashing'
    | 'stopped'
    | 'stopped_after_crashes'
    | 'unknown'
  restartCount: number
  /** Last log line of the failing container, at most 400 characters. */
  lastError?: string
  asOf: string
}

export type ServiceRunStateName = ServiceRunState['state']

/** Entries one frame may carry; mirrors the daemon's cap. */
export const MAX_SERVICE_RUN_STATES = 200

/** `lastError` cap, mirrors the daemon's. */
export const MAX_SERVICE_LAST_ERROR_CHARS = 400

const SERVICE_RUN_STATE_NAMES: ReadonlySet<string> = new Set<ServiceRunStateName>([
  'starting',
  'running',
  'unhealthy',
  'crashing',
  'stopped',
  'stopped_after_crashes',
  'unknown',
])

/** Worst first. A service on several servers reports its worst state. */
const SEVERITY: Record<ServiceRunStateName, number> = {
  stopped_after_crashes: 6,
  crashing: 5,
  unhealthy: 4,
  stopped: 3,
  unknown: 2,
  starting: 1,
  running: 0,
}

const SERVICE_ID_TOKEN = /^[A-Za-z0-9._-]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseServiceRunState(value: unknown): ServiceRunState | undefined {
  if (!isRecord(value)) return undefined
  const { serviceId, state, restartCount, lastError, asOf } = value
  if (typeof serviceId !== 'string' || !SERVICE_ID_TOKEN.test(serviceId)) {
    return undefined
  }
  if (typeof state !== 'string' || !SERVICE_RUN_STATE_NAMES.has(state)) {
    return undefined
  }
  if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf))) {
    return undefined
  }
  const count =
    typeof restartCount === 'number' && Number.isFinite(restartCount) && restartCount >= 0
      ? Math.floor(restartCount)
      : 0
  const entry: ServiceRunState = {
    serviceId,
    state: state as ServiceRunStateName,
    restartCount: count,
    asOf,
  }
  if (typeof lastError === 'string' && lastError.length > 0) {
    entry.lastError = lastError.slice(0, MAX_SERVICE_LAST_ERROR_CHARS)
  }
  return entry
}

/**
 * Parse a daemon `services` list. `undefined` means the daemon sent nothing
 * (keep what is stored); `[]` is a real answer (no services on the host).
 * Malformed entries are dropped, never fatal: a daemon reporting nonsense
 * degrades to "no run state", it does not lose its connection.
 */
export function parseServiceRunStates(value: unknown): ServiceRunState[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ServiceRunState[] = []
  const seen = new Set<string>()
  for (const raw of value.slice(0, MAX_SERVICE_RUN_STATES)) {
    const entry = parseServiceRunState(raw)
    if (!entry || seen.has(entry.serviceId)) continue
    seen.add(entry.serviceId)
    out.push(entry)
  }
  return out
}

export function serviceRunStatesEqual(
  a: readonly ServiceRunState[] | undefined,
  b: readonly ServiceRunState[] | undefined
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return (
      entry.serviceId === other?.serviceId &&
      entry.state === other.state &&
      entry.restartCount === other.restartCount &&
      entry.asOf === other.asOf &&
      (entry.lastError ?? '') === (other.lastError ?? '')
    )
  })
}

/** The state a service shows when several servers report it: the worst one. */
export function worstServiceRunState(
  states: readonly ServiceRunState[]
): ServiceRunState | undefined {
  let worst: ServiceRunState | undefined
  for (const entry of states) {
    if (!worst || SEVERITY[entry.state] > SEVERITY[worst.state]) worst = entry
  }
  return worst
}
