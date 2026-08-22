import { assertEquals, assertInstanceOf } from "@std/assert";
import { AnalyticsEngineServerMetricsStore } from "./analytics-engine/store.ts";
import { AE_DEFAULT_MAX_RANGE_SECONDS } from "./analytics-engine/sql-api.ts";
import { ClickHouseServerMetricsStore } from "./clickhouse/store.ts";
import { DisabledServerMetricsStore } from "./disabled-store.ts";
import { it } from "@std/testing/bdd";
import {
  parseAnalyticsEngineMaxRangeSeconds,
  parseMetricsRetentionDays,
  resetMetricsStoreSelectionWarningsForTests,
  resolveAnalyticsEngineSqlConfig,
  resolveServerMetricsStore,
} from "./store-selection.ts";

it("resolveServerMetricsStore workers + AE → AnalyticsEngine store", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const store = resolveServerMetricsStore({
    runtime: "workers",
    analyticsEngine: { writeDataPoint() {} },
  });
  assertInstanceOf(store, AnalyticsEngineServerMetricsStore);
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

it("resolveServerMetricsStore deno + full ClickHouse → ClickHouse store", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const store = resolveServerMetricsStore({
    runtime: "deno",
    clickhouse: {
      url: "http://127.0.0.1:8123",
      database: "turbopanel",
      user: "default",
      password: "secret",
    },
  });
  assertInstanceOf(store, ClickHouseServerMetricsStore);
});

it("resolveServerMetricsStore deno partial ClickHouse → unconfigured store", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    const store = resolveServerMetricsStore({
      runtime: "deno",
      clickhouse: {
        url: "http://127.0.0.1:8123",
        database: "turbopanel",
        user: "default",
        // password missing
      },
    });
    assertInstanceOf(store, DisabledServerMetricsStore);
    assertEquals(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
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

it("resolveAnalyticsEngineSqlConfig defaults maxRangeSeconds to AE retention", () => {
  const config = resolveAnalyticsEngineSqlConfig({
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: "token-xyz",
  });
  assertEquals(config, {
    accountId: "acct123",
    apiToken: "token-xyz",
    maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
  });
});

it("resolveAnalyticsEngineSqlConfig honors TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS", () => {
  const config = resolveAnalyticsEngineSqlConfig({
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: "token-xyz",
    TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS: "3600",
  });
  assertEquals(config?.maxRangeSeconds, 3600);
});

it("resolveAnalyticsEngineSqlConfig returns null when credentials missing", () => {
  assertEquals(
    resolveAnalyticsEngineSqlConfig({
      CLOUDFLARE_ACCOUNT_ID: "acct123",
    }),
    null,
  );
  assertEquals(
    resolveAnalyticsEngineSqlConfig({
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

it("resolveServerMetricsStore deno ClickHouse honors retentionDays override", () => {
  resetMetricsStoreSelectionWarningsForTests();
  const store = resolveServerMetricsStore({
    runtime: "deno",
    clickhouse: {
      url: "http://127.0.0.1:8123",
      database: "turbopanel",
      user: "default",
      password: "secret",
      retentionDays: 30,
    },
  });
  assertInstanceOf(store, ClickHouseServerMetricsStore);
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
