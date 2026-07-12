/**
 * ClickHouse host-metrics schema DDL.
 *
 * Physical table name matches Analytics Engine (`AE_DATASET_NAME`) so both
 * backends share one storage contract. Positional column names (`timestamp`,
 * `index1`, `double1..double20`, `blob1..blob20`) are sourced exclusively from
 * `../analytics-engine/field-map.ts`.
 *
 * Query-time bucketing mirrors the AE SQL API (`sql-api.ts`) — there are no
 * separate rollup tables or materialized views.
 *
 * Destructive legacy migrations (dropping retired raw/rollup objects) run during
 * Ansible converge with the ClickHouse admin user — not at instance runtime.
 */

import { HOST_METRIC_KEYS, type HostMetricKey } from "../contract.ts";
import {
  AE_BLOB_COUNT,
  AE_BLOB_KERNEL_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_DATASET_NAME,
  AE_INDEX_SERVER_ID_COLUMN,
  AE_TIMESTAMP_COLUMN,
  blobColumn,
  doubleColumnForMetric,
} from "../analytics-engine/field-map.ts";

/** Shared physical metrics table name (same as Analytics Engine dataset). */
export const HOST_METRICS_TABLE = AE_DATASET_NAME;

/** Legacy raw-table server id column — pre-AE positional layout. */
export const LEGACY_HOST_METRICS_SERVER_ID_COLUMN = "server_id";

/** Retired table names removed during admin-owned converge migrations. */
export const LEGACY_HOST_METRICS_RAW_TABLE = "host_metrics_raw";
export const LEGACY_HOST_METRICS_ROLLUP_5M_TABLE = "host_metrics_rollup_5m";
export const LEGACY_HOST_METRICS_ROLLUP_1H_TABLE = "host_metrics_rollup_1h";
export const LEGACY_HOST_METRICS_ROLLUP_1D_TABLE = "host_metrics_rollup_1d";
export const LEGACY_HOST_METRICS_MV_5M = "host_metrics_mv_5m";
export const LEGACY_HOST_METRICS_MV_1H = "host_metrics_mv_1h";
export const LEGACY_HOST_METRICS_MV_1D = "host_metrics_mv_1d";

/** Default raw-table TTL days (override via buildSchemaStatements config). */
export const DEFAULT_RAW_RETENTION_DAYS = 90;

export type SchemaRetentionConfig = {
  retentionDays: number;
};

/** All metric slots are non-null Float64 — same as AE `doubles` (missing → sentinel). */
function rawMetricColumnSql(key: HostMetricKey): string {
  const column = doubleColumnForMetric(key);
  return `    ${column} Float64`;
}

function rawMetricColumns(): string {
  return HOST_METRIC_KEYS
    .map((key) => rawMetricColumnSql(key))
    .join(",\n");
}

/** Positional blob columns blob1..blob20 (identity dims + reserved slots). */
function rawBlobColumns(): string {
  const lines: string[] = [];
  for (let i = 0; i < AE_BLOB_COUNT; i++) {
    const column = blobColumn(i);
    if (i >= AE_BLOB_SCHEMA_VERSION_INDEX && i <= AE_BLOB_KERNEL_INDEX) {
      lines.push(`    ${column} LowCardinality(String) CODEC(ZSTD)`);
    } else {
      lines.push(`    ${column} LowCardinality(String)`);
    }
  }
  return lines.join(",\n");
}

function buildMetricsTableDdl(retentionDays: number): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${HOST_METRICS_TABLE} (`,
    `    ${AE_TIMESTAMP_COLUMN} DateTime64(3, 'UTC'),`,
    `    ${AE_INDEX_SERVER_ID_COLUMN} UUID,`,
    rawMetricColumns() + ",",
    rawBlobColumns(),
    `) ENGINE = MergeTree`,
    `PARTITION BY toYYYYMM(${AE_TIMESTAMP_COLUMN})`,
    `ORDER BY (${AE_INDEX_SERVER_ID_COLUMN}, ${AE_TIMESTAMP_COLUMN})`,
    `TTL ${AE_TIMESTAMP_COLUMN} + INTERVAL ${retentionDays} DAY DELETE`,
  ].join("\n");
}

/** Detect whether a column name belongs to the retired snake_case layout. */
export function isLegacyHostMetricsColumnName(name: string): boolean {
  return name === LEGACY_HOST_METRICS_SERVER_ID_COLUMN;
}

/** Ordered idempotent DDL for the shared AE-named metrics table. */
export function buildSchemaStatements(
  config: SchemaRetentionConfig,
): string[] {
  const retentionDays = assertPositiveDays(
    "retentionDays",
    config.retentionDays,
  );
  return [buildMetricsTableDdl(retentionDays)];
}

function assertPositiveDays(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}
