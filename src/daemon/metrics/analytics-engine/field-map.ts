/**
 * Analytics Engine positional field map — the single source of truth for
 * double1..double20 / blob1..blob20 / indexes layout.
 *
 * External storage contract: never inline positional literals elsewhere;
 * always derive columns and write payloads through this module.
 */

import {
  HOST_METRIC_KEYS,
  type HostMetricsDimensions,
  type HostMetricKey,
  type HostMetrics,
} from "../contract.ts";
import type { AuthenticatedHostMetricsSample } from "../types.ts";

/** blob1 — event type discriminator. */
export const AE_BLOB_EVENT_TYPE_INDEX = 0;
/** blob2 — schema version (stringified integer). */
export const AE_BLOB_SCHEMA_VERSION_INDEX = 1;
/** blob3 — daemon version string. */
export const AE_BLOB_DAEMON_VERSION_INDEX = 2;
/** blob4 — operating system. */
export const AE_BLOB_OS_INDEX = 3;
/** blob5 — architecture. */
export const AE_BLOB_ARCH_INDEX = 4;
/** blob6 — kernel release. */
export const AE_BLOB_KERNEL_INDEX = 5;

/**
 * blob7..blob20 are reserved-empty until schema version 2.
 * blob1..blob6 are positional storage-contract identity dimensions.
 */
export const AE_RESERVED_BLOB_COUNT = 14;

export const AE_HOST_EVENT_TYPE = "host";

export const AE_DATASET_NAME = "turbopanel_server_metrics";

export const AE_DOUBLE_COUNT = 20;
export const AE_BLOB_COUNT = 20;

/**
 * Physical column name for the authenticated serverId identity slot.
 *
 * On Analytics Engine this is `indexes[0]` (`index1` in the SQL read path);
 * ClickHouse reuses the exact same physical name so both backends share this
 * single source of truth (no custom snake_case mapping).
 */
export const AE_INDEX_SERVER_ID_COLUMN = "index1";

/** Physical column name for the sample timestamp (shared AE + ClickHouse). */
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

/** Narrow AE data-point shape mirroring Workers `AnalyticsEngineDataPoint`. */
export type AnalyticsEngineDataPointLike = {
  indexes: [string];
  doubles: number[];
  blobs: string[];
};

/**
 * Map host metrics to double1..double20 in `HOST_METRIC_KEYS` order.
 * Missing (`null`) → `AE_MISSING_METRIC_SENTINEL` (never 0).
 */
export function mapHostMetricsToDoubles(
  metrics: HostMetrics,
): number[] {
  const doubles: number[] = [];
  for (const key of HOST_METRIC_KEYS) {
    const value = metrics[key];
    doubles.push(value ?? AE_MISSING_METRIC_SENTINEL);
  }
  return doubles;
}

/**
 * Map identity dimensions to blob1..blob20.
 * Reserved slots (blob7..blob20) are empty strings — never null/omitted.
 */
export function mapHostDimensionsToBlobs(
  dimensions: HostMetricsDimensions,
): string[] {
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill("");
  blobs[AE_BLOB_EVENT_TYPE_INDEX] = AE_HOST_EVENT_TYPE;
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(dimensions.schemaVersion);
  blobs[AE_BLOB_DAEMON_VERSION_INDEX] = dimensions.daemonVersion;
  blobs[AE_BLOB_OS_INDEX] = dimensions.operatingSystem;
  blobs[AE_BLOB_ARCH_INDEX] = dimensions.architecture;
  blobs[AE_BLOB_KERNEL_INDEX] = dimensions.kernelRelease;
  return blobs;
}

/**
 * Build one AE data point for a validated authenticated host sample.
 *
 * `indexes` is exactly `[serverId]` (canonical UUID only) — never org, account,
 * hostname, composite, metric name, or timestamp.
 */
export function buildAnalyticsEngineDataPoint(
  sample: AuthenticatedHostMetricsSample,
): AnalyticsEngineDataPointLike {
  const doubles = mapHostMetricsToDoubles(sample.metrics);
  const blobs = mapHostDimensionsToBlobs(sample.dimensions);
  if (doubles.length !== AE_DOUBLE_COUNT) {
    throw new TypeError(
      `AE doubles length ${doubles.length} !== ${AE_DOUBLE_COUNT}`,
    );
  }
  if (blobs.length !== AE_BLOB_COUNT) {
    throw new TypeError(
      `AE blobs length ${blobs.length} !== ${AE_BLOB_COUNT}`,
    );
  }
  return {
    indexes: [sample.serverId],
    doubles,
    blobs,
  };
}

/**
 * AE SQL column name for a host metric key (`double1`..`double20`).
 * Derived from the same ordered array as the write path — cannot drift.
 */
export function doubleColumnForMetric(key: HostMetricKey): string {
  const index = HOST_METRIC_KEYS.indexOf(key);
  if (index < 0) {
    throw new TypeError(`unknown host metrics metric: ${key}`);
  }
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
