/**
 * Cloudflare Analytics Engine positional field map — the single source of
 * truth for the double1..double20 / blob1..blob20 / indexes layout on the
 * `turbopanel_server_host_metrics` dataset.
 *
 * Schema v3 splits the metric allowlist into four `MetricPart`s (`core`,
 * `extended`, `sensors`, `traffic`), each capped at
 * `AE_METRIC_DOUBLE_SLOT_COUNT` (19) values so it fits one AE data point.
 * `core` and `extended` are mandatory on every sample and always written,
 * regardless of how many of their metric values are missing; `sensors`
 * (hardware sensors detected) and `traffic` (sidecars running) are written
 * only when the daemon declares them in `sample.parts` **and** at least one
 * of that part's metric values actually resolved this tick — a declared but
 * entirely-null optional part (every value missing) is never written, so one
 * host sample is **two to four** `writeDataPoint` calls:
 *
 *   blob1 = "metrics", blob2 = "core"      → always
 *   blob1 = "metrics", blob2 = "extended"  → always
 *   blob1 = "metrics", blob2 = "sensors"   → only when declared and non-empty
 *   blob1 = "metrics", blob2 = "traffic"   → only when declared and non-empty
 *
 * Every part reserves `double20` for the sample's `intervalSeconds` so query
 * aggregates can weight by true collection cadence
 * (`SUM(value * double20 * _sample_interval) / SUM(double20 * _sample_interval)`).
 * Connection-status transitions stay single data points (`blob1 = "status"`)
 * on the same dataset.
 *
 * Part → metric-key membership is derived from
 * `HOST_METRICS_METRIC_DESCRIPTORS[key].part` (`metric-descriptors.ts`), not
 * hand-maintained here — a metric's part can never drift between the
 * descriptor map and the physical write layout.
 *
 * External storage contract: never inline positional literals elsewhere;
 * always derive columns and write payloads through this module.
 */

import {
  HOST_METRIC_KEYS,
  type HostMetricKey,
  METRIC_PARTS,
  type MetricPart,
  METRICS_SCHEMA_VERSION,
  type PartialHostMetrics,
} from "../../contract.ts";
import { HOST_METRICS_METRIC_DESCRIPTORS } from "../../metric-descriptors.ts";
import type {
  AuthenticatedHostMetricsSample,
  ServerStatusEvent,
} from "../../types.ts";

/**
 * v3 dataset name — distinct from the retired `turbopanel_server_metrics`
 * (single-datapoint) and `turbopanel_server_telemetry` (two-datapoint core/
 * extended) layouts. AE datasets cannot be deleted, so no query against this
 * dataset ever touches rows from either retired layout.
 */
export const AE_DATASET_NAME = "turbopanel_server_host_metrics";

export const AE_DOUBLE_COUNT = 20;
export const AE_BLOB_COUNT = 20;

/** Metric-value double slots per part (double1..double19). */
export const AE_METRIC_DOUBLE_SLOT_COUNT = 19;

/** double20 on every metrics part — the sample's `intervalSeconds`. */
export const AE_DOUBLE_INTERVAL_INDEX = 19;

/** blob1 — event type discriminator: `"metrics"` or `"status"`. */
export const AE_BLOB_EVENT_TYPE_INDEX = 0;
/** blob2 — metrics part discriminator (`"core"` / `"extended"` / `"sensors"` / `"traffic"`; empty on status rows). */
export const AE_BLOB_PART_INDEX = 1;
/** blob3 — schema version (stringified integer, both event types). */
export const AE_BLOB_SCHEMA_VERSION_INDEX = 2;
/** blob4 — collection mode (`"baseline"` / `"live"`). */
export const AE_BLOB_COLLECTION_MODE_INDEX = 3;
/** blob5 — daemon sample timestamp (wire `at`, ISO string). */
export const AE_BLOB_SAMPLED_AT_INDEX = 4;
/** blob6 — daemon sample sequence (stringified integer). */
export const AE_BLOB_SEQUENCE_INDEX = 5;
/** blob7 — hardware profile generation (stringified integer; sensor/NIC layout epoch). */
export const AE_BLOB_HARDWARE_PROFILE_GENERATION_INDEX = 6;
/**
 * blob8 — `traffic`-part rows only: comma-joined contributing traffic
 * sources (e.g. `"caddy,proxysql"`). Empty on every other part.
 */
export const AE_BLOB_TRAFFIC_SOURCES_INDEX = 7;
/** blob17 — status rows only: {@link ServerStatusEvent.reason} (empty on metrics rows). */
export const AE_BLOB_STATUS_REASON_INDEX = 16;

/** blob9..blob16 stay reserved-empty on every event type (identities now live in Postgres). */
export const AE_RESERVED_MID_BLOB_COUNT = 8;
/** blob18..blob20 stay reserved-empty on every event type. */
export const AE_RESERVED_BLOB_COUNT = 3;

/** blob1 discriminator for host-metrics sample rows. */
export const AE_METRICS_EVENT_TYPE = "metrics";
/** blob1 discriminator for connection-status transition rows. */
export const AE_STATUS_EVENT_TYPE = "status";

/** blob2 discriminator values for the four metrics parts. */
export const AE_PART_CORE = "core";
export const AE_PART_EXTENDED = "extended";
export const AE_PART_SENSORS = "sensors";
export const AE_PART_TRAFFIC = "traffic";

/** Alias kept for call-site stability — identical to the shared `MetricPart`. */
export type AeMetricPart = MetricPart;

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

/** The `core` metrics — double1..doubleN of the `blob2 = "core"` part. */
export const CORE_METRIC_KEYS: readonly HostMetricKey[] = HOST_METRIC_KEYS
  .filter((key) => HOST_METRICS_METRIC_DESCRIPTORS[key].part === "core");

/** The `extended` metrics — double1..doubleN of the `blob2 = "extended"` part. */
export const EXTENDED_METRIC_KEYS: readonly HostMetricKey[] = HOST_METRIC_KEYS
  .filter((key) => HOST_METRICS_METRIC_DESCRIPTORS[key].part === "extended");

/** The `sensors` metrics — double1..doubleN of the `blob2 = "sensors"` part. */
export const SENSOR_METRIC_KEYS: readonly HostMetricKey[] = HOST_METRIC_KEYS
  .filter((key) => HOST_METRICS_METRIC_DESCRIPTORS[key].part === "sensors");

/** The `traffic` metrics — double1..doubleN of the `blob2 = "traffic"` part. */
export const TRAFFIC_METRIC_KEYS: readonly HostMetricKey[] = HOST_METRIC_KEYS
  .filter((key) => HOST_METRICS_METRIC_DESCRIPTORS[key].part === "traffic");

const PART_KEYS: Record<MetricPart, readonly HostMetricKey[]> = {
  [AE_PART_CORE]: CORE_METRIC_KEYS,
  [AE_PART_EXTENDED]: EXTENDED_METRIC_KEYS,
  [AE_PART_SENSORS]: SENSOR_METRIC_KEYS,
  [AE_PART_TRAFFIC]: TRAFFIC_METRIC_KEYS,
};

const PART_BY_METRIC = new Map<HostMetricKey, MetricPart>(
  HOST_METRIC_KEYS.map((
    key,
  ) => [key, HOST_METRICS_METRIC_DESCRIPTORS[key].part]),
);

/**
 * Module-load invariant: every part's key array is non-empty and fits within
 * `AE_METRIC_DOUBLE_SLOT_COUNT`, and the four arrays partition
 * `HOST_METRIC_KEYS` exactly (no gaps, no overlap). Since the arrays are
 * derived by filtering `HOST_METRIC_KEYS` on the descriptor's `part`, the
 * partition property holds by construction — this only catches an empty or
 * over-full part, plus mirrors `metric-descriptors.ts`'s own
 * `assertPartsPartitionHostMetricKeys` so drift is caught at daemon-repo
 * import time too, since this module keeps its own copy of the layout.
 */
function assertPartKeysPartitionHostMetricKeys(): void {
  let total = 0;
  for (const part of METRIC_PARTS) {
    const keys = PART_KEYS[part];
    if (keys.length < 1 || keys.length > AE_METRIC_DOUBLE_SLOT_COUNT) {
      throw new TypeError(
        `metric part ${part} has ${keys.length} keys, outside the 1..${AE_METRIC_DOUBLE_SLOT_COUNT} per-part range`,
      );
    }
    total += keys.length;
  }
  if (total !== HOST_METRIC_KEYS.length) {
    throw new TypeError(
      `field-map part key arrays overlap or miss a HOST_METRIC_KEYS entry (assigned ${total}, expected ${HOST_METRIC_KEYS.length})`,
    );
  }
  for (const key of HOST_METRIC_KEYS) {
    if (PART_BY_METRIC.get(key) === undefined) {
      throw new TypeError(
        `host metric ${key} is in no metrics part (field-map.ts)`,
      );
    }
  }
}
assertPartKeysPartitionHostMetricKeys();

/** Which metrics part (`"core"` / `"extended"` / `"sensors"` / `"traffic"`) stores a host metric. */
export function metricPart(key: HostMetricKey): MetricPart {
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
 * Missing (`null` or absent, since `metrics` is a `PartialHostMetrics`) →
 * `AE_MISSING_METRIC_SENTINEL` (never 0).
 */
export function mapPartMetricsToDoubles(
  metrics: PartialHostMetrics,
  part: MetricPart,
  intervalSeconds: number,
): number[] {
  // Every part has at most `AE_METRIC_DOUBLE_SLOT_COUNT` (19) keys, but a
  // part with fewer than 19 (all four, now that the layout isn't a fixed
  // 19/19 split) leaves a gap between its last metric slot and double20 —
  // pre-fill the whole row with the sentinel first so that gap is never a
  // sparse-array hole (which `Array.prototype.map`/`join` silently drop,
  // corrupting the AE write payload and any SQL literal built from it).
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  PART_KEYS[part].forEach((key, i) => {
    doubles[i] = metrics[key] ?? AE_MISSING_METRIC_SENTINEL;
  });
  doubles[AE_DOUBLE_INTERVAL_INDEX] = intervalSeconds;
  return doubles;
}

/**
 * Map sample identity to blob1..blob20 for one metrics part.
 * Reserved / absent slots are empty strings — never null/omitted.
 */
export function mapHostSampleToBlobs(
  sample: AuthenticatedHostMetricsSample,
  part: MetricPart,
): string[] {
  const { dimensions } = sample;
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill("");
  blobs[AE_BLOB_EVENT_TYPE_INDEX] = AE_METRICS_EVENT_TYPE;
  blobs[AE_BLOB_PART_INDEX] = part;
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(dimensions.schemaVersion);
  blobs[AE_BLOB_COLLECTION_MODE_INDEX] = sample.collectionMode;
  blobs[AE_BLOB_SAMPLED_AT_INDEX] = sample.at;
  blobs[AE_BLOB_SEQUENCE_INDEX] = String(sample.sequence);
  blobs[AE_BLOB_HARDWARE_PROFILE_GENERATION_INDEX] = String(
    dimensions.hardwareProfileGeneration,
  );
  if (part === AE_PART_TRAFFIC) {
    blobs[AE_BLOB_TRAFFIC_SOURCES_INDEX] = sample.trafficSources?.join(",") ??
      "";
  }
  return blobs;
}

/** Build the AE data point for one declared metrics part of a host sample. */
export function buildPartDataPoint(
  sample: AuthenticatedHostMetricsSample,
  part: MetricPart,
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

/** Parts written unconditionally, even when every one of their metric values is missing. */
const MANDATORY_PARTS: ReadonlySet<MetricPart> = new Set([
  AE_PART_CORE,
  AE_PART_EXTENDED,
]);

/**
 * True when every metric-value slot (`double1`..`double19`) of a part's AE
 * point is the missing sentinel — the reserved `double20` interval slot is
 * never part of this check, since it always carries a real value.
 */
function isPartEntirelyMissing(doubles: readonly number[]): boolean {
  for (let i = 0; i < AE_METRIC_DOUBLE_SLOT_COUNT; i++) {
    if (doubles[i] !== AE_MISSING_METRIC_SENTINEL) return false;
  }
  return true;
}

/**
 * Build one AE data point per part declared in `sample.parts` — always
 * `core` and `extended` (validation guarantees both, written even if every
 * metric in them is missing), plus `sensors` and/or `traffic` only when the
 * daemon declared them for this sample **and** at least one of that part's
 * metric values actually resolved this tick. A declared optional part whose
 * every metric sanitized to `null` never reaches `writeDataPoint` — writing
 * it would be a wasted row with no queryable signal, in violation of the
 * row-budget the four-part split exists to enforce. Output order is the
 * canonical `METRIC_PARTS` order, not `sample.parts`'s declaration order.
 */
export function buildPartDataPoints(
  sample: AuthenticatedHostMetricsSample,
): AnalyticsEngineDataPointLike[] {
  const declared = new Set(sample.parts);
  const points: AnalyticsEngineDataPointLike[] = [];
  for (const part of METRIC_PARTS) {
    if (!declared.has(part)) continue;
    const point = buildPartDataPoint(sample, part);
    if (!MANDATORY_PARTS.has(part) && isPartEntirelyMissing(point.doubles)) {
      continue;
    }
    points.push(point);
  }
  return points;
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
