import {
  HOST_METRIC_KEYS,
  type HostMetricKey,
} from "../contract.ts";
import type {
  HostSeriesPoint,
  HostSeriesResult,
  MetricsBackendKind,
} from "../types.ts";
import { bucketFloor } from "./buckets.ts";

export type HostSeriesChartPoint = {
  at: string;
  values: Partial<Record<HostMetricKey, number | null>>;
  /** Deferred — not populated until min/max aggregates are unified across backends. */
  minimums?: Partial<Record<HostMetricKey, number | null>>;
  /** Deferred — not populated until min/max aggregates are unified across backends. */
  maximums?: Partial<Record<HostMetricKey, number | null>>;
  sampleCount: number;
  expectedSampleCount?: number;
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
};

export type ParseRequestedMetricsResult =
  | { ok: true; metrics: HostMetricKey[] }
  | { ok: false; error: string };

const METRIC_KEY_SET = new Set<string>(HOST_METRIC_KEYS);

export function defaultExpectedSamplesPerBucket(
  resolutionSeconds: number,
): number {
  return Math.max(1, Math.round(resolutionSeconds / 60));
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

export function toHostSeriesChartResponse(input: {
  serverId: string;
  from: string;
  to: string;
  result: HostSeriesResult;
}): HostSeriesChartResponse {
  const result = finalizeHostSeriesResult(
    input.from,
    input.to,
    input.result,
  );
  const points: HostSeriesChartPoint[] = result.points.map((point) => ({
    at: point.at,
    values: point.values,
    sampleCount: point.sampleCount ?? 0,
    ...(point.expectedSampleCount !== undefined
      ? { expectedSampleCount: point.expectedSampleCount }
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
