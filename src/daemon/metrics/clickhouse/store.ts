/**
 * Deno ClickHouse host metrics store.
 *
 * Fail clearly when configured-but-unavailable: unlike the AE store's
 * `available: false` no-sql-config soft path, a full ClickHouseStoreConfig
 * means metrics is enabled on self-hosted — connection / query failures
 * propagate as thrown errors on read paths so the future query API can return
 * a clear "ClickHouse unavailable" response. Write failures still surface via
 * rejected promises; `deno-ws.ts` treats `writeHostSample` as fire-and-forget
 * (awaits-and-catches / does not await into the WS handler).
 *
 * Writes are batched in-process (row count + age) so ~1 sample/min traffic
 * lands as fewer MergeTree parts. Server async_insert is secondary only.
 */

import { HOST_METRIC_KEYS } from "../contract.ts";
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  buildHostSeriesClickHouseSql,
  buildHostSummaryClickHouseSql,
  parseHostSummaryRow,
  parseSeriesRows,
} from "../analytics-engine/sql-api.ts";
import {
  finalizeHostSeriesResult,
} from "../query/series-response.ts";
import {
  AE_INDEX_SERVER_ID_COLUMN,
  AE_TIMESTAMP_COLUMN,
  blobColumn,
  doubleColumnForMetric,
  mapHostDimensionsToBlobs,
  mapHostMetricsToDoubles,
} from "../analytics-engine/field-map.ts";
import type {
  AuthenticatedHostMetricsSample,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
} from "../types.ts";
import { ClickHouseHttpClient } from "./client.ts";
import type { ClickHouseHttpClientOptions } from "./client.ts";
import {
  buildSchemaStatements,
  DEFAULT_RAW_RETENTION_DAYS,
  HOST_METRICS_TABLE,
} from "./schema.ts";

/** Flush when this many pending rows accumulate (small co-located fleet). */
export const CLICKHOUSE_WRITE_BATCH_MAX_ROWS = 10;

/**
 * Max age before an incomplete batch flushes. Intentionally longer than the
 * ~60 s sample cadence so several one-row samples coalesce into one insert.
 */
export const CLICKHOUSE_WRITE_BATCH_MAX_AGE_MS = 5 * 60_000;

export type ClickHouseStoreConfig = {
  url: string;
  database: string;
  user: string;
  password: string;
  /** Raw-table TTL days (default 90). Applied on create and via MODIFY TTL. */
  retentionDays?: number;
};

export type ClickHouseStoreOptions = {
  /** Injected HTTP client (tests). When omitted, built from config. */
  client?: ClickHouseHttpClient;
  /** Injected fetch for the default client. */
  fetch?: typeof fetch;
  /** Override insert batch size (default {@link CLICKHOUSE_WRITE_BATCH_MAX_ROWS}). */
  writeBatchMaxRows?: number;
  /** Override insert batch age (default {@link CLICKHOUSE_WRITE_BATCH_MAX_AGE_MS}). */
  writeBatchMaxAgeMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onFlushError?: (error: unknown) => void;
  insertTimeoutMs?: number;
  queryTimeoutMs?: number;
  schemaTimeoutMs?: number;
};

export class ClickHouseServerMetricsStore implements ServerMetricsStore {
  readonly #client: ClickHouseHttpClient;
  readonly #retentionDays: number;
  readonly #batchMaxRows: number;
  readonly #batchMaxAgeMs: number;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #onFlushError: (error: unknown) => void;
  #schemaReady = false;
  #schemaPromise: Promise<void> | null = null;
  readonly #pendingRows: Array<Record<string, unknown>> = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #flushPromise: Promise<void> | null = null;

  constructor(
    config: ClickHouseStoreConfig,
    options?: ClickHouseStoreOptions,
  ) {
    this.#retentionDays = config.retentionDays ?? DEFAULT_RAW_RETENTION_DAYS;
    this.#batchMaxRows = options?.writeBatchMaxRows ??
      CLICKHOUSE_WRITE_BATCH_MAX_ROWS;
    this.#batchMaxAgeMs = options?.writeBatchMaxAgeMs ??
      CLICKHOUSE_WRITE_BATCH_MAX_AGE_MS;
    this.#setTimeout = options?.setTimeoutFn ?? setTimeout;
    this.#clearTimeout = options?.clearTimeoutFn ?? clearTimeout;
    this.#onFlushError = options?.onFlushError ?? defaultFlushErrorLog;
    if (options?.client) {
      this.#client = options.client;
    } else {
      const clientOpts: ClickHouseHttpClientOptions = {
        url: config.url,
        database: config.database,
        user: config.user,
        password: config.password,
      };
      if (options?.fetch) {
        clientOpts.fetch = options.fetch;
      }
      if (options?.insertTimeoutMs !== undefined) {
        clientOpts.insertTimeoutMs = options.insertTimeoutMs;
      }
      if (options?.queryTimeoutMs !== undefined) {
        clientOpts.queryTimeoutMs = options.queryTimeoutMs;
      }
      if (options?.schemaTimeoutMs !== undefined) {
        clientOpts.schemaTimeoutMs = options.schemaTimeoutMs;
      }
      this.#client = new ClickHouseHttpClient(clientOpts);
    }
  }

  /**
   * Fire-and-forget insert (batched). Returns a Promise so callers can
   * `.catch`; the WS path must not await it into the message handler.
   * Resolves once the sample is queued (or when a full batch flush completes).
   */
  writeHostSample(
    input: AuthenticatedHostMetricsSample,
  ): Promise<void> {
    return this.#writeHostSample(input);
  }

  /** Force-flush pending writes (queries / shutdown). */
  flushWrites(): Promise<void> {
    return this.#flushPending({ rethrow: true });
  }

  async queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
    await this.ensureSchema();
    await this.flushWrites();
    const from = assertIsoTimestamp("from", input.from);
    const to = assertIsoTimestamp("to", input.to);
    assertRange(from, to);

    const { sql, metrics, bucketSeconds } = buildHostSeriesClickHouseSql(
      input,
      {
        table: HOST_METRICS_TABLE,
        maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
      },
    );

    const rows = await this.#client.query<Record<string, unknown>>(sql, {
      index1: assertSafeServerId(input.serverId),
      from: toClickHouseDateTime64(from),
      to: toClickHouseDateTime64(to),
    });

    const { points, sampleCount } = parseSeriesRows(
      metrics,
      rows,
      bucketSeconds,
    );

    return finalizeHostSeriesResult(from.toISOString(), to.toISOString(), {
      kind: "clickhouse",
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
    await this.ensureSchema();
    await this.flushWrites();
    const from = assertIsoTimestamp("from", input.from);
    const to = assertIsoTimestamp("to", input.to);
    assertRange(from, to);

    const sql = buildHostSummaryClickHouseSql(input, {
      table: HOST_METRICS_TABLE,
      maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
    });

    const rows = await this.#client.query<Record<string, unknown>>(sql, {
      index1: assertSafeServerId(input.serverId),
      from: toClickHouseDateTime64(from),
      to: toClickHouseDateTime64(to),
    });
    const { sampleCount, latestAt } = parseHostSummaryRow(rows[0]);

    return {
      kind: "clickhouse",
      available: true,
      serverId: input.serverId,
      sampleCount,
      latestAt,
    };
  }

  /** Idempotent schema ensure — at most once per process (in-flight coalesced). */
  ensureSchema(): Promise<void> {
    if (this.#schemaReady) return Promise.resolve();
    if (this.#schemaPromise !== null) return this.#schemaPromise;
    this.#schemaPromise = this.#runEnsureSchema()
      .then(() => {
        this.#schemaReady = true;
      })
      .finally(() => {
        this.#schemaPromise = null;
      });
    return this.#schemaPromise;
  }

  async #runEnsureSchema(): Promise<void> {
    const statements = buildSchemaStatements({
      retentionDays: this.#retentionDays,
    });
    for (const sql of statements) {
      await this.#client.exec(sql);
    }
  }

  async #writeHostSample(
    input: AuthenticatedHostMetricsSample,
  ): Promise<void> {
    // Enqueue before any await so concurrent chart queries that
    // `flushWrites()` cannot race ahead of an in-flight `ensureSchema()` and
    // observe an empty pending buffer for a sample already accepted with 202.
    this.#pendingRows.push(buildHostMetricsRow(input));
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

    await this.ensureSchema();
    if (this.#pendingRows.length === 0) return;

    const batch = this.#pendingRows.splice(0);
    this.#flushPromise = this.#insertBatch(batch, opts.rethrow)
      .finally(() => {
        this.#flushPromise = null;
      });
    await this.#flushPromise;
  }

  async #insertBatch(
    batch: Array<Record<string, unknown>>,
    rethrow: boolean,
  ): Promise<void> {
    try {
      await this.#client.insertRows(HOST_METRICS_TABLE, batch);
    } catch (error) {
      // Re-queue so a later query flush / timer can retry; dropping the batch
      // permanently left charts empty after a transient ClickHouse hiccup.
      this.#pendingRows.unshift(...batch);
      this.#onFlushError(error);
      if (rethrow) throw error;
      this.#armFlushTimer();
    }
  }
}

function defaultFlushErrorLog(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`clickhouse metrics write flush failed: ${message}`);
}

/**
 * Map an authenticated sample to a JSONEachRow row using the shared
 * positional AE column names (`timestamp`, `index1`, `double1..20`,
 * `blob1..20`). Missing metrics use `AE_MISSING_METRIC_SENTINEL` — same as
 * the Analytics Engine write path (`mapHostMetricsToDoubles`).
 */
export function buildHostMetricsRow(
  input: AuthenticatedHostMetricsSample,
): Record<string, unknown> {
  const doubles = mapHostMetricsToDoubles(input.metrics);
  const row: Record<string, unknown> = {
    [AE_TIMESTAMP_COLUMN]: toClickHouseDateTime64(new Date(input.at)),
    [AE_INDEX_SERVER_ID_COLUMN]: input.serverId,
  };
  for (let i = 0; i < HOST_METRIC_KEYS.length; i++) {
    row[doubleColumnForMetric(HOST_METRIC_KEYS[i]!)] = doubles[i];
  }
  const blobs = mapHostDimensionsToBlobs(input.dimensions);
  for (let i = 0; i < blobs.length; i++) {
    row[blobColumn(i)] = blobs[i];
  }
  return row;
}

function toClickHouseDateTime64(date: Date): string {
  const iso = date.toISOString();
  return iso.replace("T", " ").replaceAll("Z", "");
}

function assertSafeServerId(serverId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(serverId)
  ) {
    throw new TypeError(`invalid serverId for ClickHouse: ${serverId}`);
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
  if (to.getTime() - from.getTime() < 0) {
    throw new TypeError("from must be <= to");
  }
}
