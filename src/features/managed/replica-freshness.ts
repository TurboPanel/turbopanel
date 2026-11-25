/**
 * Read-time freshness for the replica health shown in the panel and the API.
 *
 * A replica's reading is only written when something observes it (an apply,
 * a lifecycle result, the Refresh button, a failover probe), so a replica that
 * stopped answering would otherwise keep saying `streaming` for ever. A
 * reading older than the freshness window (the same 120 s the promote gate
 * uses) is shown as `unknown` instead, with the last state it had and how old
 * it is. A negative reading (`not_streaming`, `stopped`, ...) is kept: an
 * old "it was down" is never made vaguer.
 *
 * Display only. The promote gate and automatic failover keep reading the
 * stored observation and its own freshness rules unchanged.
 */

import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import { DEFAULT_MANAGED_PROMOTE_STALE_MS } from './promote-lag.ts'

/** How far ahead of now a daemon timestamp may be before it is not trusted (clock skew). */
export const REPLICA_HEALTH_MAX_FUTURE_SKEW_MS = 2 * 60_000

/**
 * The daemon pushes a health report every 30 s, but an unchanged reading is
 * only written again once the stored one is this old (see
 * `updateManagedMemberDisplayReplication`).
 */
export const REPLICA_DISPLAY_REFRESH_MS = 5 * 60_000

/**
 * Freshness window for a pushed (display-only) reading. It must stay well
 * above {@link REPLICA_DISPLAY_REFRESH_MS}: a healthy replica whose reading is
 * rewritten every five minutes would otherwise flip to `unknown` in between.
 * Probe-measured readings keep the shorter promote-gate window.
 */
export const REPLICA_DISPLAY_STALE_MS = 2 * REPLICA_DISPLAY_REFRESH_MS

/** Readings that say the replica was keeping up; only these can go out of date into `unknown`. */
const POSITIVE_STATES: ReadonlySet<string> = new Set(['streaming', 'catching_up', 'catchup'])

export type ReplicationHealthView = ManagedReplicationHealth & {
  /** True when the reading is older than the freshness window. */
  stale?: true
  /** The state the stale reading had before it was shown as `unknown`. */
  lastState?: string
  /** Age of the reading in whole seconds (stale readings only). */
  ageSeconds?: number
}

function readingAgeMs(observedAt: string, nowMs: number): number | null {
  const observedMs = Date.parse(observedAt)
  if (!Number.isFinite(observedMs)) return null
  // A timestamp far in the future would look fresh for ever; do not trust it.
  if (observedMs - nowMs > REPLICA_HEALTH_MAX_FUTURE_SKEW_MS) return null
  return Math.max(0, nowMs - observedMs)
}

/** The reading as it should be shown now (see the file comment). */
export function ageReplicationHealth(
  health: ManagedReplicationHealth,
  nowMs: number = Date.now(),
  staleMs: number = DEFAULT_MANAGED_PROMOTE_STALE_MS
): ReplicationHealthView {
  const ageMs = readingAgeMs(health.observedAt, nowMs)
  const stale = ageMs === null || ageMs > staleMs
  if (!stale || !POSITIVE_STATES.has(health.state)) return health
  return {
    ...health,
    state: 'unknown',
    stale: true,
    lastState: health.state,
    ...(ageMs === null ? {} : { ageSeconds: Math.round(ageMs / 1000) }),
  }
}
