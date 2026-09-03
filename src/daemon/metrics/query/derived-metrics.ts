/**
 * Backend-neutral derived-value math for chart/summary route responses.
 *
 * Every derivation is pure and consumed only at the route layer (never fed
 * back into `HostSeriesResult` / `FleetHostSnapshotResult`) — the metrics
 * backends stay unaware of CPU-catalog/override data and unit-conversion
 * concerns. A derived value is `null` whenever any input it needs is missing
 * or a denominator would be zero — never coerced to `0`, the same discipline
 * `sanitizeFinite` applies to raw metrics in `contract.ts`.
 */

import type { HostMetricKey } from "../contract.ts";

export type DerivedHostValues = {
  cpuUsagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryUsedPercent: number | null;
  swapUsedBytes: number | null;
  swapUsedPercent: number | null;
  systemStorageUsedBytes: number | null;
  systemStorageUsedPercent: number | null;
  hostingStorageUsedBytes: number | null;
  hostingStorageUsedPercent: number | null;
  dockerStorageUsedBytes: number | null;
  dockerStorageUsedPercent: number | null;
  httpErrorRatePercent: number | null;
  httpAverageLatencyMs: number | null;
};

function usedBytes(
  totalBytes: number | null | undefined,
  availableBytes: number | null | undefined,
): number | null {
  if (
    totalBytes === null || totalBytes === undefined ||
    availableBytes === null || availableBytes === undefined
  ) {
    return null;
  }
  return totalBytes - availableBytes;
}

function usedPercent(
  used: number | null,
  totalBytes: number | null | undefined,
): number | null {
  if (
    used === null || totalBytes === null || totalBytes === undefined ||
    totalBytes <= 0
  ) {
    return null;
  }
  return (used / totalBytes) * 100;
}

/** Compute all route-layer derived values from a raw metric-value map. */
export function computeDerivedHostValues(
  values: Partial<Record<HostMetricKey, number | null>>,
): DerivedHostValues {
  const cpuIdlePercent = values.cpuIdlePercent;
  const cpuUsagePercent =
    cpuIdlePercent === null || cpuIdlePercent === undefined
      ? null
      : 100 - cpuIdlePercent;

  const memoryUsedBytes = usedBytes(
    values.memoryTotalBytes,
    values.memoryAvailableBytes,
  );
  const swapUsedBytes = usedBytes(values.swapTotalBytes, values.swapFreeBytes);
  const systemStorageUsedBytes = usedBytes(
    values.systemStorageTotalBytes,
    values.systemStorageAvailableBytes,
  );
  const hostingStorageUsedBytes = usedBytes(
    values.hostingStorageTotalBytes,
    values.hostingStorageAvailableBytes,
  );
  const dockerStorageUsedBytes = usedBytes(
    values.dockerStorageTotalBytes,
    values.dockerStorageAvailableBytes,
  );

  const requestsTotal = values.caddyRequestsTotal;
  const errorCount =
    values.caddyResponses4xxTotal === null ||
      values.caddyResponses4xxTotal === undefined ||
      values.caddyResponses5xxTotal === null ||
      values.caddyResponses5xxTotal === undefined
      ? null
      : values.caddyResponses4xxTotal + values.caddyResponses5xxTotal;
  const httpErrorRatePercent =
    errorCount === null || requestsTotal === null ||
      requestsTotal === undefined || requestsTotal === 0
      ? null
      : (errorCount / requestsTotal) * 100;

  const durationSecondsSum = values.caddyRequestDurationSecondsSum;
  const httpAverageLatencyMs =
    durationSecondsSum === null || durationSecondsSum === undefined ||
      requestsTotal === null || requestsTotal === undefined ||
      requestsTotal === 0
      ? null
      : (durationSecondsSum / requestsTotal) * 1000;

  return {
    cpuUsagePercent,
    memoryUsedBytes,
    memoryUsedPercent: usedPercent(memoryUsedBytes, values.memoryTotalBytes),
    swapUsedBytes,
    swapUsedPercent: usedPercent(swapUsedBytes, values.swapTotalBytes),
    systemStorageUsedBytes,
    systemStorageUsedPercent: usedPercent(
      systemStorageUsedBytes,
      values.systemStorageTotalBytes,
    ),
    hostingStorageUsedBytes,
    hostingStorageUsedPercent: usedPercent(
      hostingStorageUsedBytes,
      values.hostingStorageTotalBytes,
    ),
    dockerStorageUsedBytes,
    dockerStorageUsedPercent: usedPercent(
      dockerStorageUsedBytes,
      values.dockerStorageTotalBytes,
    ),
    httpErrorRatePercent,
    httpAverageLatencyMs,
  };
}

export type ThermalHeadroomInput = {
  valueCelsius: number | null;
  limitCelsius: number | null;
};

export type PowerHeadroomInput = {
  valueWatts: number | null;
  limitWatts: number | null;
};

/**
 * `((limit − value) / limit) * 100` — positive means headroom remains,
 * negative means the reading exceeds the limit. `null` when either input is
 * `null` or the limit is `≤ 0` (a zero/negative limit has no meaningful
 * percentage denominator).
 */
export function computeThermalHeadroom(
  input: ThermalHeadroomInput,
): number | null {
  if (
    input.valueCelsius === null || input.limitCelsius === null ||
    input.limitCelsius <= 0
  ) {
    return null;
  }
  return ((input.limitCelsius - input.valueCelsius) / input.limitCelsius) *
    100;
}

/** Same shape as {@link computeThermalHeadroom}, for watts vs TDP. */
export function computePowerHeadroom(
  input: PowerHeadroomInput,
): number | null {
  if (
    input.valueWatts === null || input.limitWatts === null ||
    input.limitWatts <= 0
  ) {
    return null;
  }
  return ((input.limitWatts - input.valueWatts) / input.limitWatts) * 100;
}
