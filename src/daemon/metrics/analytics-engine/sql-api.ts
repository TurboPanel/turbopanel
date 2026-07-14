/**
 * Narrow HTTP client for the Workers Analytics Engine SQL API.
 *
 * Endpoint (verified against Cloudflare docs):
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql
 * Auth: Authorization: Bearer <Account Analytics Read token>
 * Body: raw SQL text (no documented parameter binding — literals are
 * allowlist-escaped via quoteSqlString / validated integers only).
 *
 * Response: standard Cloudflare client/v4 envelope
 *   `{ success, errors, result: { data, meta, rows } }` —
 * never read `data` from the top level.
 *
 * @see https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
 * @see https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */

import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
  type HostMetricKey,
} from "../contract.ts";
import type {
  HostSeriesPoint,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
} from "../types.ts";
import {
  finalizeHostSeriesResult,
} from "../query/series-response.ts";
import {
  AE_BLOB_EVENT_TYPE_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_DATASET_NAME,
  AE_HOST_EVENT_TYPE,
  AE_INDEX_SERVER_ID_COLUMN,
  AE_MISSING_METRIC_SENTINEL,
  AE_TIMESTAMP_COLUMN,
  blobColumn,
  doubleColumnForMetric,
} from "./field-map.ts";

const ALLOWED_METRIC_KEYS = new Set<string>(HOST_METRIC_KEYS);

/**
 * Default safety-net max query window — matches documented AE retention
 * (three months / 90 days). Override via `AnalyticsEngineSqlConfig.maxRangeSeconds`
 * or `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS` on Workers.
 */
export const AE_DEFAULT_MAX_RANGE_SECONDS = 90 * 24 * 60 * 60;

/** Default bucket when `resolutionSeconds` is omitted (5 minutes). */
export const AE_DEFAULT_BUCKET_SECONDS = 300;

/**
 * Schema versions this read path understands (positional semantics must match).
 * Derived from the wire contract — do not hardcode version literals in SQL.
 */
export const AE_SUPPORTED_HOST_SCHEMA_VERSIONS: readonly number[] = [
  METRICS_SCHEMA_VERSION,
];

export type AnalyticsEngineSqlConfig = {
  accountId: string;
  apiToken: string;
  /** Dataset / table name (defaults to `AE_DATASET_NAME`). */
  dataset?: string;
  /**
   * Max allowed `to - from` span in seconds.
   * Defaults to `AE_DEFAULT_MAX_RANGE_SECONDS` (documented AE retention).
   */
  maxRangeSeconds?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
};

/** SQL payload nested under the Cloudflare v4 `result` field. */
export type AnalyticsEngineSqlResult = {
  meta?: Array<{ name: string; type: string }>;
  data: Array<Record<string, unknown>>;
  rows?: number;
};

type CloudflareV4Error = {
  code?: number;
  message?: string;
} | string;

type CloudflareV4SqlEnvelope = {
  success: boolean;
  errors?: CloudflareV4Error[];
  messages?: unknown[];
  result?: {
    meta?: Array<{ name: string; type: string }>;
    data?: Array<Record<string, unknown>>;
    rows?: number;
    error?: string;
  } | null;
};

/**
 * Escape a string literal for AE SQL (single-quote doubling).
 * AE SQL API has no parameter binding — only call with pre-validated values.
 */
export function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertSafeServerId(serverId: string): string {
  // Canonical UUID (any version) — reject anything that could break out of a string literal.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(serverId)
  ) {
    throw new TypeError(`invalid serverId for AE SQL: ${serverId}`);
  }
  return serverId;
}

function assertIsoTimestamp(label: string, value: string): Date {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`invalid ${label} timestamp: ${value}`);
  }
  return new Date(ms);
}

function assertPositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function assertSafeDatasetName(dataset: string): string {
  // Dataset name is a fixed allowlisted identifier (never user input).
  if (dataset !== AE_DATASET_NAME && !/^[a-zA-Z_]\w*$/.test(dataset)) {
    throw new TypeError(`invalid AE dataset name: ${dataset}`);
  }
  return dataset;
}

function assertAllowedMetrics(
  metrics: readonly HostMetricKey[],
): HostMetricKey[] {
  if (metrics.length === 0) {
    throw new TypeError("metrics must be a non-empty allowlisted list");
  }
  const out: HostMetricKey[] = [];
  for (const key of metrics) {
    if (!ALLOWED_METRIC_KEYS.has(key)) {
      throw new TypeError(`unknown host metrics metric: ${key}`);
    }
    out.push(key);
  }
  return out;
}

function assertRange(
  from: Date,
  to: Date,
  maxRangeSeconds: number,
): void {
  const spanSeconds = (to.getTime() - from.getTime()) / 1000;
  if (spanSeconds < 0) {
    throw new TypeError("from must be <= to");
  }
  if (spanSeconds > maxRangeSeconds) {
    throw new TypeError(
      `query range ${spanSeconds}s exceeds maxRangeSeconds ${maxRangeSeconds}`,
    );
  }
}

/**
 * Host-event + schema-version discriminators for the shared AE dataset.
 * Values come from the write-path field map / wire contract — never literals.
 */
export function hostEventDiscriminatorPredicates(): string[] {
  const eventTypeCol = blobColumn(AE_BLOB_EVENT_TYPE_INDEX);
  const schemaVersionCol = blobColumn(AE_BLOB_SCHEMA_VERSION_INDEX);
  const schemaVersions = AE_SUPPORTED_HOST_SCHEMA_VERSIONS.map((v) =>
    quoteSqlString(String(v))
  );
  const schemaPredicate = schemaVersions.length === 1
    ? `${schemaVersionCol} = ${schemaVersions[0]}`
    : `${schemaVersionCol} IN (${schemaVersions.join(", ")})`;
  return [
    `${eventTypeCol} = ${quoteSqlString(AE_HOST_EVENT_TYPE)}`,
    schemaPredicate,
  ];
}

/**
 * AE SQL literal matching write-path `AE_MISSING_METRIC_SENTINEL` (`-1e308`).
 *
 * AE SQL docs only list plain decimal literals (e.g. `-4.2`) — not scientific
 * notation — so embedding `-1e308` fails parse. `pow` is a documented math
 * function; `-pow(10, 308)` equals IEEE `-1e308` for sentinel comparisons.
 */
export function aeMissingMetricSentinelSql(): string {
  return "-pow(10, 308)";
}

/**
 * Weighted average excluding missing-metric sentinel rows.
 * Documented AE sampling pattern:
 *   SUM(_sample_interval * doubleN) / SUM(_sample_interval)
 * with `if(... = sentinel, 0.0, ...)` so missing never averages as zero.
 *
 * Uses only documented AE SQL (`if`, `SUM`, `pow`) — not `NULLIF` / `-1e308`
 * literals. AE requires IF() branches to share a type, so use `0.0` and
 * `_sample_interval * 1.0` (Double) — bare `0` (Integer) vs Double is a 422.
 */
export function weightedAvgExpression(doubleCol: string): string {
  const sentinel = aeMissingMetricSentinelSql();
  return (
    `SUM(if(${doubleCol} = ${sentinel}, 0.0, _sample_interval * ${doubleCol}))` +
    ` / SUM(if(${doubleCol} = ${sentinel}, 0.0, _sample_interval * 1.0))`
  );
}

/**
 * ClickHouse weighted average excluding missing-metric sentinel rows.
 *
 * AE uses `_sample_interval` as the per-row weight; ClickHouse stores one row
 * per sample (implicit weight 1), so this mirrors
 * `weightedAvgExpression` with unit weight:
 *   sum(if(sentinel, 0, col)) / nullIf(countIf(col != sentinel), 0)
 */
export function clickhouseAvgExpression(doubleCol: string): string {
  const sentinel = String(AE_MISSING_METRIC_SENTINEL);
  return (
    `sum(if(${doubleCol} = ${sentinel}, 0, ${doubleCol}))` +
    ` / NULLIF(countIf(${doubleCol} != ${sentinel}), 0)`
  );
}

/** Sample count per bucket — AE `SUM(_sample_interval)` with unit-weight rows. */
export function clickhouseSampleCountExpression(): string {
  return "count()";
}

/** Bucket expression shared with the AE SQL read path. */
export function bucketEpochExpression(bucketSeconds: number): string {
  return `intDiv(toUnixTimestamp(${AE_TIMESTAMP_COLUMN}), ${bucketSeconds}) * ${bucketSeconds}`;
}

export function buildHostSeriesSql(
  input: HostSeriesQuery,
  opts: {
    dataset: string;
    maxRangeSeconds: number;
  },
): { sql: string; metrics: HostMetricKey[]; bucketSeconds: number } {
  const serverId = assertSafeServerId(input.serverId);
  const metrics = assertAllowedMetrics(input.metrics);
  const from = assertIsoTimestamp("from", input.from);
  const to = assertIsoTimestamp("to", input.to);
  assertRange(from, to, opts.maxRangeSeconds);
  const bucketSeconds = assertPositiveInt(
    "resolutionSeconds",
    input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS,
  );

  assertSafeDatasetName(opts.dataset);

  const metricSelects = metrics.map((key) => {
    const col = doubleColumnForMetric(key);
    return `${weightedAvgExpression(col)} AS ${key}`;
  });

  const fromUnix = Math.floor(from.getTime() / 1000);
  const toUnix = Math.floor(to.getTime() / 1000);
  const discriminators = hostEventDiscriminatorPredicates();

  const sql = [
    "SELECT",
    `  intDiv(toUnixTimestamp(${AE_TIMESTAMP_COLUMN}), ${bucketSeconds}) * ${bucketSeconds} AS bucket,`,
    `  SUM(_sample_interval) AS sample_count,`,
    `  ${metricSelects.join(",\n  ")}`,
    `FROM ${opts.dataset}`,
    `WHERE ${AE_INDEX_SERVER_ID_COLUMN} = ${quoteSqlString(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix})`,
    `  AND ${AE_TIMESTAMP_COLUMN} <= toDateTime(${toUnix})`,
    `GROUP BY bucket`,
    `ORDER BY bucket ASC`,
  ].join("\n");

  return { sql, metrics, bucketSeconds };
}

export function buildHostSeriesClickHouseSql(
  input: HostSeriesQuery,
  opts: {
    table: string;
    maxRangeSeconds: number;
  },
): { sql: string; metrics: HostMetricKey[]; bucketSeconds: number } {
  assertSafeServerId(input.serverId);
  const metrics = assertAllowedMetrics(input.metrics);
  const from = assertIsoTimestamp("from", input.from);
  const to = assertIsoTimestamp("to", input.to);
  assertRange(from, to, opts.maxRangeSeconds);
  const bucketSeconds = assertPositiveInt(
    "resolutionSeconds",
    input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS,
  );

  assertSafeDatasetName(opts.table);

  const metricSelects = metrics.map((key) => {
    const col = doubleColumnForMetric(key);
    return `${clickhouseAvgExpression(col)} AS ${key}`;
  });

  const discriminators = hostEventDiscriminatorPredicates();

  const sampleCountExpr = clickhouseSampleCountExpression();

  const sql = [
    "SELECT",
    `  ${bucketEpochExpression(bucketSeconds)} AS bucket,`,
    `  ${sampleCountExpr} AS sample_count,`,
    `  ${metricSelects.join(",\n  ")}`,
    `FROM ${opts.table}`,
    `WHERE ${AE_INDEX_SERVER_ID_COLUMN} = {index1:UUID}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_TIMESTAMP_COLUMN} >= {from:DateTime64(3, 'UTC')}`,
    `  AND ${AE_TIMESTAMP_COLUMN} <= {to:DateTime64(3, 'UTC')}`,
    `GROUP BY bucket`,
    `ORDER BY bucket ASC`,
  ].join("\n");

  return { sql, metrics, bucketSeconds };
}

export function buildHostSummaryClickHouseSql(
  input: HostSummaryQuery,
  opts: {
    table: string;
    maxRangeSeconds: number;
  },
): string {
  assertSafeServerId(input.serverId);
  const from = assertIsoTimestamp("from", input.from);
  const to = assertIsoTimestamp("to", input.to);
  assertRange(from, to, opts.maxRangeSeconds);
  assertSafeDatasetName(opts.table);

  const discriminators = hostEventDiscriminatorPredicates();

  return [
    "SELECT",
    `  count() AS sample_count,`,
    `  max(${AE_TIMESTAMP_COLUMN}) AS latest_at`,
    `FROM ${opts.table}`,
    `WHERE ${AE_INDEX_SERVER_ID_COLUMN} = {index1:UUID}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_TIMESTAMP_COLUMN} >= {from:DateTime64(3, 'UTC')}`,
    `  AND ${AE_TIMESTAMP_COLUMN} <= {to:DateTime64(3, 'UTC')}`,
  ].join("\n");
}

export function buildHostSummarySql(
  input: HostSummaryQuery,
  opts: {
    dataset: string;
    maxRangeSeconds: number;
  },
): string {
  const serverId = assertSafeServerId(input.serverId);
  const from = assertIsoTimestamp("from", input.from);
  const to = assertIsoTimestamp("to", input.to);
  assertRange(from, to, opts.maxRangeSeconds);
  assertSafeDatasetName(opts.dataset);

  const fromUnix = Math.floor(from.getTime() / 1000);
  const toUnix = Math.floor(to.getTime() / 1000);
  const discriminators = hostEventDiscriminatorPredicates();

  return [
    "SELECT",
    `  SUM(_sample_interval) AS sample_count,`,
    `  max(${AE_TIMESTAMP_COLUMN}) AS latest_at`,
    `FROM ${opts.dataset}`,
    `WHERE ${AE_INDEX_SERVER_ID_COLUMN} = ${quoteSqlString(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix})`,
    `  AND ${AE_TIMESTAMP_COLUMN} <= toDateTime(${toUnix})`,
  ].join("\n");
}

/**
 * Validate and unwrap a Cloudflare Analytics Engine SQL response.
 *
 * Preferred shape: client/v4 envelope `{ success, result: { data } }`.
 * Also accepts ClickHouse-style `{ data, meta?, rows? }` (what `FORMAT JSON`
 * returns) so we do not discard a successful result as opaque `success:false`.
 */
export function parseCloudflareV4SqlResponse(
  body: unknown,
): AnalyticsEngineSqlResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("AE SQL response is not a JSON object");
  }
  const envelope = body as CloudflareV4SqlEnvelope & {
    data?: Array<Record<string, unknown>>;
    meta?: Array<{ name: string; type: string }>;
    rows?: number;
  };

  // ClickHouse FORMAT JSON / bare SQL result — no v4 `success` field.
  if (
    envelope.success === undefined &&
    Array.isArray(envelope.data)
  ) {
    return {
      meta: envelope.meta,
      data: envelope.data,
      rows: typeof envelope.rows === "number" ? envelope.rows : undefined,
    };
  }

  if (envelope.success !== true) {
    const messages = (envelope.errors ?? [])
      .map((err) => {
        if (typeof err === "string") return err.trim();
        if (err && typeof err === "object") {
          const msg = err.message?.trim();
          if (msg) return msg;
          const code = err.code;
          if (code != null) return `code=${code}`;
        }
        return "";
      })
      .filter((msg): msg is string => Boolean(msg));
    const resultError =
      envelope.result &&
        typeof envelope.result === "object" &&
        !Array.isArray(envelope.result) &&
        typeof envelope.result.error === "string"
        ? envelope.result.error.trim()
        : "";
    if (resultError) messages.push(resultError);
    const detail = messages.length > 0
      ? messages.join("; ")
      : `opaque body keys=${Object.keys(envelope).sort((a, b) => a.localeCompare(b)).join(",")}`;
    throw new Error(`AE SQL API error: ${detail}`);
  }
  const result = envelope.result;
  if (result == null) {
    return { data: [] };
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("AE SQL response result is not an object");
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    throw new Error(`AE SQL query error: ${result.error}`);
  }
  const data = result.data;
  if (data === undefined || data === null) {
    return {
      meta: result.meta,
      data: [],
      rows: typeof result.rows === "number" ? result.rows : undefined,
    };
  }
  if (!Array.isArray(data)) {
    throw new TypeError("AE SQL response result.data is not an array");
  }
  return {
    meta: result.meta,
    data,
    rows: typeof result.rows === "number" ? result.rows : undefined,
  };
}

async function executeSql(
  config: AnalyticsEngineSqlConfig,
  sql: string,
): Promise<AnalyticsEngineSqlResult> {
  const accountId = config.accountId.trim();
  if (!accountId) {
    throw new TypeError("CLOUDFLARE_ACCOUNT_ID is required for AE SQL");
  }
  const token = config.apiToken.trim();
  if (!token) {
    throw new TypeError(
      "TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN is required for AE SQL",
    );
  }
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;
  const fetchFn = config.fetch ?? fetch;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: sql,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AE SQL HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return parseCloudflareV4SqlResponse(await response.json());
}

function parseSeriesRows(
  metrics: readonly HostMetricKey[],
  data: Array<Record<string, unknown>>,
  resolutionSeconds: number,
): { points: HostSeriesPoint[]; sampleCount: number } {
  const points: HostSeriesPoint[] = [];
  let sampleCount = 0;
  const rawExpected = Math.round(resolutionSeconds / 60);
  const expectedSampleCount = Number.isFinite(rawExpected)
    ? rawExpected
    : undefined;
  for (const row of data) {
    const bucketEpochSeconds = parseBucketEpochSeconds(row.bucket);
    if (!Number.isFinite(bucketEpochSeconds)) continue;

    const rowSamples = Number(row.sample_count ?? 0);
    const hasSamples = Number.isFinite(rowSamples);
    if (hasSamples) sampleCount += rowSamples;

    points.push({
      at: new Date(bucketEpochSeconds * 1000).toISOString(),
      values: parseMetricValues(metrics, row),
      sampleCount: hasSamples ? rowSamples : undefined,
      expectedSampleCount,
    });
  }
  return { points, sampleCount };
}

export { parseSeriesRows };

function parseBucketEpochSeconds(bucket: unknown): number {
  if (typeof bucket === "number") return bucket;
  if (typeof bucket === "string") return Number(bucket);
  return Number.NaN;
}

function parseMetricValues(
  metrics: readonly HostMetricKey[],
  row: Record<string, unknown>,
): HostSeriesPoint["values"] {
  const values: HostSeriesPoint["values"] = {};
  for (const key of metrics) {
    const raw = row[key];
    if (raw === null || raw === undefined) {
      values[key] = null;
      continue;
    }
    const num = typeof raw === "number" ? raw : Number(raw);
    values[key] = Number.isFinite(num) ? num : null;
  }
  return values;
}

export function parseHostSummaryRow(
  row: Record<string, unknown> | undefined,
): { sampleCount: number; latestAt: string | null } {
  const sampleCount = Number(row?.sample_count ?? 0);
  const normalizedSampleCount = Number.isFinite(sampleCount) ? sampleCount : 0;
  const latestRaw = row?.latest_at;
  let latestAt: string | null = null;
  if (
    normalizedSampleCount > 0 &&
    latestRaw !== null &&
    latestRaw !== undefined &&
    typeof latestRaw === "string" &&
    latestRaw.length > 0
  ) {
    const ms = Date.parse(latestRaw.replace(" ", "T") + "Z");
    latestAt = Number.isFinite(ms) ? new Date(ms).toISOString() : latestRaw;
  }
  return { sampleCount: normalizedSampleCount, latestAt };
}

export async function queryHostSeriesViaSqlApi(
  config: AnalyticsEngineSqlConfig,
  input: HostSeriesQuery,
): Promise<HostSeriesResult> {
  const dataset = config.dataset ?? AE_DATASET_NAME;
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS;
  const { sql, metrics, bucketSeconds } = buildHostSeriesSql(input, {
    dataset,
    maxRangeSeconds,
  });
  const json = await executeSql(config, sql);
  const { points, sampleCount } = parseSeriesRows(
    metrics,
    json.data,
    bucketSeconds,
  );
  return finalizeHostSeriesResult(input.from, input.to, {
    kind: "analytics-engine",
    available: true,
    serverId: input.serverId,
    metrics,
    points,
    resolutionSeconds: bucketSeconds,
    gapCount: 0,
    sampleCount,
  });
}

export async function queryHostSummaryViaSqlApi(
  config: AnalyticsEngineSqlConfig,
  input: HostSummaryQuery,
): Promise<HostSummaryResult> {
  const dataset = config.dataset ?? AE_DATASET_NAME;
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS;
  const sql = buildHostSummarySql(input, { dataset, maxRangeSeconds });
  const json = await executeSql(config, sql);
  const row = json.data[0];
  const sampleCount = Number(row?.sample_count ?? 0);
  const latestRaw = row?.latest_at;
  let latestAt: string | null = null;
  if (typeof latestRaw === "string" && latestRaw.length > 0) {
    const ms = Date.parse(latestRaw);
    latestAt = Number.isFinite(ms) ? new Date(ms).toISOString() : latestRaw;
  }
  return {
    kind: "analytics-engine",
    available: true,
    serverId: input.serverId,
    sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
    latestAt,
  };
}
