/**
 * Checked vocabularies for `upgrade` / `upgradestep`.
 *
 * The `CHECK` lists in `src/db/schema.ts` are pinned to these arrays by
 * `src/db/enum-checks.test.ts`. Add a member in both places.
 */

export const UPGRADE_SOURCES = ["manual", "auto", "server"] as const;

export type UpgradeSource = (typeof UPGRADE_SOURCES)[number];

export const UPGRADE_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "partially_failed",
  "failed",
  "cancelled",
] as const;

export type UpgradeStatus = (typeof UPGRADE_STATUSES)[number];

/** Statuses that count as the single in-flight run (`uniq_upgrade_active`). */
export const UPGRADE_ACTIVE_STATUSES = ["pending", "running"] as const;

/** Terminal runs are the only ones `pruneUpgradeHistory` may delete. */
export const UPGRADE_TERMINAL_STATUSES = [
  "succeeded",
  "partially_failed",
  "failed",
  "cancelled",
] as const;

export const UPGRADE_PHASES = [
  "colocated_daemon",
  "control_plane",
  "fleet",
] as const;

export type UpgradePhase = (typeof UPGRADE_PHASES)[number];

export const UPGRADE_STEP_UNITS = ["daemon", "instance"] as const;

export type UpgradeStepUnit = (typeof UPGRADE_STEP_UNITS)[number];

export const UPGRADE_STEP_STATUSES = [
  "pending",
  "waiting",
  "dispatched",
  "preparing",
  "downloading",
  "installing",
  "restarting",
  "verifying",
  "done",
  "failed",
  "rolled_back",
  "needs_attention",
  "skipped",
] as const;

export type UpgradeStepStatus = (typeof UPGRADE_STEP_STATUSES)[number];

/**
 * Non-terminal step statuses. `idx_upgradestep_active_next_attempt` is
 * partial on this list so the retry scan stays small.
 */
export const UPGRADE_STEP_ACTIVE_STATUSES = [
  "pending",
  "waiting",
  "dispatched",
  "preparing",
  "downloading",
  "installing",
  "restarting",
  "verifying",
] as const;

/** Successful steps, pruned after the short retention window. */
export const UPGRADE_STEP_DONE_STATUSES = ["done", "skipped"] as const;

/** Failed steps, kept longer than {@link UPGRADE_STEP_DONE_STATUSES}. */
export const UPGRADE_STEP_FAILURE_STATUSES = [
  "failed",
  "rolled_back",
  "needs_attention",
] as const;
