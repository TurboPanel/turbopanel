/**
 * Fresh-standby gate for automatic Postgres failover (owner decision
 * 2026-10-02).
 *
 * After a cold kill of the primary, the standby's WAL receiver exits, so the
 * stored observation never reads `streaming` and the normal lag gate
 * (`promote-lag.ts`) always blocks. At event time the control plane probes
 * the candidate itself and accepts a NOT-streaming standby only when ALL of:
 *
 * (a) it was last seen streaming no earlier than the failure start minus a
 *     small margin (`lastStreaming.ageMs` from the daemon's sampler);
 * (b) its replay LSN equals its received LSN (nothing received is unapplied);
 * (c) the received-vs-primary byte lag of that last streaming read was within
 *     the promote limit (64 MiB). Seconds since the last commit are not used.
 *
 * Anything missing, unparseable or out of range refuses. This never replaces
 * fencing or the cooldown; it only decides whether the candidate is healthy.
 *
 * Loss window: replication is asynchronous, so an accepted standby may still
 * lack what the primary committed after the standby's last streaming read.
 * That is bounded by the margin (time between that read and the failure start,
 * up to `marginMs` + the detector's first-probe delay) plus the receive lag
 * the read itself showed (at most 64 MiB of WAL). Several accepted standbys:
 * the one that received the most WAL wins ({@link pickMostAdvancedStandby}).
 */

import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import {
  DEFAULT_MANAGED_PROMOTE_MAX_LAG_BYTES,
  evaluateManagedPromoteLagGate,
} from './promote-lag.ts'

/** Default allowance between the last streaming read and the failure start. */
export const DEFAULT_FRESH_STANDBY_MARGIN_MS = 10_000

/** Upper bound on the configured margin: a looser gate is not a fresh one. */
export const MAX_FRESH_STANDBY_MARGIN_MS = 60_000

/**
 * Upper bound on the detector's failure span the gate will anchor on. A
 * re-sent event for an older incident falls outside it and is refused: the
 * standby's last streaming read can no longer be tied to the failure.
 */
export const MAX_FAILURE_SPAN_MS = 10 * 60_000

/** Receiver states of a standby still in recovery whose primary went away. */
const DISCONNECTED_STANDBY_STATES: ReadonlySet<string> = new Set([
  'stopped',
  'starting',
  'waiting',
  'restarting',
  'stopping',
])

export type FreshStandbyRefusal =
  | 'probe_unavailable'
  | 'not_a_standby'
  | 'lagging'
  | 'receipt_unknown'
  | 'receipt_stale'
  | 'lsn_unknown'
  | 'replay_behind'
  | 'last_lag_unknown'
  | 'last_lag_over_limit'

export type FreshStandbyVerdict =
  { accepted: true; basis: string } | { accepted: false; reason: FreshStandbyRefusal }

/** Asks the candidate's daemon for a fresh reading; `null` when it gave none. */
export type FreshStandbyProbe = (target: {
  memberId: string
  managedId: string
  serverId: string
  engine: string
}) => Promise<ManagedReplicationHealth | null>

export type FreshStandbyInput = {
  /** The probe's fresh observation; `null` when the probe gave none. */
  replication: ManagedReplicationHealth | null
  /** Control-plane ms taken before the probe was sent. */
  probeStartedAtMs: number
  /** Control-plane ms of the detector's first failed probe. */
  failureStartedAtMs: number
  marginMs: number
  maxLagBytes?: number
  maxLagSeconds?: number
}

/** `X/Y` hex `pg_lsn` text → a comparable bigint; null when malformed. */
export function parsePgLsn(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  const match = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(value.trim())
  if (!match) return null
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`)
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: FreshStandbyRefusal }

function refuse(reason: FreshStandbyRefusal): { ok: false; reason: FreshStandbyRefusal } {
  return { ok: false, reason }
}

/** (a) Seconds the last streaming read preceded the failure start. */
function checkReceipt(
  input: FreshStandbyInput,
  replication: ManagedReplicationHealth
): Check<number> {
  const ageMs = replication.lastStreaming?.ageMs
  if (!isNonNegativeFinite(ageMs)) return refuse('receipt_unknown')
  // Probe start minus age is never later than the real streaming read.
  const lastStreamingAtMs = input.probeStartedAtMs - ageMs
  if (lastStreamingAtMs < input.failureStartedAtMs - input.marginMs) {
    return refuse('receipt_stale')
  }
  return { ok: true, value: (input.failureStartedAtMs - lastStreamingAtMs) / 1000 }
}

/** (b) The received (= replayed) LSN. */
function checkReplay(replication: ManagedReplicationHealth): Check<string> {
  const received = parsePgLsn(replication.receivedLsn)
  const replayed = parsePgLsn(replication.replayLsn)
  if (received === null || replayed === null) return refuse('lsn_unknown')
  if (received !== replayed) return refuse('replay_behind')
  return { ok: true, value: String(replication.receivedLsn) }
}

/**
 * (c) The last streaming read's received-vs-primary byte lag (the standby's
 * own `latest_end_lsn - flushed_lsn`, sampled every 2 s by the daemon).
 * Seconds since the last replayed commit are deliberately not used here: on
 * an idle cluster they grow without bound while nothing is behind.
 */
function checkLastLag(
  input: FreshStandbyInput,
  replication: ManagedReplicationHealth
): Check<string> {
  const maxLagBytes = input.maxLagBytes ?? DEFAULT_MANAGED_PROMOTE_MAX_LAG_BYTES
  const receiveLagBytes = replication.lastStreaming?.receiveLagBytes
  if (!isNonNegativeFinite(receiveLagBytes)) return refuse('last_lag_unknown')
  if (receiveLagBytes > maxLagBytes) return refuse('last_lag_over_limit')
  return { ok: true, value: `${receiveLagBytes} B` }
}

/**
 * Decide whether the probed candidate may be promoted. A standby that is
 * still `streaming` goes through the unchanged lag gate on the fresh reading.
 */
export function evaluateFreshStandby(input: FreshStandbyInput): FreshStandbyVerdict {
  const replication = input.replication
  if (!replication) return { accepted: false, reason: 'probe_unavailable' }
  if (replication.state === 'streaming') {
    const gate = evaluateManagedPromoteLagGate(replication, input.probeStartedAtMs, {
      maxLagBytes: input.maxLagBytes,
      maxLagSeconds: input.maxLagSeconds,
    })
    return gate === null
      ? { accepted: true, basis: 'streaming at event time' }
      : { accepted: false, reason: 'lagging' }
  }
  if (!DISCONNECTED_STANDBY_STATES.has(replication.state)) {
    return { accepted: false, reason: 'not_a_standby' }
  }
  const receipt = checkReceipt(input, replication)
  if (!receipt.ok) return { accepted: false, reason: receipt.reason }
  const replay = checkReplay(replication)
  if (!replay.ok) return { accepted: false, reason: replay.reason }
  const lag = checkLastLag(input, replication)
  if (!lag.ok) return { accepted: false, reason: lag.reason }
  return {
    accepted: true,
    basis:
      `${replication.state}; last streaming ${receipt.value.toFixed(1)} s before failure ` +
      `start (margin ${input.marginMs / 1000} s); received = replayed = ${replay.value}; ` +
      `last receive lag ${lag.value}`,
  }
}

/**
 * Control-plane ms of the detector's first failed probe: event receipt
 * minus the detector's own (monotonic) failure span. `null` when the
 * evidence carries no usable span, which keeps the gate closed.
 */
export function failureStartedAtMs(
  evidence: Record<string, unknown> | undefined,
  receivedAtMs: number
): number | null {
  const spanMs = evidence?.spanMs
  if (!isNonNegativeFinite(spanMs) || spanMs > MAX_FAILURE_SPAN_MS) return null
  return receivedAtMs - spanMs
}

/**
 * Among accepted standbys, the one that received the most WAL (highest
 * `receivedLsn`); ties, and standbys with no parseable LSN, fall back to the
 * lowest ordinal, then id. `null` for an empty list.
 */
export function pickMostAdvancedStandby<
  T extends { id: string; ordinal: number; receivedLsn?: string | undefined },
>(accepted: readonly T[]): T | null {
  let best: T | null = null
  let bestLsn = -1n
  for (const entry of accepted) {
    const lsn = parsePgLsn(entry.receivedLsn) ?? -1n
    if (best === null || lsn > bestLsn || (lsn === bestLsn && precedes(entry, best))) {
      best = entry
      bestLsn = lsn
    }
  }
  return best
}

function precedes(a: { id: string; ordinal: number }, b: { id: string; ordinal: number }) {
  return a.ordinal < b.ordinal || (a.ordinal === b.ordinal && a.id.localeCompare(b.id) < 0)
}
