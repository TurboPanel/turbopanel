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
 * Read shape: each logical host sample is two data points (`blob1 =
 * "metrics"`, `blob2 = "core" | "extended"` — see `field-map.ts`). Host
 * series/fleet queries first recombine the physical part rows into one
 * logical sample per `(index1, timestamp)` in a subquery (dropping
 * extended-only orphans — the write path is two independent fire-and-forget
 * `writeDataPoint` calls, so one part can land without its twin), then
 * bucket/server-aggregate those logical rows, weighting every metric by
 * `double20 * _sample_interval` (true collection cadence × AE sampling
 * weight). All time ranges are canonical half-open `[from, to)`.
 *
 * @see https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
 * @see https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */

import {
  HOST_METRIC_KEYS,
  type HostMetricKey,
  METRICS_SCHEMA_VERSION,
} from "../../contract.ts";
import type {
  FleetHostSnapshotQuery,
  FleetHostSnapshotResult,
  FleetHostSnapshotServer,
  HostSeriesPoint,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerStatusTransitionReason,
  StatusHistoryEvent,
  StatusHistoryQuery,
  StatusHistoryResult,
} from "../../types.ts";
import { HOST_METRICS_METRIC_DESCRIPTORS } from "../../metric-descriptors.ts";
import {
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResult,
} from "../../query/series-response.ts";
import { computeStatusUptime } from "../../query/uptime.ts";
import {
  AE_BLOB_EVENT_TYPE_INDEX,
  AE_BLOB_PART_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_DATASET_NAME,
  AE_METRICS_EVENT_TYPE,
  AE_INDEX_SERVER_ID_COLUMN,
  AE_PART_CORE,
  AE_PART_EXTENDED,
  AE_STATUS_EVENT_TYPE,
  AE_TIMESTAMP_COLUMN,
  blobColumn,
  doubleColumnForMetric,
  intervalSecondsColumn,
  metricPart,
  statusConnectedColumn,
  statusReasonColumn,
} from "./field-map.ts";

const ALLOWED_METRIC_KEYS = new Set<string>(HOST_METRIC_KEYS);

/**
 * Default safety-net max query window — matches documented AE retention
 * (three months / 90 days). Override via `CloudflareAnalyticsSqlConfig.maxRangeSeconds`
 * or `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS` on Workers.
 */
export const AE_DEFAULT_MAX_RANGE_SECONDS = 90 * 24 * 60 * 60;

/** Default bucket when `resolutionSeconds` is omitted (5 minutes). */
export const AE_DEFAULT_BUCKET_SECONDS = 300;

/**
 * Fleet liveness window for the offline-sweep cron: three missed ~60s host
 * samples. Kept tight so genuinely-dead servers become "suspect" (and get a
 * `checkLiveness` DO wake) quickly; a slightly-stale-but-alive server just
 * costs one extra wake (safe).
 */
export const AE_LIVENESS_WINDOW_SECONDS = 180;

/** Hard deadline for the offline-sweep AE liveness SQL read. */
export const AE_LIVENESS_QUERY_TIMEOUT_MS = 5_000;

/**
 * Schema versions this read path understands (positional semantics must match).
 * Derived from the wire contract — do not hardcode version literals in SQL.
 */
export const AE_SUPPORTED_HOST_SCHEMA_VERSIONS: readonly number[] = [
  METRICS_SCHEMA_VERSION,
];

export type CloudflareAnalyticsSqlConfig = {
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
  /** Cancels the SQL subrequest rather than abandoning it. */
  signal?: AbortSignal;
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
 * Event-type + schema-version discriminators for the shared AE dataset.
 * Values come from the write-path field map / wire contract — never literals.
 */
export function eventDiscriminatorPredicates(eventType: string): string[] {
  const eventTypeCol = blobColumn(AE_BLOB_EVENT_TYPE_INDEX);
  const schemaVersionCol = blobColumn(AE_BLOB_SCHEMA_VERSION_INDEX);
  const schemaVersions = AE_SUPPORTED_HOST_SCHEMA_VERSIONS.map((v) =>
    quoteSqlString(String(v))
  );
  const schemaPredicate = schemaVersions.length === 1
    ? `${schemaVersionCol} = ${schemaVersions[0]}`
    : `${schemaVersionCol} IN (${schemaVersions.join(", ")})`;
  return [
    `${eventTypeCol} = ${quoteSqlString(eventType)}`,
    schemaPredicate,
  ];
}

/** Host-sample discriminators (`blob1 = 'metrics'` + schema version). */
export function hostEventDiscriminatorPredicates(): string[] {
  return eventDiscriminatorPredicates(AE_METRICS_EVENT_TYPE);
}

/** Status-row discriminators (`blob1 = 'status'`). */
export function statusEventDiscriminatorPredicates(): string[] {
  return eventDiscriminatorPredicates(AE_STATUS_EVENT_TYPE);
}

/** Restrict host reads to the two known metrics parts (`blob2`). */
export function hostPartsPredicate(): string {
  const partCol = blobColumn(AE_BLOB_PART_INDEX);
  return `${partCol} IN (${quoteSqlString(AE_PART_CORE)}, ${
    quoteSqlString(AE_PART_EXTENDED)
  })`;
}

/** `blob2 = '<part>'` predicate scoping an aggregate to one metrics part. */
function partPredicate(part: string): string {
  return `${blobColumn(AE_BLOB_PART_INDEX)} = ${quoteSqlString(part)}`;
}

/**
 * Cap on status-history rows returned to the client. Builders request
 * `MAX_STATUS_EVENTS + 1` so the route can set `truncated`.
 */
export const MAX_STATUS_EVENTS = 1000;

const STATUS_TRANSITION_REASONS = new Set<string>([
  "connect",
  "disconnect",
  "sweep_stale",
  "self_heal",
]);

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
 * Interval-and-sampling-weighted average for one host metric, scoped to the
 * metrics part that owns it and excluding missing-metric sentinel rows:
 *
 *   SUM(value * double20 * _sample_interval) / SUM(double20 * _sample_interval)
 *
 * where `double20` is the sample's `intervalSeconds` (write-path reserved
 * slot) and `_sample_interval` is AE's documented sampling weight. Rows of
 * the other part — and sentinel (missing) rows — contribute `0.0` to both
 * sides, so a metric never averages across the wrong part's doubles and
 * missing never averages as zero.
 *
 * Uses only documented AE SQL (`if`, `SUM`, `pow`) — not `NULLIF` / `-1e308`
 * literals. AE requires IF() branches to share a type, so every branch is a
 * Double (`0.0`, products of Double columns) — bare `0` (Integer) vs Double
 * is a 422.
 */
export function weightedAvgExpressionForMetric(key: HostMetricKey): string {
  return `${weightedAvgNumeratorForMetric(key)} / ${
    weightedAvgDenominatorForMetric(key)
  }`;
}

/** Numerator sum of {@link weightedAvgExpressionForMetric} (value × weight). */
export function weightedAvgNumeratorForMetric(key: HostMetricKey): string {
  const col = doubleColumnForMetric(key);
  const part = partPredicate(metricPart(key));
  const sentinel = aeMissingMetricSentinelSql();
  const weight = `${intervalSecondsColumn()} * _sample_interval`;
  return `SUM(if(${part}, if(${col} = ${sentinel}, 0.0, ${col} * ${weight}), 0.0))`;
}

/** Denominator sum of {@link weightedAvgExpressionForMetric} (weight only). */
export function weightedAvgDenominatorForMetric(key: HostMetricKey): string {
  const col = doubleColumnForMetric(key);
  const part = partPredicate(metricPart(key));
  const sentinel = aeMissingMetricSentinelSql();
  const weight = `${intervalSecondsColumn()} * _sample_interval`;
  return `SUM(if(${part}, if(${col} = ${sentinel}, 0.0, ${weight} * 1.0), 0.0))`;
}

/**
 * Sentinel-safe raw metric value at the logical-sample grain, for `last` /
 * `max` descriptor aggregations. Rows of the other part contribute the
 * sentinel (the minimum possible double), so `MAX` recombines the two part
 * rows into the metric's own value; a missing metric stays sentinel and is
 * stripped to `null` at parse time ({@link stripAeSentinel}).
 *
 * Uses only documented AE SQL (`if`, `MAX`, `pow`); every `if` branch is a
 * Double (column vs `-pow(10, 308)`).
 */
export function rawValueExpressionForMetric(key: HostMetricKey): string {
  const col = doubleColumnForMetric(key);
  const part = partPredicate(metricPart(key));
  const sentinel = aeMissingMetricSentinelSql();
  return `MAX(if(${part}, ${col}, ${sentinel}))`;
}

/**
 * Bucket-level `last` aggregate over logical-sample `<key>_value` columns:
 * `argMax` (documented AE SQL) keyed by `sample_ts`, with sentinel rows
 * demoted to ordering key `sample_ts * 0` so any real observation always
 * outranks an all-sentinel logical sample (`* 0` keeps both `if` branches
 * the same type). An all-sentinel bucket still yields the sentinel — parse
 * strips it to `null`.
 */
export function lastValueExpressionForMetric(key: HostMetricKey): string {
  const sentinel = aeMissingMetricSentinelSql();
  return `argMax(${key}_value, if(${key}_value = ${sentinel}, sample_ts * 0, sample_ts))`;
}

/**
 * Bucket-level `max` aggregate over logical-sample `<key>_value` columns.
 * The sentinel is the minimum possible double, so it only surfaces when
 * every contributing row is sentinel — and then parse strips it to `null`.
 */
export function maxValueExpressionForMetric(key: HostMetricKey): string {
  return `MAX(${key}_value)`;
}

/**
 * Any parsed metric value at or below this is the missing-metric sentinel
 * (`AE_MISSING_METRIC_SENTINEL` = -1e308) — no real host metric goes below
 * -100 (temperatures). Threshold, not equality: the SQL-side sentinel is
 * spelled `-pow(10, 308)` and must match after float round-trips.
 */
const AE_SENTINEL_STRIP_THRESHOLD = -1e307;

/** Report a still-sentinel `last`/`max` result as missing, never a number. */
export function stripAeSentinel(value: number): number | null {
  return value <= AE_SENTINEL_STRIP_THRESHOLD ? null : value;
}

/** Descriptor-driven bucket/server select for one metric. */
function metricSelectExpression(key: HostMetricKey): string {
  switch (HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation) {
    case "last":
      return `${lastValueExpressionForMetric(key)} AS ${key}`;
    case "max":
      return `${maxValueExpressionForMetric(key)} AS ${key}`;
    default:
      return `SUM(${key}_num) / SUM(${key}_den) AS ${key}`;
  }
}

/**
 * Underlying-sample weight for a bucket/group. Counts only the core part —
 * every sample writes both parts, so counting both would double every count.
 */
export function sampleCountExpression(): string {
  return `SUM(if(${partPredicate(AE_PART_CORE)}, _sample_interval * 1.0, 0.0))`;
}

/**
 * Sampling-weighted observed cadence for a bucket of logical samples:
 * interval-by-weight over total weight, reusing the same `core_weight`
 * (`_sample_interval`) that scales `sample_count`. Once AE query-time
 * sampling retains rows with different `_sample_interval` weights, a plain
 * `avg(interval_seconds)` would infer the wrong cadence mix and
 * `expectedSampleCount` / `gapCount` would drift from the weighted
 * aggregation semantics (and from DuckDB parity, where every row is weight 1).
 * Outer queries filter `core_weight > 0.0`, so the denominator never sums to
 * zero.
 */
export function weightedAvgIntervalSecondsExpression(): string {
  return "SUM(interval_seconds * core_weight) / SUM(core_weight)";
}

/**
 * Logical-host-sample subquery: recombine the two physical rows of one host
 * sample (`blob2 = "core"` / `"extended"`) into a single row keyed by
 * `(index1, timestamp)` before any bucket/server aggregation. Outer queries
 * aggregate these logical rows filtered to `core_weight > 0.0`, so a
 * partially ingested sample (the write path is two independent
 * fire-and-forget `writeDataPoint` calls) can never skew results:
 * extended-only orphan rows are dropped entirely, and a core-only orphan
 * contributes nothing to extended-metric numerators or denominators.
 * The range predicate is canonical half-open `[from, to)` — matches the
 * DuckDB backend and `computeSeriesGapCount`'s coverage grid.
 */
function buildLogicalHostSampleSubquery(opts: {
  dataset: string;
  metrics: readonly HostMetricKey[];
  serverPredicate: string;
  fromUnix: number;
  toUnix: number;
}): string {
  const discriminators = hostEventDiscriminatorPredicates();
  // Weighted-average metrics carry a numerator/denominator pair; last/max
  // metrics carry one sentinel-safe raw value at the logical-sample grain.
  const metricSelects = opts.metrics.map((key) =>
    HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation === "weighted-average"
      ? `${weightedAvgNumeratorForMetric(key)} AS ${key}_num,\n    ${
        weightedAvgDenominatorForMetric(key)
      } AS ${key}_den`
      : `${rawValueExpressionForMetric(key)} AS ${key}_value`
  );
  // Observed collection cadence, from the core part's reserved interval slot
  // (a logical sample without a core row is dropped by `core_weight > 0.0`).
  const intervalSelect = `MAX(if(${partPredicate(AE_PART_CORE)}, ${
    intervalSecondsColumn()
  }, 0.0)) AS interval_seconds`;
  return [
    `  SELECT`,
    `    ${AE_INDEX_SERVER_ID_COLUMN} AS server_id,`,
    `    toUnixTimestamp(${AE_TIMESTAMP_COLUMN}) AS sample_ts,`,
    `    ${sampleCountExpression()} AS core_weight,`,
    `    ${intervalSelect},`,
    `    ${metricSelects.join(",\n    ")}`,
    `  FROM ${opts.dataset}`,
    `  WHERE ${opts.serverPredicate}`,
    `    AND ${discriminators[0]}`,
    `    AND ${discriminators[1]}`,
    `    AND ${hostPartsPredicate()}`,
    `    AND ${AE_TIMESTAMP_COLUMN} >= toDateTime(${opts.fromUnix})`,
    `    AND ${AE_TIMESTAMP_COLUMN} < toDateTime(${opts.toUnix})`,
    `  GROUP BY server_id, sample_ts`,
  ].join("\n");
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

  const fromUnix = Math.floor(from.getTime() / 1000);
  const toUnix = Math.floor(to.getTime() / 1000);

  const metricSelects = metrics.map((key) => metricSelectExpression(key));

  const sql = [
    "SELECT",
    `  intDiv(sample_ts, ${bucketSeconds}) * ${bucketSeconds} AS bucket,`,
    `  SUM(core_weight) AS sample_count,`,
    `  ${weightedAvgIntervalSecondsExpression()} AS avg_interval_seconds,`,
    `  ${metricSelects.join(",\n  ")}`,
    `FROM (`,
    buildLogicalHostSampleSubquery({
      dataset: opts.dataset,
      metrics,
      serverPredicate: `${AE_INDEX_SERVER_ID_COLUMN} = ${
        quoteSqlString(serverId)
      }`,
      fromUnix,
      toUnix,
    }),
    `)`,
    `WHERE core_weight > 0.0`,
    `GROUP BY bucket`,
    `ORDER BY bucket ASC`,
  ].join("\n");

  return { sql, metrics, bucketSeconds };
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
    `  ${sampleCountExpression()} AS sample_count,`,
    `  max(${AE_TIMESTAMP_COLUMN}) AS latest_at`,
    `FROM ${opts.dataset}`,
    `WHERE ${AE_INDEX_SERVER_ID_COLUMN} = ${quoteSqlString(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${hostPartsPredicate()}`,
    `  AND ${AE_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix})`,
    `  AND ${AE_TIMESTAMP_COLUMN} < toDateTime(${toUnix})`,
  ].join("\n");
}

/** Cap on serverIds accepted into a fleet snapshot IN-list. */
export const MAX_FLEET_SNAPSHOT_SERVERS = 500;

/** Quote + validate a non-empty list of server UUIDs for an SQL `IN (...)`. */
export function quoteServerIdInList(
  serverIds: readonly string[],
): string {
  if (serverIds.length === 0) {
    throw new TypeError("serverIds must be non-empty for fleet snapshot SQL");
  }
  if (serverIds.length > MAX_FLEET_SNAPSHOT_SERVERS) {
    throw new TypeError(
      `serverIds length ${serverIds.length} exceeds max ${MAX_FLEET_SNAPSHOT_SERVERS}`,
    );
  }
  const seen = new Set<string>();
  const quoted: string[] = [];
  for (const raw of serverIds) {
    const id = assertSafeServerId(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    quoted.push(quoteSqlString(id));
  }
  if (quoted.length === 0) {
    throw new TypeError("serverIds must be non-empty for fleet snapshot SQL");
  }
  return quoted.join(", ");
}

/**
 * Fleet snapshot AE SQL: weighted averages + latest_at per serverId over a
 * short lookback. One query covers the whole authorized fleet — never N
 * per-server chart reads from the org servers overview.
 */
export function buildFleetHostSnapshotSql(
  input: FleetHostSnapshotQuery,
  opts: {
    dataset: string;
    maxRangeSeconds: number;
  },
): { sql: string; metrics: HostMetricKey[] } {
  const metrics = assertAllowedMetrics(input.metrics);
  const from = assertIsoTimestamp("from", input.from);
  const to = assertIsoTimestamp("to", input.to);
  assertRange(from, to, opts.maxRangeSeconds);
  assertSafeDatasetName(opts.dataset);
  const inList = quoteServerIdInList(input.serverIds);

  const fromUnix = Math.floor(from.getTime() / 1000);
  const toUnix = Math.floor(to.getTime() / 1000);

  const metricSelects = metrics.map((key) => metricSelectExpression(key));

  // sample_count and latest_at both derive from the same logical-sample rows
  // (`core_weight > 0.0`), so an orphan part row can never advance latest_at
  // past the newest complete logical sample. latest_at is unix seconds —
  // `parseAeLatestAtMs` handles numeric epochs.
  const sql = [
    "SELECT",
    `  server_id,`,
    `  SUM(core_weight) AS sample_count,`,
    `  max(sample_ts) AS latest_at,`,
    `  ${metricSelects.join(",\n  ")}`,
    `FROM (`,
    buildLogicalHostSampleSubquery({
      dataset: opts.dataset,
      metrics,
      serverPredicate: `${AE_INDEX_SERVER_ID_COLUMN} IN (${inList})`,
      fromUnix,
      toUnix,
    }),
    `)`,
    `WHERE core_weight > 0.0`,
    `GROUP BY server_id`,
  ].join("\n");

  return { sql, metrics };
}

export function parseFleetHostSnapshotRows(
  metrics: readonly HostMetricKey[],
  data: Array<Record<string, unknown>>,
): FleetHostSnapshotServer[] {
  const servers: FleetHostSnapshotServer[] = [];
  for (const row of data) {
    const serverId = parseAeServerId(row.server_id);
    if (serverId === null) continue;
    const sampleCountRaw = Number(row.sample_count ?? 0);
    const sampleCount = Number.isFinite(sampleCountRaw) ? sampleCountRaw : 0;
    const latestAtMs = parseAeLatestAtMs(row.latest_at);
    servers.push({
      serverId,
      sampleCount,
      latestAt: latestAtMs === null || sampleCount <= 0
        ? null
        : new Date(latestAtMs).toISOString(),
      values: parseMetricValues(metrics, row),
    });
  }
  servers.sort((a, b) => a.serverId.localeCompare(b.serverId));
  return servers;
}

export async function queryFleetHostSnapshotViaSqlApi(
  config: CloudflareAnalyticsSqlConfig,
  input: FleetHostSnapshotQuery,
): Promise<FleetHostSnapshotResult> {
  if (input.serverIds.length === 0) {
    return {
      kind: "analytics-engine",
      available: true,
      metrics: [...input.metrics],
      servers: [],
    };
  }
  const dataset = config.dataset ?? AE_DATASET_NAME;
  const maxRangeSeconds = config.maxRangeSeconds ??
    AE_DEFAULT_MAX_RANGE_SECONDS;
  const { sql, metrics } = buildFleetHostSnapshotSql(input, {
    dataset,
    maxRangeSeconds,
  });
  const result = await executeSql(config, sql);
  return {
    kind: "analytics-engine",
    available: true,
    metrics,
    servers: parseFleetHostSnapshotRows(metrics, result.data),
  };
}

/**
 * Fleet-wide AE SQL: serverIds that emitted a host sample within `sinceSeconds`.
 *
 * Scoped to the core part (`blob2 = 'core'`) so each logical sample is one
 * row — the extended twin carries the same timestamp and would only double
 * the scanned rows. No per-server filter — one query covers the whole fleet.
 * AE SQL's default row cap (~10000) means overflow servers are simply treated
 * as "suspect" by the offline sweep (probed via `checkLiveness` as today) —
 * correctness is preserved.
 */
export function buildRecentlyActiveServerIdsSql(opts: {
  sinceSeconds: number;
  nowMs?: number;
  dataset?: string;
}): string {
  const sinceSeconds = assertPositiveInt("sinceSeconds", opts.sinceSeconds);
  const dataset = assertSafeDatasetName(opts.dataset ?? AE_DATASET_NAME);
  const fromUnix = Math.floor((opts.nowMs ?? Date.now()) / 1000) - sinceSeconds;
  const discriminators = hostEventDiscriminatorPredicates();

  return [
    "SELECT",
    `  ${AE_INDEX_SERVER_ID_COLUMN} AS server_id,`,
    `  max(${AE_TIMESTAMP_COLUMN}) AS latest_at`,
    `FROM ${dataset}`,
    `WHERE ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${partPredicate(AE_PART_CORE)}`,
    `  AND ${AE_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix})`,
    `GROUP BY server_id`,
  ].join("\n");
}

/**
 * Backend DateTime without timezone: `YYYY-MM-DD HH:MM:SS` or
 * `YYYY-MM-DD HH:MM:SS.SSS`. Must be treated as UTC — engines may otherwise
 * parse the space-separated form as local time.
 */
const BACKEND_UTC_DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/;

/**
 * Parse AE `latest_at` (ISO or space-separated DateTime) to epoch ms.
 * Returns null when the value is missing or unparseable.
 *
 * Space-separated backend timestamps are normalized to an explicit UTC ISO
 * form before `Date.parse`. ISO strings with `Z` or an offset are left
 * unchanged.
 */
export function parseAeLatestAtMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // AE may return unix seconds or milliseconds.
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  const match = BACKEND_UTC_DATETIME_RE.exec(raw);
  const normalized = match === null
    ? raw
    : `${match[1]}T${match[2]}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** Accept only string serverIds from AE rows — never stringify objects. */
function parseAeServerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length > 0 ? id : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatCloudflareV4Error(err: CloudflareV4Error): string {
  if (typeof err === "string") return err.trim();
  const msg = err.message?.trim();
  if (msg) return msg;
  if (err.code != null) return `code=${err.code}`;
  return "";
}

function collectAeSqlFailureDetail(
  envelope: CloudflareV4SqlEnvelope & Record<string, unknown>,
): string {
  const messages = (envelope.errors ?? [])
    .map(formatCloudflareV4Error)
    .filter((msg) => msg.length > 0);
  const result = envelope.result;
  if (
    isPlainObject(result) &&
    typeof result.error === "string" &&
    result.error.trim()
  ) {
    messages.push(result.error.trim());
  }
  if (messages.length > 0) return messages.join("; ");
  return `opaque body keys=${
    Object.keys(envelope).sort((a, b) => a.localeCompare(b)).join(",")
  }`;
}

function unwrapAeSqlSuccessResult(
  result: NonNullable<CloudflareV4SqlEnvelope["result"]>,
): AnalyticsEngineSqlResult {
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

/**
 * Query AE for serverIds with a recent host sample. Returns a Map of
 * serverId → latest sample timestamp (epoch ms). Empty / unparseable rows
 * are skipped. Callers treat a thrown error as "AE unavailable".
 */
export async function queryRecentlyActiveServerIds(
  config: CloudflareAnalyticsSqlConfig,
  opts: { sinceSeconds: number; signal?: AbortSignal },
): Promise<Map<string, number>> {
  const sql = buildRecentlyActiveServerIdsSql({
    sinceSeconds: opts.sinceSeconds,
    dataset: config.dataset,
  });
  const result = await executeSql(
    opts.signal ? { ...config, signal: opts.signal } : config,
    sql,
  );
  const byId = new Map<string, number>();
  for (const row of result.data) {
    const id = parseAeServerId(row.server_id);
    if (id === null) continue;
    const latestAtMs = parseAeLatestAtMs(row.latest_at);
    if (latestAtMs === null) continue;
    byId.set(id, latestAtMs);
  }
  return byId;
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
  if (!isPlainObject(body)) {
    throw new TypeError("AE SQL response is not a JSON object");
  }
  const envelope = body as CloudflareV4SqlEnvelope & {
    data?: Array<Record<string, unknown>>;
    meta?: Array<{ name: string; type: string }>;
    rows?: number;
  };

  // ClickHouse FORMAT JSON / bare SQL result — no v4 `success` field.
  if (envelope.success === undefined && Array.isArray(envelope.data)) {
    return {
      meta: envelope.meta,
      data: envelope.data,
      rows: typeof envelope.rows === "number" ? envelope.rows : undefined,
    };
  }

  if (envelope.success !== true) {
    throw new Error(`AE SQL API error: ${collectAeSqlFailureDetail(envelope)}`);
  }
  const result = envelope.result;
  if (result == null) {
    return { data: [] };
  }
  if (!isPlainObject(result)) {
    throw new TypeError("AE SQL response result is not an object");
  }
  return unwrapAeSqlSuccessResult(result);
}

async function executeSql(
  config: CloudflareAnalyticsSqlConfig,
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
  const url = `https://api.cloudflare.com/client/v4/accounts/${
    encodeURIComponent(accountId)
  }/analytics_engine/sql`;
  const fetchFn = config.fetch ?? fetch;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: sql,
    signal: config.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AE SQL HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return parseCloudflareV4SqlResponse(await response.json());
}

/**
 * Thin reusable client over the raw SQL endpoint — same validation and
 * envelope parsing as every query helper in this module, for callers that
 * need to run a pre-built statement.
 */
export class CloudflareAnalyticsSqlClient {
  readonly #config: CloudflareAnalyticsSqlConfig;

  constructor(config: CloudflareAnalyticsSqlConfig) {
    this.#config = config;
  }

  executeSql(sql: string): Promise<AnalyticsEngineSqlResult> {
    return executeSql(this.#config, sql);
  }
}

function parseSeriesRows(
  metrics: readonly HostMetricKey[],
  data: Array<Record<string, unknown>>,
  resolutionSeconds: number,
): { points: HostSeriesPoint[]; sampleCount: number } {
  const points: HostSeriesPoint[] = [];
  let sampleCount = 0;
  for (const row of data) {
    const bucketEpochSeconds = parseBucketEpochSeconds(row.bucket);
    if (!Number.isFinite(bucketEpochSeconds)) continue;

    const rowSamples = Number(row.sample_count ?? 0);
    const hasSamples = Number.isFinite(rowSamples);
    if (hasSamples) sampleCount += rowSamples;

    // Buckets with data expect samples at their observed cadence — shared
    // helper, never an inline 60 s assumption (a live 10 s session must not
    // read as over-full). The cadence is `core_weight`-weighted SQL-side so
    // sampled (`_sample_interval` > 1) rows keep the same weight that scales
    // `sample_count`.
    const avgIntervalSeconds = Number(row.avg_interval_seconds);
    const expectedSampleCount = Number.isFinite(avgIntervalSeconds)
      ? defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSeconds)
      : defaultExpectedSamplesPerBucket(resolutionSeconds);

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
    // last/max aggregates surface the missing-metric sentinel when every
    // contributing row was sentinel — report missing, never -1e308.
    values[key] = Number.isFinite(num) ? stripAeSentinel(num) : null;
  }
  return values;
}

/**
 * Parse the single summary aggregate row. `latest_at` flows through the same
 * normalized AE timestamp path as every other read (`parseAeLatestAtMs` —
 * space-separated backend DateTimes are UTC, never locale-dependent), and
 * `latestAt` stays null whenever the core sample count is zero so an orphan
 * part row can never surface a bogus "latest sample" timestamp for a range
 * with no logical samples.
 */
export function parseHostSummaryRow(
  row: Record<string, unknown> | undefined,
): { sampleCount: number; latestAt: string | null } {
  const sampleCountRaw = Number(row?.sample_count ?? 0);
  const sampleCount = Number.isFinite(sampleCountRaw) ? sampleCountRaw : 0;
  if (sampleCount <= 0) {
    return { sampleCount, latestAt: null };
  }
  const latestAtMs = parseAeLatestAtMs(row?.latest_at);
  return {
    sampleCount,
    latestAt: latestAtMs === null ? null : new Date(latestAtMs).toISOString(),
  };
}

export async function queryHostSeriesViaSqlApi(
  config: CloudflareAnalyticsSqlConfig,
  input: HostSeriesQuery,
): Promise<HostSeriesResult> {
  const dataset = config.dataset ?? AE_DATASET_NAME;
  const maxRangeSeconds = config.maxRangeSeconds ??
    AE_DEFAULT_MAX_RANGE_SECONDS;
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
  config: CloudflareAnalyticsSqlConfig,
  input: HostSummaryQuery,
): Promise<HostSummaryResult> {
  const dataset = config.dataset ?? AE_DATASET_NAME;
  const maxRangeSeconds = config.maxRangeSeconds ??
    AE_DEFAULT_MAX_RANGE_SECONDS;
  const sql = buildHostSummarySql(input, { dataset, maxRangeSeconds });
  const json = await executeSql(config, sql);
  const { sampleCount, latestAt } = parseHostSummaryRow(json.data[0]);
  return {
    kind: "analytics-engine",
    available: true,
    serverId: input.serverId,
    sampleCount,
    latestAt,
  };
}

export function buildStatusEventsSql(
  input: StatusHistoryQuery,
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
  const discriminators = statusEventDiscriminatorPredicates();
  const connectedCol = statusConnectedColumn();
  const reasonCol = statusReasonColumn();
  const limit = MAX_STATUS_EVENTS + 1;

  return [
    "SELECT",
    `  ${AE_TIMESTAMP_COLUMN} AS timestamp,`,
    `  ${connectedCol} AS connected,`,
    `  ${reasonCol} AS reason`,
    `FROM ${opts.dataset}`,
    `WHERE ${AE_INDEX_SERVER_ID_COLUMN} = ${quoteSqlString(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix})`,
    `  AND ${AE_TIMESTAMP_COLUMN} < toDateTime(${toUnix})`,
    `ORDER BY ${AE_TIMESTAMP_COLUMN} ASC`,
    `LIMIT ${limit}`,
  ].join("\n");
}

/**
 * State just before `from` — deliberately `ORDER BY … DESC LIMIT 1` rather
 * than `argMax`, which Cloudflare AE SQL does not document.
 */
export function buildStatusPriorStateSql(
  input: StatusHistoryQuery,
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
  const discriminators = statusEventDiscriminatorPredicates();
  const connectedCol = statusConnectedColumn();
  const reasonCol = statusReasonColumn();

  return [
    "SELECT",
    `  ${AE_TIMESTAMP_COLUMN} AS timestamp,`,
    `  ${connectedCol} AS connected,`,
    `  ${reasonCol} AS reason`,
    `FROM ${opts.dataset}`,
    `WHERE ${AE_INDEX_SERVER_ID_COLUMN} = ${quoteSqlString(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_TIMESTAMP_COLUMN} < toDateTime(${fromUnix})`,
    `ORDER BY ${AE_TIMESTAMP_COLUMN} DESC`,
    `LIMIT 1`,
  ].join("\n");
}

export function parseStatusEventRows(
  rows: Array<Record<string, unknown>>,
): StatusHistoryEvent[] {
  const events: StatusHistoryEvent[] = [];
  for (const row of rows) {
    const atMs = parseAeLatestAtMs(row.timestamp);
    if (atMs === null) continue;
    const connected = parseStatusConnected(row.connected);
    if (connected === null) continue;
    events.push({
      at: new Date(atMs).toISOString(),
      connected,
      reason: parseStatusReason(row.reason, connected),
    });
  }
  return events;
}

/**
 * Detect truncation from the raw backend row count (before parsing), slice to
 * {@link MAX_STATUS_EVENTS}, and derive `knownUntilMs` so uptime math does not
 * extend the last retained state through `to` when later transitions exist.
 */
export function resolveTruncatedStatusEvents(
  rawRows: Array<Record<string, unknown>>,
  fromMs: number,
): {
  events: StatusHistoryEvent[];
  truncated: boolean;
  knownUntilMs: number | undefined;
} {
  const truncated = rawRows.length > MAX_STATUS_EVENTS;
  const rows = truncated ? rawRows.slice(0, MAX_STATUS_EVENTS) : rawRows;
  const events = parseStatusEventRows(rows);
  if (!truncated) {
    return { events, truncated: false, knownUntilMs: undefined };
  }
  const lastAt = events.length > 0 ? Date.parse(events.at(-1)!.at) : Number.NaN;
  const knownUntilMs = Number.isFinite(lastAt) ? lastAt : fromMs;
  return { events, truncated: true, knownUntilMs };
}

function parseStatusConnected(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return null;
  return num >= 0.5;
}

function parseStatusReason(
  raw: unknown,
  connected: boolean,
): ServerStatusTransitionReason {
  if (typeof raw === "string" && STATUS_TRANSITION_REASONS.has(raw)) {
    return raw as ServerStatusTransitionReason;
  }
  return connected ? "connect" : "disconnect";
}

export async function queryStatusHistoryViaSqlApi(
  config: CloudflareAnalyticsSqlConfig,
  input: StatusHistoryQuery,
): Promise<StatusHistoryResult> {
  const dataset = config.dataset ?? AE_DATASET_NAME;
  const maxRangeSeconds = config.maxRangeSeconds ??
    AE_DEFAULT_MAX_RANGE_SECONDS;
  const priorSql = buildStatusPriorStateSql(input, {
    dataset,
    maxRangeSeconds,
  });
  const eventsSql = buildStatusEventsSql(input, {
    dataset,
    maxRangeSeconds,
  });

  const [priorResult, eventsResult] = await Promise.all([
    executeSql(config, priorSql),
    executeSql(config, eventsSql),
  ]);

  const priorConnected = parseStatusConnected(priorResult.data[0]?.connected);
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const { events, truncated, knownUntilMs } = resolveTruncatedStatusEvents(
    eventsResult.data,
    fromMs,
  );
  const uptime = computeStatusUptime({
    fromMs,
    toMs,
    initialConnected: priorConnected,
    events,
    knownUntilMs,
  });

  return {
    kind: "analytics-engine",
    available: true,
    serverId: input.serverId,
    initialConnected: priorConnected,
    events,
    uptimeSeconds: uptime.uptimeSeconds,
    downtimeSeconds: uptime.downtimeSeconds,
    unknownSeconds: uptime.unknownSeconds,
    uptimePercent: uptime.uptimePercent,
    truncated,
  };
}
