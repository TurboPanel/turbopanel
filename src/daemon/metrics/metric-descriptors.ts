import type { HostMetricKey } from "./contract.ts";

/** How out-of-range finite values are corrected before storage. */
export type MetricSanitizeBehavior = "clamp" | "null";

/** Logical unit a metric is expressed in (drives formatting + axis labels). */
export type MetricUnit =
  | "percent"
  | "bytes"
  | "bytesPerSecond"
  | "opsPerSecond"
  | "count"
  | "seconds"
  | "celsius"
  | "watts"
  | "load"
  | "milliseconds";

/** How samples combine into a time bucket at query time. */
export type MetricAggregation = "weighted-average" | "last" | "max";

/** UI grouping family for a metric. */
export type MetricFamily =
  | "cpu"
  | "memory"
  | "storage"
  | "network"
  | "hardware"
  | "system";

/**
 * Per-metric storage/query contract: range, sanitization, unit,
 * aggregation, and family. The key set is the allowlist — unknown
 * metrics are never accepted.
 *
 * Physical column names are NOT stored here — per-backend field-map/schema
 * files own the physical layout.
 */
export type HostMetricsMetricDescriptor = {
  key: HostMetricKey;
  min: number;
  max: number;
  sanitize: MetricSanitizeBehavior;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  family: MetricFamily;
  /** When true, non-safe-integers are nulled. */
  requireSafeInteger?: boolean;
};

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
/** Generous finite ceiling for load averages (impossible values → null). */
const LOAD_MAX = 1_000_000;

function percent(key: HostMetricKey): HostMetricsMetricDescriptor {
  return {
    key,
    min: 0,
    max: 100,
    sanitize: "clamp",
    unit: "percent",
    aggregation: "weighted-average",
    family: "cpu",
  };
}

function load(key: HostMetricKey): HostMetricsMetricDescriptor {
  return {
    key,
    min: 0,
    max: LOAD_MAX,
    sanitize: "null",
    unit: "load",
    aggregation: "weighted-average",
    family: "cpu",
  };
}

function nonNegative(
  key: HostMetricKey,
  meta: {
    unit: MetricUnit;
    aggregation: MetricAggregation;
    family: MetricFamily;
    requireSafeInteger?: boolean;
  },
): HostMetricsMetricDescriptor {
  return {
    key,
    min: 0,
    max: SAFE_MAX,
    sanitize: "null",
    unit: meta.unit,
    aggregation: meta.aggregation,
    family: meta.family,
    requireSafeInteger: meta.requireSafeInteger,
  };
}

/** Memory/swap byte gauges chart as values — weighted-average buckets. */
function memoryBytes(key: HostMetricKey): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "bytes",
    aggregation: "weighted-average",
    family: "memory",
  });
}

/** Storage capacity moves slowly — buckets keep the last observed value. */
function storageCapacity(key: HostMetricKey): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "bytes",
    aggregation: "last",
    family: "storage",
  });
}

function rate(
  key: HostMetricKey,
  unit: MetricUnit,
  family: MetricFamily,
): HostMetricsMetricDescriptor {
  return nonNegative(key, { unit, aggregation: "weighted-average", family });
}

function milliseconds(
  key: HostMetricKey,
  family: MetricFamily,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "milliseconds",
    aggregation: "weighted-average",
    family,
  });
}

/** Temperatures may legitimately be negative — bounded, never clamped to 0. */
function temperature(key: HostMetricKey): HostMetricsMetricDescriptor {
  return {
    key,
    min: -100,
    max: 200,
    sanitize: "null",
    unit: "celsius",
    aggregation: "weighted-average",
    family: "hardware",
  };
}

function watts(key: HostMetricKey): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "watts",
    aggregation: "weighted-average",
    family: "hardware",
  });
}

/**
 * Central metric descriptor map — every allowed host metric, its bounds,
 * sanitization behavior, unit, bucket aggregation, and UI family.
 */
export const HOST_METRICS_METRIC_DESCRIPTORS: Record<
  HostMetricKey,
  HostMetricsMetricDescriptor
> = {
  cpuUserPercent: percent("cpuUserPercent"),
  cpuSystemPercent: percent("cpuSystemPercent"),
  cpuNicePercent: percent("cpuNicePercent"),
  cpuIdlePercent: percent("cpuIdlePercent"),
  cpuIowaitPercent: percent("cpuIowaitPercent"),
  cpuIrqPercent: percent("cpuIrqPercent"),
  cpuSoftirqPercent: percent("cpuSoftirqPercent"),
  cpuStealPercent: percent("cpuStealPercent"),
  load1: load("load1"),
  load5: load("load5"),
  load15: load("load15"),
  memoryTotalBytes: memoryBytes("memoryTotalBytes"),
  memoryAvailableBytes: memoryBytes("memoryAvailableBytes"),
  memoryFreeBytes: memoryBytes("memoryFreeBytes"),
  swapTotalBytes: memoryBytes("swapTotalBytes"),
  swapFreeBytes: memoryBytes("swapFreeBytes"),
  systemStorageTotalBytes: storageCapacity("systemStorageTotalBytes"),
  systemStorageAvailableBytes: storageCapacity("systemStorageAvailableBytes"),
  hostingStorageTotalBytes: storageCapacity("hostingStorageTotalBytes"),
  hostingStorageAvailableBytes: storageCapacity(
    "hostingStorageAvailableBytes",
  ),
  dockerStorageTotalBytes: storageCapacity("dockerStorageTotalBytes"),
  dockerStorageAvailableBytes: storageCapacity("dockerStorageAvailableBytes"),
  diskReadBytesPerSecond: rate(
    "diskReadBytesPerSecond",
    "bytesPerSecond",
    "storage",
  ),
  diskWriteBytesPerSecond: rate(
    "diskWriteBytesPerSecond",
    "bytesPerSecond",
    "storage",
  ),
  diskReadOpsPerSecond: rate(
    "diskReadOpsPerSecond",
    "opsPerSecond",
    "storage",
  ),
  diskWriteOpsPerSecond: rate(
    "diskWriteOpsPerSecond",
    "opsPerSecond",
    "storage",
  ),
  diskReadLatencyMs: milliseconds("diskReadLatencyMs", "storage"),
  diskWriteLatencyMs: milliseconds("diskWriteLatencyMs", "storage"),
  uplinkReceiveBytesPerSecond: rate(
    "uplinkReceiveBytesPerSecond",
    "bytesPerSecond",
    "network",
  ),
  uplinkTransmitBytesPerSecond: rate(
    "uplinkTransmitBytesPerSecond",
    "bytesPerSecond",
    "network",
  ),
  fabricReceiveBytesPerSecond: rate(
    "fabricReceiveBytesPerSecond",
    "bytesPerSecond",
    "network",
  ),
  fabricTransmitBytesPerSecond: rate(
    "fabricTransmitBytesPerSecond",
    "bytesPerSecond",
    "network",
  ),
  cpuTemperatureCelsius: temperature("cpuTemperatureCelsius"),
  gpuTemperatureCelsius: temperature("gpuTemperatureCelsius"),
  cpuPowerWatts: watts("cpuPowerWatts"),
  gpuPowerWatts: watts("gpuPowerWatts"),
  // Summary-card "latest process count" is a query-layer concern — buckets
  // still average so charts stay smooth.
  processCount: nonNegative("processCount", {
    unit: "count",
    aggregation: "weighted-average",
    family: "system",
    requireSafeInteger: true,
  }),
  uptimeSeconds: nonNegative("uptimeSeconds", {
    unit: "seconds",
    aggregation: "max",
    family: "system",
    requireSafeInteger: true,
  }),
};

/** Apply descriptor min/max + sanitize behavior to a finite metric value. */
export function sanitizeMetricValue(
  key: HostMetricKey,
  value: number | null,
): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;

  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
  if (descriptor.requireSafeInteger && !Number.isSafeInteger(value)) {
    return null;
  }
  if (value < descriptor.min || value > descriptor.max) {
    if (descriptor.sanitize === "clamp") {
      if (value < descriptor.min) return descriptor.min;
      return descriptor.max;
    }
    return null;
  }
  return value;
}
