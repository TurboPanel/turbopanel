/**
 * Pure run-level logic: batch gating, the fleet hard-gate, control-plane
 * failure detection, the terminal run status, and the Workers per-tick
 * dispatch cap. All host-free — the orchestrator supplies the rows.
 */
import type {
  UpgradePhase,
  UpgradeRunErrorCode,
  UpgradeStatus,
  UpgradeStepStatus,
} from "./vocabulary.ts";
import type { UpgradeRuntime } from "./planner.ts";

/**
 * Workers caps enqueues per tick below the subrequest ceiling it shares with
 * the offline sweep, so a 100% batch drains over several ticks instead of one
 * over-budget invocation. Deno has no such ceiling.
 */
export const WORKERS_DISPATCH_BUDGET = 50;

/**
 * Active step rows a maintenance tick may read. The cursor is durable, so
 * the rest of a large batch is the next tick's page. Same ceiling as the
 * Workers dispatch budget: one tick must not materialize the fleet.
 */
export const UPGRADE_TICK_STEP_BUDGET = WORKERS_DISPATCH_BUDGET;

/**
 * Cell probes on a fleet tick. One extra slot is the co-located host; the
 * rest match the Workers dispatch budget so a page of the fleet never wakes
 * every Durable Object.
 */
export const FLEET_CELL_PROBE_BUDGET = WORKERS_DISPATCH_BUDGET + 1;

const PHASE_RANK: Record<UpgradePhase, number> = {
  colocated_daemon: 0,
  control_plane: 1,
  fleet: 2,
};

/** Planned order: co-located daemon, then the control plane, then the fleet. */
export function upgradePhaseRank(phase: UpgradePhase): number {
  return PHASE_RANK[phase];
}

/** Stable step order: phase rank, then batch, then step id. */
export function compareUpgradeStepRows(
  a: { phase: UpgradePhase; batchIndex: number; id: string },
  b: { phase: UpgradePhase; batchIndex: number; id: string },
): number {
  const phase = upgradePhaseRank(a.phase) - upgradePhaseRank(b.phase);
  if (phase !== 0) return phase;
  if (a.batchIndex !== b.batchIndex) return a.batchIndex - b.batchIndex;
  return a.id.localeCompare(b.id);
}

/**
 * The phase the tick should work on. Rank wins over row order, so a fleet
 * step that Postgres returned first cannot open before the co-located daemon.
 */
export function earliestOpenPhase(
  steps: readonly { phase: UpgradePhase; status: UpgradeStepStatus }[],
): UpgradePhase | null {
  let best: UpgradePhase | null = null;
  let rank = Number.POSITIVE_INFINITY;
  for (const step of steps) {
    if (isTerminalStepStatus(step.status)) continue;
    const next = upgradePhaseRank(step.phase);
    if (next < rank) {
      best = step.phase;
      rank = next;
    }
  }
  return best;
}

/**
 * Server ids whose cells may be probed this tick: the co-located host, then
 * dispatch candidates, capped at {@link FLEET_CELL_PROBE_BUDGET}.
 */
export function fleetCellProbeIds(
  colocatedServerId: string | null,
  candidateIds: readonly string[],
  budget: number = FLEET_CELL_PROBE_BUDGET,
): string[] {
  const ids: string[] = [];
  const cap = Math.max(0, budget);
  if (colocatedServerId && cap > 0) ids.push(colocatedServerId);
  for (const id of candidateIds) {
    if (ids.length >= cap) break;
    if (id.length === 0 || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** A step the tick will not touch again (excludes `rolled_back`, still retrying). */
export function isTerminalStepStatus(status: UpgradeStepStatus): boolean {
  return (
    status === "done" ||
    status === "skipped" ||
    status === "failed" ||
    status === "needs_attention"
  );
}

export type BatchStepView = {
  batchIndex: number;
  status: UpgradeStepStatus;
};

/**
 * The batch the tick should be dispatching: the lowest index that still has a
 * non-terminal step. `null` when every step is terminal. The next batch only
 * opens once every step in the current one is terminal — failed / needs_attention
 * steps count as terminal, so a failure never blocks the following batch.
 */
export function activeBatchIndex(
  steps: readonly BatchStepView[],
): number | null {
  let active: number | null = null;
  for (const step of steps) {
    if (isTerminalStepStatus(step.status)) continue;
    if (active === null || step.batchIndex < active) active = step.batchIndex;
  }
  return active;
}

/** True once every step in `batchIndex` is terminal (and the batch exists). */
export function batchComplete(
  steps: readonly BatchStepView[],
  batchIndex: number,
): boolean {
  const inBatch = steps.filter((step) => step.batchIndex === batchIndex);
  return inBatch.length > 0 &&
    inBatch.every((step) => isTerminalStepStatus(step.status));
}

export type StepSummary = {
  total: number;
  done: number;
  skipped: number;
  failed: number;
  needsAttention: number;
  inProgress: number;
};

/** Terminal-status totals — the shape written to `upgrade.counts`. */
export function summarizeSteps(
  steps: readonly { status: UpgradeStepStatus }[],
): StepSummary {
  const summary: StepSummary = {
    total: steps.length,
    done: 0,
    skipped: 0,
    failed: 0,
    needsAttention: 0,
    inProgress: 0,
  };
  for (const step of steps) {
    if (step.status === "done") summary.done += 1;
    else if (step.status === "skipped") summary.skipped += 1;
    else if (step.status === "failed") summary.failed += 1;
    else if (step.status === "needs_attention") summary.needsAttention += 1;
    else summary.inProgress += 1;
  }
  return summary;
}

/**
 * The terminal status for a run whose steps are all terminal.
 *   - every step done/skipped → `succeeded`
 *   - no step done/skipped → `failed`
 *   - otherwise → `partially_failed`
 */
export function finalRunStatusFromSummary(summary: StepSummary): UpgradeStatus {
  const ok = summary.done + summary.skipped;
  const bad = summary.failed + summary.needsAttention;
  if (bad === 0) return "succeeded";
  if (ok === 0) return "failed";
  return "partially_failed";
}

export function finalRunStatus(
  steps: readonly { status: UpgradeStepStatus }[],
): UpgradeStatus {
  return finalRunStatusFromSummary(summarizeSteps(steps));
}

export type PhaseStepView = {
  phase: UpgradePhase;
  status: UpgradeStepStatus;
};

/** The phases the fleet gate waits on. Neither may end the run still open. */
export const PLATFORM_PHASES = ["colocated_daemon", "control_plane"] as const;

export type PlatformPhase = (typeof PLATFORM_PHASES)[number];

/**
 * The first platform phase with a step that failed (or needs attention), or
 * `null`. Either one fails the whole run: the fleet gate needs both on target,
 * so a fleet phase behind a failed co-located daemon or control plane could
 * never open, and the single instance-wide run would stay `running` forever.
 */
export function failedPlatformPhase(
  steps: readonly PhaseStepView[],
): PlatformPhase | null {
  for (const phase of PLATFORM_PHASES) {
    const failed = steps.some(
      (step) =>
        step.phase === phase &&
        (step.status === "failed" || step.status === "needs_attention"),
    );
    if (failed) return phase;
  }
  return null;
}

/** `upgrade.error` for a run ended by {@link failedPlatformPhase}. */
export function platformFailureError(phase: PlatformPhase): UpgradeRunErrorCode {
  return `${phase}_failed`;
}

export type FleetGateInput = {
  /** Developer surface / dev update overlay / source-run control plane. */
  development: boolean;
  runtime: UpgradeRuntime;
  /** False for trunk self-hosted (no control-plane package). */
  channelHasInstancePackage: boolean;
  colocatedDaemonOnTarget: boolean;
  controlPlaneOnTarget: boolean;
};

/**
 * The fleet hard-gate. Self-hosted requires the co-located daemon on target,
 * and (unless the channel has no control-plane package) the control plane on
 * target too. Workers is fleet-only — the control plane is deploy-managed, so
 * the gate is not applicable and always open. Development treats it satisfied.
 */
export function isFleetGateSatisfied(input: FleetGateInput): boolean {
  if (input.development) return true;
  if (input.runtime === "workers") return true;
  if (!input.colocatedDaemonOnTarget) return false;
  if (input.channelHasInstancePackage && !input.controlPlaneOnTarget) {
    return false;
  }
  return true;
}

/**
 * Cap a Workers dispatch list to the per-tick budget. Deno passes the whole
 * list (no ceiling). The remainder is picked up on later ticks.
 */
export function capWorkersDispatch<T>(
  runtime: UpgradeRuntime,
  items: readonly T[],
  budget: number = WORKERS_DISPATCH_BUDGET,
): T[] {
  if (runtime !== "workers") return [...items];
  return items.slice(0, Math.max(0, budget));
}
