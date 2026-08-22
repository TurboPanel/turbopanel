import { assertEquals } from "@std/assert";
import { DisabledServerMetricsStore } from "./disabled-store.ts";
import { METRICS_SCHEMA_VERSION } from "./contract.ts";
import type { AuthenticatedHostMetricsSample } from "./types.ts";
import { it } from "@std/testing/bdd";

const sample: AuthenticatedHostMetricsSample = {
  serverId: "srv-1",
  at: "2026-01-01T00:00:00.000Z",
  receivedAt: "2026-01-01T00:00:01.000Z",
  intervalSeconds: 60,
  sequence: 1,
  schemaVersion: METRICS_SCHEMA_VERSION,
  dimensions: {
    schemaVersion: METRICS_SCHEMA_VERSION,
    daemonVersion: "1.0.0",
    operatingSystem: "linux",
    architecture: "arm64",
    kernelRelease: "6.12.0",
  },
  metrics: {
    cpuUsagePercent: null,
    cpuUserPercent: null,
    cpuSystemPercent: null,
    cpuIowaitPercent: null,
    load1: null,
    load5: null,
    load15: null,
    memoryUsedPercent: null,
    memoryUsedBytes: null,
    memoryAvailableBytes: null,
    swapUsedPercent: null,
    diskUsedPercent: null,
    diskReadBytesPerSecond: null,
    diskWriteBytesPerSecond: null,
    diskReadOpsPerSecond: null,
    diskWriteOpsPerSecond: null,
    networkReceiveBytesPerSecond: null,
    networkTransmitBytesPerSecond: null,
    processCount: null,
    uptimeSeconds: null,
  },
};

it("DisabledServerMetricsStore writeHostSample is a no-op", () => {
  const store = new DisabledServerMetricsStore();
  store.writeHostSample(sample);
});

it("DisabledServerMetricsStore writeStatusEvent is a no-op", () => {
  const store = new DisabledServerMetricsStore();
  store.writeStatusEvent({
    serverId: "srv-1",
    connected: true,
    reason: "connect",
    at: "2026-01-01T00:00:00.000Z",
  });
});

it("DisabledServerMetricsStore queries return available:false", async () => {
  const store = new DisabledServerMetricsStore();
  const series = await store.queryHostSeries({
    serverId: "srv-1",
    metrics: ["cpuUsagePercent", "memoryUsedBytes"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(series.kind, "disabled");
  assertEquals(series.available, false);
  assertEquals(series.metrics, ["cpuUsagePercent", "memoryUsedBytes"]);
  assertEquals(series.points, []);
  assertEquals(series.gapCount, 0);
  assertEquals(series.sampleCount, 0);

  const summary = await store.queryHostSummary({
    serverId: "srv-1",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(summary.kind, "disabled");
  assertEquals(summary.available, false);
  assertEquals(summary.sampleCount, 0);

  const history = await store.queryStatusHistory({
    serverId: "srv-1",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(history.kind, "disabled");
  assertEquals(history.available, false);
  assertEquals(history.initialConnected, null);
  assertEquals(history.events, []);
  assertEquals(history.uptimeSeconds, 0);
  assertEquals(history.downtimeSeconds, 0);
  assertEquals(history.unknownSeconds, 0);
  assertEquals(history.uptimePercent, null);
  assertEquals(history.truncated, false);

  const fleet = await store.queryFleetHostSnapshot({
    serverIds: ["srv-1"],
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(fleet.kind, "disabled");
  assertEquals(fleet.available, false);
  assertEquals(fleet.servers, []);
  assertEquals(fleet.metrics, ["cpuUsagePercent"]);
});
