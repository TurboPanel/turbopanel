/**
 * Bounded fencing. A recovery row sits in `fencing` until every fence step
 * (a drain on each connected member server, then the stop of the old primary)
 * has answered. A step that never answers used to hold the row, and with it
 * every database action on the cluster (`managed_busy`), for as long as the
 * command's own budget or the stale sweep allowed, which was 10 to 15 minutes.
 * The deadline below caps that wait. Pure decision only; the sweep that acts on
 * it is `sweepStalledFencing` in `ha-recovery.ts`.
 *
 * The rule never weakens fencing: nothing is promoted on a deadline unless the
 * stop of the old primary was confirmed. A drain that did not answer is given
 * up on (the stop is the fence; a drain only moves traffic), a stop that did
 * not answer ends the recovery without a role change.
 */

import type { RecoveryRecord } from './recovery.ts'

/**
 * How long a row may stay in `fencing`. Longer than the consumer's own wait for
 * a lifecycle stop (2 minutes), so a slow but working stop is never cut off.
 */
export const FENCE_DEADLINE_MS = 150_000

export const FENCE_TIMED_OUT_MESSAGE =
  'Planned switchover stopped: the current primary did not finish stopping in time, so nothing was promoted. Check the database page, then run the switchover again.'

export type StalledFencePlan =
  | { action: 'wait' }
  /** The stop was confirmed: give up on the drains that are still pending. */
  | { action: 'abandon-drains' }
  /** The stop is not confirmed: end the recovery, promote nothing. */
  | { action: 'abort'; stopDelivered: boolean }

/** When the fence began: its recorded epoch, else the row's own start. */
export function fencingStartedAtMs(record: RecoveryRecord): number {
  const epoch = Date.parse(record.metadata.fencingEpoch ?? '')
  if (Number.isFinite(epoch)) return epoch
  return Date.parse(record.startedAt)
}

export function planStalledFence(
  record: RecoveryRecord,
  nowMs: number,
  stopDelivered: boolean
): StalledFencePlan {
  if (record.state !== 'fencing') return { action: 'wait' }
  if ((record.metadata.fenceCommandIds?.length ?? 0) === 0) return { action: 'wait' }
  const startedAt = fencingStartedAtMs(record)
  if (!Number.isFinite(startedAt) || nowMs - startedAt < FENCE_DEADLINE_MS) {
    return { action: 'wait' }
  }
  if (record.metadata.stopApplied) return { action: 'abandon-drains' }
  return { action: 'abort', stopDelivered }
}
