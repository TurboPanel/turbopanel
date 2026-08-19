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
  options?: ManagedPromoteLagGateOptions,
): null | ManagedPromoteLagGateError {
  const staleMs = options?.staleMs ?? 120_000
  const maxLagBytes = options?.maxLagBytes ?? 64 * 1024 * 1024
  const maxLagSeconds = options?.maxLagSeconds ?? 30

  if (
    typeof replication !== 'object' ||
    replication === null ||
    Array.isArray(replication)
  ) {
    return 'managed_replica_not_streaming'
  }
  const r = replication as Record<string, unknown>
  if (typeof r.state !== 'string' || r.state.length === 0) {
    return 'managed_replica_not_streaming'
  }
  if (r.state !== 'streaming') {
    return 'managed_replica_not_streaming'
  }
  if (typeof r.observedAt !== 'string' || r.observedAt.length === 0) {
    return 'managed_replica_health_stale'
  }
  const observedMs = Date.parse(r.observedAt)
  if (!Number.isFinite(observedMs) || nowMs - observedMs > staleMs) {
    return 'managed_replica_health_stale'
  }
  if (
    typeof r.lagBytes === 'number' &&
    Number.isFinite(r.lagBytes) &&
    r.lagBytes > maxLagBytes
  ) {
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

/** Fail-closed health for automatic failover — never honors `force`. */
export function isAutomaticFailoverHealthy(
  replication: unknown,
  nowMs: number = Date.now(),
): boolean {
  return evaluateManagedPromoteLagGate(replication, nowMs) === null
}

export function replicationFromMemberMetadata(metadata: unknown): unknown {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return undefined
  }
  return (metadata as Record<string, unknown>).replication
}
