import { it } from "@std/testing/bdd";
import {
  assertEquals,
  assertThrows,
} from "jsr:@std/assert";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
  type HostMetricKey,
} from "../contract.ts";
import type { AuthenticatedHostMetricsSample } from "../types.ts";
import {
  AE_BLOB_ARCH_INDEX,
  AE_BLOB_COUNT,
  AE_BLOB_DAEMON_VERSION_INDEX,
  AE_BLOB_EVENT_TYPE_INDEX,
  AE_BLOB_KERNEL_INDEX,
  AE_BLOB_OS_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_BLOB_STATUS_REASON_INDEX,
  AE_DOUBLE_COUNT,
  AE_DOUBLE_STATUS_CONNECTED_INDEX,
  AE_HOST_EVENT_TYPE,
  AE_INDEX_SERVER_ID_COLUMN,
  AE_MISSING_METRIC_SENTINEL,
  AE_RESERVED_BLOB_COUNT,
  AE_STATUS_EVENT_TYPE,
  AE_TIMESTAMP_COLUMN,
  assertAnalyticsEngineDataPointShape,
  buildAnalyticsEngineDataPoint,
  buildStatusAnalyticsEngineDataPoint,
  doubleColumnForMetric,
  mapHostDimensionsToBlobs,
  mapHostMetricsToDoubles,
  blobColumn,
  doubleColumn,
  statusConnectedColumn,
  statusReasonColumn,
} from "./field-map.ts";

function baseSample(
  overrides: Partial<AuthenticatedHostMetricsSample> = {},
): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  return {
    serverId: "11111111-2222-4333-8444-555555555555",
    at: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    intervalSeconds: 60,
    sequence: 1,
    schemaVersion: METRICS_SCHEMA_VERSION,
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "1.2.3",
      operatingSystem: "linux",
      architecture: "arm64",
      kernelRelease: "6.12.0",
    },
    metrics,
    ...overrides,
  };
}

it("mapHostMetricsToDoubles: each metric maps to double1..double20", () => {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (let i = 0; i < HOST_METRIC_KEYS.length; i++) {
    metrics[HOST_METRIC_KEYS[i]!] = 1000 + i;
  }
  const doubles = mapHostMetricsToDoubles(metrics);
  assertEquals(doubles.length, AE_DOUBLE_COUNT);
  for (let i = 0; i < HOST_METRIC_KEYS.length; i++) {
    assertEquals(doubles[i], 1000 + i);
  }
});

it("mapHostMetricsToDoubles: null → AE_MISSING_METRIC_SENTINEL", () => {
  const sample = baseSample();
  const doubles = mapHostMetricsToDoubles(sample.metrics);
  assertEquals(doubles.length, 20);
  for (const value of doubles) {
    assertEquals(value, AE_MISSING_METRIC_SENTINEL);
  }
});

it("mapHostDimensionsToBlobs: blob1..blob6 identity; blob7..blob20 empty", () => {
  const sample = baseSample();
  const blobs = mapHostDimensionsToBlobs(sample.dimensions);
  assertEquals(blobs.length, AE_BLOB_COUNT);
  assertEquals(blobs[AE_BLOB_EVENT_TYPE_INDEX], AE_HOST_EVENT_TYPE);
  assertEquals(
    blobs[AE_BLOB_SCHEMA_VERSION_INDEX],
    String(METRICS_SCHEMA_VERSION),
  );
  assertEquals(blobs[AE_BLOB_DAEMON_VERSION_INDEX], "1.2.3");
  assertEquals(blobs[AE_BLOB_OS_INDEX], "linux");
  assertEquals(blobs[AE_BLOB_ARCH_INDEX], "arm64");
  assertEquals(blobs[AE_BLOB_KERNEL_INDEX], "6.12.0");
  for (let i = 6; i < AE_BLOB_COUNT; i++) {
    assertEquals(blobs[i], "");
  }
  assertEquals(AE_RESERVED_BLOB_COUNT, 14);
});

it("buildAnalyticsEngineDataPoint: indexes is exactly [serverId]", () => {
  const sample = baseSample({
    serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  const point = buildAnalyticsEngineDataPoint(sample);
  assertEquals(point.indexes, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
  assertEquals(point.doubles.length, 20);
  assertEquals(point.blobs.length, 20);
});

it("identity column constants match the shared positional layout", () => {
  assertEquals(AE_INDEX_SERVER_ID_COLUMN, "index1");
  assertEquals(AE_TIMESTAMP_COLUMN, "timestamp");
});

it("doubleColumnForMetric: HOST_METRIC_KEYS → doubleN", () => {
  HOST_METRIC_KEYS.forEach((key, index) => {
    assertEquals(doubleColumnForMetric(key), `double${index + 1}`);
  });
});

it("doubleColumnForMetric: unknown key throws TypeError", () => {
  assertThrows(
    () => doubleColumnForMetric("notAMetric" as HostMetricKey),
    TypeError,
    "unknown host metrics metric",
  );
});

it("blobColumn and doubleColumn: map zero-based indices to SQL names", () => {
  assertEquals(blobColumn(0), "blob1");
  assertEquals(blobColumn(19), "blob20");
  assertEquals(doubleColumn(0), "double1");
  assertEquals(doubleColumn(19), "double20");
  assertEquals(statusConnectedColumn(), "double1");
  assertEquals(statusReasonColumn(), "blob7");
});

it("blobColumn and doubleColumn: reject invalid indices", () => {
  assertThrows(() => blobColumn(-1), TypeError, "invalid AE blob index");
  assertThrows(() => blobColumn(20), TypeError, "invalid AE blob index");
  assertThrows(() => doubleColumn(1.5), TypeError, "invalid AE double index");
  assertThrows(() => doubleColumn(20), TypeError, "invalid AE double index");
});

it("assertAnalyticsEngineDataPointShape: rejects malformed lengths", () => {
  assertThrows(
    () => assertAnalyticsEngineDataPointShape({ doubles: [1], blobs: new Array(20).fill("") }),
    TypeError,
    "AE doubles length",
  );
  assertThrows(
    () =>
      assertAnalyticsEngineDataPointShape({
        doubles: new Array(20).fill(0),
        blobs: ["a"],
      }),
    TypeError,
    "AE blobs length",
  );
});

it("buildAnalyticsEngineDataPoint: missing sentinel round-trips", () => {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  metrics.cpuUsagePercent = 42;
  metrics.uptimeSeconds = 99;
  const point = buildAnalyticsEngineDataPoint(baseSample({ metrics }));
  assertEquals(point.doubles[0], 42);
  assertEquals(point.doubles[19], 99);
  for (let i = 1; i < 19; i++) {
    assertEquals(point.doubles[i], AE_MISSING_METRIC_SENTINEL);
  }
});

it("buildStatusAnalyticsEngineDataPoint: status shape + sentinel doubles", () => {
  const serverId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const point = buildStatusAnalyticsEngineDataPoint({
    serverId,
    connected: true,
    reason: "self_heal",
    at: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(point.indexes, [serverId]);
  assertEquals(point.doubles[AE_DOUBLE_STATUS_CONNECTED_INDEX], 1);
  for (let i = 1; i < AE_DOUBLE_COUNT; i++) {
    assertEquals(point.doubles[i], AE_MISSING_METRIC_SENTINEL);
  }
  assertEquals(point.blobs[AE_BLOB_EVENT_TYPE_INDEX], AE_STATUS_EVENT_TYPE);
  assertEquals(
    point.blobs[AE_BLOB_SCHEMA_VERSION_INDEX],
    String(METRICS_SCHEMA_VERSION),
  );
  assertEquals(point.blobs[AE_BLOB_STATUS_REASON_INDEX], "self_heal");
  for (let i = 2; i < AE_BLOB_COUNT; i++) {
    if (i === AE_BLOB_STATUS_REASON_INDEX) continue;
    assertEquals(point.blobs[i], "");
  }
  assertEquals(AE_RESERVED_BLOB_COUNT, 14);

  const offline = buildStatusAnalyticsEngineDataPoint({
    serverId,
    connected: false,
    reason: "sweep_stale",
    at: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(offline.doubles[AE_DOUBLE_STATUS_CONNECTED_INDEX], 0);
  assertEquals(offline.blobs[AE_BLOB_STATUS_REASON_INDEX], "sweep_stale");
});
