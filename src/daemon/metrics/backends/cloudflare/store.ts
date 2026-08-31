/**
 * Workers Analytics Engine host metrics store (Cloudflare backend).
 *
 * Each host sample is written as two data points (core + extended metrics
 * parts — see `field-map.ts`); status transitions stay one data point.
 *
 * Cost envelope: 2 writes per sample ≈ 2,880 writes/day/server at the 60 s
 * baseline cadence — comfortably under Cloudflare's 250-datapoints-per-
 * invocation Analytics Engine limit (one ingest request carries one sample).
 */

import type {
  AuthenticatedHostMetricsSample,
  FleetHostSnapshotQuery,
  FleetHostSnapshotResult,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
  ServerStatusEvent,
  StatusHistoryQuery,
  StatusHistoryResult,
} from "../../types.ts";
import {
  buildCoreDataPoint,
  buildExtendedDataPoint,
  buildStatusDataPoint,
} from "./field-map.ts";
import {
  queryFleetHostSnapshotViaSqlApi,
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  queryStatusHistoryViaSqlApi,
  type CloudflareAnalyticsSqlConfig,
} from "./sql-api.ts";

/**
 * Narrow AE binding shape mirroring Workers `AnalyticsEngineDataset` /
 * `AnalyticsEngineDataPoint` (`indexes`, `doubles`, `blobs`).
 * Declared here (not imported from `worker-configuration.d.ts`) so the module
 * stays Deno-test portable; cast at `store-selection` / `workers.ts`.
 */
export type AnalyticsEngineDatasetLike = {
  writeDataPoint(event: {
    indexes?: string[];
    doubles?: number[];
    blobs?: string[];
  }): void;
};

export type CloudflareAnalyticsEngineStoreOptions = {
  /** Optional SQL API config for queryHostSeries / queryHostSummary. */
  sql?: CloudflareAnalyticsSqlConfig;
};

/**
 * Workers Analytics Engine host metrics store.
 * Writes are fire-and-forget (`writeDataPoint` is sync / non-blocking).
 */
export class CloudflareAnalyticsEngineServerMetricsStore
  implements ServerMetricsStore {
  readonly #dataset: AnalyticsEngineDatasetLike;
  readonly #sql: CloudflareAnalyticsSqlConfig | null;

  constructor(
    dataset: AnalyticsEngineDatasetLike,
    options?: CloudflareAnalyticsEngineStoreOptions,
  ) {
    this.#dataset = dataset;
    this.#sql = options?.sql ?? null;
  }

  /**
   * Exactly two `writeDataPoint` calls — core part then extended part —
   * both synchronous, fire-and-forget, never awaited.
   * Cloudflare docs: do not await; the runtime writes in the background.
   */
  writeHostSample(input: AuthenticatedHostMetricsSample): void {
    this.#dataset.writeDataPoint(buildCoreDataPoint(input));
    this.#dataset.writeDataPoint(buildExtendedDataPoint(input));
  }

  /**
   * Exactly one `writeDataPoint` for a connection-status transition —
   * synchronous, fire-and-forget (same discipline as {@link writeHostSample}).
   *
   * AE stamps its own ingestion `timestamp`; `event.at` is not sent (same
   * asymmetry host samples already have).
   */
  writeStatusEvent(input: ServerStatusEvent): void {
    this.#dataset.writeDataPoint(buildStatusDataPoint(input));
  }

  queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: "analytics-engine",
        available: false,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [],
        resolutionSeconds: null,
        gapCount: 0,
        sampleCount: 0,
      });
    }
    return queryHostSeriesViaSqlApi(this.#sql, input);
  }

  queryHostSummary(input: HostSummaryQuery): Promise<HostSummaryResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: "analytics-engine",
        available: false,
        serverId: input.serverId,
        sampleCount: 0,
        latestAt: null,
      });
    }
    return queryHostSummaryViaSqlApi(this.#sql, input);
  }

  queryStatusHistory(input: StatusHistoryQuery): Promise<StatusHistoryResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: "analytics-engine",
        available: false,
        serverId: input.serverId,
        initialConnected: null,
        events: [],
        uptimeSeconds: 0,
        downtimeSeconds: 0,
        unknownSeconds: 0,
        uptimePercent: null,
        truncated: false,
      });
    }
    return queryStatusHistoryViaSqlApi(this.#sql, input);
  }

  queryFleetHostSnapshot(
    input: FleetHostSnapshotQuery,
  ): Promise<FleetHostSnapshotResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: "analytics-engine",
        available: false,
        metrics: [...input.metrics],
        servers: [],
      });
    }
    return queryFleetHostSnapshotViaSqlApi(this.#sql, input);
  }
}
