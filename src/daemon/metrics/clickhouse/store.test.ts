import { assertEquals, assertRejects } from "@std/assert";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { HOST_METRIC_KEYS } from "../contract.ts";
import {
  AE_DATASET_NAME,
  AE_MISSING_METRIC_SENTINEL,
  AE_STATUS_EVENT_TYPE,
} from "../analytics-engine/field-map.ts";
import { MAX_STATUS_EVENTS } from "../analytics-engine/sql-api.ts";
import type { AuthenticatedHostMetricsSample } from "../types.ts";
import {
  type ClickHouseHttpClient,
  ClickHouseHttpTimeoutError,
} from "./client.ts";
import { it } from "@std/testing/bdd";
import { HOST_METRICS_TABLE } from "./schema.ts";
import {
  buildHostMetricsRow,
  buildStatusEventRow,
  ClickHouseServerMetricsStore,
  type ClickHouseStoreOptions,
} from "./store.ts";

function sample(
  overrides?: Partial<AuthenticatedHostMetricsSample>,
): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  metrics.cpuUsagePercent = 12.5;
  return {
    serverId: "11111111-1111-4111-8111-111111111111",
    at: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    intervalSeconds: 60,
    sequence: 7,
    schemaVersion: METRICS_SCHEMA_VERSION,
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "1.2.3",
      operatingSystem: "Debian GNU/Linux 13",
      architecture: "aarch64",
      kernelRelease: "6.12.0",
    },
    metrics,
    ...overrides,
  };
}

/** Drain microtasks until `predicate` is true (background flush paths). */
async function waitFor(
  predicate: () => boolean,
  maxTurns = 50,
): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new TypeError("waitFor timed out");
  }
}

class FakeClickHouseHttpClient {
  execCalls: string[] = [];
  insertCalls: Array<{ table: string; rows: ReadonlyArray<Record<string, unknown>> }> =
    [];
  queryCalls: Array<{ sql: string; params?: Record<string, string | number | boolean> }> =
    [];
  queryImpl: (
    sql: string,
    params?: Record<string, string | number | boolean>,
  ) => Promise<Record<string, unknown>[]> = () => Promise.resolve([]);
  failQuery = false;
  insertImpl: (
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ) => Promise<void> = () => Promise.resolve();

  exec(sql: string): Promise<void> {
    this.execCalls.push(sql);
    return Promise.resolve();
  }

  insertRows(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    this.insertCalls.push({ table, rows });
    return this.insertImpl(table, rows);
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T[]> {
    this.queryCalls.push({ sql, params });
    if (this.failQuery) {
      return Promise.reject(new Error("ClickHouse unavailable"));
    }
    return this.queryImpl(sql, params) as Promise<T[]>;
  }
}

function storeWithFake(
  fake: FakeClickHouseHttpClient,
  options?: Omit<ClickHouseStoreOptions, "client">,
): ClickHouseServerMetricsStore {
  return new ClickHouseServerMetricsStore(
    {
      url: "http://127.0.0.1:8123",
      database: "turbopanel_metrics",
      user: "turbopanel_app",
      password: "secret",
      retentionDays: 90,
    },
    { client: fake as unknown as ClickHouseHttpClient, ...options },
  );
}

it("HOST_METRICS_TABLE matches AE_DATASET_NAME", () => {
  assertEquals(HOST_METRICS_TABLE, AE_DATASET_NAME);
});

it("buildHostMetricsRow uses positional AE column names", () => {
  const row = buildHostMetricsRow(sample());
  assertEquals(row.double1, 12.5);
  assertEquals(row.index1, "11111111-1111-4111-8111-111111111111");
  assertEquals(row.blob3, "1.2.3");
  assertEquals(row.sequence, undefined);
  assertEquals(row.server_id, undefined);
});

it("writeHostSample enqueues a single row without immediate insert", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake, { writeBatchMaxRows: 10 });
  await store.writeHostSample(sample());
  assertEquals(fake.insertCalls.length, 0);
  await store.flushWrites();
  assertEquals(fake.insertCalls.length, 1);
  assertEquals(fake.insertCalls[0]!.table, HOST_METRICS_TABLE);
  assertEquals(fake.insertCalls[0]!.rows.length, 1);
  assertEquals(fake.insertCalls[0]!.rows[0]!.double1, 12.5);
});

it("buildStatusEventRow uses status discriminator and sentinel doubles", () => {
  const row = buildStatusEventRow({
    serverId: "11111111-1111-4111-8111-111111111111",
    connected: true,
    reason: "connect",
    at: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(row.blob1, AE_STATUS_EVENT_TYPE);
  assertEquals(row.double1, 1);
  assertEquals(row.double2, AE_MISSING_METRIC_SENTINEL);
  assertEquals(row.blob7, "connect");
  assertEquals(row.index1, "11111111-1111-4111-8111-111111111111");
});

it("writeStatusEvent batches into the same pending buffer as host samples", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake, { writeBatchMaxRows: 10 });
  await store.writeHostSample(sample());
  await store.writeStatusEvent({
    serverId: "11111111-1111-4111-8111-111111111111",
    connected: false,
    reason: "disconnect",
    at: "2026-01-01T00:01:00.000Z",
  });
  assertEquals(fake.insertCalls.length, 0);
  await store.flushWrites();
  assertEquals(fake.insertCalls.length, 1);
  assertEquals(fake.insertCalls[0]!.rows.length, 2);
  assertEquals(fake.insertCalls[0]!.rows[0]!.blob1, "host");
  assertEquals(fake.insertCalls[0]!.rows[1]!.blob1, AE_STATUS_EVENT_TYPE);
});

it("queryStatusHistory force-flushes pending status writes before querying", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () => Promise.resolve([]);
  const store = storeWithFake(fake, { writeBatchMaxRows: 10 });
  await store.writeStatusEvent({
    serverId: "11111111-1111-4111-8111-111111111111",
    connected: true,
    reason: "connect",
    at: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(fake.insertCalls.length, 0);
  await store.queryStatusHistory({
    serverId: "11111111-1111-4111-8111-111111111111",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T00:30:00.000Z",
  });
  assertEquals(fake.insertCalls.length, 1);
  assertEquals(fake.queryCalls.length >= 1, true);
});

it("queryStatusHistory: truncated tail accrues to unknownSeconds", async () => {
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

  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = (sql) => {
    if (sql.includes("ORDER BY timestamp DESC")) {
      return Promise.resolve([{
        timestamp: "2025-12-31T23:00:00.000Z",
        connected: 0,
        reason: "disconnect",
      }]);
    }
    return Promise.resolve(rows);
  };
  const store = storeWithFake(fake);
  const result = await store.queryStatusHistory({
    serverId: "11111111-1111-4111-8111-111111111111",
    from,
    to,
  });

  assertEquals(result.truncated, true);
  assertEquals(result.events.length, MAX_STATUS_EVENTS);
  assertEquals(result.unknownSeconds, expectedUnknownTail);
  assertEquals(result.events[MAX_STATUS_EVENTS - 1]!.connected, false);
  assertEquals(
    result.downtimeSeconds + result.uptimeSeconds,
    (lastRetainedMs - fromMs) / 1000,
  );
});

it("writeHostSample flushes a multi-row batch when max rows is reached", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake, { writeBatchMaxRows: 3 });
  await store.writeHostSample(sample({ sequence: 1 }));
  await store.writeHostSample(sample({ sequence: 2 }));
  assertEquals(fake.insertCalls.length, 0);
  await store.writeHostSample(sample({ sequence: 3 }));
  assertEquals(fake.insertCalls.length, 1);
  assertEquals(fake.insertCalls[0]!.rows.length, 3);
});

it("writeHostSample age flush inserts pending rows", async () => {
  const fake = new FakeClickHouseHttpClient();
  const timers: Array<{ cb: () => void }> = [];
  const store = storeWithFake(fake, {
    writeBatchMaxRows: 10,
    writeBatchMaxAgeMs: 1_000,
    setTimeoutFn: ((cb: () => void) => {
      timers.push({ cb });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });
  await store.writeHostSample(sample());
  assertEquals(fake.insertCalls.length, 0);
  assertEquals(timers.length, 1);
  timers[0]!.cb();
  await waitFor(() => fake.insertCalls.length === 1);
  assertEquals(fake.insertCalls.length, 1);
  assertEquals(fake.insertCalls[0]!.rows.length, 1);
});

it("queryHostSeries force-flushes pending writes before querying", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () => Promise.resolve([]);
  const store = storeWithFake(fake, { writeBatchMaxRows: 10 });
  await store.writeHostSample(sample());
  assertEquals(fake.insertCalls.length, 0);
  await store.queryHostSeries({
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T00:30:00.000Z",
  });
  assertEquals(fake.insertCalls.length, 1);
  assertEquals(fake.queryCalls.length >= 1, true);
});

it("flush errors are logged and swallowed on background flush", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.insertImpl = () => Promise.reject(new Error("insert failed"));
  const errors: unknown[] = [];
  const timers: Array<{ cb: () => void }> = [];
  const store = storeWithFake(fake, {
    writeBatchMaxRows: 10,
    writeBatchMaxAgeMs: 1_000,
    onFlushError: (err) => errors.push(err),
    setTimeoutFn: ((cb: () => void) => {
      timers.push({ cb });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });
  await store.writeHostSample(sample());
  timers[0]!.cb();
  await waitFor(() => errors.length === 1);
  assertEquals(errors.length, 1);
  assertEquals((errors[0] as Error).message, "insert failed");
});

it("ensureSchema runs CREATE plus idempotent ALTERs (no destructive DDL)", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake, { writeBatchMaxRows: 1 });
  await store.writeHostSample(sample());
  assertEquals(fake.execCalls.length, 3);
  assertEquals(fake.execCalls[0]!.includes("CREATE TABLE IF NOT EXISTS"), true);
  assertEquals(fake.execCalls[1]!.includes("MODIFY SETTING"), true);
  assertEquals(fake.execCalls[2]!.includes("MODIFY TTL"), true);
  assertEquals(fake.execCalls.every((sql) => !sql.includes("DROP ")), true);
});

it("ensureSchema applies retention TTL alter for existing tables", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake, { writeBatchMaxRows: 1 });
  await store.ensureSchema();
  assertEquals(
    fake.execCalls.some((sql) =>
      sql.includes("MODIFY TTL timestamp + INTERVAL 90 DAY DELETE")
    ),
    true,
  );
});

it("ensureSchema runs at most once across multiple writes", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake, { writeBatchMaxRows: 1 });
  await store.writeHostSample(sample({ sequence: 1 }));
  await store.writeHostSample(sample({ sequence: 2 }));
  await store.writeHostSample(sample({ sequence: 3 }));
  assertEquals(fake.execCalls.length, 3);
  assertEquals(fake.insertCalls.length, 3);
});

function seriesQueryCall(fake: FakeClickHouseHttpClient) {
  const call = fake.queryCalls.find((entry) =>
    entry.sql.includes("GROUP BY bucket")
  );
  if (!call) {
    throw new TypeError("expected host series query");
  }
  return call;
}

function summaryQueryCall(fake: FakeClickHouseHttpClient) {
  const call = fake.queryCalls.find((entry) =>
    entry.sql.includes("max(timestamp)")
  );
  if (!call) {
    throw new TypeError("expected host summary query");
  }
  return call;
}

it("queryHostSeries uses AE-parity bucket SQL on the shared table", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () =>
    Promise.resolve([
      {
        bucket: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000),
        sample_count: 5,
        cpuUsagePercent: 10,
      },
    ]);
  const store = storeWithFake(fake);
  const result = await store.queryHostSeries({
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
    resolutionSeconds: 3600,
  });
  const call = seriesQueryCall(fake);
  assertEquals(call.sql.includes(`FROM ${HOST_METRICS_TABLE}`), true);
  assertEquals(call.sql.includes("intDiv(toUnixTimestamp(timestamp), 3600)"), true);
  assertEquals(call.sql.includes(String(-1e308)), true);
  assertEquals(call.sql.includes("countIf(double1 != "), true);
  assertEquals(call.sql.includes("blob1 = 'host'"), true);
  assertEquals(result.resolutionSeconds, 3600);
  assertEquals(result.points.length, 1);
  assertEquals(result.points[0]!.values.cpuUsagePercent, 10);
  assertEquals(result.points[0]!.sampleCount, 5);
  assertEquals(result.points[0]!.expectedSampleCount, 60);
});

it("queryHostSeries defaults to 300s buckets and allowlists metrics", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake);
  await store.queryHostSeries({
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T00:30:00.000Z",
  });
  const call = seriesQueryCall(fake);
  assertEquals(call.sql.includes("intDiv(toUnixTimestamp(timestamp), 300)"), true);
  assertEquals(call.sql.includes(`FROM ${HOST_METRICS_TABLE}`), true);

  await assertRejects(
    () =>
      store.queryHostSeries({
        serverId: "11111111-1111-4111-8111-111111111111",
        // deno-lint-ignore no-explicit-any
        metrics: ["notARealMetric" as any],
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:30:00.000Z",
      }),
    TypeError,
    "unknown host metrics metric",
  );
});

it("queryHostSeries supports 60-second buckets (AE parity)", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () => Promise.resolve([]);
  const store = storeWithFake(fake);
  const result = await store.queryHostSeries({
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T00:30:00.000Z",
    resolutionSeconds: 60,
  });
  assertEquals(result.resolutionSeconds, 60);
  assertEquals(
    seriesQueryCall(fake).sql.includes("intDiv(toUnixTimestamp(timestamp), 60)"),
    true,
  );
});

it("queryHostSeries computes gapCount for missing buckets", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () =>
    Promise.resolve([
      {
        bucket: Math.floor(Date.parse("2026-01-01T00:05:00.000Z") / 1000),
        sample_count: 3,
        cpuUsagePercent: 10,
      },
    ]);
  const store = storeWithFake(fake);
  const result = await store.queryHostSeries({
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T00:10:00.000Z",
    resolutionSeconds: 300,
  });
  assertEquals(result.points.length, 1);
  // Half-open [00:00, 00:10): buckets 00:00 + 00:05; partial (2 missing) + full miss (5).
  assertEquals(result.gapCount, 7);
});

it("queryHostSeries surfaces ClickHouse failures (not empty soft result)", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.failQuery = true;
  const store = storeWithFake(fake);
  await assertRejects(
    () =>
      store.queryHostSeries({
        serverId: "11111111-1111-4111-8111-111111111111",
        metrics: ["cpuUsagePercent"],
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:30:00.000Z",
      }),
    Error,
    "ClickHouse unavailable",
  );
});

it("queryHostSeries surfaces ClickHouseHttpTimeoutError for route mapping", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () =>
    Promise.reject(new ClickHouseHttpTimeoutError("query", 30_000));
  const store = storeWithFake(fake);
  await assertRejects(
    () =>
      store.queryHostSeries({
        serverId: "11111111-1111-4111-8111-111111111111",
        metrics: ["cpuUsagePercent"],
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:30:00.000Z",
      }),
    ClickHouseHttpTimeoutError,
  );
});

it("writeHostSample preserves AE missing-metric sentinel for null metrics", async () => {
  const fake = new FakeClickHouseHttpClient();
  const store = storeWithFake(fake, { writeBatchMaxRows: 1 });
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  await store.writeHostSample(sample({ metrics }));
  const row = fake.insertCalls[0]!.rows[0]!;
  assertEquals(row.double1, -1e308);
  assertEquals(row.double5, -1e308);
  assertEquals(row.double13, -1e308);
  assertEquals(row.double15, -1e308);
  assertEquals(row.double9, -1e308);
});

it("queryHostSummary returns latestAt null for empty range", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () =>
    Promise.resolve([
      {
        sample_count: 0,
        latest_at: null,
      },
    ]);
  const store = storeWithFake(fake);
  const result = await store.queryHostSummary({
    serverId: "11111111-1111-4111-8111-111111111111",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(summaryQueryCall(fake).sql.includes(`FROM ${HOST_METRICS_TABLE}`), true);
  assertEquals(result.sampleCount, 0);
  assertEquals(result.latestAt, null);
});

it("queryHostSummary ignores epoch-like latest_at when sample_count is zero", async () => {
  const fake = new FakeClickHouseHttpClient();
  fake.queryImpl = () =>
    Promise.resolve([
      {
        sample_count: 0,
        latest_at: "1970-01-01 00:00:00.000",
      },
    ]);
  const store = storeWithFake(fake);
  const result = await store.queryHostSummary({
    serverId: "11111111-1111-4111-8111-111111111111",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
  });
  assertEquals(result.sampleCount, 0);
  assertEquals(result.latestAt, null);
});
