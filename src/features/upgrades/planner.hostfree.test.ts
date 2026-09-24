import { assertEquals } from "@std/assert";
import {
  batchIndexFor,
  computeBatchSize,
  type PlanInput,
  planSingleServer,
  planUpgrade,
} from "./planner.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    runtime: "deno",
    channelHasInstancePackage: true,
    colocatedServerId: "cp",
    fleetServerIds: ["a", "b", "c"],
    batch: { mode: "percent", value: 100 },
    ...overrides,
  };
}

test("computeBatchSize: percent rounds up, count is literal, both clamp", () => {
  assertEquals(computeBatchSize({ mode: "percent", value: 100 }, 3), 3);
  assertEquals(computeBatchSize({ mode: "percent", value: 50 }, 3), 2);
  assertEquals(computeBatchSize({ mode: "percent", value: 1 }, 10), 1);
  assertEquals(computeBatchSize({ mode: "count", value: 2 }, 5), 2);
  assertEquals(computeBatchSize({ mode: "count", value: 99 }, 5), 5);
  assertEquals(computeBatchSize({ mode: "percent", value: 100 }, 0), 0);
});

test("batchIndexFor groups by wave size", () => {
  assertEquals([0, 1, 2, 3].map((i) => batchIndexFor(i, 2)), [0, 0, 1, 1]);
  assertEquals(batchIndexFor(5, 0), 0);
});

test("deno full run orders colocated_daemon → control_plane → fleet", () => {
  const plan = planUpgrade(input());
  assertEquals(
    plan.phases.map((p) => p.phase),
    ["colocated_daemon", "control_plane", "fleet"],
  );
  assertEquals(plan.phases[0].steps, [
    {
      serverId: "cp",
      unit: "daemon",
      phase: "colocated_daemon",
      batchIndex: 0,
    },
  ]);
  assertEquals(plan.phases[1].steps, [
    { serverId: "cp", unit: "instance", phase: "control_plane", batchIndex: 0 },
  ]);
  assertEquals(plan.phases[2].steps.map((s) => s.serverId), ["a", "b", "c"]);
  assertEquals(plan.phases[2].steps.every((s) => s.unit === "daemon"), true);
});

test("trunk self-hosted skips the control_plane phase", () => {
  const plan = planUpgrade(input({ channelHasInstancePackage: false }));
  assertEquals(plan.phases.map((p) => p.phase), ["colocated_daemon", "fleet"]);
});

test("workers is fleet only — no colocated_daemon / control_plane phase", () => {
  const plan = planUpgrade(
    input({
      runtime: "workers",
      fleetServerIds: ["a", "b"],
      colocatedServerId: null,
    }),
  );
  assertEquals(plan.phases.map((p) => p.phase), ["fleet"]);
  assertEquals(plan.steps.map((s) => s.serverId), ["a", "b"]);
});

test("fleet batching assigns waves and drops the colocated + duplicate ids", () => {
  const plan = planUpgrade(
    input({
      fleetServerIds: ["a", "a", "b", "c", "d", "cp"],
      batch: { mode: "count", value: 2 },
    }),
  );
  const fleet = plan.phases.find((p) => p.phase === "fleet");
  if (!fleet) throw new TypeError("expected a fleet phase");
  assertEquals(fleet.steps.map((s) => s.serverId), ["a", "b", "c", "d"]);
  assertEquals(fleet.steps.map((s) => s.batchIndex), [0, 0, 1, 1]);
});

test("an empty fleet still leaves the earlier phases", () => {
  const plan = planUpgrade(input({ fleetServerIds: [] }));
  assertEquals(plan.phases.map((p) => p.phase), [
    "colocated_daemon",
    "control_plane",
  ]);
});

test("planSingleServer is one fleet daemon step", () => {
  const plan = planSingleServer("srv-1");
  assertEquals(plan.phases.map((p) => p.phase), ["fleet"]);
  assertEquals(plan.steps, [
    { serverId: "srv-1", unit: "daemon", phase: "fleet", batchIndex: 0 },
  ]);
});
