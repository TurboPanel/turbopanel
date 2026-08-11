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
} from "./types.ts";

/** Default store when metrics is disabled or a backend cannot be resolved. */
export class DisabledServerMetricsStore implements ServerMetricsStore {
  writeHostSample(_input: AuthenticatedHostMetricsSample): void {
    // no-op
  }

  writeStatusEvent(_input: ServerStatusEvent): void {
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

  queryStatusHistory(input: StatusHistoryQuery): Promise<StatusHistoryResult> {
    return Promise.resolve({
      kind: "disabled",
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

  queryFleetHostSnapshot(
    input: FleetHostSnapshotQuery,
  ): Promise<FleetHostSnapshotResult> {
    return Promise.resolve({
      kind: "disabled",
      available: false,
      metrics: [...input.metrics],
      servers: [],
    });
  }
}
