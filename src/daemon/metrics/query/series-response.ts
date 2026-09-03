import {
  HOST_METRIC_KEYS,
  type HostMetricKey,
  type MetricPart,
} from "../contract.ts";
import type {
  HostSeriesPoint,
  HostSeriesResult,
  MetricsBackendKind,
} from "../types.ts";
import { bucketFloor } from "./buckets.ts";
import {
  computeDerivedHostValues,
  computePowerHeadroom,
  computeThermalHeadroom,
  type DerivedHostValues,
} from "./derived-metrics.ts";

/**
 * Server-computed presentation values for one series point — so the UI never
 * reimplements CPU busy / memory-swap-storage used / HTTP error rate /
 * average latency, or CPU thermal/power headroom. Headroom is `null` when
 * `cpuLimits` was not passed to {@link toHostSeriesChartResponse} (no
 * resolved TDP/Tjmax for this host) as well as when the point carries no
 * sensor reading — same "missing input" discipline as `derived-metrics.ts`.
 */
export type HostSeriesChartPointDerived = DerivedHostValues & {
  cpuThermalHeadroomPercent: number | null;
  cpuPowerHeadroomPercent: number | null;
};

export type HostSeriesChartPoint = {
  at: string;
  values: Partial<Record<HostMetricKey, number | null>>;
  /** Deferred — not populated until min/max aggregates are unified across backends. */
  minimums?: Partial<Record<HostMetricKey, number | null>>;
  /** Deferred — not populated until min/max aggregates are unified across backends. */
  maximums?: Partial<Record<HostMetricKey, number | null>>;
  /** Server-computed presentation values derived from `values` — see {@link HostSeriesChartPointDerived}. */
  derived: HostSeriesChartPointDerived;
  sampleCount: number;
  expectedSampleCount?: number;
  /**
   * Hardware-profile generation shared by every contributing sample in this
   * bucket — see {@link HostSeriesPoint.hardwareProfileGeneration}. Omitted
   * when the backend doesn't track generations.
   */
  hardwareProfileGeneration?: number | null;
};

export type HostSeriesChartResponse = {
  ok: true;
  serverId: string;
  from: string;
  to: string;
  resolutionSeconds: number | null;
  backend: MetricsBackendKind;
  available: boolean;
  metrics: readonly HostMetricKey[];
  sampleCount: number;
  gapCount: number;
  points: HostSeriesChartPoint[];
  /**
   * Point indices where `hardwareProfileGeneration` differs from the
   * previous known generation — a boundary marker so the UI can segment
   * chart continuity without inferring it from raw generation numbers
   * itself. See {@link computeGenerationBreaks}.
   */
  generationBreaks: number[];
  /**
   * Distinct hardware-profile generations observed anywhere in the queried
   * range — see {@link HostSeriesResult.hardwareProfileGenerations}. Omitted
   * when the backend doesn't track generations.
   */
  hardwareProfileGenerations?: number[];
};

export type ParseRequestedMetricsResult =
  | { ok: true; metrics: HostMetricKey[] }
  | { ok: false; error: string };

const METRIC_KEY_SET = new Set<string>(HOST_METRIC_KEYS);

/**
 * Expected samples per bucket. Buckets with data pass their observed average
 * collection interval so live (fast-cadence) sessions do not read as
 * over-full against a 60 s assumption; buckets with no points have no
 * observed interval and keep the baseline 60 s default.
 */
export function defaultExpectedSamplesPerBucket(
  resolutionSeconds: number,
  avgIntervalSeconds = 60,
): number {
  const interval =
    Number.isFinite(avgIntervalSeconds) && avgIntervalSeconds > 0
      ? avgIntervalSeconds
      : 60;
  return Math.max(1, Math.round(resolutionSeconds / interval));
}

/**
 * Count fully missing buckets and partial buckets on the canonical grid.
 *
 * The range is half-open `[from, to)` on bucket starts after floor alignment.
 * Inclusive end would always expect the in-progress `to` bucket on live charts
 * (e.g. 1 h @ 60 s → 61 slots), so coverage could almost never hit 100%.
 */
export function computeSeriesGapCount(input: {
  fromMs: number;
  toMs: number;
  resolutionSeconds: number;
  points: readonly Pick<
    HostSeriesPoint,
    "at" | "sampleCount" | "expectedSampleCount"
  >[];
}): number {
  const bucketMs = input.resolutionSeconds * 1000;
  const startMs = bucketFloor(input.fromMs, input.resolutionSeconds);
  const endMs = bucketFloor(input.toMs, input.resolutionSeconds);
  if (endMs <= startMs) return 0;

  const pointByBucket = new Map<
    number,
    { sampleCount: number; expectedSampleCount: number }
  >();
  for (const point of input.points) {
    const atMs = Date.parse(point.at);
    if (!Number.isFinite(atMs)) continue;
    const bucketStart = bucketFloor(atMs, input.resolutionSeconds);
    const expected = point.expectedSampleCount ??
      defaultExpectedSamplesPerBucket(input.resolutionSeconds);
    const samples = point.sampleCount ?? 0;
    pointByBucket.set(bucketStart, {
      sampleCount: samples,
      expectedSampleCount: expected,
    });
  }

  const defaultExpected = defaultExpectedSamplesPerBucket(
    input.resolutionSeconds,
  );
  let gapCount = 0;
  for (let bucket = startMs; bucket < endMs; bucket += bucketMs) {
    const existing = pointByBucket.get(bucket);
    if (!existing) {
      gapCount += defaultExpected;
      continue;
    }
    if (existing.sampleCount < existing.expectedSampleCount) {
      gapCount += existing.expectedSampleCount - existing.sampleCount;
    }
  }
  return gapCount;
}

export function finalizeHostSeriesResult(
  from: string,
  to: string,
  result: HostSeriesResult,
): HostSeriesResult {
  if (!result.available || result.resolutionSeconds === null) {
    return result;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return result;
  }
  return {
    ...result,
    gapCount: computeSeriesGapCount({
      fromMs,
      toMs,
      resolutionSeconds: result.resolutionSeconds,
      points: result.points,
    }),
  };
}

export function parseRequestedMetrics(
  raw: string | undefined,
): ParseRequestedMetricsResult {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, metrics: [...HOST_METRIC_KEYS] };
  }
  const names = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (names.length === 0) {
    return { ok: true, metrics: [...HOST_METRIC_KEYS] };
  }
  const metrics: HostMetricKey[] = [];
  for (const name of names) {
    if (!METRIC_KEY_SET.has(name)) {
      return { ok: false, error: `unknown metrics metric: ${name}` };
    }
    metrics.push(name as HostMetricKey);
  }
  return { ok: true, metrics };
}

/**
 * Indices where `hardwareProfileGeneration` differs from the previous
 * *known* generation (a `null`/`undefined` entry is "unknown" and never
 * itself a break — it neither starts nor ends a segment). The first point
 * establishing a known generation is never a break (nothing precedes it to
 * differ from).
 */
export function computeGenerationBreaks(
  points: readonly { hardwareProfileGeneration?: number | null }[],
): number[] {
  const breaks: number[] = [];
  let lastKnown: number | undefined;
  for (let i = 0; i < points.length; i++) {
    const generation = points[i].hardwareProfileGeneration;
    if (generation === null || generation === undefined) continue;
    if (lastKnown !== undefined && generation !== lastKnown) {
      breaks.push(i);
    }
    lastKnown = generation;
  }
  return breaks;
}

/**
 * True when at least one point in the queried range declared the
 * `"sensors"` part — lets the UI hide the hardware group when the daemon
 * never once reported hardware sensors, without scanning null value arrays
 * itself. `false` on a backend that doesn't track `partsPresent` (every
 * point omits it) — same as "never declared".
 */
export function computeSensorsAvailable(
  points: readonly { partsPresent?: MetricPart[] }[],
): boolean {
  return points.some((point) => point.partsPresent?.includes("sensors") ?? false);
}

export function toHostSeriesChartResponse(input: {
  serverId: string;
  from: string;
  to: string;
  result: HostSeriesResult;
  /** Resolved CPU thermal/power limits — omitted when unresolved for this host. */
  cpuLimits?: { tdpWatts: number | null; tjMaxCelsius: number | null };
}): HostSeriesChartResponse {
  const result = finalizeHostSeriesResult(
    input.from,
    input.to,
    input.result,
  );
  const points: HostSeriesChartPoint[] = result.points.map((point) => ({
    at: point.at,
    values: point.values,
    derived: {
      ...computeDerivedHostValues(point.values),
      cpuThermalHeadroomPercent: computeThermalHeadroom({
        valueCelsius: point.values.cpuTemperatureCelsius ?? null,
        limitCelsius: input.cpuLimits?.tjMaxCelsius ?? null,
      }),
      cpuPowerHeadroomPercent: computePowerHeadroom({
        valueWatts: point.values.cpuPowerWatts ?? null,
        limitWatts: input.cpuLimits?.tdpWatts ?? null,
      }),
    },
    sampleCount: point.sampleCount ?? 0,
    ...(point.expectedSampleCount !== undefined
      ? { expectedSampleCount: point.expectedSampleCount }
      : {}),
    ...(point.hardwareProfileGeneration !== undefined
      ? { hardwareProfileGeneration: point.hardwareProfileGeneration }
      : {}),
  }));

  return {
    ok: true,
    serverId: input.serverId,
    from: input.from,
    to: input.to,
    resolutionSeconds: result.resolutionSeconds,
    backend: result.kind,
    available: result.available,
    metrics: result.metrics,
    sampleCount: result.sampleCount,
    gapCount: result.gapCount,
    points,
    generationBreaks: computeGenerationBreaks(points),
    ...(result.hardwareProfileGenerations !== undefined
      ? { hardwareProfileGenerations: result.hardwareProfileGenerations }
      : {}),
  };
}

export type HostSummaryChartResponse = {
  ok: true;
  serverId: string;
  from: string;
  to: string;
  backend: MetricsBackendKind;
  available: boolean;
  sampleCount: number;
  latestAt: string | null;
};
