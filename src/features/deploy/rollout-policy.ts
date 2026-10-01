/**
 * Multi-host rollout policy, read from the Compose `deploy.update_config`
 * stanza (the Docker Swarm shape) per the frozen compose contract: Compose
 * already expresses "how many at a time, how long between, what on failure",
 * so no TurboPanel key is invented for it.
 *
 * Stage 1: pure parsing and resolution only. `deploy.update_config` stays
 * `unsupported` in `field-policy.ts` until the rollout (stage 6) acts on this,
 * because accepting a key nothing reads is the silent-drop bug the field
 * registry exists to prevent.
 *
 * Defaults (owner decision, 2026-10-01): one host at a time, halt on failure.
 */

export type RolloutFailureAction = 'halt' | 'continue'
export type RolloutOrder = 'stop-first' | 'start-first'

export type RolloutPolicy = {
  /** Hosts updated at once. `0` means every host at once (Swarm semantics). */
  parallelism: number
  /** Seconds to wait between batches. */
  delaySeconds: number
  /** What a failed host does to the rest of the rollout. */
  failureAction: RolloutFailureAction
  /** Seconds a finished host is watched for failure before the batch counts as done. */
  monitorSeconds: number
  /** Tolerated fraction of failed hosts under `continue` (0 to 1). */
  maxFailureRatio: number
  order: RolloutOrder
}

export const DEFAULT_ROLLOUT_POLICY: RolloutPolicy = {
  parallelism: 1,
  delaySeconds: 0,
  failureAction: 'halt',
  monitorSeconds: 5,
  maxFailureRatio: 0,
  order: 'stop-first',
}

const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/y
const UNIT_SECONDS: Record<string, number> = {
  h: 3600,
  m: 60,
  s: 1,
  ms: 0.001,
  us: 0.000001,
  ns: 0.000000001,
}

/**
 * Compose duration (`10s`, `1m30s`, `500ms`) or a bare non-negative number of
 * seconds, to seconds. `null` when it is neither.
 */
export function parseComposeDurationSeconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string' || value.length === 0) return null
  let total = 0
  let index = 0
  DURATION_PART_RE.lastIndex = 0
  while (index < value.length) {
    DURATION_PART_RE.lastIndex = index
    const match = DURATION_PART_RE.exec(value)
    if (match === null) return null
    total += Number(match[1]) * UNIT_SECONDS[match[2]]
    index = DURATION_PART_RE.lastIndex
  }
  return total
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type UpdateConfigResult =
  { ok: true; value: Partial<RolloutPolicy> } | { ok: false; reasons: string[] }

type FieldReader = (raw: unknown) => { value: Partial<RolloutPolicy> } | { reason: string }

const FIELD_READERS: Record<string, FieldReader> = {
  parallelism: (raw) =>
    Number.isInteger(raw) && (raw as number) >= 0
      ? { value: { parallelism: raw as number } }
      : { reason: 'parallelism must be a non-negative integer' },
  delay: (raw) => durationField('delay', 'delaySeconds', raw),
  monitor: (raw) => durationField('monitor', 'monitorSeconds', raw),
  failure_action: (raw) => {
    // `pause` stops the rollout; `rollback` stops it too (TurboPanel's own
    // rollback is the deploy strategy's job). Only `continue` keeps going.
    if (raw === 'pause' || raw === 'rollback') return { value: { failureAction: 'halt' } }
    if (raw === 'continue') return { value: { failureAction: 'continue' } }
    return { reason: 'failure_action must be pause, continue or rollback' }
  },
  max_failure_ratio: (raw) =>
    typeof raw === 'number' && raw >= 0 && raw <= 1
      ? { value: { maxFailureRatio: raw } }
      : { reason: 'max_failure_ratio must be a number from 0 to 1' },
  order: (raw) =>
    raw === 'stop-first' || raw === 'start-first'
      ? { value: { order: raw } }
      : { reason: 'order must be stop-first or start-first' },
}

function durationField(
  composeKey: string,
  policyKey: 'delaySeconds' | 'monitorSeconds',
  raw: unknown
): { value: Partial<RolloutPolicy> } | { reason: string } {
  const seconds = parseComposeDurationSeconds(raw)
  if (seconds === null) return { reason: `${composeKey} must be a duration such as 10s or 1m30s` }
  return { value: { [policyKey]: seconds } }
}

/** One service's `deploy.update_config`, validated. Unknown keys are reported. */
export function parseUpdateConfig(value: unknown): UpdateConfigResult {
  if (!isRecord(value)) return { ok: false, reasons: ['update_config must be a mapping'] }
  const parsed: Partial<RolloutPolicy> = {}
  const reasons: string[] = []
  for (const [key, raw] of Object.entries(value)) {
    const read = FIELD_READERS[key]
    if (read === undefined) {
      reasons.push(`update_config.${key} is not a known setting`)
      continue
    }
    const result = read(raw)
    if ('reason' in result) reasons.push(result.reason)
    else Object.assign(parsed, result.value)
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: parsed }
}

/** `0` means "all at once", so it is the *least* conservative parallelism. */
function mergeParallelism(current: number | undefined, next: number): number {
  if (current === undefined) return next
  if (current === 0) return next
  if (next === 0) return current
  return Math.min(current, next)
}

/** Merge two partial policies, keeping the more conservative value per field. */
function mostConservative(into: Partial<RolloutPolicy>, next: Partial<RolloutPolicy>): void {
  if (next.parallelism !== undefined) {
    into.parallelism = mergeParallelism(into.parallelism, next.parallelism)
  }
  if (next.delaySeconds !== undefined) {
    into.delaySeconds = Math.max(into.delaySeconds ?? 0, next.delaySeconds)
  }
  if (next.monitorSeconds !== undefined) {
    into.monitorSeconds = Math.max(into.monitorSeconds ?? 0, next.monitorSeconds)
  }
  if (next.maxFailureRatio !== undefined) {
    into.maxFailureRatio = Math.min(into.maxFailureRatio ?? 1, next.maxFailureRatio)
  }
  if (next.failureAction !== undefined) {
    into.failureAction = into.failureAction === 'halt' ? 'halt' : next.failureAction
  }
  if (next.order !== undefined) {
    into.order = into.order === 'stop-first' ? 'stop-first' : next.order
  }
}

/**
 * The environment's rollout policy from its services' `deploy.update_config`.
 *
 * A rollout spans hosts, but Compose states the stanza per service. Where
 * several services declare one, the most conservative value of each field
 * wins (lowest parallelism, longest delay and monitor, `halt` over
 * `continue`, `stop-first` over `start-first`). A service with an invalid
 * stanza is ignored here and reported in `invalid`; callers refuse the deploy.
 */
export function resolveRolloutPolicy(services: Record<string, unknown> | undefined): {
  policy: RolloutPolicy
  declaredBy: string[]
  invalid: Array<{ service: string; reasons: string[] }>
} {
  const merged: Partial<RolloutPolicy> = {}
  const declaredBy: string[] = []
  const invalid: Array<{ service: string; reasons: string[] }> = []
  for (const [name, service] of Object.entries(services ?? {})) {
    const deploy = isRecord(service) && isRecord(service.deploy) ? service.deploy : null
    if (deploy === null || deploy.update_config === undefined) continue
    const result = parseUpdateConfig(deploy.update_config)
    if (!result.ok) {
      invalid.push({ service: name, reasons: result.reasons })
      continue
    }
    declaredBy.push(name)
    mostConservative(merged, result.value)
  }
  return { policy: { ...DEFAULT_ROLLOUT_POLICY, ...merged }, declaredBy, invalid }
}
