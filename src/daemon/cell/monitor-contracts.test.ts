import { assertEquals } from "jsr:@std/assert";
import {
  applyResourceDelta,
  computeEffectiveStatus,
  evaluateFullSyncSequence,
  evaluateMonitorSequence,
  mergeResourceStates,
  MONITOR_OFFLINE_GRACE_MS,
  MONITOR_PROTOCOL_VERSION,
  type MonitorResourceState,
  normalizeMonitorMetricBucket,
  parseMonitorMessage,
} from "./monitor-contracts.ts";
import {
  isMeaningfulMonitorTransition,
  summarizeMonitorResources,
} from "./postgres-projection.ts";

const at = "2020-01-01T00:00:00.000Z";

function sampleResource(
  key: string,
  status: MonitorResourceState["status"] = "healthy",
): MonitorResourceState {
  return { resourceKey: key, kind: "container", status };
}

Deno.test("parseMonitorMessage round-trips valid monitor messages", () => {
  const sync = {
    type: "monitor.sync",
    from: "daemon",
    serverId: "srv-1",
    at,
    sequence: 1,
    instance: {},
    resources: [sampleResource("container:abc")],
    protocolVersion: MONITOR_PROTOCOL_VERSION,
  };
  assertEquals(parseMonitorMessage(sync)?.type, "monitor.sync");
  assertEquals(parseMonitorMessage(JSON.stringify(sync))?.sequence, 1);

  const heartbeat = {
    type: "monitor.heartbeat",
    from: "daemon",
    serverId: "srv-1",
    at,
    sequence: 2,
    instance: { cpu: { cores: 4 } },
  };
  assertEquals(parseMonitorMessage(heartbeat)?.type, "monitor.heartbeat");
  assertEquals(parseMonitorMessage(heartbeat)?.sequence, 2);

  const transition = {
    type: "monitor.transition",
    from: "daemon",
    serverId: "srv-1",
    at,
    sequence: 3,
    events: [{
      resourceKey: "container:abc",
      kind: "container",
      toStatus: "unhealthy",
      at,
    }],
  };
  assertEquals(parseMonitorMessage(transition)?.type, "monitor.transition");

  const ack = {
    type: "monitor.ack",
    from: "instance",
    serverId: "srv-1",
    at,
    acceptedSequence: 3,
    resyncNeeded: true,
  };
  assertEquals(parseMonitorMessage(ack)?.acceptedSequence, 3);
  assertEquals(parseMonitorMessage(ack)?.resyncNeeded, true);
});

Deno.test("parseMonitorMessage returns null for invalid shapes", () => {
  assertEquals(parseMonitorMessage("not-json"), null);
  assertEquals(parseMonitorMessage({ type: "monitor.sync" }), null);
  assertEquals(
    parseMonitorMessage({
      type: "monitor.sync",
      from: "daemon",
      serverId: "srv-1",
      at,
      sequence: 1,
      instance: {},
      resources: "bad",
      protocolVersion: MONITOR_PROTOCOL_VERSION,
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.ack",
      from: "daemon",
      serverId: "srv-1",
      at,
      acceptedSequence: 1,
    }),
    null,
  );
});

Deno.test("evaluateMonitorSequence noop/accept/gap", () => {
  assertEquals(evaluateMonitorSequence(5, 5), {
    action: "noop",
    acceptedSequence: 5,
    resyncNeeded: false,
  });
  assertEquals(evaluateMonitorSequence(5, 3), {
    action: "noop",
    acceptedSequence: 5,
    resyncNeeded: false,
  });
  assertEquals(evaluateMonitorSequence(5, 6), {
    action: "accept",
    acceptedSequence: 6,
    resyncNeeded: false,
  });
  assertEquals(evaluateMonitorSequence(0, 5), {
    action: "gap",
    acceptedSequence: 0,
    resyncNeeded: true,
  });
});

Deno.test("evaluateFullSyncSequence accepts any newer sequence", () => {
  assertEquals(evaluateFullSyncSequence(5, 5), {
    action: "noop",
    acceptedSequence: 5,
    resyncNeeded: false,
  });
  assertEquals(evaluateFullSyncSequence(5, 3), {
    action: "noop",
    acceptedSequence: 5,
    resyncNeeded: false,
  });
  assertEquals(evaluateFullSyncSequence(0, 5), {
    action: "accept",
    acceptedSequence: 5,
    resyncNeeded: false,
  });
  assertEquals(evaluateFullSyncSequence(2, 10), {
    action: "accept",
    acceptedSequence: 10,
    resyncNeeded: false,
  });
});

Deno.test("mergeResourceStates and applyResourceDelta override by resourceKey", () => {
  const base = [
    sampleResource("a", "healthy"),
    sampleResource("b", "starting"),
  ];
  const incoming = [
    sampleResource("a", "unhealthy"),
    sampleResource("c", "healthy"),
  ];

  const merged = mergeResourceStates(base, incoming);
  assertEquals(merged.length, 3);
  assertEquals(merged.find((r) => r.resourceKey === "a")?.status, "unhealthy");
  assertEquals(merged.find((r) => r.resourceKey === "b")?.status, "starting");
  assertEquals(merged.find((r) => r.resourceKey === "c")?.status, "healthy");

  assertEquals(applyResourceDelta(base, incoming), merged);
});

Deno.test("computeEffectiveStatus respects grace and terminal states", () => {
  const now = Date.parse("2020-01-01T01:00:00.000Z");
  const freshAt = "2020-01-01T00:59:00.000Z";
  const staleAt = "2020-01-01T00:00:00.000Z";

  assertEquals(computeEffectiveStatus("healthy", freshAt, now), "healthy");
  assertEquals(
    computeEffectiveStatus("healthy", staleAt, now),
    "offline",
  );
  assertEquals(
    computeEffectiveStatus(
      "healthy",
      staleAt,
      now - MONITOR_OFFLINE_GRACE_MS - 1,
    ),
    "offline",
  );
  assertEquals(computeEffectiveStatus("stopped", staleAt, now), "stopped");
  assertEquals(computeEffectiveStatus("failed", staleAt, now), "failed");
});

Deno.test("normalizeMonitorMetricBucket truncates to minute boundary", () => {
  assertEquals(
    normalizeMonitorMetricBucket("2020-01-01T12:34:56.789Z"),
    "2020-01-01T12:34:00.000Z",
  );
});

Deno.test("isMeaningfulMonitorTransition filters UX-relevant events", () => {
  assertEquals(
    isMeaningfulMonitorTransition({
      resourceKey: "container:abc",
      kind: "container",
      toStatus: "unhealthy",
      at,
    }),
    true,
  );
  assertEquals(
    isMeaningfulMonitorTransition({
      resourceKey: "container:abc",
      kind: "container",
      fromStatus: "starting",
      toStatus: "starting",
      at,
    }),
    false,
  );
  assertEquals(
    isMeaningfulMonitorTransition({ toStatus: "offline", at }),
    true,
  );
});

Deno.test("summarizeMonitorResources counts and derives status", () => {
  const instanceAt = new Date().toISOString();
  const summary = summarizeMonitorResources([
    {
      resourceKey: "a",
      serverId: "srv-1",
      kind: "container",
      status: "healthy",
      state: sampleResource("a", "healthy"),
      updatedAt: instanceAt,
    },
    {
      resourceKey: "b",
      serverId: "srv-1",
      kind: "service",
      status: "degraded",
      state: sampleResource("b", "degraded"),
      updatedAt: instanceAt,
    },
    {
      resourceKey: "c",
      serverId: "srv-1",
      kind: "project",
      status: "unhealthy",
      state: sampleResource("c", "unhealthy"),
      updatedAt: instanceAt,
    },
  ], instanceAt);

  assertEquals(summary.healthyCount, 1);
  assertEquals(summary.degradedCount, 1);
  assertEquals(summary.unhealthyCount, 1);
  assertEquals(summary.status, "unhealthy");

  const empty = summarizeMonitorResources([], instanceAt);
  assertEquals(empty.status, "unknown");
  assertEquals(empty.healthyCount, 0);
});
