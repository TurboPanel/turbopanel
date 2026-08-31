import { assertEquals, assertThrows } from "@std/assert";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
} from "../../contract.ts";
import { it } from "@std/testing/bdd";
import type {
  AuthenticatedHostMetricsSample,
  HostSeriesResult,
  ServerStatusEvent,
} from "../../types.ts";
import { DuckDbParquetServerMetricsStore } from "../duckdb/store.ts";
import {
  AE_BLOB_COUNT,
  AE_BLOB_EVENT_TYPE_INDEX,
  AE_BLOB_PART_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_DATASET_NAME,
  AE_DOUBLE_COUNT,
  AE_METRICS_EVENT_TYPE,
  AE_MISSING_METRIC_SENTINEL,
  AE_PART_CORE,
  AE_PART_EXTENDED,
  AE_STATUS_EVENT_TYPE,
  type AnalyticsEngineDataPointLike,
  blobColumn,
  buildCoreDataPoint,
  buildExtendedDataPoint,
  buildStatusDataPoint,
  doubleColumnForMetric,
  intervalSecondsColumn,
  metricPart,
  statusConnectedColumn,
  statusReasonColumn,
} from "./field-map.ts";
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  AE_LIVENESS_WINDOW_SECONDS,
  aeMissingMetricSentinelSql,
  buildFleetHostSnapshotSql,
  buildHostSeriesSql,
  buildHostSummarySql,
  buildRecentlyActiveServerIdsSql,
  buildStatusEventsSql,
  buildStatusPriorStateSql,
  CloudflareAnalyticsSqlClient,
  hostEventDiscriminatorPredicates,
  hostPartsPredicate,
  lastValueExpressionForMetric,
  MAX_FLEET_SNAPSHOT_SERVERS,
  MAX_STATUS_EVENTS,
  parseAeLatestAtMs,
  parseCloudflareV4SqlResponse,
  parseFleetHostSnapshotRows,
  parseHostSummaryRow,
  parseSeriesRows,
  parseStatusEventRows,
  queryFleetHostSnapshotViaSqlApi,
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  queryRecentlyActiveServerIds,
  queryStatusHistoryViaSqlApi,
  maxValueExpressionForMetric,
  quoteServerIdInList,
  quoteSqlString,
  rawValueExpressionForMetric,
  resolveTruncatedStatusEvents,
  sampleCountExpression,
  stripAeSentinel,
  statusEventDiscriminatorPredicates,
  weightedAvgDenominatorForMetric,
  weightedAvgExpressionForMetric,
  weightedAvgIntervalSecondsExpression,
  weightedAvgNumeratorForMetric,
} from "./sql-api.ts";

const SERVER_ID = "11111111-2222-4333-8444-555555555555";

function envelopedSqlResponse(
  data: Array<Record<string, unknown>>,
  rows = data.length,
): string {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { data, meta: [], rows },
  });
}

it("quoteSqlString doubles single quotes", () => {
  assertEquals(quoteSqlString("a'b"), "'a''b'");
  assertEquals(quoteSqlString(SERVER_ID), `'${SERVER_ID}'`);
});

it("weightedAvgExpressionForMetric: part-scoped, interval × sampling weighted, sentinel-safe", () => {
  const expr = weightedAvgExpressionForMetric("cpuUserPercent");
  assertEquals(expr.includes(aeMissingMetricSentinelSql()), true);
  // Scientific notation / NULLIF are not documented AE SQL — embedding them
  // broke production chart queries (`metrics_backend_unavailable`).
  assertEquals(expr.includes(String(AE_MISSING_METRIC_SENTINEL)), false);
  assertEquals(expr.includes("NULLIF"), false);
  // AE IF() requires matching branch types (Integer 0 vs Double → HTTP 422).
  assertEquals(expr.includes("0.0"), true);
  assertEquals(expr.includes(", 0,"), false);
  // Weight is intervalSeconds (double20) × AE sampling weight, both sides.
  assertEquals(
    expr.includes(`${intervalSecondsColumn()} * _sample_interval`),
    true,
  );
  // Aggregation stays scoped to the part that owns the metric.
  assertEquals(
    expr.includes(
      `${blobColumn(AE_BLOB_PART_INDEX)} = ${quoteSqlString(AE_PART_CORE)}`,
    ),
    true,
  );
  assertEquals(expr.includes(doubleColumnForMetric("cpuUserPercent")), true);

  const extendedExpr = weightedAvgExpressionForMetric("gpuPowerWatts");
  assertEquals(metricPart("gpuPowerWatts"), AE_PART_EXTENDED);
  assertEquals(
    extendedExpr.includes(
      `${blobColumn(AE_BLOB_PART_INDEX)} = ${quoteSqlString(AE_PART_EXTENDED)}`,
    ),
    true,
  );
});

it("sampleCountExpression counts only the core part — never both twins", () => {
  const expr = sampleCountExpression();
  assertEquals(
    expr.includes(
      `${blobColumn(AE_BLOB_PART_INDEX)} = ${quoteSqlString(AE_PART_CORE)}`,
    ),
    true,
  );
  assertEquals(expr.includes(quoteSqlString(AE_PART_EXTENDED)), false);
  assertEquals(expr.includes("_sample_interval * 1.0"), true);
});

it("AE_DEFAULT_MAX_RANGE_SECONDS matches documented three-month retention", () => {
  assertEquals(AE_DEFAULT_MAX_RANGE_SECONDS, 90 * 24 * 60 * 60);
});

it("hostEventDiscriminatorPredicates derive event type + schema version", () => {
  const predicates = hostEventDiscriminatorPredicates();
  assertEquals(predicates.length, 2);
  assertEquals(
    predicates[0],
    `${blobColumn(AE_BLOB_EVENT_TYPE_INDEX)} = ${
      quoteSqlString(AE_METRICS_EVENT_TYPE)
    }`,
  );
  assertEquals(
    predicates[1],
    `${blobColumn(AE_BLOB_SCHEMA_VERSION_INDEX)} = ${
      quoteSqlString(String(METRICS_SCHEMA_VERSION))
    }`,
  );
});

it("buildHostSeriesSql: allowlisted doubles + part-scoped weighted avg only", () => {
  const { sql, metrics, bucketSeconds } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent", "load1"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 60,
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(metrics, ["cpuUserPercent", "load1"]);
  assertEquals(bucketSeconds, 60);
  assertEquals(sql.includes(doubleColumnForMetric("cpuUserPercent")), true);
  assertEquals(sql.includes(doubleColumnForMetric("load1")), true);
  assertEquals(sql.includes("_sample_interval"), true);
  assertEquals(sql.includes(intervalSecondsColumn()), true);
  assertEquals(sql.includes(`index1 = ${quoteSqlString(SERVER_ID)}`), true);
  assertEquals(sql.includes(AE_DATASET_NAME), true);
  assertEquals(sql.includes(hostPartsPredicate()), true);
  assertEquals(sql.includes(aeMissingMetricSentinelSql()), true);
  assertEquals(sql.includes(String(AE_MISSING_METRIC_SENTINEL)), false);
  assertEquals(sql.includes("NULLIF"), false);
  assertEquals(sql.includes("FORMAT JSON"), false);
});

it("buildHostSeriesSql: filters metrics event type and schema version", () => {
  const { sql } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  for (const predicate of hostEventDiscriminatorPredicates()) {
    assertEquals(sql.includes(`AND ${predicate}`), true);
  }
  assertEquals(sql.includes(`AND ${hostPartsPredicate()}`), true);
});

it("buildHostSeriesSql: unknown metric throws before SQL", () => {
  assertThrows(
    () =>
      buildHostSeriesSql(
        {
          serverId: SERVER_ID,
          metrics: ["notARealMetric" as "cpuUserPercent"],
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        {
          dataset: AE_DATASET_NAME,
          maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
        },
      ),
    TypeError,
    "unknown host metrics metric",
  );
});

it("buildHostSeriesSql: invalid serverId throws", () => {
  assertThrows(
    () =>
      buildHostSeriesSql(
        {
          serverId: "not-a-uuid'; DROP TABLE",
          metrics: ["cpuUserPercent"],
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        {
          dataset: AE_DATASET_NAME,
          maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
        },
      ),
    TypeError,
    "invalid serverId",
  );
});

it("buildHostSeriesSql: range exceeding maxRangeSeconds throws", () => {
  assertThrows(
    () =>
      buildHostSeriesSql(
        {
          serverId: SERVER_ID,
          metrics: ["cpuUserPercent"],
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-03-01T00:00:00.000Z",
        },
        { dataset: AE_DATASET_NAME, maxRangeSeconds: 3600 },
      ),
    TypeError,
    "exceeds maxRangeSeconds",
  );
});

it("buildHostSeriesSql: retention-aligned default allows 90-day range", () => {
  const { sql } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-04-01T00:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(sql.includes(`index1 = ${quoteSqlString(SERVER_ID)}`), true);
});

it("buildHostSeriesSql: range past retention default throws", () => {
  assertThrows(
    () =>
      buildHostSeriesSql(
        {
          serverId: SERVER_ID,
          metrics: ["cpuUserPercent"],
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-04-02T00:00:00.000Z",
        },
        {
          dataset: AE_DATASET_NAME,
          maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
        },
      ),
    TypeError,
    "exceeds maxRangeSeconds",
  );
});

it("buildHostSummarySql: quoted serverId + core-part sample_count/latest_at", () => {
  const sql = buildHostSummarySql(
    {
      serverId: SERVER_ID,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(sql.includes(`index1 = ${quoteSqlString(SERVER_ID)}`), true);
  assertEquals(sql.includes(`${sampleCountExpression()} AS sample_count`), true);
  assertEquals(sql.includes("max(timestamp) AS latest_at"), true);
  // Untrusted serverId is never concatenated raw.
  assertEquals(sql.includes("index1 = " + SERVER_ID), false);
  for (const predicate of hostEventDiscriminatorPredicates()) {
    assertEquals(sql.includes(`AND ${predicate}`), true);
  }
});

it("buildFleetHostSnapshotSql: IN-list + GROUP BY server + weighted metrics", () => {
  const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const { sql, metrics } = buildFleetHostSnapshotSql(
    {
      serverIds: [SERVER_ID, idB],
      metrics: ["cpuUserPercent", "memoryAvailableBytes", "swapFreeBytes"],
      from: "2026-01-01T00:50:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(metrics, [
    "cpuUserPercent",
    "memoryAvailableBytes",
    "swapFreeBytes",
  ]);
  assertEquals(sql.includes(`IN (${quoteSqlString(SERVER_ID)}, ${quoteSqlString(idB)})`), true);
  assertEquals(sql.includes("GROUP BY server_id"), true);
  assertEquals(sql.includes("AS cpuUserPercent"), true);
  assertEquals(sql.includes("AS memoryAvailableBytes"), true);
  assertEquals(sql.includes("AS swapFreeBytes"), true);
  assertEquals(
    sql.includes(
      `${weightedAvgNumeratorForMetric("cpuUserPercent")} AS cpuUserPercent_num`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `${
        weightedAvgDenominatorForMetric("cpuUserPercent")
      } AS cpuUserPercent_den`,
    ),
    true,
  );
  assertEquals(sql.includes(sampleCountExpression()), true);
});

it("buildHostSeriesSql: recombines parts into logical samples keyed by (index1, timestamp)", () => {
  const { sql } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent", "gpuPowerWatts"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 60,
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  // Inner subquery groups physical part rows into one logical sample per
  // (index1, timestamp) before any bucket aggregation.
  assertEquals(
    sql.includes(`toUnixTimestamp(timestamp) AS sample_ts`),
    true,
  );
  assertEquals(sql.includes("GROUP BY server_id, sample_ts"), true);
  assertEquals(
    sql.includes(`${sampleCountExpression()} AS core_weight`),
    true,
  );
  // Outer aggregation only sees logical samples with a core row — orphan
  // extended-only rows never influence buckets.
  assertEquals(sql.includes("WHERE core_weight > 0.0"), true);
  assertEquals(sql.includes("SUM(core_weight) AS sample_count"), true);
  assertEquals(sql.includes("intDiv(sample_ts, 60) * 60 AS bucket"), true);
  assertEquals(
    sql.includes("SUM(cpuUserPercent_num) / SUM(cpuUserPercent_den) AS cpuUserPercent"),
    true,
  );
  assertEquals(
    sql.includes("SUM(gpuPowerWatts_num) / SUM(gpuPowerWatts_den) AS gpuPowerWatts"),
    true,
  );
});

it("buildFleetHostSnapshotSql: sample_count and latest_at derive from the same logical rows", () => {
  const { sql } = buildFleetHostSnapshotSql(
    {
      serverIds: [SERVER_ID],
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:50:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(sql.includes("GROUP BY server_id, sample_ts"), true);
  assertEquals(sql.includes("WHERE core_weight > 0.0"), true);
  assertEquals(sql.includes("SUM(core_weight) AS sample_count"), true);
  // latest_at is max over the logical-sample rows — never over raw part rows,
  // so an orphan extended row cannot advance it.
  assertEquals(sql.includes("max(sample_ts) AS latest_at"), true);
  assertEquals(sql.includes(`max(timestamp)`), false);
});

it("host read + status SQL right edge is exclusive — canonical half-open [from, to)", () => {
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-01-01T01:00:00.000Z";
  const toUnix = Math.floor(Date.parse(to) / 1000);
  const opts = {
    dataset: AE_DATASET_NAME,
    maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
  };
  const statements = [
    buildHostSeriesSql(
      { serverId: SERVER_ID, metrics: ["cpuUserPercent"], from, to },
      opts,
    ).sql,
    buildHostSummarySql({ serverId: SERVER_ID, from, to }, opts),
    buildFleetHostSnapshotSql(
      { serverIds: [SERVER_ID], metrics: ["cpuUserPercent"], from, to },
      opts,
    ).sql,
    buildStatusEventsSql({ serverId: SERVER_ID, from, to }, opts),
  ];
  for (const sql of statements) {
    assertEquals(sql.includes(`timestamp < toDateTime(${toUnix})`), true);
    assertEquals(sql.includes("<="), false);
  }
});

it("parseFleetHostSnapshotRows skips bad ids and sorts", () => {
  const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const rows = parseFleetHostSnapshotRows(
    ["cpuUserPercent"],
    [
      {
        server_id: idB,
        sample_count: 2,
        latest_at: "2026-01-01T00:59:00Z",
        cpuUserPercent: 10,
      },
      {
        server_id: SERVER_ID,
        sample_count: 3,
        latest_at: "2026-01-01T00:58:00Z",
        cpuUserPercent: 42.5,
      },
      { server_id: 12, sample_count: 1, cpuUserPercent: 1 },
    ],
  );
  assertEquals(rows.length, 2);
  assertEquals(rows[0]!.serverId, SERVER_ID);
  assertEquals(rows[0]!.values.cpuUserPercent, 42.5);
  assertEquals(rows[1]!.serverId, idB);
});

it("AE_LIVENESS_WINDOW_SECONDS is three missed 60s samples", () => {
  assertEquals(AE_LIVENESS_WINDOW_SECONDS, 180);
});

it("buildRecentlyActiveServerIdsSql: fleet-wide metrics discriminators, core part only", () => {
  const predicates = hostEventDiscriminatorPredicates();
  const sql = buildRecentlyActiveServerIdsSql({
    sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
    nowMs: 1_704_067_200_000,
  });
  for (const predicate of predicates) {
    assertEquals(sql.includes(predicate), true);
  }
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_METRICS_EVENT_TYPE)}`), true);
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_STATUS_EVENT_TYPE)}`), false);
  // One row per logical sample — the extended twin is filtered out.
  assertEquals(
    sql.includes(
      `${blobColumn(AE_BLOB_PART_INDEX)} = ${quoteSqlString(AE_PART_CORE)}`,
    ),
    true,
  );
  assertEquals(sql.includes("index1 AS server_id"), true);
  assertEquals(sql.includes("max(timestamp) AS latest_at"), true);
  assertEquals(sql.includes("GROUP BY"), true);
  assertEquals(sql.includes("toDateTime("), true);
  assertEquals(sql.includes("double"), false);
  assertEquals(sql.includes("FORMAT JSON"), false);
});

it("buildStatusEventsSql: status discriminators, ORDER BY ASC, LIMIT", () => {
  const sql = buildStatusEventsSql(
    {
      serverId: SERVER_ID,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  for (const predicate of statusEventDiscriminatorPredicates()) {
    assertEquals(sql.includes(`AND ${predicate}`), true);
  }
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_STATUS_EVENT_TYPE)}`), true);
  assertEquals(
    sql.includes(
      `${blobColumn(AE_BLOB_SCHEMA_VERSION_INDEX)} = ${
        quoteSqlString(String(METRICS_SCHEMA_VERSION))
      }`,
    ),
    true,
  );
  assertEquals(sql.includes(`${statusConnectedColumn()} AS connected`), true);
  assertEquals(sql.includes(`${statusReasonColumn()} AS reason`), true);
  assertEquals(sql.includes("ORDER BY timestamp ASC"), true);
  assertEquals(sql.includes(`LIMIT ${MAX_STATUS_EVENTS + 1}`), true);
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_METRICS_EVENT_TYPE)}`), false);
});

it("buildStatusPriorStateSql: timestamp < from, ORDER BY DESC LIMIT 1", () => {
  const sql = buildStatusPriorStateSql(
    {
      serverId: SERVER_ID,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_STATUS_EVENT_TYPE)}`), true);
  assertEquals(sql.includes("timestamp < toDateTime("), true);
  assertEquals(sql.includes("ORDER BY timestamp DESC"), true);
  assertEquals(sql.includes("LIMIT 1"), true);
  assertEquals(sql.includes("argMax"), false);
});

it("host series SQL filters blob1 = metrics, never status", () => {
  const { sql } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_METRICS_EVENT_TYPE)}`), true);
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_STATUS_EVENT_TYPE)}`), false);
});

it("queryRecentlyActiveServerIds: maps enveloped rows to serverId → latestAtMs", async () => {
  const idA = "11111111-2222-4333-8444-555555555555";
  const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const byId = await queryRecentlyActiveServerIds(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            { server_id: idA, latest_at: "2026-01-01T00:58:00Z" },
            { server_id: idB, latest_at: "2026-01-01T00:59:00Z" },
          ]),
          { status: 200 },
        ),
    },
    { sinceSeconds: AE_LIVENESS_WINDOW_SECONDS },
  );
  assertEquals(byId.size, 2);
  assertEquals(byId.get(idA), Date.parse("2026-01-01T00:58:00Z"));
  assertEquals(byId.get(idB), Date.parse("2026-01-01T00:59:00Z"));
});

it("queryRecentlyActiveServerIds: forwards AbortSignal to fetch", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  await queryRecentlyActiveServerIds(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: (_url, init) => {
        seen = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(envelopedSqlResponse([]), { status: 200 }),
        );
      },
    },
    {
      sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
      signal: controller.signal,
    },
  );
  assertEquals(seen, controller.signal);
});

it("CloudflareAnalyticsSqlClient.executeSql posts raw SQL and unwraps the envelope", async () => {
  const fetchCalls: Array<{ url: string; body: string; auth: string }> = [];
  const client = new CloudflareAnalyticsSqlClient({
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
        envelopedSqlResponse([{ answer: 42 }]),
        { status: 200 },
      );
    },
  });
  const result = await client.executeSql("SELECT 42 AS answer");
  assertEquals(fetchCalls.length, 1);
  assertEquals(
    fetchCalls[0]!.url,
    "https://api.cloudflare.com/client/v4/accounts/acct123/analytics_engine/sql",
  );
  assertEquals(fetchCalls[0]!.auth, "Bearer token-xyz");
  assertEquals(fetchCalls[0]!.body, "SELECT 42 AS answer");
  assertEquals(result.data, [{ answer: 42 }]);
});

it("parseCloudflareV4SqlResponse: reads result.data from v4 envelope", () => {
  const parsed = parseCloudflareV4SqlResponse({
    success: true,
    errors: [],
    result: {
      data: [{ bucket: 1, sample_count: 2, cpuUserPercent: 9 }],
      rows: 1,
    },
  });
  assertEquals(parsed.data.length, 1);
  assertEquals(parsed.data[0]!.cpuUserPercent, 9);
  assertEquals(parsed.rows, 1);
});

it("parseCloudflareV4SqlResponse: accepts ClickHouse-style flat { data } body", () => {
  const parsed = parseCloudflareV4SqlResponse({
    data: [{ bucket: 1, sample_count: 2, cpuUserPercent: 9 }],
    rows: 1,
  });
  assertEquals(parsed.data.length, 1);
  assertEquals(parsed.data[0]!.cpuUserPercent, 9);
  assertEquals(parsed.rows, 1);
});

it("parseCloudflareV4SqlResponse: success:false surfaces result.error when errors empty", () => {
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: false,
        errors: [],
        result: { error: "table turbopanel_server_telemetry does not exist" },
      }),
    Error,
    "table turbopanel_server_telemetry does not exist",
  );
});

it("parseCloudflareV4SqlResponse: success:false surfaces API errors", () => {
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
        result: null,
      }),
    Error,
    "Authentication error",
  );
});

it("queryHostSeriesViaSqlApi: consumes enveloped result.data", async () => {
  const result = await queryHostSeriesViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              bucket: 1_704_067_200,
              sample_count: 2,
              cpuUserPercent: 10.5,
            },
          ]),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 300,
    },
  );
  assertEquals(result.available, true);
  assertEquals(result.points.length, 1);
  assertEquals(result.points[0]!.values.cpuUserPercent, 10.5);
  assertEquals(result.points[0]!.sampleCount, 2);
  assertEquals(result.points[0]!.expectedSampleCount, 5);
  assertEquals(result.sampleCount, 2);
});

it("queryHostSummaryViaSqlApi: consumes enveloped result.data", async () => {
  const result = await queryHostSummaryViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              sample_count: 4,
              latest_at: "2026-01-01T00:59:00Z",
            },
          ]),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
  );
  assertEquals(result.available, true);
  assertEquals(result.sampleCount, 4);
  assertEquals(result.latestAt, "2026-01-01T00:59:00.000Z");
});

it("queryHostSummaryViaSqlApi: space-separated latest_at is normalized as UTC", async () => {
  const result = await queryHostSummaryViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            { sample_count: 3, latest_at: "2026-01-15 12:34:56" },
          ]),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      from: "2026-01-15T00:00:00.000Z",
      to: "2026-01-15T13:00:00.000Z",
    },
  );
  assertEquals(result.sampleCount, 3);
  // Backend DateTime without timezone must parse as UTC regardless of the
  // process's local timezone — never bare Date.parse.
  assertEquals(result.latestAt, "2026-01-15T12:34:56.000Z");
});

it("queryHostSummaryViaSqlApi: zero-sample range keeps latestAt null despite a raw timestamp", async () => {
  const result = await queryHostSummaryViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            // Orphan extended row scenario: no core samples, but the backend
            // still surfaces a max(timestamp).
            { sample_count: 0, latest_at: "2026-01-01 00:59:00" },
          ]),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
  );
  assertEquals(result.sampleCount, 0);
  assertEquals(result.latestAt, null);
});

it("queryHostSeriesViaSqlApi: computes gapCount for missing buckets", async () => {
  const result = await queryHostSeriesViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              bucket: 1_767_225_900,
              sample_count: 5,
              cpuUserPercent: 10.5,
            },
          ]),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T00:10:00.000Z",
      resolutionSeconds: 300,
    },
  );
  assertEquals(result.points.length, 1);
  // Half-open [00:00, 00:10): buckets 00:00 + 00:05; one full → one missing × 5.
  assertEquals(result.gapCount, 5);
});

it("queryHostSeriesViaSqlApi: flat ClickHouse-style response is accepted", async () => {
  const result = await queryHostSeriesViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                bucket: 1_704_067_200,
                sample_count: 2,
                cpuUserPercent: 10.5,
              },
            ],
            rows: 1,
          }),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 300,
    },
  );
  assertEquals(result.available, true);
  assertEquals(result.points.length, 1);
  assertEquals(result.points[0]!.values.cpuUserPercent, 10.5);
  assertEquals(result.sampleCount, 2);
});

it("queryHostSeriesViaSqlApi: maxRangeSeconds override is enforced", () => {
  assertThrows(
    () =>
      buildHostSeriesSql(
        {
          serverId: SERVER_ID,
          metrics: ["cpuUserPercent"],
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T02:00:00.000Z",
        },
        { dataset: AE_DATASET_NAME, maxRangeSeconds: 3600 },
      ),
    TypeError,
    "exceeds maxRangeSeconds",
  );
});

it("parseStatusEventRows: space-separated DateTime is UTC regardless of local TZ", () => {
  const events = parseStatusEventRows([
    {
      timestamp: "2026-06-15 12:30:45.123",
      connected: 1,
      reason: "connect",
    },
  ]);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.at, "2026-06-15T12:30:45.123Z");
});

it("queryStatusHistoryViaSqlApi: truncated tail accrues to unknownSeconds", async () => {
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-01-01T02:00:00.000Z";
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < MAX_STATUS_EVENTS + 1; i++) {
    const connected = i % 2 === 0;
    rows.push({
      timestamp: new Date(fromMs + i * 1000).toISOString(),
      connected: connected ? 1 : 0,
      reason: connected ? "connect" : "disconnect",
    });
  }
  const lastRetainedMs = fromMs + (MAX_STATUS_EVENTS - 1) * 1000;
  const expectedUnknownTail = (toMs - lastRetainedMs) / 1000;

  const result = await queryStatusHistoryViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async (_url, init) => {
        const body = String(init?.body ?? "");
        if (body.includes("ORDER BY timestamp DESC")) {
          return new Response(
            envelopedSqlResponse([{
              timestamp: "2025-12-31T23:00:00.000Z",
              connected: 0,
              reason: "disconnect",
            }]),
            { status: 200 },
          );
        }
        return new Response(envelopedSqlResponse(rows), { status: 200 });
      },
    },
    { serverId: SERVER_ID, from, to },
  );

  assertEquals(result.truncated, true);
  assertEquals(result.events.length, MAX_STATUS_EVENTS);
  assertEquals(result.unknownSeconds, expectedUnknownTail);
  // Last retained state is offline (odd index) — without the fix that suffix
  // would have been counted as downtime instead of unknown.
  assertEquals(result.events[MAX_STATUS_EVENTS - 1]!.connected, false);
  assertEquals(result.downtimeSeconds + result.uptimeSeconds, (lastRetainedMs - fromMs) / 1000);
});

it("queryStatusHistoryViaSqlApi: truncation follows raw row count, not parsed length", async () => {
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-01-01T01:00:00.000Z";
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < MAX_STATUS_EVENTS; i++) {
    rows.push({
      timestamp: new Date(Date.parse(from) + i * 1000).toISOString(),
      connected: 1,
      reason: "connect",
    });
  }
  // Sentinel overflow row that fails to parse — must still mark truncated.
  rows.push({ timestamp: "not-a-timestamp", connected: 1, reason: "connect" });

  const result = await queryStatusHistoryViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async (_url, init) => {
        const body = String(init?.body ?? "");
        if (body.includes("ORDER BY timestamp DESC")) {
          return new Response(envelopedSqlResponse([]), { status: 200 });
        }
        return new Response(envelopedSqlResponse(rows), { status: 200 });
      },
    },
    { serverId: SERVER_ID, from, to },
  );

  assertEquals(result.truncated, true);
  assertEquals(result.events.length, MAX_STATUS_EVENTS);
});

it("parseAeLatestAtMs accepts unix seconds, milliseconds, and space-separated UTC", () => {
  assertEquals(parseAeLatestAtMs(null), null);
  assertEquals(parseAeLatestAtMs(undefined), null);
  assertEquals(parseAeLatestAtMs(""), null);
  assertEquals(parseAeLatestAtMs(1_700_000_000), 1_700_000_000_000);
  assertEquals(parseAeLatestAtMs(1_700_000_000_000), 1_700_000_000_000);
  assertEquals(
    parseAeLatestAtMs("2026-01-15 12:34:56"),
    Date.parse("2026-01-15T12:34:56Z"),
  );
  assertEquals(
    parseAeLatestAtMs("2026-01-15T12:34:56.123Z"),
    Date.parse("2026-01-15T12:34:56.123Z"),
  );
});

it("parseHostSummaryRow normalizes latest_at when samples exist", () => {
  assertEquals(parseHostSummaryRow(undefined), {
    sampleCount: 0,
    latestAt: null,
  });
  assertEquals(
    parseHostSummaryRow({
      sample_count: 3,
      latest_at: "2026-01-15 12:34:56",
    }).latestAt,
    new Date(Date.parse("2026-01-15T12:34:56Z")).toISOString(),
  );
  assertEquals(
    parseHostSummaryRow({ sample_count: 0, latest_at: "2026-01-15 12:34:56" })
      .latestAt,
    null,
  );
});

it("parseCloudflareV4SqlResponse surfaces AE SQL API errors", () => {
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: false,
        errors: [{ message: "dataset missing" }],
      }),
    Error,
    "AE SQL API error: dataset missing",
  );
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: false,
        errors: [{ code: 1003 }],
      }),
    Error,
    "AE SQL API error: code=1003",
  );
});

it("quoteServerIdInList rejects empty and over-cap lists", () => {
  assertThrows(
    () => quoteServerIdInList([]),
    TypeError,
    "serverIds must be non-empty",
  );
  assertThrows(
    () =>
      quoteServerIdInList(
        Array.from({ length: MAX_FLEET_SNAPSHOT_SERVERS + 1 }, () => SERVER_ID),
      ),
    TypeError,
    `exceeds max ${MAX_FLEET_SNAPSHOT_SERVERS}`,
  );
});

it("quoteServerIdInList dedupes and validates UUID literals", () => {
  const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assertEquals(
    quoteServerIdInList([SERVER_ID, SERVER_ID, idB]),
    `${quoteSqlString(SERVER_ID)}, ${quoteSqlString(idB)}`,
  );
  assertThrows(
    () => quoteServerIdInList(["not-a-uuid"]),
    TypeError,
    "invalid serverId",
  );
});

it("parseSeriesRows skips bad buckets and ignores non-finite sample_count", () => {
  const { points, sampleCount } = parseSeriesRows(
    ["cpuUserPercent"],
    [
      { bucket: 1_704_067_200, sample_count: 2, cpuUserPercent: 10 },
      { bucket: "1704067500", sample_count: "3", cpuUserPercent: "12.5" },
      { bucket: { not: "a number" }, sample_count: 99, cpuUserPercent: 1 },
      { bucket: 1_704_067_800, sample_count: "nope", cpuUserPercent: null },
    ],
    300,
  );
  assertEquals(points.length, 3);
  assertEquals(points[0]!.at, new Date(1_704_067_200 * 1000).toISOString());
  assertEquals(points[0]!.values.cpuUserPercent, 10);
  assertEquals(points[0]!.sampleCount, 2);
  assertEquals(points[0]!.expectedSampleCount, 5);
  assertEquals(points[1]!.values.cpuUserPercent, 12.5);
  assertEquals(points[1]!.sampleCount, 3);
  assertEquals(points[2]!.sampleCount, undefined);
  assertEquals(points[2]!.values.cpuUserPercent, null);
  assertEquals(sampleCount, 5);
});

it("resolveTruncatedStatusEvents marks the cap from raw row count", () => {
  const fromMs = Date.parse("2026-01-01T00:00:00.000Z");
  const under = resolveTruncatedStatusEvents(
    [
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        connected: true,
        reason: "self_heal",
      },
    ],
    fromMs,
  );
  assertEquals(under.truncated, false);
  assertEquals(under.knownUntilMs, undefined);
  assertEquals(under.events[0]!.reason, "self_heal");

  const overflow: Array<Record<string, unknown>> = [];
  for (let i = 0; i < MAX_STATUS_EVENTS + 1; i++) {
    overflow.push({
      timestamp: new Date(fromMs + i * 1000).toISOString(),
      connected: 1,
      reason: "connect",
    });
  }
  const over = resolveTruncatedStatusEvents(overflow, fromMs);
  assertEquals(over.truncated, true);
  assertEquals(over.events.length, MAX_STATUS_EVENTS);
  assertEquals(
    over.knownUntilMs,
    fromMs + (MAX_STATUS_EVENTS - 1) * 1000,
  );

  const unparseable = resolveTruncatedStatusEvents(
    Array.from({ length: MAX_STATUS_EVENTS + 1 }, () => ({
      timestamp: "not-a-timestamp",
      connected: 1,
      reason: "connect",
    })),
    fromMs,
  );
  assertEquals(unparseable.truncated, true);
  assertEquals(unparseable.events.length, 0);
  assertEquals(unparseable.knownUntilMs, fromMs);
});

it("parseStatusEventRows accepts boolean connected and unknown reasons", () => {
  const events = parseStatusEventRows([
    { timestamp: "2026-01-01T00:00:00.000Z", connected: true, reason: "mystery" },
    { timestamp: "2026-01-01T00:00:01.000Z", connected: false, reason: 12 },
    { timestamp: "2026-01-01T00:00:02.000Z", connected: "nope", reason: "connect" },
  ]);
  assertEquals(events.length, 2);
  assertEquals(events[0]!.connected, true);
  assertEquals(events[0]!.reason, "connect");
  assertEquals(events[1]!.connected, false);
  assertEquals(events[1]!.reason, "disconnect");
});

it("parseFleetHostSnapshotRows drops blank ids and zero-sample latest_at", () => {
  const rows = parseFleetHostSnapshotRows(
    ["cpuUserPercent"],
    [
      {
        server_id: "  ",
        sample_count: 2,
        latest_at: "2026-01-01T00:59:00Z",
        cpuUserPercent: 1,
      },
      {
        server_id: SERVER_ID,
        sample_count: 0,
        latest_at: "2026-01-01T00:59:00Z",
        cpuUserPercent: 9,
      },
      {
        server_id: SERVER_ID,
        sample_count: "not-a-number",
        latest_at: "2026-01-01T00:59:00Z",
        cpuUserPercent: 4,
      },
    ],
  );
  assertEquals(rows.length, 2);
  assertEquals(rows[0]!.latestAt, null);
  assertEquals(rows[0]!.sampleCount, 0);
  assertEquals(rows[1]!.sampleCount, 0);
  assertEquals(rows[1]!.latestAt, null);
});

it("queryFleetHostSnapshotViaSqlApi: empty serverIds skips fetch", async () => {
  const result = await queryFleetHostSnapshotViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: () => {
        throw new TypeError("fetch must not run for an empty fleet");
      },
    },
    {
      serverIds: [],
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:50:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
  );
  assertEquals(result.kind, "analytics-engine");
  assertEquals(result.available, true);
  assertEquals(result.metrics, ["cpuUserPercent"]);
  assertEquals(result.servers, []);
});

it("queryFleetHostSnapshotViaSqlApi: consumes enveloped result.data", async () => {
  const result = await queryFleetHostSnapshotViaSqlApi(
    {
      accountId: "acct123",
      apiToken: "token-xyz",
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              server_id: SERVER_ID,
              sample_count: 4,
              latest_at: "2026-01-01T00:59:00Z",
              cpuUserPercent: 11,
            },
          ]),
          { status: 200 },
        ),
    },
    {
      serverIds: [SERVER_ID],
      metrics: ["cpuUserPercent"],
      from: "2026-01-01T00:50:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
  );
  assertEquals(result.servers.length, 1);
  assertEquals(result.servers[0]!.serverId, SERVER_ID);
  assertEquals(result.servers[0]!.values.cpuUserPercent, 11);
  assertEquals(result.servers[0]!.sampleCount, 4);
});

it("parseCloudflareV4SqlResponse maps remaining envelope and error shapes", () => {
  assertThrows(
    () => parseCloudflareV4SqlResponse([]),
    TypeError,
    "not a JSON object",
  );
  assertEquals(parseCloudflareV4SqlResponse({ success: true, result: null }).data, []);
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: true,
        result: { error: "query aborted" },
      }),
    Error,
    "AE SQL query error: query aborted",
  );
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: true,
        result: { data: { not: "rows" } },
      }),
    TypeError,
    "result.data is not an array",
  );
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: true,
        result: "oops",
      }),
    TypeError,
    "result is not an object",
  );
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: false,
        errors: ["  auth failed  "],
      }),
    Error,
    "AE SQL API error: auth failed",
  );
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: false,
        errors: [{}],
        extra: true,
      }),
    Error,
    "opaque body keys=",
  );
});

it("parseAeLatestAtMs rejects non-numeric non-string values", () => {
  assertEquals(parseAeLatestAtMs(false), null);
  assertEquals(parseAeLatestAtMs(Number.NaN), null);
  assertEquals(parseAeLatestAtMs("not-a-date"), null);
});

// ---------------------------------------------------------------------------
// Executed-SQL semantics: run the generated AE SQL against an embedded DuckDB
// with a physical AE-shaped table and minimal dialect shims (macros for the
// documented AE functions DuckDB lacks). Rows are written through the real
// write-path builders (`buildCoreDataPoint` / `buildExtendedDataPoint` /
// `buildStatusDataPoint`), so these tests prove logical-sample recombination
// and half-open range behavior end to end — string assertions cannot.
// ---------------------------------------------------------------------------

const EXEC_T0 = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function execHostSample(overrides: {
  serverId?: string;
  atMs: number;
  intervalSeconds?: number;
  metrics?: Partial<AuthenticatedHostMetricsSample["metrics"]>;
}): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = overrides.metrics?.[key] ?? null;
  }
  const at = isoAt(overrides.atMs);
  return {
    serverId: overrides.serverId ?? SERVER_ID,
    at,
    sampledAt: at,
    receivedAt: at,
    intervalSeconds: overrides.intervalSeconds ?? 60,
    sequence: 1,
    schemaVersion: METRICS_SCHEMA_VERSION,
    collectionMode: "baseline",
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "linux",
      architecture: "x86_64",
      kernelRelease: "6.18.0",
      collectionMode: "baseline",
    },
    metrics,
  };
}

type AeSqlFixture = {
  insertPoint(
    point: AnalyticsEngineDataPointLike,
    atIso: string,
    sampleInterval?: number,
  ): Promise<void>;
  query(sql: string): Promise<Array<Record<string, unknown>>>;
};

/** Emulate the AE JSON transport: numbers and space-separated DateTimes. */
function normalizeExecValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace("T", " ");
  }
  if (value !== null && typeof value === "object") {
    // Driver-specific timestamp wrapper — render like an AE DateTime string.
    return String(value).replace(/(\.\d{3})\d*$/, "$1");
  }
  return value;
}

async function withAeSqlFixture(
  run: (fixture: AeSqlFixture) => Promise<void>,
): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    // Documented AE SQL functions the DuckDB dialect lacks.
    await connection.run(
      "CREATE MACRO intDiv(a, b) AS CAST(floor(a / b) AS BIGINT)",
    );
    await connection.run(
      "CREATE MACRO toUnixTimestamp(ts) AS CAST(epoch(ts) AS BIGINT)",
    );
    await connection.run(
      "CREATE MACRO toDateTime(u) AS epoch_ms(CAST(u AS BIGINT) * 1000)",
    );
    await connection.run(
      "CREATE MACRO argMax(arg, val) AS arg_max(arg, val)",
    );
    const doubleColumns = Array.from(
      { length: AE_DOUBLE_COUNT },
      (_, i) => `double${i + 1} DOUBLE`,
    );
    const blobColumns = Array.from(
      { length: AE_BLOB_COUNT },
      (_, i) => `blob${i + 1} VARCHAR`,
    );
    await connection.run(
      `CREATE TABLE ${AE_DATASET_NAME} (index1 VARCHAR, "timestamp" TIMESTAMP, _sample_interval DOUBLE, ${
        [...doubleColumns, ...blobColumns].join(", ")
      })`,
    );
    await run({
      async insertPoint(point, atIso, sampleInterval = 1) {
        const values = [
          quoteSqlString(point.indexes[0]!),
          `TIMESTAMP ${
            quoteSqlString(atIso.replace("T", " ").replace("Z", ""))
          }`,
          String(sampleInterval),
          ...point.doubles.map((d) => String(d)),
          ...point.blobs.map((b) => quoteSqlString(b)),
        ];
        await connection.run(
          `INSERT INTO ${AE_DATASET_NAME} VALUES (${values.join(", ")})`,
        );
      },
      async query(sql) {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowObjectsJS().map((row) => {
          const out: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) {
            out[key] = normalizeExecValue(value);
          }
          return out;
        });
      },
    });
  } finally {
    connection.closeSync();
  }
}

it("executed series SQL: one-sided part rows never skew logical samples", async () => {
  await withAeSqlFixture(async (fixture) => {
    // Complete logical sample — both parts landed.
    const full = execHostSample({
      atMs: EXEC_T0 + 60_000,
      metrics: { cpuUserPercent: 10, gpuPowerWatts: 100 },
    });
    await fixture.insertPoint(buildCoreDataPoint(full), full.at);
    await fixture.insertPoint(buildExtendedDataPoint(full), full.at);
    // Core-only orphan — the extended fire-and-forget write was lost.
    const coreOnly = execHostSample({
      atMs: EXEC_T0 + 120_000,
      metrics: { cpuUserPercent: 30, gpuPowerWatts: 999 },
    });
    await fixture.insertPoint(buildCoreDataPoint(coreOnly), coreOnly.at);
    // Extended-only orphan — the core write was lost; not a logical sample.
    const extendedOnly = execHostSample({
      atMs: EXEC_T0 + 180_000,
      metrics: { cpuUserPercent: 999, gpuPowerWatts: 900 },
    });
    await fixture.insertPoint(
      buildExtendedDataPoint(extendedOnly),
      extendedOnly.at,
    );
    // Second bucket: core-only orphan alone — extended metrics must be null.
    const secondBucket = execHostSample({
      atMs: EXEC_T0 + 360_000,
      metrics: { cpuUserPercent: 50 },
    });
    await fixture.insertPoint(buildCoreDataPoint(secondBucket), secondBucket.at);

    const { sql, metrics, bucketSeconds } = buildHostSeriesSql(
      {
        serverId: SERVER_ID,
        metrics: ["cpuUserPercent", "gpuPowerWatts"],
        from: isoAt(EXEC_T0),
        to: isoAt(EXEC_T0 + 600_000),
        resolutionSeconds: 300,
      },
      {
        dataset: AE_DATASET_NAME,
        maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
      },
    );
    const rows = await fixture.query(sql);
    const { points, sampleCount } = parseSeriesRows(
      metrics,
      rows,
      bucketSeconds,
    );

    assertEquals(points.length, 2);
    // Three logical samples (rows with a core part) — the extended-only
    // orphan is not a sample.
    assertEquals(sampleCount, 3);
    assertEquals(points[0]!.at, isoAt(EXEC_T0));
    assertEquals(points[0]!.sampleCount, 2);
    assertEquals(points[0]!.values.cpuUserPercent, 20); // (10 + 30) / 2
    // Only the complete logical sample contributes extended metrics — the
    // orphan extended row (900) would otherwise pull this to 500.
    assertEquals(points[0]!.values.gpuPowerWatts, 100);
    assertEquals(points[1]!.at, isoAt(EXEC_T0 + 300_000));
    assertEquals(points[1]!.sampleCount, 1);
    assertEquals(points[1]!.values.cpuUserPercent, 50);
    // A core-only bucket has no extended data — null, never fabricated.
    assertEquals(points[1]!.values.gpuPowerWatts, null);
  });
});

it("executed fleet snapshot SQL: sample_count/latest_at track logical samples only", async () => {
  const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await withAeSqlFixture(async (fixture) => {
    // Server A: one complete logical sample, then a newer extended-only
    // orphan that must not advance latest_at.
    const fullA = execHostSample({
      atMs: EXEC_T0 + 60_000,
      metrics: { cpuUserPercent: 40 },
    });
    await fixture.insertPoint(buildCoreDataPoint(fullA), fullA.at);
    await fixture.insertPoint(buildExtendedDataPoint(fullA), fullA.at);
    const orphanA = execHostSample({ atMs: EXEC_T0 + 540_000 });
    await fixture.insertPoint(buildExtendedDataPoint(orphanA), orphanA.at);
    // Server A: complete sample exactly at `to` — half-open range excludes it.
    const boundaryA = execHostSample({
      atMs: EXEC_T0 + 600_000,
      metrics: { cpuUserPercent: 90 },
    });
    await fixture.insertPoint(buildCoreDataPoint(boundaryA), boundaryA.at);
    await fixture.insertPoint(buildExtendedDataPoint(boundaryA), boundaryA.at);
    // Server B: only extended-only orphans — no logical samples at all.
    const orphanB = execHostSample({
      serverId: idB,
      atMs: EXEC_T0 + 120_000,
      metrics: { gpuPowerWatts: 700 },
    });
    await fixture.insertPoint(buildExtendedDataPoint(orphanB), orphanB.at);

    const { sql, metrics } = buildFleetHostSnapshotSql(
      {
        serverIds: [SERVER_ID, idB],
        metrics: ["cpuUserPercent"],
        from: isoAt(EXEC_T0),
        to: isoAt(EXEC_T0 + 600_000),
      },
      {
        dataset: AE_DATASET_NAME,
        maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
      },
    );
    const servers = parseFleetHostSnapshotRows(
      metrics,
      await fixture.query(sql),
    );

    // Server B never produced a logical sample — it must not appear.
    assertEquals(servers.length, 1);
    assertEquals(servers[0]!.serverId, SERVER_ID);
    assertEquals(servers[0]!.sampleCount, 1);
    // latest_at is the newest logical sample — not the newer orphan row and
    // not the boundary sample sitting exactly at `to`.
    assertEquals(servers[0]!.latestAt, isoAt(EXEC_T0 + 60_000));
    assertEquals(servers[0]!.values.cpuUserPercent, 40);
  });
});

it("executed series + summary SQL: sample exactly at `to` belongs to the next range only", async () => {
  await withAeSqlFixture(async (fixture) => {
    const boundaryMs = EXEC_T0 + 3_600_000; // 2026-01-01T01:00:00Z
    const sample = execHostSample({
      atMs: boundaryMs,
      metrics: { cpuUserPercent: 25 },
    });
    await fixture.insertPoint(buildCoreDataPoint(sample), sample.at);
    await fixture.insertPoint(buildExtendedDataPoint(sample), sample.at);

    const opts = {
      dataset: AE_DATASET_NAME,
      maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
    };
    const earlier = { from: isoAt(EXEC_T0), to: isoAt(boundaryMs) };
    const later = {
      from: isoAt(boundaryMs),
      to: isoAt(boundaryMs + 3_600_000),
    };

    const earlierSeries = buildHostSeriesSql(
      {
        serverId: SERVER_ID,
        metrics: ["cpuUserPercent"],
        resolutionSeconds: 300,
        ...earlier,
      },
      opts,
    );
    assertEquals((await fixture.query(earlierSeries.sql)).length, 0);
    const laterSeries = buildHostSeriesSql(
      {
        serverId: SERVER_ID,
        metrics: ["cpuUserPercent"],
        resolutionSeconds: 300,
        ...later,
      },
      opts,
    );
    const laterPoints = parseSeriesRows(
      laterSeries.metrics,
      await fixture.query(laterSeries.sql),
      laterSeries.bucketSeconds,
    );
    assertEquals(laterPoints.points.length, 1);
    assertEquals(laterPoints.points[0]!.at, isoAt(boundaryMs));
    assertEquals(laterPoints.sampleCount, 1);

    const earlierSummary = parseHostSummaryRow(
      (await fixture.query(
        buildHostSummarySql({ serverId: SERVER_ID, ...earlier }, opts),
      ))[0],
    );
    assertEquals(earlierSummary, { sampleCount: 0, latestAt: null });
    const laterSummary = parseHostSummaryRow(
      (await fixture.query(
        buildHostSummarySql({ serverId: SERVER_ID, ...later }, opts),
      ))[0],
    );
    // sample_count counts the core part only — one logical sample.
    assertEquals(laterSummary.sampleCount, 1);
    assertEquals(laterSummary.latestAt, isoAt(boundaryMs));
  });
});

it("executed status events SQL: event exactly at `to` belongs to the next range only", async () => {
  await withAeSqlFixture(async (fixture) => {
    const boundaryMs = EXEC_T0 + 3_600_000;
    const event: ServerStatusEvent = {
      serverId: SERVER_ID,
      connected: true,
      reason: "connect",
      at: isoAt(boundaryMs),
    };
    await fixture.insertPoint(buildStatusDataPoint(event), event.at);

    const opts = {
      dataset: AE_DATASET_NAME,
      maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
    };
    const earlierRows = await fixture.query(buildStatusEventsSql(
      { serverId: SERVER_ID, from: isoAt(EXEC_T0), to: isoAt(boundaryMs) },
      opts,
    ));
    assertEquals(parseStatusEventRows(earlierRows), []);

    const laterRows = await fixture.query(buildStatusEventsSql(
      {
        serverId: SERVER_ID,
        from: isoAt(boundaryMs),
        to: isoAt(boundaryMs + 3_600_000),
      },
      opts,
    ));
    const events = parseStatusEventRows(laterRows);
    assertEquals(events.length, 1);
    assertEquals(events[0]!.at, isoAt(boundaryMs));
    assertEquals(events[0]!.connected, true);
    assertEquals(events[0]!.reason, "connect");
  });
});

it("stripAeSentinel: sentinel reads as missing, real values pass through", () => {
  assertEquals(stripAeSentinel(AE_MISSING_METRIC_SENTINEL), null);
  assertEquals(stripAeSentinel(-1e308), null);
  assertEquals(stripAeSentinel(0), 0);
  assertEquals(stripAeSentinel(-100), -100);
  assertEquals(stripAeSentinel(42.5), 42.5);
});

it("buildHostSeriesSql: descriptor dispatch — argMax for last, MAX for max, num/den for weighted", () => {
  const { sql } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUserPercent", "systemStorageTotalBytes", "uptimeSeconds"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 60,
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  // weighted-average metric keeps the num/den pair.
  assertEquals(
    sql.includes(
      "SUM(cpuUserPercent_num) / SUM(cpuUserPercent_den) AS cpuUserPercent",
    ),
    true,
  );
  // last metric: sentinel-safe raw value at the logical-sample grain, then
  // argMax with sentinel rows demoted so real observations always win.
  assertEquals(
    sql.includes(
      `${
        rawValueExpressionForMetric("systemStorageTotalBytes")
      } AS systemStorageTotalBytes_value`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `${
        lastValueExpressionForMetric("systemStorageTotalBytes")
      } AS systemStorageTotalBytes`,
    ),
    true,
  );
  // max metric: plain MAX over the raw value column.
  assertEquals(
    sql.includes(
      `${maxValueExpressionForMetric("uptimeSeconds")} AS uptimeSeconds`,
    ),
    true,
  );
  // last/max metrics never build weighted num/den columns.
  assertEquals(sql.includes("systemStorageTotalBytes_num"), false);
  assertEquals(sql.includes("uptimeSeconds_den"), false);
  // Observed cadence flows out of the logical-sample grain into each bucket,
  // weighted by the same core_weight (_sample_interval) that scales
  // sample_count — never a plain avg that misweights sampled rows.
  assertEquals(
    sql.includes(
      `${weightedAvgIntervalSecondsExpression()} AS avg_interval_seconds`,
    ),
    true,
  );
  assertEquals(sql.includes("avg(interval_seconds)"), false);
  assertEquals(
    sql.includes(`${intervalSecondsColumn()}, 0.0)) AS interval_seconds`),
    true,
  );
});

it("executed series SQL: mixed-cadence hour is interval-weighted, not naive-averaged", async () => {
  await withAeSqlFixture(async (fixture) => {
    // Mirror of the DuckDB store fixture: 30 baseline samples (60 s, value
    // 10) then 180 live samples (10 s, value 90) across one hour.
    for (let i = 0; i < 30; i++) {
      const s = execHostSample({
        atMs: EXEC_T0 + i * 60_000,
        intervalSeconds: 60,
        metrics: { cpuUserPercent: 10 },
      });
      await fixture.insertPoint(buildCoreDataPoint(s), s.at);
      await fixture.insertPoint(buildExtendedDataPoint(s), s.at);
    }
    for (let i = 0; i < 180; i++) {
      const s = execHostSample({
        atMs: EXEC_T0 + 1_800_000 + i * 10_000,
        intervalSeconds: 10,
        metrics: { cpuUserPercent: 90 },
      });
      await fixture.insertPoint(buildCoreDataPoint(s), s.at);
      await fixture.insertPoint(buildExtendedDataPoint(s), s.at);
    }

    const { sql, metrics, bucketSeconds } = buildHostSeriesSql(
      {
        serverId: SERVER_ID,
        metrics: ["cpuUserPercent"],
        from: isoAt(EXEC_T0),
        to: isoAt(EXEC_T0 + 3_600_000),
        resolutionSeconds: 3600,
      },
      {
        dataset: AE_DATASET_NAME,
        maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
      },
    );
    const { points, sampleCount } = parseSeriesRows(
      metrics,
      await fixture.query(sql),
      bucketSeconds,
    );

    assertEquals(points.length, 1);
    assertEquals(sampleCount, 210);
    // (30·60·10 + 180·10·90) / (30·60 + 180·10) = 50 — a naive per-sample
    // average would overweight the live burst (~78.6).
    assertEquals(points[0]!.values.cpuUserPercent, 50);
    // Expected samples follow the observed average cadence, not 60 s (60).
    assertEquals(points[0]!.expectedSampleCount, 210);
  });
});

it("executed series SQL: sampled (_sample_interval > 1) mixed-cadence rows weight cadence and coverage", async () => {
  await withAeSqlFixture(async (fixture) => {
    // AE query-time sampling retained two rows for the first bucket: one
    // 60 s-cadence row standing for 2 logical samples and one 20 s-cadence
    // row standing for 6. Weighted cadence: (60·2 + 20·6) / (2 + 6) = 30 s —
    // a plain avg(interval_seconds) would claim (60 + 20) / 2 = 40 s and
    // under-expect the bucket.
    const slow = execHostSample({
      atMs: EXEC_T0 + 60_000,
      intervalSeconds: 60,
      metrics: { cpuUserPercent: 10 },
    });
    await fixture.insertPoint(buildCoreDataPoint(slow), slow.at, 2);
    await fixture.insertPoint(buildExtendedDataPoint(slow), slow.at, 2);
    const fast = execHostSample({
      atMs: EXEC_T0 + 120_000,
      intervalSeconds: 20,
      metrics: { cpuUserPercent: 50 },
    });
    await fixture.insertPoint(buildCoreDataPoint(fast), fast.at, 6);
    await fixture.insertPoint(buildExtendedDataPoint(fast), fast.at, 6);

    // Full result path: SQL build → execute → parse → finalize (gapCount).
    const result = await queryHostSeriesViaSqlApi(
      {
        accountId: "acct123",
        apiToken: "token-xyz",
        fetch: async (_url, init) =>
          new Response(
            envelopedSqlResponse(
              await fixture.query(String(init?.body ?? "")),
            ),
            { status: 200 },
          ),
      },
      {
        serverId: SERVER_ID,
        metrics: ["cpuUserPercent"],
        from: isoAt(EXEC_T0),
        to: isoAt(EXEC_T0 + 1_200_000),
        resolutionSeconds: 600,
      },
    );

    assertEquals(result.points.length, 1);
    // sample_count is _sample_interval-scaled: 2 + 6 logical samples.
    assertEquals(result.points[0]!.sampleCount, 8);
    assertEquals(result.sampleCount, 8);
    // 600 s bucket at the 30 s weighted cadence → 20, not round(600/40) = 15.
    assertEquals(result.points[0]!.expectedSampleCount, 20);
    // Both rows carry equal value weight (interval × _sample_interval = 120),
    // so the weighted average is (10 + 50) / 2 = 30.
    assertEquals(result.points[0]!.values.cpuUserPercent, 30);
    // First bucket misses 20 − 8 = 12 samples; the empty second bucket
    // contributes the 60 s-default expectation of 10.
    assertEquals(result.gapCount, 22);
  });
});

it("executed series SQL: last/max dispatch with sentinel-safe missing buckets", async () => {
  await withAeSqlFixture(async (fixture) => {
    const writeBoth = async (s: AuthenticatedHostMetricsSample) => {
      await fixture.insertPoint(buildCoreDataPoint(s), s.at);
      await fixture.insertPoint(buildExtendedDataPoint(s), s.at);
    };
    // First bucket: capacity grows, uptime drops mid-bucket (reboot), then a
    // final sample missing both metrics.
    await writeBoth(execHostSample({
      atMs: EXEC_T0 + 60_000,
      metrics: { systemStorageTotalBytes: 1000, uptimeSeconds: 100 },
    }));
    await writeBoth(execHostSample({
      atMs: EXEC_T0 + 120_000,
      metrics: { systemStorageTotalBytes: 2000, uptimeSeconds: 50 },
    }));
    await writeBoth(execHostSample({ atMs: EXEC_T0 + 180_000 }));
    // Second bucket: every sample misses both metrics — all-sentinel bucket.
    await writeBoth(execHostSample({ atMs: EXEC_T0 + 360_000 }));

    const { sql, metrics, bucketSeconds } = buildHostSeriesSql(
      {
        serverId: SERVER_ID,
        metrics: ["systemStorageTotalBytes", "uptimeSeconds"],
        from: isoAt(EXEC_T0),
        to: isoAt(EXEC_T0 + 600_000),
        resolutionSeconds: 300,
      },
      {
        dataset: AE_DATASET_NAME,
        maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
      },
    );
    const { points } = parseSeriesRows(
      metrics,
      await fixture.query(sql),
      bucketSeconds,
    );

    assertEquals(points.length, 2);
    // last: the newest present value wins — never the trailing sentinel
    // sample, never a 1500 weighted average.
    assertEquals(points[0]!.values.systemStorageTotalBytes, 2000);
    // max: the pre-reboot uptime, not the latest and not an average.
    assertEquals(points[0]!.values.uptimeSeconds, 100);
    // All-sentinel bucket parses to null — never an astronomically negative
    // number leaking the storage sentinel to charts.
    assertEquals(points[1]!.values.systemStorageTotalBytes, null);
    assertEquals(points[1]!.values.uptimeSeconds, null);
  });
});

/**
 * Backend-independent view of a series result: everything a chart consumer
 * sees except the `kind` discriminator — sampleCount, expectedSampleCount,
 * gapCount, resolutionSeconds, normalized timestamps, and metric values.
 */
function normalizeSeriesResultForParity(result: HostSeriesResult) {
  return {
    available: result.available,
    serverId: result.serverId,
    metrics: [...result.metrics],
    resolutionSeconds: result.resolutionSeconds,
    sampleCount: result.sampleCount,
    gapCount: result.gapCount,
    points: result.points.map((point) => ({
      at: point.at,
      values: point.values,
      sampleCount: point.sampleCount,
      expectedSampleCount: point.expectedSampleCount,
    })),
  };
}

it("backend parity: identical samples aggregate identically on DuckDB and AE", async () => {
  // Weighted (35, exactly representable), last (2000), and max (100) over
  // three mixed-cadence samples — the same logical input goes through the
  // DuckDB store and the AE field-map/SQL builders.
  const parityAtMs = [EXEC_T0 + 60_000, EXEC_T0 + 120_000, EXEC_T0 + 240_000];
  const parityInputs = [
    {
      atMs: parityAtMs[0]!,
      intervalSeconds: 60,
      metrics: {
        cpuUserPercent: 10,
        systemStorageTotalBytes: 1000,
        uptimeSeconds: 100,
      },
    },
    {
      atMs: parityAtMs[1]!,
      intervalSeconds: 60,
      metrics: {
        cpuUserPercent: 30,
        systemStorageTotalBytes: 2000,
        uptimeSeconds: 50,
      },
    },
    // Faster cadence, missing last/max metrics.
    {
      atMs: parityAtMs[2]!,
      intervalSeconds: 120,
      metrics: { cpuUserPercent: 50 },
    },
  ] as const;
  const parityMetrics = [
    "cpuUserPercent",
    "systemStorageTotalBytes",
    "uptimeSeconds",
  ] as const;
  const from = isoAt(EXEC_T0);
  const to = isoAt(EXEC_T0 + 3_600_000);

  // AE side — the full logical query path (SQL build → execute → parse →
  // finalize), not just the value map, so contract drift in sampleCount /
  // expectedSampleCount / gapCount / timestamps cannot slip through.
  let aeSeries: HostSeriesResult | undefined;
  await withAeSqlFixture(async (fixture) => {
    for (const input of parityInputs) {
      const s = execHostSample(input);
      await fixture.insertPoint(buildCoreDataPoint(s), s.at);
      await fixture.insertPoint(buildExtendedDataPoint(s), s.at);
    }
    aeSeries = await queryHostSeriesViaSqlApi(
      {
        accountId: "acct123",
        apiToken: "token-xyz",
        fetch: async (_url, init) =>
          new Response(
            envelopedSqlResponse(
              await fixture.query(String(init?.body ?? "")),
            ),
            { status: 200 },
          ),
      },
      {
        serverId: SERVER_ID,
        metrics: [...parityMetrics],
        from,
        to,
        resolutionSeconds: 3600,
      },
    );
  });

  // DuckDB side.
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-parity-duckdb-" });
  const store = new DuckDbParquetServerMetricsStore(
    { metricsDir },
    { writeBatchMaxRows: 1 },
  );
  try {
    for (const input of parityInputs) {
      await store.writeHostSample(execHostSample(input));
    }
    const duckSeries = await store.queryHostSeries({
      serverId: SERVER_ID,
      metrics: [...parityMetrics],
      from,
      to,
      resolutionSeconds: 3600,
    });

    // Concrete expected shape — spot-checked on DuckDB, then the whole
    // normalized result must match AE exactly.
    assertEquals(duckSeries.kind, "duckdb");
    assertEquals(aeSeries!.kind, "analytics-engine");
    assertEquals(duckSeries.points.length, 1);
    const duckPoint = duckSeries.points[0]!;
    assertEquals(duckPoint.at, isoAt(EXEC_T0));
    // Interval-weighted: (60·10 + 60·30 + 120·50) / 240 = 35.
    assertEquals(duckPoint.values.cpuUserPercent, 35);
    // last / max agree, including the trailing sample that misses both.
    assertEquals(duckPoint.values.systemStorageTotalBytes, 2000);
    assertEquals(duckPoint.values.uptimeSeconds, 100);
    assertEquals(duckSeries.resolutionSeconds, 3600);
    assertEquals(duckSeries.sampleCount, 3);
    assertEquals(duckPoint.sampleCount, 3);
    // Observed cadence (60 + 60 + 120) / 3 = 80 s → round(3600 / 80) = 45
    // expected samples; 45 − 3 present = 42 missing in the hour bucket.
    assertEquals(duckPoint.expectedSampleCount, 45);
    assertEquals(duckSeries.gapCount, 42);

    assertEquals(
      normalizeSeriesResultForParity(aeSeries!),
      normalizeSeriesResultForParity(duckSeries),
    );
  } finally {
    await store.close();
    await Deno.remove(metricsDir, { recursive: true });
  }
});
