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

export type ClickHouseStoreConfig = {
  url: string;
  database: string;
  user: string;
  password: string;
  /** Raw-table TTL days (default 90). */
  retentionDays?: number;
};

export type ClickHouseStoreOptions = {
  /** Injected HTTP client (tests). When omitted, built from config. */
  client?: ClickHouseHttpClient;
  /** Injected fetch for the default client. */
  fetch?: typeof fetch;
};

export class ClickHouseServerMetricsStore implements ServerMetricsStore {
  readonly #client: ClickHouseHttpClient;
  readonly #retentionDays: number;
  #schemaReady = false;
  #schemaPromise: Promise<void> | null = null;

  constructor(
    config: ClickHouseStoreConfig,
    options?: ClickHouseStoreOptions,
  ) {
    this.#retentionDays = config.retentionDays ?? DEFAULT_RAW_RETENTION_DAYS;
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
      this.#client = new ClickHouseHttpClient(clientOpts);
    }
  }

  /**
   * Fire-and-forget insert. Returns a Promise so callers can `.catch`; the WS
   * path must not await it into the message handler.
   */
  writeHostSample(
    input: AuthenticatedHostMetricsSample,
  ): Promise<void> {
    return this.#writeHostSample(input);
  }

  async queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
    await this.ensureSchema();
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
    await this.ensureSchema();
    const row = buildHostMetricsRow(input);
    await this.#client.insertRows(HOST_METRICS_TABLE, [row]);
  }
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