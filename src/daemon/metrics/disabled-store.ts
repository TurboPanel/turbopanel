import type {
  AuthenticatedHostMetricsSample,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
} from "./types.ts";

/** Default store when metrics is disabled or a backend cannot be resolved. */
export class DisabledServerMetricsStore implements ServerMetricsStore {
  writeHostSample(_input: AuthenticatedHostMetricsSample): void {
    // no-op
  }

  queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
    return Promise.resolve({
      kind: "disabled",
      available: false,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [],
      resolutionSeconds: null,
      gapCount: 0,
      sampleCount: 0,
    });
  }

  queryHostSummary(input: HostSummaryQuery): Promise<HostSummaryResult> {
    return Promise.resolve({
      kind: "disabled",
      available: false,
      serverId: input.serverId,
      sampleCount: 0,
      latestAt: null,
    });
  }
}
