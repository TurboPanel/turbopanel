/**
 * Is the switchover target proven caught up with the old primary?
 *
 * The planned-switchover re-seed wipes the former primary's data, so it may
 * only run when nothing on that node can be missing from the new primary. Only
 * a fresh, fully caught-up Postgres reading counts as that evidence: a clean
 * Postgres shutdown ships the remaining log to a connected standby, and the
 * reading shows no receive or replay lag. MySQL and MariaDB are not proven
 * here: the promote waits for the old primary's final GTID set
 * (`switchover-catchup.ts`), but nothing in the result confirms the new
 * primary's daemon honoured that wait, so their old primary stays
 * `needs_resync` for an operator until the daemon says it did.
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
    return {
      caughtUp: false,
      basis: 'not a Postgres reading (MySQL and MariaDB have no confirmed final position)',
    }
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

const LSN_PATTERN = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/

function parseLsn(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  const match = LSN_PATTERN.exec(value)
  if (!match) return null
  return (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`)
}

/**
 * Is the new primary at or past the old primary's FINAL write position, both
 * taken after the old primary was stopped? The reading at switchover start is
 * taken before the drain and the stop, so it can never prove this. The old
 * position is where the cleanly stopped primary's WAL ends, the new one is
 * what the promoted standby had replayed, and the new primary must have
 * promoted onto the timeline right after the old primary's. Missing or
 * unreadable positions or timelines, a new primary behind the old one, or any
 * other timeline are not proof.
 */
export function evaluateFinalPosition(positions: {
  oldPrimaryFinalLsn?: string
  oldPrimaryFinalTimeline?: number
  newPrimaryReplayLsn?: string
  newPrimaryTimeline?: number
}): SwitchoverCatchUp {
  const oldLsn = parseLsn(positions.oldPrimaryFinalLsn)
  const newLsn = parseLsn(positions.newPrimaryReplayLsn)
  const oldTimeline = positions.oldPrimaryFinalTimeline
  const newTimeline = positions.newPrimaryTimeline
  if (
    oldLsn === null ||
    newLsn === null ||
    oldTimeline === undefined ||
    newTimeline === undefined
  ) {
    return { caughtUp: false, basis: 'final position not proven' }
  }
  if (newTimeline !== oldTimeline + 1) {
    return { caughtUp: false, basis: 'final position not proven: timeline does not follow' }
  }
  if (newLsn < oldLsn) {
    return { caughtUp: false, basis: 'final position not proven: new primary is behind' }
  }
  return { caughtUp: true, basis: 'new primary replayed the old primary final position' }
}
