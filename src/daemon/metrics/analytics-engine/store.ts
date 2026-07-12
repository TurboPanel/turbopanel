import type {
  AuthenticatedHostMetricsSample,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
} from "../types.ts";
import {
  buildAnalyticsEngineDataPoint,
  type AnalyticsEngineDataPointLike,
} from "./field-map.ts";
import {
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  type AnalyticsEngineSqlConfig,
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

export type AnalyticsEngineStoreOptions = {
  /** Optional SQL API config for queryHostSeries / queryHostSummary. */
  sql?: AnalyticsEngineSqlConfig;
};

/**
 * Workers Analytics Engine host metrics store.
 * Writes are fire-and-forget (`writeDataPoint` is sync / non-blocking).
 */
export class AnalyticsEngineServerMetricsStore
  implements ServerMetricsStore {
  readonly #dataset: AnalyticsEngineDatasetLike;
  readonly #sql: AnalyticsEngineSqlConfig | null;

  constructor(
    dataset: AnalyticsEngineDatasetLike,
    options?: AnalyticsEngineStoreOptions,
  ) {
    this.#dataset = dataset;
    this.#sql = options?.sql ?? null;
  }

  /**
   * Exactly one `writeDataPoint` call — synchronous, fire-and-forget.
   * Cloudflare docs: do not await; the runtime writes in the background.
   */
  writeHostSample(input: AuthenticatedHostMetricsSample): void {
    const point: AnalyticsEngineDataPointLike = buildAnalyticsEngineDataPoint(
      input,
    );
    this.#dataset.writeDataPoint(point);
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
}
