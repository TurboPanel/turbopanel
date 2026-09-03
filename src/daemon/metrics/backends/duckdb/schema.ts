/**
 * DuckDB host-metrics schema DDL — the DuckDB backend's own private field map.
 *
 * One genuinely typed table with real named columns and real SQL `NULL`s: no
 * positional `doubleN`/`blobN` slots and no missing-metric sentinel. The
 * column-name mapping here is backend-private (snake_case of the host metric
 * key) and is independent of `../cloudflare/field-map.ts` — the AE
 * positional layout never leaks into DuckDB.
 *
 * Deliberately a single wide table rather than one table per `MetricPart`
 * (sensors/traffic split out): every metric column is already independently
 * nullable, so a conditionally-declared part costs nothing extra per row
 * beyond NULLs, and a wide table avoids a join on every read. The `parts`
 * column below is what makes that split unnecessary — it records exactly
 * which parts a row declared, so "part never collected" (absent from
 * `parts`) stays distinguishable from "part collected, every value missing"
 * (present in `parts`, every metric column NULL) without a second table.
 */

import { HOST_METRIC_KEYS, type HostMetricKey } from "../../contract.ts";

/** Hot raw-sample table (recent, un-archived rows). */
export const HOST_METRICS_TABLE = "server_metric_samples";

/** Connection-status transition table — never shared with host samples. */
export const STATUS_EVENTS_TABLE = "server_status_events";

/**
 * Bumped whenever the physical DuckDB layout changes in a way existing rows
 * can't satisfy (e.g. a new `NOT NULL` column) — DuckDB has no in-place
 * schema-migration path here, so `database.ts` compares this against a
 * sidecar marker file on open and wipes + rebuilds the store on mismatch
 * rather than attempting to migrate old rows in place.
 */
export const DUCKDB_SCHEMA_MARKER_VERSION = 3;

const METRIC_KEY_SET = new Set<string>(HOST_METRIC_KEYS);

/**
 * DuckDB column name for a host metric key — snake_case of the key
 * (`cpuUserPercent` → `cpu_user_percent`). Analogous to the AE backend's
 * `doubleColumnForMetric`, but producing named identifiers instead of
 * positional slots.
 */
export function metricColumnName(key: HostMetricKey): string {
  if (!METRIC_KEY_SET.has(key)) {
    throw new TypeError(`unknown host metrics metric: ${key}`);
  }
  return key.replaceAll(/([A-Z])/g, "_$1").toLowerCase();
}

/** Non-metric columns of {@link HOST_METRICS_TABLE}, in DDL/insert order. */
export const HOST_METRICS_BASE_COLUMNS = [
  "server_id",
  "sampled_at",
  "received_at",
  "interval_seconds",
  "collection_mode",
  "hardware_profile_generation",
  "parts",
] as const;

/** Full insert column list for {@link HOST_METRICS_TABLE} (base + metrics). */
export function hostMetricsInsertColumns(): string[] {
  return [
    ...HOST_METRICS_BASE_COLUMNS,
    ...HOST_METRIC_KEYS.map((key) => metricColumnName(key)),
  ];
}

function hostMetricsTableDdl(): string {
  const metricColumns = HOST_METRIC_KEYS
    .map((key) => `    ${metricColumnName(key)} DOUBLE`)
    .join(",\n");
  return [
    `CREATE TABLE IF NOT EXISTS ${HOST_METRICS_TABLE} (`,
    `    server_id UUID NOT NULL,`,
    `    sampled_at TIMESTAMP NOT NULL,`,
    `    received_at TIMESTAMP NOT NULL,`,
    `    interval_seconds SMALLINT NOT NULL,`,
    `    collection_mode VARCHAR NOT NULL,`,
    `    hardware_profile_generation SMALLINT,`,
    `    parts VARCHAR NOT NULL,`,
    metricColumns,
    `)`,
  ].join("\n");
}

function statusEventsTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${STATUS_EVENTS_TABLE} (`,
    `    server_id UUID NOT NULL,`,
    `    "at" TIMESTAMP NOT NULL,`,
    `    connected BOOLEAN NOT NULL,`,
    `    reason VARCHAR NOT NULL`,
    `)`,
  ].join("\n");
}

/**
 * Ordered idempotent DDL for both tables plus the `(server_id, <time>)` range
 * indexes queries scan on.
 */
export function buildSchemaStatements(): string[] {
  return [
    hostMetricsTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${HOST_METRICS_TABLE}_server_time ` +
    `ON ${HOST_METRICS_TABLE} (server_id, sampled_at)`,
    statusEventsTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${STATUS_EVENTS_TABLE}_server_time ` +
    `ON ${STATUS_EVENTS_TABLE} (server_id, "at")`,
  ];
}
