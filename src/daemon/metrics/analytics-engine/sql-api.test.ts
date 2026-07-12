import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { it } from "@std/testing/bdd";
import {
  AE_BLOB_EVENT_TYPE_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_DATASET_NAME,
  AE_HOST_EVENT_TYPE,
  AE_MISSING_METRIC_SENTINEL,
  blobColumn,
  doubleColumnForMetric,
} from "./field-map.ts";
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  buildHostSeriesSql,
  buildHostSummarySql,
  hostEventDiscriminatorPredicates,
  parseCloudflareV4SqlResponse,
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  quoteSqlString,
  clickhouseAvgExpression,
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

it("weightedAvgExpression excludes AE_MISSING_METRIC_SENTINEL", () => {
  const expr = weightedAvgExpression("double1");
  assertEquals(expr.includes(String(AE_MISSING_METRIC_SENTINEL)), true);
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
    `${blobColumn(AE_BLOB_EVENT_TYPE_INDEX)} = ${quoteSqlString(AE_HOST_EVENT_TYPE)}`,
  );
  assertEquals(
    predicates[1],
    `${blobColumn(AE_BLOB_SCHEMA_VERSION_INDEX)} = ${quoteSqlString(String(METRICS_SCHEMA_VERSION))}`,
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
  assertEquals(sql.includes(String(AE_MISSING_METRIC_SENTINEL)), true);
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

it("parseCloudflareV4SqlResponse: flat { data } body is rejected", () => {
  assertThrows(
    () =>
      parseCloudflareV4SqlResponse({
        data: [{ bucket: 1 }],
        rows: 1,
      }),
    Error,
    "success:false",
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
  assertEquals(result.gapCount, 10);
});

it("queryHostSeriesViaSqlApi: flat (non-envelope) response is rejected", async () => {
  // Flat bodies lack success:true — treated as API failure, not silent empty.
  await assertRejects(
    () =>
      queryHostSeriesViaSqlApi(
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
        },
      ),
    Error,
    "success:false",
  );
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
