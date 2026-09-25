import { assertEquals } from "@std/assert";
import {
  computeBackoffMs,
  isInFlightStepStatus,
  isSettledStepStatus,
  planStepAction,
  type StepConfig,
  type StepFacts,
  type StepView,
  UPGRADE_BACKOFF_BASE_MS,
  UPGRADE_BACKOFF_MAX_MS,
} from "./transitions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW = "2026-01-01T12:00:00.000Z";

function step(overrides: Partial<StepView> = {}): StepView {
  return {
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    lastStageAt: null,
    toCommit: "target-sha",
    ...overrides,
  };
}

function facts(overrides: Partial<StepFacts> = {}): StepFacts {
  return { serverConnected: true, currentCommit: null, ...overrides };
}

const cfg: StepConfig = { now: NOW };

test("settled steps are left alone", () => {
  for (
    const status of ["done", "skipped", "failed", "needs_attention"] as const
  ) {
    assertEquals(planStepAction(step({ status }), facts(), cfg).kind, "none");
  }
});

test("a matching current commit marks the step done", () => {
  const action = planStepAction(
    step({ status: "installing" }),
    facts({ currentCommit: "target-sha" }),
    cfg,
  );
  assertEquals(action.kind, "done");
});

test("pending + connected + no backoff → dispatch", () => {
  assertEquals(planStepAction(step(), facts(), cfg).kind, "dispatch");
});

test("pending + offline → waiting (self-heal on reconnect)", () => {
  assertEquals(
    planStepAction(step(), facts({ serverConnected: false }), cfg).kind,
    "wait_offline",
  );
});

test("pending with a future backoff waits without dispatching", () => {
  const future = new Date(Date.parse(NOW) + 60_000).toISOString();
  assertEquals(
    planStepAction(
      step({ status: "waiting", nextAttemptAt: future }),
      facts(),
      cfg,
    ).kind,
    "none",
  );
  const past = new Date(Date.parse(NOW) - 60_000).toISOString();
  assertEquals(
    planStepAction(
      step({ status: "waiting", nextAttemptAt: past }),
      facts(),
      cfg,
    ).kind,
    "dispatch",
  );
});

test("in-flight and offline → waiting so it re-dispatches on reconnect", () => {
  assertEquals(
    planStepAction(
      step({ status: "downloading" }),
      facts({ serverConnected: false }),
      cfg,
    ).kind,
    "wait_offline",
  );
});

test("in-flight and not stalled → none", () => {
  const recent = new Date(Date.parse(NOW) - 60_000).toISOString();
  assertEquals(
    planStepAction(
      step({ status: "installing", lastStageAt: recent }),
      facts(),
      cfg,
    ).kind,
    "none",
  );
});

test("stalled install retries with backoff until attempts are exhausted", () => {
  const stale = new Date(Date.parse(NOW) - 30 * 60 * 1000).toISOString();
  const retry = planStepAction(
    step({ status: "installing", lastStageAt: stale, attempts: 1 }),
    facts(),
    cfg,
  );
  assertEquals(retry.kind, "retry");
  if (retry.kind !== "retry") throw new TypeError("expected a retry action");
  assertEquals(
    retry.nextAttemptAt,
    new Date(Date.parse(NOW) + UPGRADE_BACKOFF_BASE_MS).toISOString(),
  );

  const exhausted = planStepAction(
    step({ status: "installing", lastStageAt: stale, attempts: 3 }),
    facts(),
    cfg,
  );
  assertEquals(exhausted.kind, "needs_attention");
  if (exhausted.kind !== "needs_attention") {
    throw new TypeError("expected needs_attention");
  }
  assertEquals(exhausted.errorCode, "step_timeout");
});

test("rolled_back retries once then needs attention", () => {
  assertEquals(
    planStepAction(step({ status: "rolled_back", attempts: 1 }), facts(), cfg)
      .kind,
    "dispatch",
  );
  const attention = planStepAction(
    step({ status: "rolled_back", attempts: 2 }),
    facts(),
    cfg,
  );
  assertEquals(attention.kind, "needs_attention");
  if (attention.kind !== "needs_attention") {
    throw new TypeError("expected needs_attention");
  }
  assertEquals(attention.errorCode, "rolled_back");
});

test("rolled_back while offline waits instead of dispatching", () => {
  assertEquals(
    planStepAction(
      step({ status: "rolled_back", attempts: 1 }),
      facts({ serverConnected: false }),
      cfg,
    ).kind,
    "wait_offline",
  );
});

const HOUR_MS = 60 * 60 * 1000;

function hoursBefore(iso: string, hours: number): string {
  return new Date(Date.parse(iso) - hours * HOUR_MS).toISOString();
}

test("a step still offline past the offline deadline needs attention", () => {
  const action = planStepAction(
    step({ status: "waiting", lastStageAt: hoursBefore(NOW, 2) }),
    facts({ serverConnected: false }),
    cfg,
  );
  assertEquals(action, { kind: "needs_attention", errorCode: "server_offline" });
});

test("a waiting step inside the offline deadline keeps waiting", () => {
  const action = planStepAction(
    step({
      status: "waiting",
      lastStageAt: new Date(Date.parse(NOW) - 10 * 60 * 1000).toISOString(),
    }),
    facts({ serverConnected: false }),
    cfg,
  );
  assertEquals(action.kind, "wait_offline");
});

test("a later-batch step that first finds its server offline waits, whatever its row age", () => {
  const action = planStepAction(
    step({ status: "pending", lastStageAt: hoursBefore(NOW, 48) }),
    facts({ serverConnected: false }),
    cfg,
  );
  assertEquals(action.kind, "wait_offline");
});

test("the offline deadline is configurable", () => {
  const action = planStepAction(
    step({
      status: "waiting",
      lastStageAt: new Date(Date.parse(NOW) - 5 * 60 * 1000).toISOString(),
    }),
    facts({ serverConnected: false }),
    { now: NOW, offlineDeadlineMs: 60 * 1000 },
  );
  assertEquals(action, { kind: "needs_attention", errorCode: "server_offline" });
});

test("a server back online before the deadline is dispatched", () => {
  const action = planStepAction(
    step({ status: "waiting", lastStageAt: hoursBefore(NOW, 2) }),
    facts({ serverConnected: true }),
    cfg,
  );
  assertEquals(action.kind, "dispatch");
});

test("computeBackoffMs doubles per attempt and caps", () => {
  assertEquals(computeBackoffMs(1), UPGRADE_BACKOFF_BASE_MS);
  assertEquals(computeBackoffMs(2), UPGRADE_BACKOFF_BASE_MS * 2);
  assertEquals(computeBackoffMs(3), UPGRADE_BACKOFF_BASE_MS * 4);
  assertEquals(computeBackoffMs(99), UPGRADE_BACKOFF_MAX_MS);
});

test("status classifiers", () => {
  assertEquals(isSettledStepStatus("done"), true);
  assertEquals(isSettledStepStatus("rolled_back"), false);
  assertEquals(isInFlightStepStatus("downloading"), true);
  assertEquals(isInFlightStepStatus("pending"), false);
});
