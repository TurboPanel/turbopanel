/**
 * Waits measured against the sweep slots (`jobs/registry.ts` runs the tunnel
 * sweeps every five minutes). Pure, so both runtimes use the same check.
 */

/** Slack a per-sweep wait gets, so jitter of a few seconds does not push a run a whole slot later. */
export const SLOT_TOLERANCE_MS = 60_000

/** The shortest gap that is measured in whole slots. */
const SLOT_MS = 5 * 60_000

/**
 * Is a wait of `gapMs` still running after `ageMs`? A gap of a slot or more is
 * cut by {@link SLOT_TOLERANCE_MS}: a ten minute gap measured from the last
 * run's wall clock is only about 9:45 old at the slot ten minutes on, and
 * without the slack it would skip to the slot after (15 minutes). Shorter gaps
 * are exact.
 */
export function gapStillRunning(ageMs: number, gapMs: number): boolean {
  return ageMs < (gapMs >= SLOT_MS ? gapMs - SLOT_TOLERANCE_MS : gapMs)
}
