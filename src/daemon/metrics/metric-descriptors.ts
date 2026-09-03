import type { HostMetricKey, MetricPart } from "./contract.ts";
import { HOST_METRIC_KEYS, METRIC_KEY_PARTS } from "./contract.ts";

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
  | "milliseconds"
  | "rpm";

/** How samples combine into a time bucket at query time. */
export type MetricAggregation = "weighted-average" | "last" | "max" | "sum";

/** UI grouping family for a metric. */
export type MetricFamily =
  | "cpu"
  | "memory"
  | "storage"
  | "network"
  | "hardware"
  | "system"
  | "traffic";

/**
 * Per-metric storage/query contract: range, sanitization, unit,
 * aggregation, family, and the `MetricPart` it belongs to. The key set is
 * the allowlist — unknown metrics are never accepted.
 *
 * Physical column names are NOT stored here — per-backend field-map/schema
 * files own the physical layout. `part` is the canonical source later
 * backend phases derive their per-part key groupings from, instead of
 * hand-maintaining separate arrays.
 */
export type HostMetricsMetricDescriptor = {
  key: HostMetricKey;
  min: number;
  max: number;
  sanitize: MetricSanitizeBehavior;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  family: MetricFamily;
  part: MetricPart;
  /** When true, non-safe-integers are nulled. */
  requireSafeInteger?: boolean;
};

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
/** Generous finite ceiling for load averages (impossible values → null). */
const LOAD_MAX = 1_000_000;

function percent(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return {
    key,
    min: 0,
    max: 100,
    sanitize: "clamp",
    unit: "percent",
    aggregation: "weighted-average",
    family: "cpu",
    part,
  };
}

/** Percent-shaped but hardware-family (GPU utilization, not CPU breakdown). */
function hardwarePercent(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return {
    key,
    min: 0,
    max: 100,
    sanitize: "clamp",
    unit: "percent",
    aggregation: "weighted-average",
    family: "hardware",
    part,
  };
}

function load(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return {
    key,
    min: 0,
    max: LOAD_MAX,
    sanitize: "null",
    unit: "load",
    aggregation: "weighted-average",
    family: "cpu",
    part,
  };
}

function nonNegative(
  key: HostMetricKey,
  meta: {
    unit: MetricUnit;
    aggregation: MetricAggregation;
    family: MetricFamily;
    part: MetricPart;
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
    part: meta.part,
    requireSafeInteger: meta.requireSafeInteger,
  };
}

/** Memory/swap byte gauges chart as values — weighted-average buckets. */
function memoryBytes(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "bytes",
    aggregation: "weighted-average",
    family: "memory",
    part,
  });
}

/** Storage capacity moves slowly — buckets keep the last observed value. */
function storageCapacity(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "bytes",
    aggregation: "last",
    family: "storage",
    part,
  });
}

function rate(
  key: HostMetricKey,
  unit: MetricUnit,
  family: MetricFamily,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return nonNegative(key, { unit, aggregation: "weighted-average", family, part });
}

function milliseconds(
  key: HostMetricKey,
  family: MetricFamily,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "milliseconds",
    aggregation: "weighted-average",
    family,
    part,
  });
}

/** Temperatures may legitimately be negative — bounded, never clamped to 0. */
function temperature(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return {
    key,
    min: -100,
    max: 200,
    sanitize: "null",
    unit: "celsius",
    aggregation: "weighted-average",
    family: "hardware",
    part,
  };
}

function watts(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "watts",
    aggregation: "weighted-average",
    family: "hardware",
    part,
  });
}

/** Fan speed gauges — non-negative RPM, weighted-average buckets. */
function fanRpm(
  key: HostMetricKey,
  part: MetricPart,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit: "rpm",
    aggregation: "weighted-average",
    family: "hardware",
    part,
  });
}

/** Monotonic traffic counter — bucketed as a sum, never averaged. */
function trafficCounter(
  key: HostMetricKey,
  unit: MetricUnit,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit,
    aggregation: "sum",
    family: "traffic",
    part: "traffic",
  });
}

/** Traffic gauge (in-flight requests, live connection counts). */
function trafficGauge(
  key: HostMetricKey,
  unit: MetricUnit,
): HostMetricsMetricDescriptor {
  return nonNegative(key, {
    unit,
    aggregation: "weighted-average",
    family: "traffic",
    part: "traffic",
  });
}

/**
 * Central metric descriptor map — every allowed host metric, its bounds,
 * sanitization behavior, unit, bucket aggregation, UI family, and part.
 */
export const HOST_METRICS_METRIC_DESCRIPTORS: Record<
  HostMetricKey,
  HostMetricsMetricDescriptor
> = {
  cpuUserPercent: percent("cpuUserPercent", "core"),
  cpuSystemPercent: percent("cpuSystemPercent", "core"),
  cpuNicePercent: percent("cpuNicePercent", "core"),
  cpuIdlePercent: percent("cpuIdlePercent", "core"),
  cpuIowaitPercent: percent("cpuIowaitPercent", "core"),
  cpuIrqPercent: percent("cpuIrqPercent", "core"),
  cpuSoftirqPercent: percent("cpuSoftirqPercent", "core"),
  cpuStealPercent: percent("cpuStealPercent", "core"),
  load1: load("load1", "core"),
  load5: load("load5", "core"),
  load15: load("load15", "core"),
  memoryTotalBytes: memoryBytes("memoryTotalBytes", "core"),
  memoryAvailableBytes: memoryBytes("memoryAvailableBytes", "core"),
  swapTotalBytes: memoryBytes("swapTotalBytes", "core"),
  swapFreeBytes: memoryBytes("swapFreeBytes", "core"),
  // Summary-card "latest process count" is a query-layer concern — buckets
  // still average so charts stay smooth.
  processCount: nonNegative("processCount", {
    unit: "count",
    aggregation: "weighted-average",
    family: "system",
    part: "core",
    requireSafeInteger: true,
  }),
  uptimeSeconds: nonNegative("uptimeSeconds", {
    unit: "seconds",
    aggregation: "max",
    family: "system",
    part: "core",
    requireSafeInteger: true,
  }),

  systemStorageTotalBytes: storageCapacity(
    "systemStorageTotalBytes",
    "extended",
  ),
  systemStorageAvailableBytes: storageCapacity(
    "systemStorageAvailableBytes",
    "extended",
  ),
  hostingStorageTotalBytes: storageCapacity(
    "hostingStorageTotalBytes",
    "extended",
  ),
  hostingStorageAvailableBytes: storageCapacity(
    "hostingStorageAvailableBytes",
    "extended",
  ),
  dockerStorageTotalBytes: storageCapacity(
    "dockerStorageTotalBytes",
    "extended",
  ),
  dockerStorageAvailableBytes: storageCapacity(
    "dockerStorageAvailableBytes",
    "extended",
  ),
  diskReadBytesPerSecond: rate(
    "diskReadBytesPerSecond",
    "bytesPerSecond",
    "storage",
    "extended",
  ),
  diskWriteBytesPerSecond: rate(
    "diskWriteBytesPerSecond",
    "bytesPerSecond",
    "storage",
    "extended",
  ),
  diskReadOpsPerSecond: rate(
    "diskReadOpsPerSecond",
    "opsPerSecond",
    "storage",
    "extended",
  ),
  diskWriteOpsPerSecond: rate(
    "diskWriteOpsPerSecond",
    "opsPerSecond",
    "storage",
    "extended",
  ),
  diskReadLatencyMs: milliseconds("diskReadLatencyMs", "storage", "extended"),
  diskWriteLatencyMs: milliseconds(
    "diskWriteLatencyMs",
    "storage",
    "extended",
  ),
  interfaceReceiveBytesPerSecond: rate(
    "interfaceReceiveBytesPerSecond",
    "bytesPerSecond",
    "network",
    "extended",
  ),
  interfaceTransmitBytesPerSecond: rate(
    "interfaceTransmitBytesPerSecond",
    "bytesPerSecond",
    "network",
    "extended",
  ),
  fabricReceiveBytesPerSecond: rate(
    "fabricReceiveBytesPerSecond",
    "bytesPerSecond",
    "network",
    "extended",
  ),
  fabricTransmitBytesPerSecond: rate(
    "fabricTransmitBytesPerSecond",
    "bytesPerSecond",
    "network",
    "extended",
  ),
  gpuTemperatureCelsius: temperature("gpuTemperatureCelsius", "extended"),
  gpuPowerWatts: watts("gpuPowerWatts", "extended"),

  cpuTemperatureCelsius: temperature("cpuTemperatureCelsius", "sensors"),
  cpuPowerWatts: watts("cpuPowerWatts", "sensors"),
  gpuUtilizationPercent: hardwarePercent("gpuUtilizationPercent", "sensors"),
  gpuFanRpm: fanRpm("gpuFanRpm", "sensors"),
  disk1TemperatureCelsius: temperature("disk1TemperatureCelsius", "sensors"),
  disk2TemperatureCelsius: temperature("disk2TemperatureCelsius", "sensors"),
  ambient1TemperatureCelsius: temperature(
    "ambient1TemperatureCelsius",
    "sensors",
  ),
  ambient2TemperatureCelsius: temperature(
    "ambient2TemperatureCelsius",
    "sensors",
  ),
  boardTemperatureCelsius: temperature("boardTemperatureCelsius", "sensors"),
  cpuFanRpm: fanRpm("cpuFanRpm", "sensors"),
  systemFan1Rpm: fanRpm("systemFan1Rpm", "sensors"),
  systemFan2Rpm: fanRpm("systemFan2Rpm", "sensors"),
  nic1ReceiveBytesPerSecond: rate(
    "nic1ReceiveBytesPerSecond",
    "bytesPerSecond",
    "network",
    "sensors",
  ),
  nic1TransmitBytesPerSecond: rate(
    "nic1TransmitBytesPerSecond",
    "bytesPerSecond",
    "network",
    "sensors",
  ),
  nic2ReceiveBytesPerSecond: rate(
    "nic2ReceiveBytesPerSecond",
    "bytesPerSecond",
    "network",
    "sensors",
  ),
  nic2TransmitBytesPerSecond: rate(
    "nic2TransmitBytesPerSecond",
    "bytesPerSecond",
    "network",
    "sensors",
  ),

  caddyRequestsTotal: trafficCounter("caddyRequestsTotal", "count"),
  caddyResponses2xxTotal: trafficCounter("caddyResponses2xxTotal", "count"),
  caddyResponses3xxTotal: trafficCounter("caddyResponses3xxTotal", "count"),
  caddyResponses4xxTotal: trafficCounter("caddyResponses4xxTotal", "count"),
  caddyResponses5xxTotal: trafficCounter("caddyResponses5xxTotal", "count"),
  caddyRequestBytesTotal: trafficCounter("caddyRequestBytesTotal", "bytes"),
  caddyResponseBytesTotal: trafficCounter("caddyResponseBytesTotal", "bytes"),
  caddyRequestDurationSecondsSum: trafficCounter(
    "caddyRequestDurationSecondsSum",
    "seconds",
  ),
  caddyRequestsUnder100msTotal: trafficCounter(
    "caddyRequestsUnder100msTotal",
    "count",
  ),
  caddyRequestsUnder1sTotal: trafficCounter(
    "caddyRequestsUnder1sTotal",
    "count",
  ),
  caddyRequestsInFlight: trafficGauge("caddyRequestsInFlight", "count"),
  proxysqlQueriesTotal: trafficCounter("proxysqlQueriesTotal", "count"),
  proxysqlSlowQueriesTotal: trafficCounter(
    "proxysqlSlowQueriesTotal",
    "count",
  ),
  proxysqlConnectionErrorsTotal: trafficCounter(
    "proxysqlConnectionErrorsTotal",
    "count",
  ),
  proxysqlClientConnections: trafficGauge(
    "proxysqlClientConnections",
    "count",
  ),
  proxysqlBackendConnections: trafficGauge(
    "proxysqlBackendConnections",
    "count",
  ),
  proxysqlBackendsUp: trafficGauge("proxysqlBackendsUp", "count"),
};

/**
 * Per-part metric-value slot ceiling. Every backend write layout reserves one
 * slot (`double20`-equivalent) for the sample's `intervalSeconds` out of a
 * 20-slot row, leaving 19 slots for actual metric values on each of the four
 * parts — so no part's descriptors may exceed 19 members.
 */
export const MAX_METRICS_PER_PART = 19;

/**
 * Module-load invariant: every descriptor's `part` groups exactly partition
 * `HOST_METRIC_KEYS` — no gaps, no overlaps, none empty, none over
 * `MAX_METRICS_PER_PART` — so a future key addition that forgets to assign a
 * part, or overflows a part's row budget, fails on import, before any
 * backend even loads.
 */
function assertPartsPartitionHostMetricKeys(): void {
  const seenByPart = new Map<MetricPart, number>();
  for (const key of HOST_METRIC_KEYS) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    if (!descriptor) {
      throw new TypeError(`host metric ${key} has no descriptor`);
    }
    seenByPart.set(descriptor.part, (seenByPart.get(descriptor.part) ?? 0) + 1);
  }
  const parts: MetricPart[] = ["core", "extended", "sensors", "traffic"];
  for (const part of parts) {
    const count = seenByPart.get(part) ?? 0;
    if (!count) {
      throw new TypeError(`metric part ${part} has no descriptor members`);
    }
    if (count > MAX_METRICS_PER_PART) {
      throw new TypeError(
        `metric part ${part} has ${count} descriptor members, exceeding the ${MAX_METRICS_PER_PART}-key per-part ceiling`,
      );
    }
  }
  const total = [...seenByPart.values()].reduce((sum, n) => sum + n, 0);
  if (total !== HOST_METRIC_KEYS.length) {
    throw new TypeError(
      `descriptor parts overlap or miss a HOST_METRIC_KEYS entry (assigned ${total}, expected ${HOST_METRIC_KEYS.length})`,
    );
  }
}
assertPartsPartitionHostMetricKeys();

/**
 * Module-load invariant: `metric-descriptors.ts` and `contract.ts` maintain
 * independent per-key part assignments (the daemon repo has no descriptor
 * module to derive `METRIC_KEY_PARTS` from — see the comment on that map).
 * `validateHostMetricsSample()` enforces part-scoping using descriptor parts,
 * not `METRIC_KEY_PARTS`, so any drift between the two silently rejects
 * legitimate samples. This assertion catches that drift on import instead.
 */
function assertPartsMatchContractMap(): void {
  for (const key of HOST_METRIC_KEYS) {
    const descriptorPart = HOST_METRICS_METRIC_DESCRIPTORS[key].part;
    const contractPart = METRIC_KEY_PARTS[key];
    if (descriptorPart !== contractPart) {
      throw new TypeError(
        `host metric ${key} part mismatch: descriptor says "${descriptorPart}", contract.ts METRIC_KEY_PARTS says "${contractPart}"`,
      );
    }
  }
}
assertPartsMatchContractMap();

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
