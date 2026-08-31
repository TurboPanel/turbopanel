import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { CloudflareAnalyticsEngineServerMetricsStore } from "./backends/cloudflare/store.ts";
import { AE_DEFAULT_MAX_RANGE_SECONDS } from "./backends/cloudflare/sql-api.ts";
import { DuckDbParquetServerMetricsStore } from "./backends/duckdb/store.ts";
import { DisabledServerMetricsStore } from "./disabled-store.ts";
import { it } from "@std/testing/bdd";
import {
  parseAnalyticsEngineMaxRangeSeconds,
  parseMetricsRetentionDays,
  resetMetricsStoreSelectionWarningsForTests,
  resolveCloudflareAnalyticsSqlConfig,
  resolveServerMetricsStore,
  UnavailableServerMetricsStore,
} from "./store-selection.ts";

it("resolveServerMetricsStore workers + AE → AnalyticsEngine store", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const store = resolveServerMetricsStore({
    runtime: "workers",
    analyticsEngine: { writeDataPoint() {} },
  });
  assertInstanceOf(store, CloudflareAnalyticsEngineServerMetricsStore);
});

it("resolveServerMetricsStore workers without AE → unconfigured store", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    const store = resolveServerMetricsStore({
      runtime: "workers",
    });
    assertInstanceOf(store, DisabledServerMetricsStore);
    assertEquals(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

it("resolveServerMetricsStore deno → DuckDB store", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const metricsDir = Deno.makeTempDirSync({ prefix: "tp-metrics-select-" });
  try {
    const store = resolveServerMetricsStore({
      runtime: "deno",
      duckdb: { metricsDir },
    });
    assertInstanceOf(store, DuckDbParquetServerMetricsStore);
  } finally {
    Deno.removeSync(metricsDir, { recursive: true });
  }
});

it("resolveServerMetricsStore deno construction failure → reads reject as unavailable", async () => {
  resetMetricsStoreSelectionWarningsForTests();
  // A regular file where the metrics directory should be makes mkdir fail.
  const blocker = Deno.makeTempFileSync({ prefix: "tp-metrics-blocker-" });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    const store = resolveServerMetricsStore({
      runtime: "deno",
      duckdb: { metricsDir: `${blocker}/metrics` },
    });
    // A real DuckDB outage must never degrade to the disabled store — reads
    // reject so metrics routes return 503 metrics_backend_unavailable.
    assertInstanceOf(store, UnavailableServerMetricsStore);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "DuckDB store failed to open");

    const range = {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    };
    await assertRejects(
      () => store.queryHostSeries({ serverId: "srv-1", metrics: [], ...range }),
      Error,
      "DuckDB metrics store failed to open",
    );
    await assertRejects(
      () => store.queryHostSummary({ serverId: "srv-1", ...range }),
      Error,
      "DuckDB metrics store failed to open",
    );
    await assertRejects(
      () => store.queryStatusHistory({ serverId: "srv-1", ...range }),
      Error,
      "DuckDB metrics store failed to open",
    );
    await assertRejects(
      () =>
        store.queryFleetHostSnapshot({
          serverIds: ["srv-1"],
          metrics: [],
          ...range,
        }),
      Error,
      "DuckDB metrics store failed to open",
    );

    // Writes stay fire-and-forget no-ops — never a throw into callers.
    store.writeStatusEvent({
      serverId: "srv-1",
      connected: true,
      reason: "connect",
      at: range.from,
    });
  } finally {
    console.warn = originalWarn;
    Deno.removeSync(blocker);
  }
});

it("parseAnalyticsEngineMaxRangeSeconds accepts positive integers", () => {
  assertEquals(parseAnalyticsEngineMaxRangeSeconds("7776000"), 7_776_000);
  assertEquals(parseAnalyticsEngineMaxRangeSeconds(3600), 3600);
  assertEquals(parseAnalyticsEngineMaxRangeSeconds(""), undefined);
  assertEquals(parseAnalyticsEngineMaxRangeSeconds("0"), undefined);
  assertEquals(parseAnalyticsEngineMaxRangeSeconds("-1"), undefined);
  assertEquals(parseAnalyticsEngineMaxRangeSeconds("1.5"), undefined);
  assertEquals(parseAnalyticsEngineMaxRangeSeconds(undefined), undefined);
});

it("resolveCloudflareAnalyticsSqlConfig defaults maxRangeSeconds to AE retention", () => {
  const config = resolveCloudflareAnalyticsSqlConfig({
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: "token-xyz",
  });
  assertEquals(config, {
    accountId: "acct123",
    apiToken: "token-xyz",
    maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
  });
});

it("resolveCloudflareAnalyticsSqlConfig honors TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS", () => {
  const config = resolveCloudflareAnalyticsSqlConfig({
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: "token-xyz",
    TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS: "3600",
  });
  assertEquals(config?.maxRangeSeconds, 3600);
});

it("resolveCloudflareAnalyticsSqlConfig returns null when credentials missing", () => {
  assertEquals(
    resolveCloudflareAnalyticsSqlConfig({
      CLOUDFLARE_ACCOUNT_ID: "acct123",
    }),
    null,
  );
  assertEquals(
    resolveCloudflareAnalyticsSqlConfig({
      TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: "token-xyz",
    }),
    null,
  );
});

it("parseMetricsRetentionDays accepts positive integers only", () => {
  assertEquals(parseMetricsRetentionDays("90"), 90);
  assertEquals(parseMetricsRetentionDays(30), 30);
  assertEquals(parseMetricsRetentionDays(""), undefined);
  assertEquals(parseMetricsRetentionDays("bad"), undefined);
});

it("resolveServerMetricsStore deno DuckDB honors retentionDays override", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const metricsDir = Deno.makeTempDirSync({ prefix: "tp-metrics-retention-" });
  try {
    const store = resolveServerMetricsStore({
      runtime: "deno",
      duckdb: { metricsDir, retentionDays: 30 },
    });
    assertInstanceOf(store, DuckDbParquetServerMetricsStore);
  } finally {
    Deno.removeSync(metricsDir, { recursive: true });
  }
});

it("resolveServerMetricsStore warns only once per missing-backend key", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    resolveServerMetricsStore({ runtime: "workers" });
    resolveServerMetricsStore({ runtime: "workers" });
    assertEquals(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
