/**
 * Pure upgrade planner: from the fleet shape and the batch policy, decide the
 * phases and the batched step list of one run. No DB, no clock, no random.
 *
 * Order (self-hosted / Deno):
 *   colocated_daemon → control_plane → fleet
 * The co-located daemon updates first, then the control plane on that same
 * host, then every other server's daemon in batches. Trunk self-hosted skips
 * `control_plane` (there is no control-plane package on trunk).
 *
 * Workers: `fleet` only. The control plane is deploy-managed and read-only, so
 * there is no colocated_daemon / control_plane phase — every managed daemon is
 * a fleet step.
 *
 * Single-server runs (manual per-server) are one fleet step for one server.
 *
 * The fleet phase is hard-gated by `isFleetGateSatisfied` (`./run.ts`); the
 * planner lays out every phase, but the orchestrator only dispatches fleet
 * steps once the gate opens.
 */
import type { UpgradePhase, UpgradeStepUnit } from "./vocabulary.ts";
import type { UpgradeBatchMode } from "../settings/upgrade-settings.ts";
import { isOnTarget, type UpgradeTarget } from "./target.ts";

export type UpgradeRuntime = "deno" | "workers";

export type BatchPolicy = { mode: UpgradeBatchMode; value: number };

export type PlannedStep = {
  serverId: string;
  unit: UpgradeStepUnit;
  phase: UpgradePhase;
  batchIndex: number;
};

export type PlannedPhase = {
  phase: UpgradePhase;
  steps: PlannedStep[];
};

export type UpgradePlan = {
  phases: PlannedPhase[];
  steps: PlannedStep[];
};

export type PlanInput = {
  runtime: UpgradeRuntime;
  /** False for trunk self-hosted (no control-plane package to install). */
  channelHasInstancePackage: boolean;
  /** The co-located control-plane host, or null when none is enrolled. */
  colocatedServerId: string | null;
  /** Every managed server that is not the co-located control-plane host. */
  fleetServerIds: readonly string[];
  batch: BatchPolicy;
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * How many fleet steps ride in one batch. `percent` rounds up so a non-zero
 * fleet always advances; `count` is a literal wave size. Both clamp to
 * `[1, stepCount]`; an empty fleet is 0.
 */
export function computeBatchSize(
  policy: BatchPolicy,
  stepCount: number,
): number {
  if (stepCount <= 0) return 0;
  if (policy.mode === "count") {
    return clamp(Math.trunc(policy.value), 1, stepCount);
  }
  const size = Math.ceil((stepCount * policy.value) / 100);
  return clamp(size, 1, stepCount);
}

/** Zero-based batch index for the i-th fleet step given a wave `size`. */
export function batchIndexFor(index: number, size: number): number {
  if (size <= 0) return 0;
  return Math.floor(index / size);
}

function dedupeInOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function planFleetSteps(
  fleetServerIds: readonly string[],
  batch: BatchPolicy,
): PlannedStep[] {
  const size = computeBatchSize(batch, fleetServerIds.length);
  return fleetServerIds.map((serverId, index) => ({
    serverId,
    unit: "daemon",
    phase: "fleet",
    batchIndex: batchIndexFor(index, size),
  }));
}

function assemble(phases: PlannedPhase[]): UpgradePlan {
  const nonEmpty = phases.filter((phase) => phase.steps.length > 0);
  return {
    phases: nonEmpty,
    steps: nonEmpty.flatMap((phase) => phase.steps),
  };
}

/** One fleet step for exactly one server (manual per-server run). */
export function planSingleServer(serverId: string): UpgradePlan {
  return assemble([
    {
      phase: "fleet",
      steps: [{ serverId, unit: "daemon", phase: "fleet", batchIndex: 0 }],
    },
  ]);
}

/** Units a run will install. Workers and an empty fleet do not need instance or UI. */
export function unitsForPlannedRun(input: {
  runtime: UpgradeRuntime;
  channelHasInstancePackage: boolean;
  hasColocated: boolean;
  fleetCount: number;
}): ("daemon" | "instance" | "ui")[] {
  const units: ("daemon" | "instance" | "ui")[] = [];
  if (input.runtime === "deno" && input.hasColocated) {
    units.push("daemon");
    if (input.channelHasInstancePackage) units.push("instance", "ui");
  }
  if (
    (input.runtime === "workers" || input.fleetCount > 0) &&
    !units.includes("daemon")
  ) {
    units.push("daemon");
  }
  return units;
}

/**
 * An already-current unit stays in the plan as satisfied. The tick does not
 * dispatch it. Instance and UI share the control-plane step, so that step
 * stays open until the instance commit matches.
 */
export function stepSatisfiedByInstalled(
  step: PlannedStep,
  installed: { daemonCommit: string | null; instanceCommit: string | null },
  target: UpgradeTarget,
): boolean {
  if (step.unit === "instance") {
    return isOnTarget(
      { version: null, commit: installed.instanceCommit },
      target.instance,
    );
  }
  return isOnTarget(
    { version: null, commit: installed.daemonCommit },
    target.daemon,
  );
}

/** Lay out the phases and batched steps of a full run. */
export function planUpgrade(input: PlanInput): UpgradePlan {
  const phases: PlannedPhase[] = [];
  const colocated = input.colocatedServerId;

  if (input.runtime === "deno" && colocated) {
    phases.push({
      phase: "colocated_daemon",
      steps: [
        {
          serverId: colocated,
          unit: "daemon",
          phase: "colocated_daemon",
          batchIndex: 0,
        },
      ],
    });
    if (input.channelHasInstancePackage) {
      phases.push({
        phase: "control_plane",
        steps: [
          {
            serverId: colocated,
            unit: "instance",
            phase: "control_plane",
            batchIndex: 0,
          },
        ],
      });
    }
  }

  const fleet = dedupeInOrder(input.fleetServerIds).filter((id) =>
    id !== colocated
  );
  phases.push({ phase: "fleet", steps: planFleetSteps(fleet, input.batch) });

  return assemble(phases);
}
