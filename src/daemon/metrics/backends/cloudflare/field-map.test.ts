import { it } from "@std/testing/bdd";
import {
  assertEquals,
  assertThrows,
} from "@std/assert";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
  type HostMetricKey,
} from "../../contract.ts";
import type { AuthenticatedHostMetricsSample } from "../../types.ts";
import {
  AE_BLOB_ARCH_INDEX,
  AE_BLOB_COLLECTION_MODE_INDEX,
  AE_BLOB_COUNT,
  AE_BLOB_CPU_POWER_SENSOR_INDEX,
  AE_BLOB_CPU_TEMPERATURE_SENSOR_INDEX,
  AE_BLOB_DAEMON_VERSION_INDEX,
  AE_BLOB_EVENT_TYPE_INDEX,
  AE_BLOB_FABRIC_INTERFACES_INDEX,
  AE_BLOB_GPU_POWER_SENSOR_INDEX,
  AE_BLOB_GPU_TEMPERATURE_SENSOR_INDEX,
  AE_BLOB_KERNEL_INDEX,
  AE_BLOB_OS_INDEX,
  AE_BLOB_PART_INDEX,
  AE_BLOB_SAMPLED_AT_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_BLOB_SEQUENCE_INDEX,
  AE_BLOB_STATUS_REASON_INDEX,
  AE_BLOB_UPLINK_INTERFACES_INDEX,
  AE_DATASET_NAME,
  AE_DOUBLE_COUNT,
  AE_DOUBLE_INTERVAL_INDEX,
  AE_DOUBLE_STATUS_CONNECTED_INDEX,
  AE_METRIC_DOUBLE_SLOT_COUNT,
  AE_METRICS_EVENT_TYPE,
  AE_INDEX_SERVER_ID_COLUMN,
  AE_MISSING_METRIC_SENTINEL,
  AE_PART_CORE,
  AE_PART_EXTENDED,
  AE_RESERVED_BLOB_COUNT,
  AE_STATUS_EVENT_TYPE,
  AE_TIMESTAMP_COLUMN,
  assertAnalyticsEngineDataPointShape,
  blobColumn,
  buildCoreDataPoint,
  buildExtendedDataPoint,
  buildStatusDataPoint,
  CORE_METRIC_KEYS,
  doubleColumn,
  doubleColumnForMetric,
  EXTENDED_METRIC_KEYS,
  intervalSecondsColumn,
  mapHostSampleToBlobs,
  mapPartMetricsToDoubles,
  metricPart,
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
    sampledAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    intervalSeconds: 60,
    sequence: 7,
    schemaVersion: METRICS_SCHEMA_VERSION,
    collectionMode: "baseline",
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "1.2.3",
      operatingSystem: "linux",
      architecture: "arm64",
      kernelRelease: "6.12.0",
      collectionMode: "baseline",
    },
    metrics,
    ...overrides,
  };
}

it("core/extended parts partition HOST_METRIC_KEYS exactly", () => {
  assertEquals(CORE_METRIC_KEYS.length, AE_METRIC_DOUBLE_SLOT_COUNT);
  assertEquals(EXTENDED_METRIC_KEYS.length, AE_METRIC_DOUBLE_SLOT_COUNT);
  const union = new Set<HostMetricKey>([
    ...CORE_METRIC_KEYS,
    ...EXTENDED_METRIC_KEYS,
  ]);
  assertEquals(union.size, HOST_METRIC_KEYS.length);
  assertEquals(union, new Set(HOST_METRIC_KEYS));
});

it("dataset name is the brand-new telemetry dataset", () => {
  assertEquals(AE_DATASET_NAME, "turbopanel_server_telemetry");
});

it("metricPart: every key resolves to the part that lists it", () => {
  for (const key of CORE_METRIC_KEYS) {
    assertEquals(metricPart(key), AE_PART_CORE);
  }
  for (const key of EXTENDED_METRIC_KEYS) {
    assertEquals(metricPart(key), AE_PART_EXTENDED);
  }
  assertThrows(
    () => metricPart("notAMetric" as HostMetricKey),
    TypeError,
    "unknown host metrics metric",
  );
});

it("mapPartMetricsToDoubles: part order → double1..double19, interval → double20", () => {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  CORE_METRIC_KEYS.forEach((key, i) => {
    metrics[key] = 1000 + i;
  });
  EXTENDED_METRIC_KEYS.forEach((key, i) => {
    metrics[key] = 2000 + i;
  });

  const core = mapPartMetricsToDoubles(metrics, AE_PART_CORE, 60);
  assertEquals(core.length, AE_DOUBLE_COUNT);
  CORE_METRIC_KEYS.forEach((_key, i) => {
    assertEquals(core[i], 1000 + i);
  });
  assertEquals(core[AE_DOUBLE_INTERVAL_INDEX], 60);

  const extended = mapPartMetricsToDoubles(metrics, AE_PART_EXTENDED, 15);
  assertEquals(extended.length, AE_DOUBLE_COUNT);
  EXTENDED_METRIC_KEYS.forEach((_key, i) => {
    assertEquals(extended[i], 2000 + i);
  });
  assertEquals(extended[AE_DOUBLE_INTERVAL_INDEX], 15);
});

it("mapPartMetricsToDoubles: null → AE_MISSING_METRIC_SENTINEL, never 0", () => {
  const sample = baseSample();
  const doubles = mapPartMetricsToDoubles(sample.metrics, AE_PART_CORE, 60);
  for (let i = 0; i < AE_METRIC_DOUBLE_SLOT_COUNT; i++) {
    assertEquals(doubles[i], AE_MISSING_METRIC_SENTINEL);
  }
  assertEquals(doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
});

it("mapHostSampleToBlobs: identity slots filled, rest reserved empty", () => {
  const sample = baseSample({
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "1.2.3",
      operatingSystem: "linux",
      architecture: "arm64",
      kernelRelease: "6.12.0",
      collectionMode: "live",
      cpuTemperatureSensor: "coretemp",
      gpuTemperatureSensor: "amdgpu",
      cpuPowerSensor: "rapl",
      gpuPowerSensor: "nvml",
      uplinkInterfaces: ["eth0", "eth1"],
      fabricInterfaces: ["wg0"],
    },
    collectionMode: "live",
  });
  const blobs = mapHostSampleToBlobs(sample, AE_PART_EXTENDED);
  assertEquals(blobs.length, AE_BLOB_COUNT);
  assertEquals(blobs[AE_BLOB_EVENT_TYPE_INDEX], AE_METRICS_EVENT_TYPE);
  assertEquals(blobs[AE_BLOB_PART_INDEX], AE_PART_EXTENDED);
  assertEquals(
    blobs[AE_BLOB_SCHEMA_VERSION_INDEX],
    String(METRICS_SCHEMA_VERSION),
  );
  assertEquals(blobs[AE_BLOB_DAEMON_VERSION_INDEX], "1.2.3");
  assertEquals(blobs[AE_BLOB_OS_INDEX], "linux");
  assertEquals(blobs[AE_BLOB_ARCH_INDEX], "arm64");
  assertEquals(blobs[AE_BLOB_KERNEL_INDEX], "6.12.0");
  assertEquals(blobs[AE_BLOB_COLLECTION_MODE_INDEX], "live");
  assertEquals(blobs[AE_BLOB_SAMPLED_AT_INDEX], "2026-01-01T00:00:00.000Z");
  assertEquals(blobs[AE_BLOB_SEQUENCE_INDEX], "7");
  assertEquals(blobs[AE_BLOB_CPU_TEMPERATURE_SENSOR_INDEX], "coretemp");
  assertEquals(blobs[AE_BLOB_GPU_TEMPERATURE_SENSOR_INDEX], "amdgpu");
  assertEquals(blobs[AE_BLOB_CPU_POWER_SENSOR_INDEX], "rapl");
  assertEquals(blobs[AE_BLOB_GPU_POWER_SENSOR_INDEX], "nvml");
  assertEquals(blobs[AE_BLOB_UPLINK_INTERFACES_INDEX], "eth0,eth1");
  assertEquals(blobs[AE_BLOB_FABRIC_INTERFACES_INDEX], "wg0");
  // Status-reason slot + tail reserved slots stay empty on metrics rows.
  assertEquals(blobs[AE_BLOB_STATUS_REASON_INDEX], "");
  for (let i = AE_BLOB_COUNT - AE_RESERVED_BLOB_COUNT; i < AE_BLOB_COUNT; i++) {
    assertEquals(blobs[i], "");
  }
});

it("mapHostSampleToBlobs: optional sensor/interface identity defaults to empty", () => {
  const blobs = mapHostSampleToBlobs(baseSample(), AE_PART_CORE);
  assertEquals(blobs[AE_BLOB_PART_INDEX], AE_PART_CORE);
  assertEquals(blobs[AE_BLOB_CPU_TEMPERATURE_SENSOR_INDEX], "");
  assertEquals(blobs[AE_BLOB_GPU_TEMPERATURE_SENSOR_INDEX], "");
  assertEquals(blobs[AE_BLOB_CPU_POWER_SENSOR_INDEX], "");
  assertEquals(blobs[AE_BLOB_GPU_POWER_SENSOR_INDEX], "");
  assertEquals(blobs[AE_BLOB_UPLINK_INTERFACES_INDEX], "");
  assertEquals(blobs[AE_BLOB_FABRIC_INTERFACES_INDEX], "");
});

it("buildCoreDataPoint / buildExtendedDataPoint: indexes is exactly [serverId]", () => {
  const sample = baseSample({
    serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  for (const point of [buildCoreDataPoint(sample), buildExtendedDataPoint(sample)]) {
    assertEquals(point.indexes, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
    assertEquals(point.doubles.length, AE_DOUBLE_COUNT);
    assertEquals(point.blobs.length, AE_BLOB_COUNT);
    assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
  }
  assertEquals(
    buildCoreDataPoint(sample).blobs[AE_BLOB_PART_INDEX],
    AE_PART_CORE,
  );
  assertEquals(
    buildExtendedDataPoint(sample).blobs[AE_BLOB_PART_INDEX],
    AE_PART_EXTENDED,
  );
});

it("part data points carry their own part's metric values", () => {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  metrics.cpuUserPercent = 42; // core, slot 0
  metrics.gpuPowerWatts = 99; // extended, last slot
  const sample = baseSample({ metrics });

  const core = buildCoreDataPoint(sample);
  assertEquals(core.doubles[CORE_METRIC_KEYS.indexOf("cpuUserPercent")], 42);

  const extended = buildExtendedDataPoint(sample);
  assertEquals(
    extended.doubles[EXTENDED_METRIC_KEYS.indexOf("gpuPowerWatts")],
    99,
  );
  // The core value never leaks into the extended part's slots.
  for (let i = 0; i < AE_METRIC_DOUBLE_SLOT_COUNT; i++) {
    if (i === EXTENDED_METRIC_KEYS.indexOf("gpuPowerWatts")) continue;
    assertEquals(extended.doubles[i], AE_MISSING_METRIC_SENTINEL);
  }
});

it("identity column constants match the shared positional layout", () => {
  assertEquals(AE_INDEX_SERVER_ID_COLUMN, "index1");
  assertEquals(AE_TIMESTAMP_COLUMN, "timestamp");
});

it("doubleColumnForMetric: part-key order → doubleN within the part", () => {
  CORE_METRIC_KEYS.forEach((key, index) => {
    assertEquals(doubleColumnForMetric(key), `double${index + 1}`);
  });
  EXTENDED_METRIC_KEYS.forEach((key, index) => {
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
  assertEquals(intervalSecondsColumn(), "double20");
  assertEquals(statusConnectedColumn(), "double1");
  assertEquals(statusReasonColumn(), `blob${AE_BLOB_STATUS_REASON_INDEX + 1}`);
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

it("buildStatusDataPoint: status shape + sentinel doubles", () => {
  const serverId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const point = buildStatusDataPoint({
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
  // No part discriminator on status rows.
  assertEquals(point.blobs[AE_BLOB_PART_INDEX], "");
  assertEquals(
    point.blobs[AE_BLOB_SCHEMA_VERSION_INDEX],
    String(METRICS_SCHEMA_VERSION),
  );
  assertEquals(point.blobs[AE_BLOB_STATUS_REASON_INDEX], "self_heal");
  for (let i = 0; i < AE_BLOB_COUNT; i++) {
    if (
      i === AE_BLOB_EVENT_TYPE_INDEX ||
      i === AE_BLOB_SCHEMA_VERSION_INDEX ||
      i === AE_BLOB_STATUS_REASON_INDEX
    ) continue;
    assertEquals(point.blobs[i], "");
  }

  const offline = buildStatusDataPoint({
    serverId,
    connected: false,
    reason: "sweep_stale",
    at: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(offline.doubles[AE_DOUBLE_STATUS_CONNECTED_INDEX], 0);
  assertEquals(offline.blobs[AE_BLOB_STATUS_REASON_INDEX], "sweep_stale");
});
