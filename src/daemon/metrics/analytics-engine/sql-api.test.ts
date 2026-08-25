import { assertEquals, assertThrows } from "@std/assert";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { it } from "@std/testing/bdd";
import {
  AE_BLOB_EVENT_TYPE_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_DATASET_NAME,
  AE_HOST_EVENT_TYPE,
  AE_MISSING_METRIC_SENTINEL,
  AE_STATUS_EVENT_TYPE,
  blobColumn,
  doubleColumnForMetric,
  statusConnectedColumn,
  statusReasonColumn,
} from "./field-map.ts";
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  AE_LIVENESS_WINDOW_SECONDS,
  aeMissingMetricSentinelSql,
  buildHostSeriesSql,
  buildHostSummarySql,
  buildFleetHostSnapshotSql,
  buildRecentlyActiveServerIdsSql,
  buildStatusEventsSql,
  buildStatusPriorStateSql,
  clickhouseAvgExpression,
  hostEventDiscriminatorPredicates,
  MAX_STATUS_EVENTS,
  parseAeLatestAtMs,
  parseCloudflareV4SqlResponse,
  parseFleetHostSnapshotRows,
  parseHostSummaryRow,
  parseStatusEventRows,
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  queryRecentlyActiveServerIds,
  queryStatusHistoryViaSqlApi,
  quoteSqlString,
  statusEventDiscriminatorPredicates,
  weightedAvgExpression,
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

it("clickhouseAvgExpression excludes AE_MISSING_METRIC_SENTINEL", () => {
  const expr = clickhouseAvgExpression("double1");
  assertEquals(expr.includes(String(AE_MISSING_METRIC_SENTINEL)), true);
  assertEquals(expr.includes("countIf(double1 != "), true);
  assertEquals(expr.includes("double1"), true);
});

it("quoteSqlString doubles single quotes", () => {
  assertEquals(quoteSqlString("a'b"), "'a''b'");
  assertEquals(quoteSqlString(SERVER_ID), `'${SERVER_ID}'`);
});

it("weightedAvgExpression excludes AE_MISSING_METRIC_SENTINEL via AE-safe literal", () => {
  const expr = weightedAvgExpression("double1");
  assertEquals(expr.includes(aeMissingMetricSentinelSql()), true);
  // Scientific notation / NULLIF are not documented AE SQL — embedding them
  // broke production chart queries (`metrics_backend_unavailable`).
  assertEquals(expr.includes(String(AE_MISSING_METRIC_SENTINEL)), false);
  assertEquals(expr.includes("NULLIF"), false);
  // AE IF() requires matching branch types (Integer 0 vs Double → HTTP 422).
  assertEquals(expr.includes("0.0"), true);
  assertEquals(expr.includes(", 0,"), false);
  assertEquals(expr.includes("_sample_interval * 1.0"), true);
  assertEquals(expr.includes("_sample_interval"), true);
  assertEquals(expr.includes("double1"), true);
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
      quoteSqlString(AE_HOST_EVENT_TYPE)
    }`,
  );
  assertEquals(
    predicates[1],
    `${blobColumn(AE_BLOB_SCHEMA_VERSION_INDEX)} = ${
      quoteSqlString(String(METRICS_SCHEMA_VERSION))
    }`,
  );
});

it("buildHostSeriesSql: allowlisted doubles + weighted avg only", () => {
  const { sql, metrics, bucketSeconds } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUsagePercent", "load1"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 60,
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(metrics, ["cpuUsagePercent", "load1"]);
  assertEquals(bucketSeconds, 60);
  assertEquals(sql.includes(doubleColumnForMetric("cpuUsagePercent")), true);
  assertEquals(sql.includes(doubleColumnForMetric("load1")), true);
  assertEquals(sql.includes("_sample_interval"), true);
  assertEquals(sql.includes(`index1 = ${quoteSqlString(SERVER_ID)}`), true);
  assertEquals(sql.includes(AE_DATASET_NAME), true);
  // No ad-hoc double columns outside the field map.
  assertEquals(sql.includes("double3"), false);
  assertEquals(sql.includes(aeMissingMetricSentinelSql()), true);
  assertEquals(sql.includes(String(AE_MISSING_METRIC_SENTINEL)), false);
  assertEquals(sql.includes("NULLIF"), false);
  assertEquals(sql.includes("FORMAT JSON"), false);
});

it("buildHostSeriesSql: filters host event type and schema version", () => {
  const { sql } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUsagePercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  for (const predicate of hostEventDiscriminatorPredicates()) {
    assertEquals(sql.includes(`AND ${predicate}`), true);
  }
});

it("buildHostSeriesSql: unknown metric throws before SQL", () => {
  assertThrows(
    () =>
      buildHostSeriesSql(
        {
          serverId: SERVER_ID,
          metrics: ["notARealMetric" as "cpuUsagePercent"],
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
          metrics: ["cpuUsagePercent"],
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
          metrics: ["cpuUsagePercent"],
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
      metrics: ["cpuUsagePercent"],
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
          metrics: ["cpuUsagePercent"],
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

it("buildHostSummarySql: quoted serverId + sample_count/latest_at", () => {
  const sql = buildHostSummarySql(
    {
      serverId: SERVER_ID,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(sql.includes(`index1 = ${quoteSqlString(SERVER_ID)}`), true);
  assertEquals(sql.includes("SUM(_sample_interval) AS sample_count"), true);
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
      metrics: ["cpuUsagePercent", "memoryUsedPercent", "swapUsedPercent"],
      from: "2026-01-01T00:50:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(metrics, [
    "cpuUsagePercent",
    "memoryUsedPercent",
    "swapUsedPercent",
  ]);
  assertEquals(sql.includes(`IN (${quoteSqlString(SERVER_ID)}, ${quoteSqlString(idB)})`), true);
  assertEquals(sql.includes("GROUP BY server_id"), true);
  assertEquals(sql.includes("AS cpuUsagePercent"), true);
  assertEquals(sql.includes("AS memoryUsedPercent"), true);
  assertEquals(sql.includes("AS swapUsedPercent"), true);
  assertEquals(sql.includes(weightedAvgExpression(doubleColumnForMetric("cpuUsagePercent"))), true);
});

it("parseFleetHostSnapshotRows skips bad ids and sorts", () => {
  const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const rows = parseFleetHostSnapshotRows(
    ["cpuUsagePercent"],
    [
      {
        server_id: idB,
        sample_count: 2,
        latest_at: "2026-01-01T00:59:00Z",
        cpuUsagePercent: 10,
      },
      {
        server_id: SERVER_ID,
        sample_count: 3,
        latest_at: "2026-01-01T00:58:00Z",
        cpuUsagePercent: 42.5,
      },
      { server_id: 12, sample_count: 1, cpuUsagePercent: 1 },
    ],
  );
  assertEquals(rows.length, 2);
  assertEquals(rows[0]!.serverId, SERVER_ID);
  assertEquals(rows[0]!.values.cpuUsagePercent, 42.5);
  assertEquals(rows[1]!.serverId, idB);
});

it("AE_LIVENESS_WINDOW_SECONDS is three missed 60s samples", () => {
  assertEquals(AE_LIVENESS_WINDOW_SECONDS, 180);
});

it("buildRecentlyActiveServerIdsSql: fleet-wide host discriminators, no doubles", () => {
  const predicates = hostEventDiscriminatorPredicates();
  const sql = buildRecentlyActiveServerIdsSql({
    sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
    nowMs: 1_704_067_200_000,
  });
  for (const predicate of predicates) {
    assertEquals(sql.includes(predicate), true);
  }
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_HOST_EVENT_TYPE)}`), true);
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_STATUS_EVENT_TYPE)}`), false);
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
    sql.includes(`blob2 = ${quoteSqlString(String(METRICS_SCHEMA_VERSION))}`),
    true,
  );
  assertEquals(sql.includes(`${statusConnectedColumn()} AS connected`), true);
  assertEquals(sql.includes(`${statusReasonColumn()} AS reason`), true);
  assertEquals(sql.includes("ORDER BY timestamp ASC"), true);
  assertEquals(sql.includes(`LIMIT ${MAX_STATUS_EVENTS + 1}`), true);
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_HOST_EVENT_TYPE)}`), false);
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

it("host series SQL still filters blob1 = host after discriminator refactor", () => {
  const { sql } = buildHostSeriesSql(
    {
      serverId: SERVER_ID,
      metrics: ["cpuUsagePercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
    },
    { dataset: AE_DATASET_NAME, maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS },
  );
  assertEquals(sql.includes(`blob1 = ${quoteSqlString(AE_HOST_EVENT_TYPE)}`), true);
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

it("parseCloudflareV4SqlResponse: reads result.data from v4 envelope", () => {
  const parsed = parseCloudflareV4SqlResponse({
    success: true,
    errors: [],
    result: {
      data: [{ bucket: 1, sample_count: 2, cpuUsagePercent: 9 }],
      rows: 1,
    },
  });
  assertEquals(parsed.data.length, 1);
  assertEquals(parsed.data[0]!.cpuUsagePercent, 9);
  assertEquals(parsed.rows, 1);
});

it("parseCloudflareV4SqlResponse: accepts ClickHouse-style flat { data } body", () => {
  const parsed = parseCloudflareV4SqlResponse({
    data: [{ bucket: 1, sample_count: 2, cpuUsagePercent: 9 }],
    rows: 1,
  });
  assertEquals(parsed.data.length, 1);
  assertEquals(parsed.data[0]!.cpuUsagePercent, 9);
  assertEquals(parsed.rows, 1);
});

it("parseCloudflareV4SqlResponse: success:false surfaces result.error when errors empty", () => {
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        success: false,
        errors: [],
        result: { error: "table turbopanel_server_metrics does not exist" },
      }),
    Error,
    "table turbopanel_server_metrics does not exist",
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
              cpuUsagePercent: 10.5,
            },
          ]),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      metrics: ["cpuUsagePercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 300,
    },
  );
  assertEquals(result.available, true);
  assertEquals(result.points.length, 1);
  assertEquals(result.points[0]!.values.cpuUsagePercent, 10.5);
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
              cpuUsagePercent: 10.5,
            },
          ]),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      metrics: ["cpuUsagePercent"],
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
                cpuUsagePercent: 10.5,
              },
            ],
            rows: 1,
          }),
          { status: 200 },
        ),
    },
    {
      serverId: SERVER_ID,
      metrics: ["cpuUsagePercent"],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T01:00:00.000Z",
      resolutionSeconds: 300,
    },
  );
  assertEquals(result.available, true);
  assertEquals(result.points.length, 1);
  assertEquals(result.points[0]!.values.cpuUsagePercent, 10.5);
  assertEquals(result.sampleCount, 2);
});

it("queryHostSeriesViaSqlApi: maxRangeSeconds override is enforced", () => {
  assertThrows(
    () =>
      buildHostSeriesSql(
        {
          serverId: SERVER_ID,
          metrics: ["cpuUsagePercent"],
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
