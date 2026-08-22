/**
 * ClickHouse container-logs schema DDL.
 *
 * Lives in the same database as host metrics (`turbopanel_metrics`) and is
 * written by the same least-privilege `turbopanel_app` user — the Ansible
 * bootstrap grant is already `<database>.*`-scoped, so no new grant is needed.
 * The table itself is *also* created at converge time by
 * `turbopaneld/orchestration/roles/clickhouse/tasks/bootstrap.yml`; both paths
 * are idempotent and must stay in sync (see `../AGENTS.md`).
 *
 * `ORDER BY (organization_id, server_id, service_id, timestamp)` is the whole
 * design: it matches the query predicates in `../types.ts` most-selective-first
 * and doubles as the partition/column plan for the Iceberg backend that comes
 * next. `service_id` sits before `timestamp` even though it is nullable —
 * ClickHouse sorts NULL consistently, and putting the time column last is what
 * makes a per-service tail a range read instead of a scan.
 */

/** Physical container-logs table name. */
export const CONTAINER_LOGS_TABLE = 'container_logs'

/** Default raw-table TTL days (override via buildContainerLogSchemaStatements). */
export const DEFAULT_CONTAINER_LOG_RETENTION_DAYS = 30

export type ContainerLogSchemaConfig = {
  retentionDays: number
}

function buildContainerLogsTableDdl(retentionDays: number): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${CONTAINER_LOGS_TABLE} (`,
    `    timestamp DateTime64(3, 'UTC'),`,
    `    organization_id UUID,`,
    `    server_id UUID,`,
    `    environment_id Nullable(UUID),`,
    `    service_id Nullable(UUID),`,
    `    container_id String,`,
    `    stream LowCardinality(String),`,
    `    message String CODEC(ZSTD)`,
    `) ENGINE = MergeTree`,
    `PARTITION BY toYYYYMM(timestamp)`,
    `ORDER BY (organization_id, server_id, service_id, timestamp)`,
    `TTL timestamp + INTERVAL ${retentionDays} DAY DELETE`,
  ].join('\n')
}

/** Idempotent ALTER for existing tables (CREATE IF NOT EXISTS does not update). */
function buildContainerLogsAlterStatements(retentionDays: number): string[] {
  return [
    `ALTER TABLE ${CONTAINER_LOGS_TABLE} MODIFY TTL timestamp + ` +
      `INTERVAL ${retentionDays} DAY DELETE`,
  ]
}

/** Ordered idempotent DDL for the container-logs table. */
export function buildContainerLogSchemaStatements(config: ContainerLogSchemaConfig): string[] {
  const retentionDays = assertPositiveDays('retentionDays', config.retentionDays)
  return [
    buildContainerLogsTableDdl(retentionDays),
    ...buildContainerLogsAlterStatements(retentionDays),
  ]
}

function assertPositiveDays(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}
