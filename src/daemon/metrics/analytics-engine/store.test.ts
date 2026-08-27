import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
} from "../contract.ts";
import type { AuthenticatedHostMetricsSample } from "../types.ts";
import {
  buildAnalyticsEngineDataPoint,
  buildStatusAnalyticsEngineDataPoint,
} from "./field-map.ts";
import type { AnalyticsEngineSqlConfig } from "./sql-api.ts";
import {
  AnalyticsEngineServerMetricsStore,
  type AnalyticsEngineDatasetLike,
} from "./store.ts";

function sample(
  overrides: Partial<AuthenticatedHostMetricsSample> = {},
): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  metrics.cpuUsagePercent = 12.5;
  return {
    serverId: "11111111-2222-4333-8444-555555555555",
    at: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    intervalSeconds: 60,
    sequence: 1,
    schemaVersion: METRICS_SCHEMA_VERSION,
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "1.0.0",
      operatingSystem: "linux",
      architecture: "arm64",
      kernelRelease: "6.12.0",
    },
    metrics,
    ...overrides,
  };
}

function createFakeDataset(): {
  dataset: AnalyticsEngineDatasetLike;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    dataset: {
      writeDataPoint(event) {
        calls.push(event);
      },
    },
  };
}

it("writeHostSample: exactly one writeDataPoint matching field map", () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset);
  const input = sample();
  store.writeHostSample(input);
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0], buildAnalyticsEngineDataPoint(input));
});

it("writeHostSample: indexes is authenticated serverId only", () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset);
  const input = sample({
    serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  store.writeHostSample(input);
  const point = fake.calls[0] as { indexes: string[] };
  assertEquals(point.indexes, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
});

it("queryHostSeries without sql config returns available:false", async () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset);
  const result = await store.queryHostSeries({
    serverId: "11111111-2222-4333-8444-555555555555",
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.available, false);
  assertEquals(result.kind, "analytics-engine");
  assertEquals(result.points, []);
});

it("writeStatusEvent: exactly one writeDataPoint", () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset);
  const event = {
    serverId: "11111111-2222-4333-8444-555555555555",
    connected: true,
    reason: "connect" as const,
    at: "2026-01-01T00:00:00.000Z",
  };
  store.writeStatusEvent(event);
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0], buildStatusAnalyticsEngineDataPoint(event));
});

it("queryStatusHistory without sql config returns available:false", async () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset);
  const result = await store.queryStatusHistory({
    serverId: "11111111-2222-4333-8444-555555555555",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.available, false);
  assertEquals(result.kind, "analytics-engine");
  assertEquals(result.initialConnected, null);
  assertEquals(result.events, []);
  assertEquals(result.uptimePercent, null);
});

function envelopedSqlResponse(
  data: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { data, meta: [], rows: data.length },
  });
}

function sqlConfig(
  fetchImpl: NonNullable<AnalyticsEngineSqlConfig["fetch"]>,
): AnalyticsEngineSqlConfig {
  return {
    accountId: "acct123",
    apiToken: "token-xyz",
    fetch: fetchImpl,
  };
}

it("queryHostSummary without sql config returns available:false", async () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset);
  const result = await store.queryHostSummary({
    serverId: "11111111-2222-4333-8444-555555555555",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.available, false);
  assertEquals(result.kind, "analytics-engine");
  assertEquals(result.sampleCount, 0);
  assertEquals(result.latestAt, null);
});

it("queryFleetHostSnapshot without sql config returns available:false", async () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset);
  const result = await store.queryFleetHostSnapshot({
    serverIds: ["11111111-2222-4333-8444-555555555555"],
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:50:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.available, false);
  assertEquals(result.kind, "analytics-engine");
  assertEquals(result.servers, []);
  assertEquals(result.metrics, ["cpuUsagePercent"]);
});

it("queryHostSummary with sql config delegates and maps rows", async () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset, {
    sql: sqlConfig(async () =>
      new Response(
        envelopedSqlResponse([
          { sample_count: 4, latest_at: "2026-01-01T00:59:00Z" },
        ]),
        { status: 200 },
      )
    ),
  });
  const result = await store.queryHostSummary({
    serverId: "11111111-2222-4333-8444-555555555555",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.available, true);
  assertEquals(result.sampleCount, 4);
  assertEquals(result.latestAt, "2026-01-01T00:59:00.000Z");
});

it("queryStatusHistory with sql config delegates to the SQL API", async () => {
  const fake = createFakeDataset();
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset, {
    sql: sqlConfig(async () =>
      new Response(envelopedSqlResponse([]), { status: 200 })
    ),
  });
  const result = await store.queryStatusHistory({
    serverId: "11111111-2222-4333-8444-555555555555",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.available, true);
  assertEquals(result.kind, "analytics-engine");
  assertEquals(result.events, []);
  assertEquals(result.initialConnected, null);
});

it("queryFleetHostSnapshot with sql config delegates and maps rows", async () => {
  const fake = createFakeDataset();
  const serverId = "11111111-2222-4333-8444-555555555555";
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset, {
    sql: sqlConfig(async () =>
      new Response(
        envelopedSqlResponse([
          {
            server_id: serverId,
            sample_count: 4,
            latest_at: "2026-01-01T00:59:00Z",
            cpuUsagePercent: 11,
          },
        ]),
        { status: 200 },
      )
    ),
  });
  const result = await store.queryFleetHostSnapshot({
    serverIds: [serverId],
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:50:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.available, true);
  assertEquals(result.servers.length, 1);
  assertEquals(result.servers[0]!.serverId, serverId);
  assertEquals(result.servers[0]!.values.cpuUsagePercent, 11);
});

it("queryHostSeries with sql config delegates and maps rows", async () => {
  const fake = createFakeDataset();
  const fetchCalls: Array<{ url: string; body: string; auth: string }> = [];
  const store = new AnalyticsEngineServerMetricsStore(fake.dataset, {
    sql: {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          body: String(init?.body ?? ""),
          auth: String(
            (init?.headers as Record<string, string>)?.Authorization ?? "",
          ),
        });
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: {
              data: [
                {
                  bucket: 1_704_067_200,
                  sample_count: 2,
                  cpuUsagePercent: 10.5,
                },
              ],
              meta: [],
              rows: 1,
            },
          }),
          { status: 200 },
        );
      },
    },
  });
  const result = await store.queryHostSeries({
    serverId: "11111111-2222-4333-8444-555555555555",
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
    resolutionSeconds: 300,
  });
  assertEquals(fetchCalls.length, 1);
  assertEquals(
    fetchCalls[0]!.url,
    "https://api.cloudflare.com/client/v4/accounts/acct123/analytics_engine/sql",
  );
  assertEquals(fetchCalls[0]!.auth, "Bearer token-xyz");
  assertEquals(result.available, true);
  assertEquals(result.points.length, 1);
  assertEquals(result.points[0]!.values.cpuUsagePercent, 10.5);
  assertEquals(result.sampleCount, 2);
});
