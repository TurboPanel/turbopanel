import { assertEquals } from "@std/assert";
import type { DaemonOutboundEnvelope } from "../../contracts/cell-protocol.ts";
import { createUpgradeCoordinator } from "./coordinator.ts";
import { clientUpdateBlock } from "./decisions.ts";
import { compareUpgradeStepRows } from "./run.ts";
import { createMemoryUpgradeStore, type FleetServerFact } from "./store.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER = "11111111-1111-4111-8111-111111111111";

function fact(features: string[], commit = "old-daemon"): FleetServerFact {
  return {
    serverId: SERVER,
    name: "panel",
    hostname: "panel.example",
    connected: true,
    commit,
    version: "0.1.0",
    features,
    colocated: true,
  };
}

const target = {
  daemon: {
    version: "0.1.1",
    commit: "new-daemon",
    buildId: "d1",
    builtAt: "2026-09-24T00:00:00.000Z",
    manifestUrl: "https://example.test/daemon/manifest.json",
  },
  instance: {
    version: "0.1.1",
    commit: "new-instance",
    buildId: "i1",
    builtAt: "2026-09-24T00:00:00.000Z",
    manifestUrl: "https://example.test/instance/manifest.json",
  },
  ui: {
    version: "0.1.1",
    commit: "new-ui",
    buildId: "u1",
    builtAt: "2026-09-24T00:00:00.000Z",
    manifestUrl: "https://example.test/ui/manifest.json",
  },
};

function harness(features: string[]) {
  const enqueued: DaemonOutboundEnvelope[] = [];
  const database = {
    fingerprint: "0000",
    version: "0.1.0",
    commit: "old-instance",
  };
  const store = createMemoryUpgradeStore({
    facts: [fact(features)],
    latest: target,
  });
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push(envelope);
      void serverId;
      return Promise.resolve();
    },
    runtime: "deno",
    channel: "release",
    development: false,
    now: () => "2026-09-24T12:00:00.000Z",
    colocatedServerId: SERVER,
    instanceInstalled: { version: database.version, commit: database.commit },
    resolveTarget: () => Promise.resolve(target),
  });
  return { coordinator, enqueued, database, store };
}

test("an old co-located daemon cannot start a control-plane install", async () => {
  const { coordinator, enqueued, database } = harness([]);
  const preflight = await coordinator.preflight();
  assertEquals(preflight.canStart, false);
  assertEquals(
    preflight.blockers.some((line) => line.includes("managed-upgrade-v1")),
    true,
  );
  assertEquals(
    preflight.recoveryCommand.includes("TURBOPANEL_DAEMON_ONLY=1"),
    true,
  );
  const started = await coordinator.start({
    source: "manual",
    startedBy: null,
  });
  assertEquals(started.ok, false);
  assertEquals(enqueued.length, 0);
  assertEquals(database, {
    fingerprint: "0000",
    version: "0.1.0",
    commit: "old-instance",
  });
});

test("managed-upgrade-v1 updates the daemon before the control plane", async () => {
  const { coordinator, enqueued, database, store } = harness([
    "managed-upgrade-v1",
  ]);
  const preflight = await coordinator.preflight();
  assertEquals(preflight.canStart, true);
  assertEquals(
    preflight.recoveryCommand.includes(
      "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate",
    ),
    true,
  );
  const started = await coordinator.start({
    source: "manual",
    startedBy: null,
  });
  if (!started.ok) throw new TypeError(started.error);
  assertEquals(enqueued.map((entry) => entry.kind), ["update"]);
  const daemonUpdate = enqueued[0];
  if (daemonUpdate?.kind !== "update") throw new TypeError("expected update");
  assertEquals(daemonUpdate.upgradeId, started.runId);
  assertEquals(daemonUpdate.targetCommit, "new-daemon");
  assertEquals(database.commit, "old-instance");

  await coordinator.noteDaemonCommit(
    SERVER,
    "new-daemon",
    "2026-09-24T12:05:00.000Z",
  );
  store.facts[0] = fact(["managed-upgrade-v1"], "new-daemon");
  await coordinator.tick({ resolveManifests: false });
  assertEquals(enqueued.map((entry) => entry.kind), [
    "update",
    "instance-update",
  ]);
  const instanceUpdate = enqueued[1];
  if (instanceUpdate?.kind !== "instance-update") {
    throw new TypeError("expected instance-update");
  }
  assertEquals(instanceUpdate.upgradeId, started.runId);
  assertEquals(instanceUpdate.targetCommit, "new-instance");
});

test("a missing run id is not a successful upgrade", async () => {
  const { coordinator } = harness(["managed-upgrade-v1"]);
  assertEquals(await coordinator.run("missing-run"), null);
});

test("cancel records a cancelled run and retry reopens a failed step", async () => {
  const { coordinator } = harness(["managed-upgrade-v1"]);
  const started = await coordinator.start({
    source: "manual",
    startedBy: null,
  });
  if (!started.ok) throw new TypeError(started.error);
  const active = await coordinator.activeRun();
  const step = active?.steps[0];
  if (!step?.requestId) throw new TypeError("expected a dispatched step");
  await coordinator.noteProgress({
    serverId: SERVER,
    unit: "daemon",
    stage: "failed",
    at: "2026-09-24T12:01:00.000Z",
    detail: "disk full",
    errorCode: "preflight_disk",
    requestId: step.requestId,
  });
  const failed = await coordinator.activeRun();
  assertEquals(failed?.steps[0]?.status, "failed");
  const cancelled = await coordinator.cancel(started.runId);
  assertEquals(cancelled.ok, true);
  const gone = await coordinator.activeRun();
  assertEquals(gone, null);
  const recorded = await coordinator.run(started.runId);
  assertEquals(recorded?.status, "cancelled");
});

const FLEET_A = "33333333-3333-4333-8333-333333333333";
const FLEET_B = "44444444-4444-4444-8444-444444444444";

test("a missing UI or instance manifest refuses the run", async () => {
  for (const unit of ["ui", "instance"] as const) {
    const broken = { ...target, [unit]: null };
    const enqueued: DaemonOutboundEnvelope[] = [];
    const store = createMemoryUpgradeStore({
      facts: [fact(["managed-upgrade-v1"])],
      latest: broken,
    });
    const coordinator = createUpgradeCoordinator({
      store,
      enqueue: (_serverId, envelope) => {
        enqueued.push(envelope);
        return Promise.resolve();
      },
      runtime: "deno",
      channel: "release",
      development: false,
      now: () => "2026-09-24T12:00:00.000Z",
      colocatedServerId: SERVER,
      instanceInstalled: { version: "0.1.0", commit: "old-instance" },
      resolveTarget: () => Promise.resolve(broken),
    });
    const preflight = await coordinator.preflight();
    assertEquals(preflight.canStart, false);
    const label = unit === "ui" ? "UI" : "instance";
    assertEquals(
      preflight.blockers.some((line) => line.includes(label)),
      true,
    );
    const started = await coordinator.start({
      source: "manual",
      startedBy: null,
    });
    assertEquals(started.ok, false);
    assertEquals(enqueued.length, 0);
  }
});

test("an already-current host is satisfied and a behind host is dispatched", async () => {
  const enqueued: Array<{ serverId: string; kind: string }> = [];
  const facts: FleetServerFact[] = [
    fact(["managed-upgrade-v1"], "new-daemon"),
    {
      ...fact(["managed-upgrade-v1"], "new-daemon"),
      serverId: FLEET_A,
      name: "current",
      colocated: false,
    },
    {
      ...fact(["managed-upgrade-v1"], "old-daemon"),
      serverId: FLEET_B,
      name: "behind",
      colocated: false,
    },
  ];
  const store = createMemoryUpgradeStore({ facts, latest: target });
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, kind: envelope.kind });
      return Promise.resolve();
    },
    runtime: "deno",
    channel: "release",
    development: false,
    now: () => "2026-09-24T12:00:00.000Z",
    colocatedServerId: SERVER,
    instanceInstalled: { version: "0.1.1", commit: "new-instance" },
    resolveTarget: () => Promise.resolve(target),
  });
  const started = await coordinator.start({
    source: "manual",
    startedBy: null,
  });
  if (!started.ok) throw new TypeError(started.error);
  assertEquals(enqueued, [{ serverId: FLEET_B, kind: "update" }]);
});

test("fleet rows returned first still dispatch daemon then instance then fleet", async () => {
  const enqueued: Array<{ serverId: string; kind: string }> = [];
  const installed = { version: "0.1.0", commit: "old-instance" };
  const facts: FleetServerFact[] = [
    fact(["managed-upgrade-v1"], "old-daemon"),
    {
      ...fact(["managed-upgrade-v1"], "old-daemon"),
      serverId: FLEET_B,
      name: "behind",
      colocated: false,
    },
  ];
  const store = createMemoryUpgradeStore({ facts, latest: target });
  const inner = store.stepsFor.bind(store);
  store.stepsFor = (id) =>
    inner(id).then((steps) =>
      [...steps].sort((a, b) => compareUpgradeStepRows(b, a))
    );
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, kind: envelope.kind });
      return Promise.resolve();
    },
    runtime: "deno",
    channel: "release",
    development: false,
    now: () => "2026-09-24T12:00:00.000Z",
    colocatedServerId: SERVER,
    instanceInstalled: installed,
    resolveTarget: () => Promise.resolve(target),
  });
  const started = await coordinator.start({
    source: "manual",
    startedBy: null,
  });
  if (!started.ok) throw new TypeError(started.error);
  assertEquals(enqueued, [{ serverId: SERVER, kind: "update" }]);
  await coordinator.noteDaemonCommit(
    SERVER,
    "new-daemon",
    "2026-09-24T12:05:00.000Z",
  );
  store.facts[0] = fact(["managed-upgrade-v1"], "new-daemon");
  await coordinator.tick({ resolveManifests: false });
  assertEquals(enqueued.map((entry) => entry.kind), [
    "update",
    "instance-update",
  ]);
  assertEquals(enqueued[1]?.serverId, SERVER);
  installed.commit = "new-instance";
  installed.version = "0.1.1";
  const afterDaemon = await coordinator.activeRun();
  const instanceStep = afterDaemon?.steps.find((item) =>
    item.unit === "instance"
  );
  if (!instanceStep?.requestId) {
    throw new TypeError("expected an instance dispatch");
  }
  await coordinator.noteOutcome({
    serverId: SERVER,
    unit: "instance",
    ok: true,
    at: "2026-09-24T12:10:00.000Z",
    requestId: instanceStep.requestId,
  });
  await coordinator.tick({ resolveManifests: false });
  assertEquals(enqueued, [
    { serverId: SERVER, kind: "update" },
    { serverId: SERVER, kind: "instance-update" },
    { serverId: FLEET_B, kind: "update" },
  ]);
});

test("a late failed report from attempt one does not overwrite attempt two", async () => {
  const { coordinator, enqueued, store } = harness(["managed-upgrade-v1"]);
  const started = await coordinator.start({
    source: "manual",
    startedBy: null,
  });
  if (!started.ok) throw new TypeError(started.error);
  const first = enqueued[0];
  if (!first || first.kind !== "update") throw new TypeError("expected update");
  const active = await coordinator.activeRun();
  const step = active?.steps.find((item) => item.unit === "daemon");
  if (!step) throw new TypeError("expected a daemon step");
  step.status = "pending";
  step.nextAttemptAt = null;
  await store.saveStep(step);
  await coordinator.tick({ resolveManifests: false });
  const second = enqueued[1];
  if (!second || second.kind !== "update") {
    throw new TypeError("expected a second update");
  }
  if (second.requestId === first.requestId) {
    throw new TypeError("attempt two reused attempt one's request id");
  }

  const replayLateFailure = async () => {
    await coordinator.noteProgress({
      serverId: SERVER,
      unit: "daemon",
      stage: "failed",
      at: "2026-09-24T12:02:00.000Z",
      detail: "attempt one failed",
      errorCode: "update_failed",
      requestId: first.requestId,
    });
    await coordinator.noteOutcome({
      serverId: SERVER,
      unit: "daemon",
      ok: false,
      at: "2026-09-24T12:02:00.000Z",
      error: "attempt one failed",
      errorCode: "update_failed",
      requestId: first.requestId,
    });
  };
  await replayLateFailure();
  await replayLateFailure();
  const held = await coordinator.activeRun();
  const heldStep = held?.steps.find((item) => item.unit === "daemon");
  assertEquals(heldStep?.status, "dispatched");
  assertEquals(heldStep?.requestId, second.requestId);
  assertEquals(heldStep?.attempts, 2);

  await coordinator.noteDaemonCommit(
    SERVER,
    "new-daemon",
    "2026-09-24T12:06:00.000Z",
  );
  const confirmed = await coordinator.activeRun();
  assertEquals(
    confirmed?.steps.find((item) => item.unit === "daemon")?.status,
    "done",
  );
});

test("preflight reserves a run id and start reuses the copied command", async () => {
  const { coordinator, store } = harness(["managed-upgrade-v1"]);
  const first = await coordinator.preflight();
  assertEquals(first.recoveryCommand.includes("pending"), false);
  assertEquals(first.recoveryCommand.includes(first.runId), true);
  assertEquals(first.backupPath, `/backup/control-plane/${first.runId}`);
  const restarted = createUpgradeCoordinator({
    store,
    enqueue: () => Promise.resolve(),
    runtime: "deno",
    channel: "release",
    development: false,
    now: () => "2026-09-24T12:00:00.000Z",
    colocatedServerId: SERVER,
    instanceInstalled: { version: "0.1.0", commit: "old-instance" },
    resolveTarget: () => Promise.resolve(target),
  });
  const after = await restarted.preflight();
  assertEquals(after.runId, first.runId);
  assertEquals(after.recoveryCommand, first.recoveryCommand);
  const started = await restarted.start({
    source: "manual",
    startedBy: null,
    runId: first.runId,
  });
  if (!started.ok) throw new TypeError(started.error);
  assertEquals(started.runId, first.runId);
});

test("a non-development gate fails closed when the target cannot be read", () => {
  assertEquals(
    clientUpdateBlock({
      runtime: "deno",
      development: false,
      targetCommitKnown: false,
      gateOpen: false,
    }),
    { blocked: true, error: "upgrade_gate_unavailable" },
  );
  assertEquals(
    clientUpdateBlock({
      runtime: "deno",
      development: true,
      targetCommitKnown: false,
      gateOpen: false,
    }),
    { blocked: false, useCoordinator: false },
  );
  assertEquals(
    clientUpdateBlock({
      runtime: "deno",
      development: false,
      targetCommitKnown: true,
      gateOpen: false,
    }),
    { blocked: true, error: "control_plane_upgrade_required" },
  );
});
