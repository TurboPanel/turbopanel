/**
 * Is the switchover target proven caught up with the old primary?
 *
 * The planned-switchover re-seed wipes the former primary's data, so it may
 * only run when nothing on that node can be missing from the new primary. Only
 * a fresh, fully caught-up Postgres reading counts as that evidence: a clean
 * Postgres shutdown ships the remaining log to a connected standby, and the
 * reading shows no receive or replay lag. MySQL and MariaDB replicate
 * asynchronously and the control plane cannot compare the final GTID sets, so
 * they are never proven here and their old primary stays `needs_resync` for an
 * operator.
 */

/** Max age of the reading the evidence is based on. */
export const SWITCHOVER_CATCHUP_MAX_AGE_MS = 30_000

export type SwitchoverCatchUp = { caughtUp: boolean; basis: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isZero(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value === 0
}

function freshEnough(observedAt: unknown, nowMs: number): boolean {
  if (typeof observedAt !== 'string') return false
  const observedMs = Date.parse(observedAt)
  return Number.isFinite(observedMs) && nowMs - observedMs <= SWITCHOVER_CATCHUP_MAX_AGE_MS
}

export function evaluateSwitchoverCatchUp(
  engine: string,
  replication: unknown,
  nowMs: number = Date.now()
): SwitchoverCatchUp {
  if (engine !== 'postgres') {
    return { caughtUp: false, basis: 'asynchronous engine: final position cannot be compared' }
  }
  if (!isRecord(replication)) return { caughtUp: false, basis: 'no replication reading' }
  if (replication.state !== 'streaming') return { caughtUp: false, basis: 'not streaming' }
  if (!freshEnough(replication.observedAt, nowMs)) {
    return { caughtUp: false, basis: 'reading is stale' }
  }
  if (
    !isZero(replication.lagBytes) ||
    !isZero(replication.receiveLagBytes) ||
    !isZero(replication.lagSeconds)
  ) {
    return { caughtUp: false, basis: 'lag is not zero or unknown' }
  }
  return { caughtUp: true, basis: 'streaming with zero lag' }
}
