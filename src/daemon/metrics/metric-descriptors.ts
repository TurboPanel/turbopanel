import type { HostMetricKey } from "./contract.ts";

/** How out-of-range finite values are corrected before storage. */
export type MetricSanitizeBehavior = "clamp" | "null";

/**
 * Per-metric storage/query contract: range and sanitization.
 * The key set is the allowlist — unknown metrics are never accepted.
 *
 * Physical column names are NOT stored here — `field-map.ts`
 * (`doubleColumnForMetric`) is the single source of the positional
 * `double1..double20` layout shared by Analytics Engine and ClickHouse.
 */
export type HostMetricsMetricDescriptor = {
  key: HostMetricKey;
  min: number;
  max: number;
  sanitize: MetricSanitizeBehavior;
  /** When true, non-safe-integers are nulled. */
  requireSafeInteger?: boolean;
};

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
/** Generous finite ceiling for load averages (impossible values → null). */
const LOAD_MAX = 1_000_000;

function percent(key: HostMetricKey): HostMetricsMetricDescriptor {
  return { key, min: 0, max: 100, sanitize: "clamp" };
}

function load(key: HostMetricKey): HostMetricsMetricDescriptor {
  return { key, min: 0, max: LOAD_MAX, sanitize: "null" };
}

function nonNegative(
  key: HostMetricKey,
  opts?: { requireSafeInteger?: boolean },
): HostMetricsMetricDescriptor {
  return {
    key,
    min: 0,
    max: SAFE_MAX,
    sanitize: "null",
    requireSafeInteger: opts?.requireSafeInteger,
  };
}

/**
 * Central metric descriptor map — every allowed host metric, its bounds, and
 * sanitization behavior.
 */
export const HOST_METRICS_METRIC_DESCRIPTORS: Record<
  HostMetricKey,
  HostMetricsMetricDescriptor
> = {
  cpuUsagePercent: percent("cpuUsagePercent"),
  cpuUserPercent: percent("cpuUserPercent"),
  cpuSystemPercent: percent("cpuSystemPercent"),
  cpuIowaitPercent: percent("cpuIowaitPercent"),
  load1: load("load1"),
  load5: load("load5"),
  load15: load("load15"),
  memoryUsedPercent: percent("memoryUsedPercent"),
  memoryUsedBytes: nonNegative("memoryUsedBytes"),
  memoryAvailableBytes: nonNegative("memoryAvailableBytes"),
  swapUsedPercent: percent("swapUsedPercent"),
  diskUsedPercent: percent("diskUsedPercent"),
  diskReadBytesPerSecond: nonNegative("diskReadBytesPerSecond"),
  diskWriteBytesPerSecond: nonNegative("diskWriteBytesPerSecond"),
  diskReadOpsPerSecond: nonNegative("diskReadOpsPerSecond"),
  diskWriteOpsPerSecond: nonNegative("diskWriteOpsPerSecond"),
  networkReceiveBytesPerSecond: nonNegative("networkReceiveBytesPerSecond"),
  networkTransmitBytesPerSecond: nonNegative("networkTransmitBytesPerSecond"),
  processCount: nonNegative("processCount", {
    requireSafeInteger: true,
  }),
  uptimeSeconds: nonNegative("uptimeSeconds", {
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
