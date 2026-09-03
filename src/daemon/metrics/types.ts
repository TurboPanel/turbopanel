import type {
  HostMetricKey,
  HostMetricsDimensions,
  MetricPart,
  METRICS_SCHEMA_VERSION,
  MetricsCollectionMode,
  PartialHostMetrics,
} from "./contract.ts";

export type {
  HostMetricKey,
  HostMetrics,
  HostMetricsDimensions,
  MetricPart,
  MetricsCollectionMode,
  PartialHostMetrics,
} from "./contract.ts";

/** Live cadence granted to a lease holder, in seconds. */
export const METRICS_LIVE_INTERVAL_SECONDS = 10;

/** Success body of `POST /servers/:id/metrics/live` (start/renew a lease). */
export type MetricsLiveLeaseStartResponse = {
  ok: true;
  leaseId: string;
  intervalSeconds: typeof METRICS_LIVE_INTERVAL_SECONDS;
  expiresAt: string;
};

// This file is backend-neutral by design: no physical storage tokens
// (doubleN/blobN/indexN column names, AnalyticsEngineDataPoint, DuckDB DDL)
// may appear here — those live in per-backend field-map/schema files.
export type MetricsBackendKind =
  | "disabled"
  | "analytics-engine"
  | "duckdb";

/** Authenticated host sample after validation — `serverId` always from auth context. */
export type AuthenticatedHostMetricsSample = {
  serverId: string;
  at: string;
  /** Daemon sample time (copy of wire `at`) — stored beside `receivedAt`. */
  sampledAt: string;
  receivedAt: string;
  intervalSeconds: number;
  sequence: number;
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  /** Mirrored from `dimensions.collectionMode` for convenient store access. */
  collectionMode: MetricsCollectionMode;
  /** Metric groupings declared by the daemon for this sample. */
  parts: MetricPart[];
  dimensions: HostMetricsDimensions;
  metrics: PartialHostMetrics;
  /**
   * Contributing traffic sources (e.g. `["caddy", "proxysql"]`) — only
   * meaningful when `parts` includes `"traffic"`; written to `blob8` on the
   * `traffic` part's AE data point (see `backends/cloudflare/field-map.ts`).
   */
  trafficSources?: string[];
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
  /**
   * Parts declared by at least one contributing sample in this bucket — lets
   * a consumer tell "part never collected" (absent here) apart from "part
   * collected, value missing" (present here, `values[key]` still `null`)
   * without touching the value map itself. Omitted when the backend doesn't
   * track parts.
   */
  partsPresent?: MetricPart[];
  /**
   * Hardware-profile generation shared by every contributing sample in this
   * bucket, or `null` when it's unknown or the bucket spans a hardware
   * reassignment (mixed generations) — a boundary marker so a consumer can
   * break series continuity there. Omitted when the backend doesn't track
   * generations.
   */
  hardwareProfileGeneration?: number | null;
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
  /**
   * Distinct hardware-profile generations observed anywhere in the queried
   * range, sorted ascending — `length > 1` means the server was reassigned
   * during the window. Omitted when the backend doesn't track generations.
   */
  hardwareProfileGenerations?: number[];
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

/**
 * One AE/DuckDB query for recent host usage across many servers.
 * Used by the org servers overview — never N per-server chart calls.
 */
export type FleetHostSnapshotQuery = {
  serverIds: readonly string[];
  metrics: readonly HostMetricKey[];
  from: string;
  to: string;
};

export type FleetHostSnapshotServer = {
  serverId: string;
  latestAt: string | null;
  values: Partial<Record<HostMetricKey, number | null>>;
  sampleCount: number;
  /**
   * Parts declared by at least one contributing sample in the queried
   * window — see {@link HostSeriesPoint.partsPresent}. Omitted when the
   * backend doesn't track parts.
   */
  partsPresent?: MetricPart[];
  /**
   * Hardware-profile generation shared by every contributing sample in the
   * queried window, or `null` when unknown or mixed (a reassignment
   * happened inside the window). Omitted when the backend doesn't track
   * generations.
   */
  hardwareProfileGeneration?: number | null;
};

export type FleetHostSnapshotResult = {
  kind: MetricsBackendKind;
  available: boolean;
  metrics: readonly HostMetricKey[];
  servers: FleetHostSnapshotServer[];
};

/** Why a `connected` boolean flipped — closed enum for status-stream rows. */
export type ServerStatusTransitionReason =
  | "connect"
  | "disconnect"
  | "sweep_stale"
  | "self_heal";

/** Validated connection-status transition written to AE / DuckDB. */
export type ServerStatusEvent = {
  serverId: string;
  connected: boolean;
  reason: ServerStatusTransitionReason;
  at: string;
};

export type StatusHistoryQuery = {
  serverId: string;
  from: string;
  to: string;
};

export type StatusHistoryEvent = {
  at: string;
  connected: boolean;
  reason: ServerStatusTransitionReason;
};

/**
 * Connection history + uptime totals for a range.
 *
 * `initialConnected === null` means state before `from` is unknown — that span
 * accrues to `unknownSeconds`, never to uptime or downtime.
 */
export type StatusHistoryResult = {
  kind: MetricsBackendKind;
  available: boolean;
  serverId: string;
  initialConnected: boolean | null;
  events: StatusHistoryEvent[];
  uptimeSeconds: number;
  downtimeSeconds: number;
  unknownSeconds: number;
  uptimePercent: number | null;
  truncated: boolean;
};

/**
 * Backend-neutral store for host metrics and connection-status events.
 *
 * `writeHostSample` / `writeStatusEvent` are fire-and-forget — callers must
 * not await them into WS / request handlers (same discipline as host writes).
 */
export interface ServerMetricsStore {
  writeHostSample(
    input: AuthenticatedHostMetricsSample,
  ): void | Promise<void>;
  writeStatusEvent(input: ServerStatusEvent): void | Promise<void>;
  queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult>;
  queryHostSummary(input: HostSummaryQuery): Promise<HostSummaryResult>;
  queryStatusHistory(input: StatusHistoryQuery): Promise<StatusHistoryResult>;
  queryFleetHostSnapshot(
    input: FleetHostSnapshotQuery,
  ): Promise<FleetHostSnapshotResult>;
}
