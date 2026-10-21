/**
 * Shared lag/health gate for managed promote and automatic failover.
 *
 * Missing, stale, or lagging observations fail closed. Operator promote may
 * bypass this with `force`; automatic failover never does.
 */

export type ManagedPromoteLagGateError =
  | 'managed_replica_not_streaming'
  | 'managed_replica_lagging'
  | 'managed_replica_health_stale'
  | 'managed_replica_not_fully_applied'

/** Default max age of a replica observation for the promote gate. */
export const DEFAULT_MANAGED_PROMOTE_STALE_MS = 120_000

/** Default max replay lag in bytes for the promote gate (64 MiB). */
export const DEFAULT_MANAGED_PROMOTE_MAX_LAG_BYTES = 64 * 1024 * 1024

/** Default max replay lag in seconds for the promote gate. */
export const DEFAULT_MANAGED_PROMOTE_MAX_LAG_SECONDS = 30

export type ManagedPromoteLagGateOptions = {
  /** Max age of the observation (default 120s). */
  staleMs?: number
  /** Max replay lag in bytes (default 64 MiB). */
  maxLagBytes?: number
  /** Max replay lag in seconds (default 30). */
  maxLagSeconds?: number
}

/**
 * Returns null when healthy enough to promote, or a typed error code when not.
 */
export function evaluateManagedPromoteLagGate(
  replication: unknown,
  nowMs: number = Date.now(),
  options?: ManagedPromoteLagGateOptions & {
    /** When set, require `fullyApplied === true` (MySQL-family operator promote). */
    requireFullyApplied?: boolean
  }
): null | ManagedPromoteLagGateError {
  const staleMs = options?.staleMs ?? DEFAULT_MANAGED_PROMOTE_STALE_MS
  const maxLagBytes = options?.maxLagBytes ?? DEFAULT_MANAGED_PROMOTE_MAX_LAG_BYTES
  const maxLagSeconds = options?.maxLagSeconds ?? DEFAULT_MANAGED_PROMOTE_MAX_LAG_SECONDS

  if (typeof replication !== 'object' || replication === null || Array.isArray(replication)) {
    return 'managed_replica_not_streaming'
  }
  const r = replication as Record<string, unknown>
  if (typeof r.state !== 'string' || r.state.length === 0) {
    return 'managed_replica_not_streaming'
  }
  if (r.state !== 'streaming') {
    return 'managed_replica_not_streaming'
  }
  if (options?.requireFullyApplied && r.fullyApplied !== true) {
    return 'managed_replica_not_fully_applied'
  }
  if (typeof r.observedAt !== 'string' || r.observedAt.length === 0) {
    return 'managed_replica_health_stale'
  }
  const observedMs = Date.parse(r.observedAt)
  if (!Number.isFinite(observedMs) || nowMs - observedMs > staleMs) {
    return 'managed_replica_health_stale'
  }
  if (typeof r.lagBytes === 'number' && Number.isFinite(r.lagBytes) && r.lagBytes > maxLagBytes) {
    return 'managed_replica_lagging'
  }
  if (
    typeof r.lagSeconds === 'number' &&
    Number.isFinite(r.lagSeconds) &&
    r.lagSeconds > maxLagSeconds
  ) {
    return 'managed_replica_lagging'
  }
  return null
}

/**
 * True when the stored observation is missing, unparseable, or older than the
 * gate's staleness window — i.e. a fresh reading could change the verdict.
 *
 * Deliberately keyed on age, not on the gate's error code: the gate answers
 * `managed_replica_not_streaming` *before* it looks at `observedAt`, so a
 * replica last seen catching up (or never observed) would otherwise never be
 * re-probed. Used only to decide whether the operator promote route asks the
 * daemon. Automatic failover probes on its own terms (`ha-fresh-standby.ts`).
 */
export function isManagedReplicaObservationStale(
  replication: unknown,
  nowMs: number = Date.now(),
  staleMs: number = DEFAULT_MANAGED_PROMOTE_STALE_MS
): boolean {
  if (typeof replication !== 'object' || replication === null || Array.isArray(replication)) {
    return true
  }
  const observedAt = (replication as Record<string, unknown>).observedAt
  if (typeof observedAt !== 'string' || observedAt.length === 0) return true
  const observedMs = Date.parse(observedAt)
  return !Number.isFinite(observedMs) || nowMs - observedMs > staleMs
}

/** Fail-closed health for automatic failover — never honors `force`. */
export function isAutomaticFailoverHealthy(
  replication: unknown,
  nowMs: number = Date.now()
): boolean {
  return evaluateManagedPromoteLagGate(replication, nowMs) === null
}

export function replicationFromMemberMetadata(metadata: unknown): unknown {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return undefined
  }
  return (metadata as Record<string, unknown>).replication
}
