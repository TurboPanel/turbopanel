/**
 * Deno DuckDB + Parquet host metrics store.
 *
 * Two genuinely typed tables (`server_metric_samples`, `server_status_events`)
 * with real named columns and real SQL `NULL`s for missing metrics — no AE
 * sentinel, no positional `doubleN`/`blobN` layout. Recent rows live in the
 * hot DuckDB table; completed UTC days are sealed into immutable Parquet
 * partitions (`parquet.ts`) and reads union both.
 *
 * Fail clearly when configured-but-unavailable: DuckDB/filesystem failures
 * propagate as thrown errors on read paths so chart routes return a clear
 * "metrics backend unavailable" response. Writes are batched in-process
 * (row count + age) and stay fire-and-forget at the ingest boundary.
 */

import { HOST_METRIC_KEYS, type HostMetricKey } from "../../contract.ts";
import { HOST_METRICS_METRIC_DESCRIPTORS } from "../../metric-descriptors.ts";
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  MAX_STATUS_EVENTS,
  resolveTruncatedStatusEvents,
} from "../cloudflare/sql-api.ts";
import {
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResult,
} from "../../query/series-response.ts";
import { computeStatusUptime } from "../../query/uptime.ts";
import type {
  AuthenticatedHostMetricsSample,
  FleetHostSnapshotQuery,
  FleetHostSnapshotResult,
  FleetHostSnapshotServer,
  HostSeriesPoint,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
  ServerStatusEvent,
  StatusHistoryQuery,
  StatusHistoryResult,
} from "../../types.ts";
import {
  type DuckDbBindValue,
  type DuckDbConnectionLike,
  type DuckDbHandle,
  type DuckDbPaths,
  type DuckDbRow,
  escapeSqlString,
  openDuckDb,
  resolveDuckDbPaths,
} from "./database.ts";
import {
  cleanupTmpParquetFiles,
  listPartitionFilesInRange,
  MS_PER_DAY,
  pruneExpiredPartitions,
  sealDayToParquet,
  timestampLiteralFromMs,
  utcDayStartMs,
} from "./parquet.ts";
import {
  HOST_METRICS_TABLE,
  hostMetricsInsertColumns,
  metricColumnName,
  STATUS_EVENTS_TABLE,
} from "./schema.ts";

/** Flush when this many pending rows accumulate (small co-located fleet). */
export const DUCKDB_WRITE_BATCH_MAX_ROWS = 10;

/**
 * Max age before an incomplete batch flushes. Short on purpose: loaded
 * instances flush via the row-count path, while sparse traffic (a single
 * sample every ~60 s) must still persist promptly — an accepted row never
 * sits in memory for more than a few seconds.
 */
export const DUCKDB_WRITE_BATCH_MAX_AGE_MS = 5_000;

/** Default retention for hot rows + sealed partitions (matches AE's 90 days). */
export const DEFAULT_DUCKDB_RETENTION_DAYS = 90;

/** Loopback port the dev-only embedded DuckDB UI serves on. */
export const DUCKDB_UI_DEFAULT_PORT = 4213;

/** Default bucket when `resolutionSeconds` is omitted (5 minutes). */
export const DUCKDB_DEFAULT_BUCKET_SECONDS = 300;

/** How often the armed daily-archive timer checks for a completed UTC day. */
export const DUCKDB_ARCHIVE_CHECK_INTERVAL_MS = 60 * 60_000;

/** Cap on serverIds accepted into a fleet snapshot IN-list. */
export const DUCKDB_MAX_FLEET_SNAPSHOT_SERVERS = 500;

const ALLOWED_METRIC_KEYS = new Set<string>(HOST_METRIC_KEYS);

export type DuckDbStoreConfig = {
  /** Metrics state root override (default: `resolveMetricsDir()`). */
  metricsDir?: string;
  /** DuckDB worker-thread cap (`SET threads`, default 2). */
  threads?: number;
  /** DuckDB memory cap in MiB (`SET memory_limit`, default 128). */
  memoryLimitMb?: number;
  /** Hot + Parquet retention days (default 90). */
  retentionDays?: number;
};

export type DuckDbStoreOptions = {
  /** Injected handle factory (tests) — skips filesystem setup + native open. */
  openHandle?: () => Promise<DuckDbHandle>;
  /** Override insert batch size (default {@link DUCKDB_WRITE_BATCH_MAX_ROWS}). */
  writeBatchMaxRows?: number;
  /** Override insert batch age (default {@link DUCKDB_WRITE_BATCH_MAX_AGE_MS}). */
  writeBatchMaxAgeMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  now?: () => number;
  onFlushError?: (error: unknown) => void;
};

type PendingRow =
  | { table: "host"; values: DuckDbBindValue[] }
  | { table: "status"; values: DuckDbBindValue[] };

export class DuckDbParquetServerMetricsStore implements ServerMetricsStore {
  readonly #paths: DuckDbPaths;
  readonly #threads: number | undefined;
  readonly #memoryLimitMb: number | undefined;
  readonly #retentionDays: number;
  readonly #openHandle: () => Promise<DuckDbHandle>;
  readonly #batchMaxRows: number;
  readonly #batchMaxAgeMs: number;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #setInterval: typeof setInterval;
  readonly #clearInterval: typeof clearInterval;
  readonly #now: () => number;
  readonly #onFlushError: (error: unknown) => void;
  #handle: DuckDbHandle | null = null;
  #openPromise: Promise<DuckDbHandle> | null = null;
  readonly #pendingRows: PendingRow[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #flushPromise: Promise<void> | null = null;
  #archiveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: DuckDbStoreConfig = {}, options?: DuckDbStoreOptions) {
    this.#threads = assertOptionalPositiveInt("threads", config.threads);
    this.#memoryLimitMb = assertOptionalPositiveInt(
      "memoryLimitMb",
      config.memoryLimitMb,
    );
    this.#retentionDays = assertOptionalPositiveInt(
      "retentionDays",
      config.retentionDays,
    ) ?? DEFAULT_DUCKDB_RETENTION_DAYS;
    this.#paths = resolveDuckDbPaths(config.metricsDir);
    this.#batchMaxRows = options?.writeBatchMaxRows ??
      DUCKDB_WRITE_BATCH_MAX_ROWS;
    this.#batchMaxAgeMs = options?.writeBatchMaxAgeMs ??
      DUCKDB_WRITE_BATCH_MAX_AGE_MS;
    this.#setTimeout = options?.setTimeoutFn ?? setTimeout;
    this.#clearTimeout = options?.clearTimeoutFn ?? clearTimeout;
    this.#setInterval = options?.setIntervalFn ?? setInterval;
    this.#clearInterval = options?.clearIntervalFn ?? clearInterval;
    this.#now = options?.now ?? Date.now;
    this.#onFlushError = options?.onFlushError ?? defaultFlushErrorLog;
    if (options?.openHandle) {
      this.#openHandle = options.openHandle;
    } else {
      // Fail at construction (not first query) when the metrics directory
      // cannot be created — store selection catches this and falls back to
      // the disabled store.
      Deno.mkdirSync(this.#paths.metricsDir, { recursive: true });
      Deno.mkdirSync(this.#paths.parquetRoot, { recursive: true });
      Deno.mkdirSync(this.#paths.tmpDir, { recursive: true });
      this.#openHandle = () =>
        openDuckDb({
          paths: this.#paths,
          ...(this.#threads !== undefined ? { threads: this.#threads } : {}),
          ...(this.#memoryLimitMb !== undefined
            ? { memoryLimitMb: this.#memoryLimitMb }
            : {}),
        });
    }
  }

  /** Resolved on-disk layout (db file, parquet tree, tmp spill). */
  get paths(): DuckDbPaths {
    return this.#paths;
  }

  /**
   * Dev-only: serve the DuckDB UI from this store's embedded instance
   * (`INSTALL ui; LOAD ui; CALL start_ui_server()`), so the browser attaches
   * to the single writer instead of a second process opening the database
   * file. Idempotent — `start_ui_server()` is a no-op when already running.
   */
  async startUiServer(
    port: number = DUCKDB_UI_DEFAULT_PORT,
  ): Promise<{ port: number }> {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new TypeError("port must be a valid TCP port");
    }
    const handle = await this.#ensureOpen();
    await handle.connection.run(`SET ui_local_port = ${port}`);
    await handle.connection.run("INSTALL ui");
    await handle.connection.run("LOAD ui");
    await handle.connection.run("CALL start_ui_server()");
    return { port };
  }

  /**
   * Fire-and-forget insert (batched). Returns a Promise so callers can
   * `.catch`; the ingest path must not await it into the request handler.
   */
  writeHostSample(input: AuthenticatedHostMetricsSample): Promise<void> {
    const values: DuckDbBindValue[] = [
      input.serverId,
      toDuckDbTimestamp(input.sampledAt),
      toDuckDbTimestamp(input.receivedAt),
      Math.round(input.intervalSeconds),
      input.collectionMode,
    ];
    for (const key of HOST_METRIC_KEYS) {
      // Raw value or SQL NULL — never a sentinel, never a coerced 0.
      values.push(input.metrics[key] ?? null);
    }
    return this.#enqueueRow({ table: "host", values });
  }

  /**
   * Fire-and-forget status transition — batched onto the same pending buffer
   * / flush timer as host samples, but inserted into its own typed table.
   */
  writeStatusEvent(input: ServerStatusEvent): Promise<void> {
    return this.#enqueueRow({
      table: "status",
      values: [
        input.serverId,
        toDuckDbTimestamp(input.at),
        input.connected,
        input.reason,
      ],
    });
  }

  /** Force-flush pending writes (queries / shutdown / archive tick). */
  flushWrites(): Promise<void> {
    return this.#flushPending({ rethrow: true });
  }

  async queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
    await this.flushWrites();
    const serverId = assertSafeServerId(input.serverId);
    const metrics = assertAllowedMetrics(input.metrics);
    const from = assertIsoTimestamp("from", input.from);
    const to = assertIsoTimestamp("to", input.to);
    assertRange(from, to);
    const bucketSeconds = assertPositiveInt(
      "resolutionSeconds",
      input.resolutionSeconds ?? DUCKDB_DEFAULT_BUCKET_SECONDS,
    );

    const handle = await this.#ensureOpen();
    const source = await this.#samplesSource(from.getTime(), to.getTime());
    const metricSelects = metrics.map((key) =>
      `${metricAggregateSql(key)} AS "${key}"`
    );
    const sql = [
      "SELECT",
      `  CAST((epoch_ms(sampled_at) // ${
        bucketSeconds * 1000
      }) * ${bucketSeconds} AS DOUBLE) AS bucket,`,
      `  CAST(count(*) AS DOUBLE) AS sample_count,`,
      `  CAST(avg(interval_seconds) AS DOUBLE) AS avg_interval_seconds,`,
      `  ${metricSelects.join(",\n  ")}`,
      `FROM ${source}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND sampled_at < CAST(? AS TIMESTAMP)`,
      `GROUP BY bucket`,
      `ORDER BY bucket ASC`,
    ].join("\n");

    const reader = await handle.connection.runAndReadAll(sql, [
      serverId,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ]);
    const { points, sampleCount } = parseSeriesRows(
      metrics,
      reader.getRowObjectsJS(),
      bucketSeconds,
    );

    return finalizeHostSeriesResult(from.toISOString(), to.toISOString(), {
      kind: "duckdb",
      available: true,
      serverId: input.serverId,
      metrics,
      points,
      resolutionSeconds: bucketSeconds,
      gapCount: 0,
      sampleCount,
    });
  }

  async queryHostSummary(input: HostSummaryQuery): Promise<HostSummaryResult> {
    await this.flushWrites();
    const serverId = assertSafeServerId(input.serverId);
    const from = assertIsoTimestamp("from", input.from);
    const to = assertIsoTimestamp("to", input.to);
    assertRange(from, to);

    const handle = await this.#ensureOpen();
    const source = await this.#samplesSource(from.getTime(), to.getTime());
    const sql = [
      "SELECT",
      `  CAST(count(*) AS DOUBLE) AS sample_count,`,
      `  CAST(epoch_ms(max(sampled_at)) AS DOUBLE) AS latest_at_ms`,
      `FROM ${source}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND sampled_at < CAST(? AS TIMESTAMP)`,
    ].join("\n");
    const reader = await handle.connection.runAndReadAll(sql, [
      serverId,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ]);
    const row = reader.getRowObjectsJS()[0];
    const sampleCount = toFiniteNumber(row?.sample_count) ?? 0;
    const latestAtMs = toFiniteNumber(row?.latest_at_ms);

    return {
      kind: "duckdb",
      available: true,
      serverId: input.serverId,
      sampleCount,
      latestAt: sampleCount > 0 && latestAtMs !== null
        ? new Date(latestAtMs).toISOString()
        : null,
    };
  }

  async queryFleetHostSnapshot(
    input: FleetHostSnapshotQuery,
  ): Promise<FleetHostSnapshotResult> {
    if (input.serverIds.length === 0) {
      return {
        kind: "duckdb",
        available: true,
        metrics: [...input.metrics],
        servers: [],
      };
    }
    await this.flushWrites();
    const metrics = assertAllowedMetrics(input.metrics);
    const from = assertIsoTimestamp("from", input.from);
    const to = assertIsoTimestamp("to", input.to);
    assertRange(from, to);
    const serverIds = dedupeServerIds(input.serverIds);

    const handle = await this.#ensureOpen();
    const source = await this.#samplesSource(from.getTime(), to.getTime());
    const metricSelects = metrics.map((key) =>
      `${metricAggregateSql(key)} AS "${key}"`
    );
    const inList = serverIds.map(() => "CAST(? AS UUID)").join(", ");
    const sql = [
      "SELECT",
      `  CAST(server_id AS VARCHAR) AS server_id,`,
      `  CAST(count(*) AS DOUBLE) AS sample_count,`,
      `  CAST(epoch_ms(max(sampled_at)) AS DOUBLE) AS latest_at_ms,`,
      `  ${metricSelects.join(",\n  ")}`,
      `FROM ${source}`,
      `WHERE server_id IN (${inList})`,
      `  AND sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND sampled_at < CAST(? AS TIMESTAMP)`,
      `GROUP BY server_id`,
    ].join("\n");
    const reader = await handle.connection.runAndReadAll(sql, [
      ...serverIds,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ]);

    const servers: FleetHostSnapshotServer[] = [];
    for (const row of reader.getRowObjectsJS()) {
      const serverId = typeof row.server_id === "string"
        ? row.server_id.trim()
        : "";
      if (!serverId) continue;
      const sampleCount = toFiniteNumber(row.sample_count) ?? 0;
      const latestAtMs = toFiniteNumber(row.latest_at_ms);
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

    return { kind: "duckdb", available: true, metrics, servers };
  }

  async queryStatusHistory(
    input: StatusHistoryQuery,
  ): Promise<StatusHistoryResult> {
    await this.flushWrites();
    const serverId = assertSafeServerId(input.serverId);
    const from = assertIsoTimestamp("from", input.from);
    const to = assertIsoTimestamp("to", input.to);
    assertRange(from, to);

    const handle = await this.#ensureOpen();
    // Aliases match `resolveTruncatedStatusEvents` row expectations
    // (`timestamp` epoch-ms, `connected`, `reason`).
    const selectList = [
      `  CAST(epoch_ms("at") AS DOUBLE) AS "timestamp",`,
      `  connected,`,
      `  reason`,
    ].join("\n");
    const priorSql = [
      "SELECT",
      selectList,
      `FROM ${STATUS_EVENTS_TABLE}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND "at" < CAST(? AS TIMESTAMP)`,
      `ORDER BY "at" DESC`,
      `LIMIT 1`,
    ].join("\n");
    const eventsSql = [
      "SELECT",
      selectList,
      `FROM ${STATUS_EVENTS_TABLE}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND "at" >= CAST(? AS TIMESTAMP)`,
      `  AND "at" < CAST(? AS TIMESTAMP)`,
      `ORDER BY "at" ASC`,
      `LIMIT ${MAX_STATUS_EVENTS + 1}`,
    ].join("\n");

    // Sequential on purpose — a DuckDB connection is not safe for
    // concurrent statements.
    const fromParam = toDuckDbTimestamp(from.toISOString());
    const toParam = toDuckDbTimestamp(to.toISOString());
    const priorReader = await handle.connection.runAndReadAll(priorSql, [
      serverId,
      fromParam,
    ]);
    const eventsReader = await handle.connection.runAndReadAll(eventsSql, [
      serverId,
      fromParam,
      toParam,
    ]);

    const priorConnected = parseStatusConnected(
      priorReader.getRowObjectsJS()[0]?.connected,
    );
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const { events, truncated, knownUntilMs } = resolveTruncatedStatusEvents(
      eventsReader.getRowObjectsJS(),
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
      kind: "duckdb",
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

  /**
   * Arm the periodic daily-archive check. Not auto-started by the
   * constructor — the boot path (`deno-server.ts`) calls this once so tests
   * can drive archiving deterministically via {@link runDailyArchiveOnce}.
   */
  startDailyArchiveTimer(): void {
    if (this.#archiveTimer !== null) return;
    const tick = () => {
      void this.runDailyArchiveOnce().catch((error) => {
        this.#onFlushError(error);
      });
    };
    this.#archiveTimer = this.#setInterval(
      tick,
      DUCKDB_ARCHIVE_CHECK_INTERVAL_MS,
    );
    // Immediate first pass: sweep crash leftovers + seal any backlog days.
    tick();
  }

  stopDailyArchiveTimer(): void {
    if (this.#archiveTimer === null) return;
    this.#clearInterval(this.#archiveTimer);
    this.#archiveTimer = null;
  }

  /**
   * One archive pass: sweep interrupted exports, seal every completed UTC
   * day still in the hot table, then apply retention to partitions and rows.
   */
  async runDailyArchiveOnce(nowMs: number = this.#now()): Promise<void> {
    const handle = await this.#ensureOpen();
    await this.flushWrites();
    // An interrupted export never counts as sealed — its hot rows are still
    // in the hot table, so deleting the leftover cannot double-delete.
    await cleanupTmpParquetFiles(this.#paths.tmpDir);

    const todayStartMs = utcDayStartMs(nowMs);
    const reader = await handle.connection.runAndReadAll(
      `SELECT DISTINCT CAST(epoch_ms(sampled_at) // ${MS_PER_DAY} AS DOUBLE) AS day ` +
        `FROM ${HOST_METRICS_TABLE} ` +
        `WHERE sampled_at < ${timestampLiteralFromMs(todayStartMs)}`,
    );
    const days = reader.getRowObjectsJS()
      .map((row) => toFiniteNumber(row.day))
      .filter((day): day is number => day !== null)
      .sort((a, b) => a - b);
    for (const day of days) {
      const dayStartMs = day * MS_PER_DAY;
      await sealDayToParquet(handle.connection, {
        dayStartMs,
        dayEndMs: dayStartMs + MS_PER_DAY,
        parquetRoot: this.#paths.parquetRoot,
        tmpDir: this.#paths.tmpDir,
      });
    }

    await pruneExpiredPartitions(handle.connection, {
      retentionDays: this.#retentionDays,
      parquetRoot: this.#paths.parquetRoot,
      nowMs,
    });
  }

  /** Flush pending writes and release the database handle (tests/shutdown). */
  async close(): Promise<void> {
    this.stopDailyArchiveTimer();
    this.#clearFlushTimer();
    try {
      await this.#flushPending({ rethrow: false });
    } finally {
      if (this.#openPromise !== null) {
        try {
          await this.#openPromise;
        } catch {
          // Never opened successfully — nothing to close.
        }
      }
      this.#handle?.close();
      this.#handle = null;
      this.#openPromise = null;
    }
  }

  #ensureOpen(): Promise<DuckDbHandle> {
    if (this.#handle !== null) return Promise.resolve(this.#handle);
    if (this.#openPromise !== null) return this.#openPromise;
    this.#openPromise = this.#openHandle()
      .then((handle) => {
        this.#handle = handle;
        return handle;
      })
      .catch((error) => {
        this.#openPromise = null;
        throw error;
      });
    return this.#openPromise;
  }

  async #samplesSource(fromMs: number, toMs: number): Promise<string> {
    const files = await listPartitionFilesInRange(
      this.#paths.parquetRoot,
      fromMs,
      toMs,
    );
    if (files.length === 0) return HOST_METRICS_TABLE;
    const fileList = files
      .map((file) => `'${escapeSqlString(file)}'`)
      .join(", ");
    return `(SELECT * FROM ${HOST_METRICS_TABLE} ` +
      `UNION ALL BY NAME ` +
      `SELECT * FROM read_parquet([${fileList}], union_by_name = true))`;
  }

  async #enqueueRow(row: PendingRow): Promise<void> {
    // Enqueue before any await so concurrent chart queries that
    // `flushWrites()` cannot race ahead of an in-flight open and observe an
    // empty pending buffer for a sample already accepted with 202.
    this.#pendingRows.push(row);
    if (this.#pendingRows.length >= this.#batchMaxRows) {
      await this.#flushPending({ rethrow: true });
      return;
    }
    this.#armFlushTimer();
  }

  #armFlushTimer(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = this.#setTimeout(() => {
      this.#flushTimer = null;
      void this.#flushPending({ rethrow: false });
    }, this.#batchMaxAgeMs);
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer === null) return;
    this.#clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
  }

  async #flushPending(opts: { rethrow: boolean }): Promise<void> {
    if (this.#flushPromise) {
      await this.#flushPromise;
      if (this.#pendingRows.length === 0) return;
    }
    this.#clearFlushTimer();
    if (this.#pendingRows.length === 0) return;

    const handle = await this.#ensureOpen();
    if (this.#pendingRows.length === 0) return;

    const batch = this.#pendingRows.splice(0);
    this.#flushPromise = this.#insertBatch(handle.connection, batch, opts.rethrow)
      .finally(() => {
        this.#flushPromise = null;
      });
    await this.#flushPromise;
  }

  async #insertBatch(
    connection: DuckDbConnectionLike,
    batch: PendingRow[],
    rethrow: boolean,
  ): Promise<void> {
    const hostRows = batch.filter((row) => row.table === "host");
    const statusRows = batch.filter((row) => row.table === "status");
    try {
      await connection.run("BEGIN TRANSACTION");
      try {
        if (hostRows.length > 0) {
          await connection.run(
            buildHostInsertSql(hostRows.length),
            hostRows.flatMap((row) => row.values),
          );
        }
        if (statusRows.length > 0) {
          await connection.run(
            buildStatusInsertSql(statusRows.length),
            statusRows.flatMap((row) => row.values),
          );
        }
        await connection.run("COMMIT");
      } catch (error) {
        await connection.run("ROLLBACK").catch(() => {});
        throw error;
      }
    } catch (error) {
      // Re-queue so a later query flush / timer can retry; dropping the batch
      // permanently would leave charts empty after a transient hiccup.
      this.#pendingRows.unshift(...batch);
      this.#onFlushError(error);
      if (rethrow) throw error;
      this.#armFlushTimer();
    }
  }
}

function defaultFlushErrorLog(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`duckdb metrics write flush failed: ${message}`);
}

/**
 * Interval-weighted average over real named columns with real NULLs:
 * `SUM(value * interval_seconds) / SUM(interval_seconds)` restricted to rows
 * where the metric is present — a NULL metric contributes neither value nor
 * weight, so missing never averages as zero.
 */
export function intervalWeightedAvgSql(column: string): string {
  return `SUM(${column} * interval_seconds)` +
    ` / (SUM(interval_seconds) FILTER (WHERE ${column} IS NOT NULL))`;
}

/**
 * Latest present value in the group — `arg_max` over `sampled_at` restricted
 * to rows where the metric is present, so a trailing NULL sample never
 * blanks a slow-moving gauge (storage capacity).
 */
export function lastValueSql(column: string): string {
  return `arg_max(${column}, sampled_at) FILTER (WHERE ${column} IS NOT NULL)`;
}

/** Group maximum — NULLs are ignored by SQL `MAX` semantics. */
export function maxValueSql(column: string): string {
  return `MAX(${column})`;
}

/**
 * Descriptor-driven bucket aggregate for one metric — weighted-average,
 * last, or max per `HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation`.
 */
export function metricAggregateSql(key: HostMetricKey): string {
  const column = metricColumnName(key);
  switch (HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation) {
    case "last":
      return lastValueSql(column);
    case "max":
      return maxValueSql(column);
    default:
      return intervalWeightedAvgSql(column);
  }
}

const HOST_INSERT_COLUMNS = hostMetricsInsertColumns();
const HOST_INSERT_TUPLE = "(" + [
  "CAST(? AS UUID)",
  "CAST(? AS TIMESTAMP)",
  "CAST(? AS TIMESTAMP)",
  "CAST(? AS SMALLINT)",
  "?",
  ...HOST_METRIC_KEYS.map(() => "?"),
].join(", ") + ")";

function buildHostInsertSql(rowCount: number): string {
  const tuples = new Array<string>(rowCount).fill(HOST_INSERT_TUPLE).join(", ");
  return `INSERT INTO ${HOST_METRICS_TABLE} (${
    HOST_INSERT_COLUMNS.join(", ")
  }) VALUES ${tuples}`;
}

const STATUS_INSERT_TUPLE =
  "(CAST(? AS UUID), CAST(? AS TIMESTAMP), ?, ?)";

function buildStatusInsertSql(rowCount: number): string {
  const tuples = new Array<string>(rowCount).fill(STATUS_INSERT_TUPLE)
    .join(", ");
  return `INSERT INTO ${STATUS_EVENTS_TABLE} (server_id, "at", connected, reason) VALUES ${tuples}`;
}

/** DuckDB `TIMESTAMP`-castable UTC string from an ISO timestamp. */
function toDuckDbTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`invalid timestamp: ${iso}`);
  }
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function toFiniteNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

function parseSeriesRows(
  metrics: readonly HostMetricKey[],
  rows: DuckDbRow[],
  resolutionSeconds: number,
): { points: HostSeriesPoint[]; sampleCount: number } {
  const points: HostSeriesPoint[] = [];
  let sampleCount = 0;
  for (const row of rows) {
    const bucketEpochSeconds = toFiniteNumber(row.bucket);
    if (bucketEpochSeconds === null) continue;
    const rowSamples = toFiniteNumber(row.sample_count) ?? 0;
    sampleCount += rowSamples;
    // Buckets with data expect samples at their observed cadence — a live
    // (10 s) session must not read as over-full against the 60 s default.
    const avgIntervalSeconds = toFiniteNumber(row.avg_interval_seconds);
    const expectedSampleCount = avgIntervalSeconds !== null
      ? defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSeconds)
      : defaultExpectedSamplesPerBucket(resolutionSeconds);
    points.push({
      at: new Date(bucketEpochSeconds * 1000).toISOString(),
      values: parseMetricValues(metrics, row),
      sampleCount: rowSamples,
      expectedSampleCount,
    });
  }
  return { points, sampleCount };
}

function parseMetricValues(
  metrics: readonly HostMetricKey[],
  row: DuckDbRow,
): HostSeriesPoint["values"] {
  const values: HostSeriesPoint["values"] = {};
  for (const key of metrics) {
    values[key] = toFiniteNumber(row[key]);
  }
  return values;
}

function parseStatusConnected(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw;
  const num = toFiniteNumber(raw);
  if (num === null) return null;
  return num >= 0.5;
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

function dedupeServerIds(serverIds: readonly string[]): string[] {
  if (serverIds.length > DUCKDB_MAX_FLEET_SNAPSHOT_SERVERS) {
    throw new TypeError(
      `serverIds length ${serverIds.length} exceeds max ${DUCKDB_MAX_FLEET_SNAPSHOT_SERVERS}`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of serverIds) {
    const id = assertSafeServerId(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) {
    throw new TypeError("serverIds must be non-empty for fleet snapshot");
  }
  return out;
}

function assertSafeServerId(serverId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(serverId)
  ) {
    throw new TypeError(`invalid serverId for DuckDB: ${serverId}`);
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

function assertRange(from: Date, to: Date): void {
  const spanSeconds = (to.getTime() - from.getTime()) / 1000;
  if (spanSeconds < 0) {
    throw new TypeError("from must be <= to");
  }
  if (spanSeconds > AE_DEFAULT_MAX_RANGE_SECONDS) {
    throw new TypeError(
      `query range ${spanSeconds}s exceeds maxRangeSeconds ${AE_DEFAULT_MAX_RANGE_SECONDS}`,
    );
  }
}

function assertPositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function assertOptionalPositiveInt(
  label: string,
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  return assertPositiveInt(label, value);
}
