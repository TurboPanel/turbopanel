import type {
  HostMetricsDimensions,
  HostMetricKey,
  HostMetrics,
} from "./contract.ts";

export type { HostMetricKey, HostMetrics, HostMetricsDimensions } from "./contract.ts";

export type MetricsBackendKind =
  | "disabled"
  | "analytics-engine"
  | "clickhouse";

/** Authenticated host sample after validation — `serverId` always from auth context. */
export type AuthenticatedHostMetricsSample = {
  serverId: string;
  at: string;
  receivedAt: string;
  intervalSeconds: number;
  sequence: number;
  schemaVersion: 1;
  dimensions: HostMetricsDimensions;
  metrics: HostMetrics;
};

/**
 * Multi-metric series query — one backend call for all requested metrics.
 * `metrics` is bounded by the host metrics allowlist (`HostMetricKey`).
 */
export type HostSeriesQuery = {
  serverId: string;
  metrics: readonly HostMetricKey[];
  from: string;
  to: string;
  resolutionSeconds?: number;
};

/**
 * One bucket timestamp with a values map keyed by requested metric.
 * Per-point `minimums` / `maximums` are deferred — optional on chart payloads only.
 */
export type HostSeriesPoint = {
  at: string;
  values: Partial<Record<HostMetricKey, number | null>>;
  /** Underlying samples contributing to this bucket. */
  sampleCount?: number;
  /** Expected samples for full bucket coverage (gap detection). */
  expectedSampleCount?: number;
};

export type HostSeriesResult = {
  kind: MetricsBackendKind;
  available: boolean;
  serverId: string;
  /** Echo of the metrics requested (allowlist-bounded). */
  metrics: readonly HostMetricKey[];
  points: HostSeriesPoint[];
  resolutionSeconds: number | null;
  /** Number of missing buckets in the resolved resolution grid. */
  gapCount: number;
  /** Number of underlying samples contributing to the series. */
  sampleCount: number;
};

export type HostSummaryQuery = {
  serverId: string;
  from: string;
  to: string;
};

export type HostSummaryResult = {
  kind: MetricsBackendKind;
  available: boolean;
  serverId: string;
  sampleCount: number;
  /** Latest sample timestamp in range, if any. */
  latestAt: string | null;
};

/** Backend-neutral store for host metrics writes and (phase 7) queries. */
export interface ServerMetricsStore {
  writeHostSample(
    input: AuthenticatedHostMetricsSample,
  ): void | Promise<void>;
  queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult>;
  queryHostSummary(input: HostSummaryQuery): Promise<HostSummaryResult>;
}
