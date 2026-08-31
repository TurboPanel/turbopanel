/**
 * Cloudflare Analytics Engine positional field map — the single source of
 * truth for the double1..double20 / blob1..blob20 / indexes layout on the
 * `turbopanel_server_telemetry` dataset.
 *
 * Schema v2 carries 38 named metrics but one AE data point only has 20
 * doubles, so every host sample is written as **two** data points:
 *
 *   blob1 = "metrics", blob2 = "core"      → 19 core metrics + interval
 *   blob1 = "metrics", blob2 = "extended"  → 19 extended metrics + interval
 *
 * Both parts reserve `double20` for the sample's `intervalSeconds` so query
 * aggregates can weight by true collection cadence
 * (`SUM(value * double20 * _sample_interval) / SUM(double20 * _sample_interval)`).
 * Connection-status transitions stay single data points (`blob1 = "status"`)
 * on the same dataset.
 *
 * External storage contract: never inline positional literals elsewhere;
 * always derive columns and write payloads through this module.
 */

import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
  type HostMetricKey,
  type HostMetrics,
} from "../../contract.ts";
import type {
  AuthenticatedHostMetricsSample,
  ServerStatusEvent,
} from "../../types.ts";

/**
 * Brand-new dataset name — the retired single-datapoint layout lives in
 * `turbopanel_server_metrics`; no query against this dataset ever touches
 * old rows.
 */
export const AE_DATASET_NAME = "turbopanel_server_telemetry";

export const AE_DOUBLE_COUNT = 20;
export const AE_BLOB_COUNT = 20;

/** Metric-value double slots per part (double1..double19). */
export const AE_METRIC_DOUBLE_SLOT_COUNT = 19;

/** double20 on both metrics parts — the sample's `intervalSeconds`. */
export const AE_DOUBLE_INTERVAL_INDEX = 19;

/** blob1 — event type discriminator: `"metrics"` or `"status"`. */
export const AE_BLOB_EVENT_TYPE_INDEX = 0;
/** blob2 — metrics part discriminator: `"core"` or `"extended"` (empty on status rows). */
export const AE_BLOB_PART_INDEX = 1;
/** blob3 — schema version (stringified integer, both event types). */
export const AE_BLOB_SCHEMA_VERSION_INDEX = 2;
/** blob4 — daemon version string. */
export const AE_BLOB_DAEMON_VERSION_INDEX = 3;
/** blob5 — operating system. */
export const AE_BLOB_OS_INDEX = 4;
/** blob6 — architecture. */
export const AE_BLOB_ARCH_INDEX = 5;
/** blob7 — kernel release. */
export const AE_BLOB_KERNEL_INDEX = 6;
/** blob8 — collection mode (`"baseline"` / `"live"`). */
export const AE_BLOB_COLLECTION_MODE_INDEX = 7;
/** blob9 — daemon sample timestamp (wire `at`, ISO string). */
export const AE_BLOB_SAMPLED_AT_INDEX = 8;
/** blob10 — daemon sample sequence (stringified integer). */
export const AE_BLOB_SEQUENCE_INDEX = 9;
/** blob11 — selected CPU temperature sensor identity. */
export const AE_BLOB_CPU_TEMPERATURE_SENSOR_INDEX = 10;
/** blob12 — selected GPU temperature sensor identity. */
export const AE_BLOB_GPU_TEMPERATURE_SENSOR_INDEX = 11;
/** blob13 — selected CPU power sensor identity. */
export const AE_BLOB_CPU_POWER_SENSOR_INDEX = 12;
/** blob14 — selected GPU power sensor identity. */
export const AE_BLOB_GPU_POWER_SENSOR_INDEX = 13;
/** blob15 — uplink interface selection (comma-joined). */
export const AE_BLOB_UPLINK_INTERFACES_INDEX = 14;
/** blob16 — fabric interface selection (comma-joined). */
export const AE_BLOB_FABRIC_INTERFACES_INDEX = 15;
/** blob17 — status rows only: {@link ServerStatusEvent.reason} (empty on metrics rows). */
export const AE_BLOB_STATUS_REASON_INDEX = 16;

/** blob18..blob20 stay reserved-empty on every event type. */
export const AE_RESERVED_BLOB_COUNT = 3;

/** blob1 discriminator for host-metrics sample rows. */
export const AE_METRICS_EVENT_TYPE = "metrics";
/** blob1 discriminator for connection-status transition rows. */
export const AE_STATUS_EVENT_TYPE = "status";

/** blob2 discriminator values for the two fixed metrics parts. */
export const AE_PART_CORE = "core";
export const AE_PART_EXTENDED = "extended";

export type AeMetricPart = typeof AE_PART_CORE | typeof AE_PART_EXTENDED;

/** double1 on status rows — connected (1) / disconnected (0). */
export const AE_DOUBLE_STATUS_CONNECTED_INDEX = 0;

/**
 * Physical column name for the authenticated serverId identity slot
 * (`indexes[0]` on the write path, `index1` on the SQL read path).
 */
export const AE_INDEX_SERVER_ID_COLUMN = "index1";

/** Physical column name for the AE ingestion timestamp. */
export const AE_TIMESTAMP_COLUMN = "timestamp";

/**
 * Missing-metric sentinel written into double slots when a metric is `null`.
 *
 * AE doubles have no null — every slot must be a finite IEEE number.
 * Converting missing → 0 is forbidden (would silently skew averages).
 * AE SQL mathematical-functions docs do not list `isNaN()`, so NaN is not
 * a reliable query-side filter; all host metrics are ≥ 0, so this very large
 * negative sentinel sits outside every metric range. Query aggregates must
 * exclude rows where `doubleN = AE_MISSING_METRIC_SENTINEL` (via `if` / `sumIf`).
 */
export const AE_MISSING_METRIC_SENTINEL = -1e308;

/**
 * The 19 core metrics — double1..double19 of the `blob2 = "core"` part, in
 * this exact order: CPU breakdown, load averages, memory/swap, CPU temp,
 * process count, uptime.
 */
export const CORE_METRIC_KEYS = [
  "cpuUserPercent",
  "cpuSystemPercent",
  "cpuNicePercent",
  "cpuIdlePercent",
  "cpuIowaitPercent",
  "cpuIrqPercent",
  "cpuSoftirqPercent",
  "cpuStealPercent",
  "load1",
  "load5",
  "load15",
  "memoryTotalBytes",
  "memoryAvailableBytes",
  "memoryFreeBytes",
  "swapTotalBytes",
  "swapFreeBytes",
  "cpuTemperatureCelsius",
  "processCount",
  "uptimeSeconds",
] as const satisfies readonly HostMetricKey[];

/**
 * The 19 extended metrics — double1..double19 of the `blob2 = "extended"`
 * part, in this exact order: storage totals, disk throughput/ops/latency,
 * network rates, GPU temp, power draw.
 */
export const EXTENDED_METRIC_KEYS = [
  "systemStorageTotalBytes",
  "systemStorageAvailableBytes",
  "hostingStorageTotalBytes",
  "hostingStorageAvailableBytes",
  "dockerStorageTotalBytes",
  "dockerStorageAvailableBytes",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
  "diskReadOpsPerSecond",
  "diskWriteOpsPerSecond",
  "diskReadLatencyMs",
  "diskWriteLatencyMs",
  "uplinkReceiveBytesPerSecond",
  "uplinkTransmitBytesPerSecond",
  "fabricReceiveBytesPerSecond",
  "fabricTransmitBytesPerSecond",
  "gpuTemperatureCelsius",
  "cpuPowerWatts",
  "gpuPowerWatts",
] as const satisfies readonly HostMetricKey[];

const PART_KEYS: Record<AeMetricPart, readonly HostMetricKey[]> = {
  [AE_PART_CORE]: CORE_METRIC_KEYS,
  [AE_PART_EXTENDED]: EXTENDED_METRIC_KEYS,
};

const PART_BY_METRIC = new Map<HostMetricKey, AeMetricPart>();
for (const key of CORE_METRIC_KEYS) PART_BY_METRIC.set(key, AE_PART_CORE);
for (const key of EXTENDED_METRIC_KEYS) {
  PART_BY_METRIC.set(key, AE_PART_EXTENDED);
}

/**
 * Module-load invariant: the core/extended partition is exactly
 * `HOST_METRIC_KEYS` — no overlap, no gaps, and both parts fit beside the
 * reserved interval slot. A contract change that breaks the split fails
 * every import of this module, not just a query at runtime.
 */
function assertPartitionCoversHostMetricKeys(): void {
  if (CORE_METRIC_KEYS.length !== AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `CORE_METRIC_KEYS length ${CORE_METRIC_KEYS.length} !== ${AE_METRIC_DOUBLE_SLOT_COUNT}`,
    );
  }
  if (EXTENDED_METRIC_KEYS.length !== AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `EXTENDED_METRIC_KEYS length ${EXTENDED_METRIC_KEYS.length} !== ${AE_METRIC_DOUBLE_SLOT_COUNT}`,
    );
  }
  if (PART_BY_METRIC.size !== HOST_METRIC_KEYS.length) {
    throw new TypeError(
      "core/extended metric parts overlap or miss a HOST_METRIC_KEYS entry",
    );
  }
  for (const key of HOST_METRIC_KEYS) {
    if (!PART_BY_METRIC.has(key)) {
      throw new TypeError(`host metric ${key} is in neither metrics part`);
    }
  }
}
assertPartitionCoversHostMetricKeys();

/** Which metrics part (`"core"` / `"extended"`) stores a host metric. */
export function metricPart(key: HostMetricKey): AeMetricPart {
  const part = PART_BY_METRIC.get(key);
  if (part === undefined) {
    throw new TypeError(`unknown host metrics metric: ${key}`);
  }
  return part;
}

/**
 * AE SQL column name for a host metric key (`double1`..`double19` within its
 * part). Derived from the same ordered arrays as the write path — cannot
 * drift. Callers must pair this with a `blob2 = metricPart(key)` predicate.
 */
export function doubleColumnForMetric(key: HostMetricKey): string {
  const index = PART_KEYS[metricPart(key)].indexOf(key);
  return `double${index + 1}`;
}

/**
 * AE SQL column name for a blob slot (`blob1`..`blob20`).
 * Index is 0-based (same as write-path blob array indices).
 */
export function blobColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_BLOB_COUNT) {
    throw new TypeError(`invalid AE blob index: ${index}`);
  }
  return `blob${index + 1}`;
}

/**
 * AE SQL column name for a double slot (`double1`..`double20`).
 * Index is 0-based (same as write-path doubles array indices).
 */
export function doubleColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_DOUBLE_COUNT) {
    throw new TypeError(`invalid AE double index: ${index}`);
  }
  return `double${index + 1}`;
}

/** AE column for the interval-seconds weight slot (`double20`). */
export function intervalSecondsColumn(): string {
  return doubleColumn(AE_DOUBLE_INTERVAL_INDEX);
}

/** AE column for status-row connected (1/0). */
export function statusConnectedColumn(): string {
  return doubleColumn(AE_DOUBLE_STATUS_CONNECTED_INDEX);
}

/** AE column for status-row transition reason. */
export function statusReasonColumn(): string {
  return blobColumn(AE_BLOB_STATUS_REASON_INDEX);
}

/** Narrow AE data-point shape mirroring Workers `AnalyticsEngineDataPoint`. */
export type AnalyticsEngineDataPointLike = {
  indexes: [string];
  doubles: number[];
  blobs: string[];
};

/**
 * Map one part's metrics to double1..double19 in part-key order, with the
 * sample's `intervalSeconds` in double20.
 * Missing (`null`) → `AE_MISSING_METRIC_SENTINEL` (never 0).
 */
export function mapPartMetricsToDoubles(
  metrics: HostMetrics,
  part: AeMetricPart,
  intervalSeconds: number,
): number[] {
  const doubles: number[] = [];
  for (const key of PART_KEYS[part]) {
    doubles.push(metrics[key] ?? AE_MISSING_METRIC_SENTINEL);
  }
  doubles[AE_DOUBLE_INTERVAL_INDEX] = intervalSeconds;
  return doubles;
}

/**
 * Map sample identity to blob1..blob20 for one metrics part.
 * Reserved / absent slots are empty strings — never null/omitted.
 */
export function mapHostSampleToBlobs(
  sample: AuthenticatedHostMetricsSample,
  part: AeMetricPart,
): string[] {
  const { dimensions } = sample;
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill("");
  blobs[AE_BLOB_EVENT_TYPE_INDEX] = AE_METRICS_EVENT_TYPE;
  blobs[AE_BLOB_PART_INDEX] = part;
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(dimensions.schemaVersion);
  blobs[AE_BLOB_DAEMON_VERSION_INDEX] = dimensions.daemonVersion;
  blobs[AE_BLOB_OS_INDEX] = dimensions.operatingSystem;
  blobs[AE_BLOB_ARCH_INDEX] = dimensions.architecture;
  blobs[AE_BLOB_KERNEL_INDEX] = dimensions.kernelRelease;
  blobs[AE_BLOB_COLLECTION_MODE_INDEX] = sample.collectionMode;
  blobs[AE_BLOB_SAMPLED_AT_INDEX] = sample.at;
  blobs[AE_BLOB_SEQUENCE_INDEX] = String(sample.sequence);
  blobs[AE_BLOB_CPU_TEMPERATURE_SENSOR_INDEX] =
    dimensions.cpuTemperatureSensor ?? "";
  blobs[AE_BLOB_GPU_TEMPERATURE_SENSOR_INDEX] =
    dimensions.gpuTemperatureSensor ?? "";
  blobs[AE_BLOB_CPU_POWER_SENSOR_INDEX] = dimensions.cpuPowerSensor ?? "";
  blobs[AE_BLOB_GPU_POWER_SENSOR_INDEX] = dimensions.gpuPowerSensor ?? "";
  blobs[AE_BLOB_UPLINK_INTERFACES_INDEX] =
    dimensions.uplinkInterfaces?.join(",") ?? "";
  blobs[AE_BLOB_FABRIC_INTERFACES_INDEX] =
    dimensions.fabricInterfaces?.join(",") ?? "";
  return blobs;
}

function buildPartDataPoint(
  sample: AuthenticatedHostMetricsSample,
  part: AeMetricPart,
): AnalyticsEngineDataPointLike {
  const point: AnalyticsEngineDataPointLike = {
    indexes: [sample.serverId],
    doubles: mapPartMetricsToDoubles(
      sample.metrics,
      part,
      sample.intervalSeconds,
    ),
    blobs: mapHostSampleToBlobs(sample, part),
  };
  assertAnalyticsEngineDataPointShape(point);
  return point;
}

/**
 * Build the `blob2 = "core"` AE data point for a validated authenticated host
 * sample. `indexes` is exactly `[serverId]` (canonical UUID only) — never
 * org, account, hostname, composite, metric name, or timestamp.
 */
export function buildCoreDataPoint(
  sample: AuthenticatedHostMetricsSample,
): AnalyticsEngineDataPointLike {
  return buildPartDataPoint(sample, AE_PART_CORE);
}

/** Build the `blob2 = "extended"` AE data point for a host sample. */
export function buildExtendedDataPoint(
  sample: AuthenticatedHostMetricsSample,
): AnalyticsEngineDataPointLike {
  return buildPartDataPoint(sample, AE_PART_EXTENDED);
}

/**
 * Build one AE data point for a connection-status transition.
 *
 * AE stamps its own ingestion `timestamp` — `event.at` is not sent (same
 * asymmetry host samples already have). Remaining doubles are the missing
 * sentinel (never 0 — zero is a legal host value).
 */
export function buildStatusDataPoint(
  event: ServerStatusEvent,
): AnalyticsEngineDataPointLike {
  const doubles = new Array(AE_DOUBLE_COUNT).fill(AE_MISSING_METRIC_SENTINEL);
  doubles[AE_DOUBLE_STATUS_CONNECTED_INDEX] = event.connected ? 1 : 0;

  const blobs: string[] = new Array(AE_BLOB_COUNT).fill("");
  blobs[AE_BLOB_EVENT_TYPE_INDEX] = AE_STATUS_EVENT_TYPE;
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(METRICS_SCHEMA_VERSION);
  blobs[AE_BLOB_STATUS_REASON_INDEX] = event.reason;

  const point: AnalyticsEngineDataPointLike = {
    indexes: [event.serverId],
    doubles,
    blobs,
  };
  assertAnalyticsEngineDataPointShape(point);
  return point;
}

/** Test-only: assert doubles/blobs lengths (used by shape-drift tests). */
export function assertAnalyticsEngineDataPointShape(
  point: { doubles: number[]; blobs: string[] },
): void {
  if (point.doubles.length !== AE_DOUBLE_COUNT) {
    throw new TypeError(
      `AE doubles length ${point.doubles.length} !== ${AE_DOUBLE_COUNT}`,
    );
  }
  if (point.blobs.length !== AE_BLOB_COUNT) {
    throw new TypeError(
      `AE blobs length ${point.blobs.length} !== ${AE_BLOB_COUNT}`,
    );
  }
}
