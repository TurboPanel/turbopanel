import { assertEquals } from "@std/assert";
import {
  activeBatchIndex,
  batchComplete,
  capWorkersDispatch,
  controlPlaneStepFailed,
  finalRunStatus,
  isFleetGateSatisfied,
  isTerminalStepStatus,
  summarizeSteps,
  WORKERS_DISPATCH_BUDGET,
} from "./run.ts";
import type { UpgradeStepStatus } from "./vocabulary.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function batch(pairs: Array<[number, UpgradeStepStatus]>) {
  return pairs.map(([batchIndex, status]) => ({ batchIndex, status }));
}

test("rolled_back is not terminal; failure statuses are", () => {
  assertEquals(isTerminalStepStatus("done"), true);
  assertEquals(isTerminalStepStatus("failed"), true);
  assertEquals(isTerminalStepStatus("needs_attention"), true);
  assertEquals(isTerminalStepStatus("rolled_back"), false);
  assertEquals(isTerminalStepStatus("downloading"), false);
});

test("activeBatchIndex is the lowest incomplete batch", () => {
  assertEquals(
    activeBatchIndex(batch([[0, "done"], [1, "installing"], [1, "pending"]])),
    1,
  );
  // A failure in batch 0 does not block batch 1 — it is terminal.
  assertEquals(
    activeBatchIndex(batch([[0, "failed"], [1, "pending"]])),
    1,
  );
  assertEquals(activeBatchIndex(batch([[0, "done"], [1, "skipped"]])), null);
});

test("batchComplete requires every step in the batch terminal", () => {
  const steps = batch([[0, "done"], [0, "failed"], [1, "pending"]]);
  assertEquals(batchComplete(steps, 0), true);
  assertEquals(batchComplete(steps, 1), false);
  assertEquals(batchComplete(steps, 9), false);
});

test("summarizeSteps and finalRunStatus classify outcomes", () => {
  assertEquals(
    finalRunStatus(batch([[0, "done"], [0, "skipped"]])),
    "succeeded",
  );
  assertEquals(
    finalRunStatus(batch([[0, "failed"], [0, "needs_attention"]])),
    "failed",
  );
  assertEquals(
    finalRunStatus(batch([[0, "done"], [0, "failed"]])),
    "partially_failed",
  );
  const summary = summarizeSteps(
    batch([[0, "done"], [0, "failed"], [0, "installing"]]),
  );
  assertEquals(summary, {
    total: 3,
    done: 1,
    skipped: 0,
    failed: 1,
    needsAttention: 0,
    inProgress: 1,
  });
});

test("a failed control-plane step is detected (fails the run, holds the gate)", () => {
  assertEquals(
    controlPlaneStepFailed([{ phase: "control_plane", status: "failed" }]),
    true,
  );
  assertEquals(
    controlPlaneStepFailed([{
      phase: "control_plane",
      status: "needs_attention",
    }]),
    true,
  );
  assertEquals(
    controlPlaneStepFailed([{ phase: "fleet", status: "failed" }]),
    false,
  );
});

test("fleet gate: self-hosted needs both units on target", () => {
  const base = {
    development: false,
    runtime: "deno" as const,
    channelHasInstancePackage: true,
    colocatedDaemonOnTarget: false,
    controlPlaneOnTarget: false,
  };
  assertEquals(isFleetGateSatisfied(base), false);
  assertEquals(
    isFleetGateSatisfied({ ...base, colocatedDaemonOnTarget: true }),
    false,
  );
  assertEquals(
    isFleetGateSatisfied({
      ...base,
      colocatedDaemonOnTarget: true,
      controlPlaneOnTarget: true,
    }),
    true,
  );
});

test("fleet gate: trunk needs only the co-located daemon on target", () => {
  assertEquals(
    isFleetGateSatisfied({
      development: false,
      runtime: "deno",
      channelHasInstancePackage: false,
      colocatedDaemonOnTarget: true,
      controlPlaneOnTarget: false,
    }),
    true,
  );
});

test("fleet gate: workers and development are always open", () => {
  const shut = {
    development: false,
    runtime: "workers" as const,
    channelHasInstancePackage: true,
    colocatedDaemonOnTarget: false,
    controlPlaneOnTarget: false,
  };
  assertEquals(isFleetGateSatisfied(shut), true);
  assertEquals(
    isFleetGateSatisfied({ ...shut, runtime: "deno", development: true }),
    true,
  );
});

test("capWorkersDispatch limits Workers ticks but never Deno", () => {
  const items = Array.from(
    { length: WORKERS_DISPATCH_BUDGET + 10 },
    (_, i) => i,
  );
  assertEquals(
    capWorkersDispatch("workers", items).length,
    WORKERS_DISPATCH_BUDGET,
  );
  assertEquals(capWorkersDispatch("deno", items).length, items.length);
  assertEquals(capWorkersDispatch("workers", items, 3), [0, 1, 2]);
});
