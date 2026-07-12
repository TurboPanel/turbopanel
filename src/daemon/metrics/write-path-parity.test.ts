import { assertEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
} from "./contract.ts";
import type { AuthenticatedHostMetricsSample } from "./types.ts";
import {
  AE_MISSING_METRIC_SENTINEL,
  buildAnalyticsEngineDataPoint,
  doubleColumnForMetric,
} from "./analytics-engine/field-map.ts";
import {
  buildHostSeriesClickHouseSql,
  buildHostSeriesSql,
  clickhouseAvgExpression,
  weightedAvgExpression,
} from "./analytics-engine/sql-api.ts";
import { buildHostMetricsRow } from "./clickhouse/store.ts";

const SERVER_ID = "11111111-2222-4333-8444-555555555555";

function validatedSample(
  overrides?: Partial<AuthenticatedHostMetricsSample>,
): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  metrics.cpuUsagePercent = 12.5;
  metrics.load1 = 0.42;
  metrics.memoryUsedBytes = 1_000_000;
  metrics.diskReadBytesPerSecond = 1024;
  return {
    serverId: SERVER_ID,
    at: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    intervalSeconds: 60,
    sequence: 3,
    schemaVersion: METRICS_SCHEMA_VERSION,
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "1.2.3",
      operatingSystem: "Debian GNU/Linux 13",
      architecture: "aarch64",
      kernelRelease: "6.12.0",
    },
    metrics,
    ...overrides,
  };
}

it("buildHostMetricsRow matches buildAnalyticsEngineDataPoint for the same sample", () => {
  const sample = validatedSample();
  const aePoint = buildAnalyticsEngineDataPoint(sample);
  const chRow = buildHostMetricsRow(sample);

  assertEquals(chRow.index1, aePoint.indexes[0]);
  for (let i = 0; i < HOST_METRIC_KEYS.length; i++) {
    const col = doubleColumnForMetric(HOST_METRIC_KEYS[i]!);
    assertEquals(chRow[col], aePoint.doubles[i]);
  }
  for (let i = 0; i < aePoint.blobs.length; i++) {
    assertEquals(chRow[`blob${i + 1}`], aePoint.blobs[i]);
  }
});

it("buildHostMetricsRow stores AE_MISSING_METRIC_SENTINEL for null metrics", () => {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  metrics.cpuUsagePercent = 7;
  const row = buildHostMetricsRow(validatedSample({ metrics }));
  assertEquals(row.double1, 7);
  assertEquals(row.double2, AE_MISSING_METRIC_SENTINEL);
  assertEquals(row.double20, AE_MISSING_METRIC_SENTINEL);
});

it("AE and ClickHouse query builders exclude the missing-metric sentinel", () => {
  const aeExpr = weightedAvgExpression("double1");
  const chExpr = clickhouseAvgExpression("double1");
  const sentinel = String(AE_MISSING_METRIC_SENTINEL);
  assertEquals(aeExpr.includes(sentinel), true);
  assertEquals(chExpr.includes(sentinel), true);
  assertEquals(aeExpr.includes("double1"), true);
  assertEquals(chExpr.includes("double1"), true);
});

it("buildHostSeriesSql and buildHostSeriesClickHouseSql share bucket + filter semantics", () => {
  const query = {
    serverId: SERVER_ID,
    metrics: ["cpuUsagePercent", "load1"] as const,
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
    resolutionSeconds: 300,
  };
  const ae = buildHostSeriesSql(query, {
    dataset: "turbopanel_server_metrics",
    maxRangeSeconds: 90 * 24 * 60 * 60,
  });
  const ch = buildHostSeriesClickHouseSql(query, {
    table: "turbopanel_server_metrics",
    maxRangeSeconds: 90 * 24 * 60 * 60,
  });
  assertEquals(ae.bucketSeconds, ch.bucketSeconds);
  assertEquals(ae.metrics, ch.metrics);
  assertEquals(ae.sql.includes("blob1 = 'host'"), true);
  assertEquals(ch.sql.includes("blob1 = 'host'"), true);
  assertEquals(ae.sql.includes("blob2 = '1'"), true);
  assertEquals(ch.sql.includes("blob2 = '1'"), true);
  assertEquals(ae.sql.includes("GROUP BY bucket"), true);
  assertEquals(ch.sql.includes("GROUP BY bucket"), true);
  assertEquals(ch.sql.includes(clickhouseAvgExpression("double1")), true);
  assertEquals(ch.sql.includes(clickhouseAvgExpression("double5")), true);
});
