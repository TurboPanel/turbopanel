import { assertEquals, assertExists } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
} from "../../contract.ts";
import { MAX_METRICS_POINTS } from "../../query/resolution.ts";
import type {
  AuthenticatedHostMetricsSample,
  ServerStatusEvent,
} from "../../types.ts";
import { openDuckDb, resolveDuckDbPaths } from "./database.ts";
import { MS_PER_DAY, partitionFileForDay } from "./parquet.ts";
import {
  DUCKDB_WRITE_BATCH_MAX_AGE_MS,
  DuckDbParquetServerMetricsStore,
} from "./store.ts";

const SERVER_A = "11111111-2222-4333-8444-555555555555";
const SERVER_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AE_SENTINEL = -1e308;
const DAY_START = Date.UTC(2026, 5, 2); // 2026-06-02T00:00:00Z

function makeStore(
  metricsDir: string,
  config: { retentionDays?: number } = {},
): DuckDbParquetServerMetricsStore {
  // writeBatchMaxRows 1 → every accepted write flushes before resolving, so
  // tests never leave a pending flush timer behind.
  return new DuckDbParquetServerMetricsStore(
    { metricsDir, ...config },
    { writeBatchMaxRows: 1 },
  );
}

async function withStore(
  run: (
    store: DuckDbParquetServerMetricsStore,
    metricsDir: string,
  ) => Promise<void>,
  config: { retentionDays?: number } = {},
): Promise<void> {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-store-" });
  const store = makeStore(metricsDir, config);
  try {
    await run(store, metricsDir);
  } finally {
    await store.close();
    await Deno.remove(metricsDir, { recursive: true });
  }
}

function sample(overrides: {
  serverId?: string;
  atMs: number;
  intervalSeconds?: number;
  metrics?: Partial<AuthenticatedHostMetricsSample["metrics"]>;
}): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = overrides.metrics?.[key] ?? null;
  }
  const at = new Date(overrides.atMs).toISOString();
  return {
    serverId: overrides.serverId ?? SERVER_A,
    at,
    sampledAt: at,
    receivedAt: at,
    intervalSeconds: overrides.intervalSeconds ?? 60,
    sequence: 1,
    schemaVersion: METRICS_SCHEMA_VERSION,
    collectionMode: "baseline",
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "linux",
      architecture: "x86_64",
      kernelRelease: "6.18.0",
      collectionMode: "baseline",
    },
    metrics,
  };
}

function statusEvent(overrides: {
  atMs: number;
  connected: boolean;
  reason?: ServerStatusEvent["reason"];
}): ServerStatusEvent {
  return {
    serverId: SERVER_A,
    connected: overrides.connected,
    reason: overrides.reason ?? (overrides.connected ? "connect" : "disconnect"),
    at: new Date(overrides.atMs).toISOString(),
  };
}

it("hot round trip: series/summary keep genuine NULLs and interval weighting", async () => {
  await withStore(async (store) => {
    await store.writeHostSample(sample({
      atMs: DAY_START + 60_000,
      metrics: { cpuUserPercent: 10, load1: 1 },
    }));
    await store.writeHostSample(sample({
      atMs: DAY_START + 120_000,
      metrics: { cpuUserPercent: 20 }, // load1 missing → NULL, not sentinel
    }));

    const series = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent", "load1", "memoryTotalBytes"],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
      resolutionSeconds: 300,
    });
    assertEquals(series.kind, "duckdb");
    assertEquals(series.available, true);
    assertEquals(series.points.length, 1);
    const point = series.points[0]!;
    // Equal 60 s weights → plain average of present values.
    assertEquals(point.values.cpuUserPercent, 15);
    // load1 present in one sample only — averages that sample, never halves.
    assertEquals(point.values.load1, 1);
    // Never-set metric is a real null; the AE sentinel never appears.
    assertEquals(point.values.memoryTotalBytes, null);
    for (const value of Object.values(point.values)) {
      assertEquals(value === AE_SENTINEL, false);
    }
    assertEquals(point.sampleCount, 2);
    assertEquals(series.sampleCount, 2);

    const summary = await store.queryHostSummary({
      serverId: SERVER_A,
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    });
    assertEquals(summary.kind, "duckdb");
    assertEquals(summary.sampleCount, 2);
    assertEquals(summary.latestAt, new Date(DAY_START + 120_000).toISOString());
  });
});

it("fleet snapshot groups by server with parameterized UUIDs", async () => {
  await withStore(async (store) => {
    await store.writeHostSample(sample({
      serverId: SERVER_B,
      atMs: DAY_START + 60_000,
      metrics: { cpuUserPercent: 40 },
    }));
    await store.writeHostSample(sample({
      serverId: SERVER_A,
      atMs: DAY_START + 90_000,
      metrics: { cpuUserPercent: 10 },
    }));

    const snapshot = await store.queryFleetHostSnapshot({
      serverIds: [SERVER_A, SERVER_B, SERVER_A],
      metrics: ["cpuUserPercent", "load1"],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    });
    assertEquals(snapshot.kind, "duckdb");
    assertEquals(snapshot.servers.length, 2);
    // Sorted by serverId.
    assertEquals(snapshot.servers[0]!.serverId, SERVER_A);
    assertEquals(snapshot.servers[0]!.values.cpuUserPercent, 10);
    assertEquals(snapshot.servers[0]!.values.load1, null);
    assertEquals(
      snapshot.servers[0]!.latestAt,
      new Date(DAY_START + 90_000).toISOString(),
    );
    assertEquals(snapshot.servers[1]!.serverId, SERVER_B);
    assertEquals(snapshot.servers[1]!.values.cpuUserPercent, 40);
  });
});

it("status history: prior state + in-range transitions + uptime math", async () => {
  await withStore(async (store) => {
    const from = DAY_START;
    const to = DAY_START + 3600_000;
    await store.writeStatusEvent(
      statusEvent({ atMs: from - 600_000, connected: false }),
    );
    await store.writeStatusEvent(
      statusEvent({ atMs: from + 600_000, connected: true }),
    );
    await store.writeStatusEvent(
      statusEvent({ atMs: from + 1800_000, connected: false, reason: "sweep_stale" }),
    );

    const history = await store.queryStatusHistory({
      serverId: SERVER_A,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    assertEquals(history.kind, "duckdb");
    assertEquals(history.initialConnected, false);
    assertEquals(history.events.length, 2);
    assertEquals(history.events[0]!.connected, true);
    assertEquals(history.events[1]!.reason, "sweep_stale");
    assertEquals(history.truncated, false);
    // down 10 min, up 20 min, down 40 min.
    assertEquals(history.uptimeSeconds, 1200);
    assertEquals(history.downtimeSeconds, 2400);
    assertEquals(history.unknownSeconds, 0);
  });
});

it("daily archive seals completed days; reads union hot + Parquet", async () => {
  await withStore(async (store) => {
    const yesterday = DAY_START - MS_PER_DAY;
    await store.writeHostSample(sample({
      atMs: yesterday + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    await store.writeHostSample(sample({
      atMs: DAY_START + 60_000,
      metrics: { cpuUserPercent: 30 },
    }));

    await store.runDailyArchiveOnce(DAY_START + 3600_000);
    const partition = partitionFileForDay(store.paths.parquetRoot, yesterday);
    assertExists(await Deno.stat(partition));

    const from = new Date(yesterday).toISOString();
    const to = new Date(DAY_START + 600_000).toISOString();
    const spanning = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from,
      to,
      resolutionSeconds: 300,
    });
    assertEquals(spanning.sampleCount, 2);
    assertEquals(spanning.points.length, 2);

    // Removing the sealed partition removes yesterday's row from results —
    // proof the hot table no longer holds the archived day.
    await Deno.remove(partition);
    const hotOnly = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from,
      to,
      resolutionSeconds: 300,
    });
    assertEquals(hotOnly.sampleCount, 1);
    assertEquals(hotOnly.points[0]!.values.cpuUserPercent, 30);
  });
});

it("late sample for an already archived day merges on the next archive tick", async () => {
  await withStore(async (store) => {
    const yesterday = DAY_START - MS_PER_DAY;
    await store.writeHostSample(sample({
      atMs: yesterday + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    await store.runDailyArchiveOnce(DAY_START + 3600_000);

    // Late arrival for the already sealed day (a different 300 s bucket),
    // then a second archive pass.
    await store.writeHostSample(sample({
      atMs: yesterday + 360_000,
      metrics: { cpuUserPercent: 20 },
    }));
    await store.runDailyArchiveOnce(DAY_START + 7200_000);

    const from = new Date(yesterday).toISOString();
    const to = new Date(DAY_START).toISOString();
    const series = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from,
      to,
      resolutionSeconds: 300,
    });
    // Both the originally archived row and the late row stay queryable.
    assertEquals(series.sampleCount, 2);
    assertEquals(series.points.length, 2);
    assertEquals(series.points[0]!.values.cpuUserPercent, 10);
    assertEquals(series.points[1]!.values.cpuUserPercent, 20);

    // Removing the (single) sealed partition removes both rows — proof the
    // merge landed in the one-file-per-day partition, not the hot table.
    await Deno.remove(partitionFileForDay(store.paths.parquetRoot, yesterday));
    const hotOnly = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from,
      to,
      resolutionSeconds: 300,
    });
    assertEquals(hotOnly.sampleCount, 0);
  });
});

it("half-open range: sample and status event exactly at `to` are excluded", async () => {
  await withStore(async (store) => {
    const from = DAY_START;
    const to = DAY_START + 600_000;
    await store.writeHostSample(sample({
      atMs: from + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    // Exactly at `to` — outside the advertised [from, to) range.
    await store.writeHostSample(sample({
      atMs: to,
      metrics: { cpuUserPercent: 90 },
    }));
    await store.writeStatusEvent(
      statusEvent({ atMs: from + 60_000, connected: true }),
    );
    await store.writeStatusEvent(statusEvent({ atMs: to, connected: false }));

    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    const series = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from: fromIso,
      to: toIso,
      resolutionSeconds: 60,
    });
    assertEquals(series.sampleCount, 1);
    assertEquals(series.points.length, 1);
    assertEquals(series.points[0]!.values.cpuUserPercent, 10);

    const summary = await store.queryHostSummary({
      serverId: SERVER_A,
      from: fromIso,
      to: toIso,
    });
    assertEquals(summary.sampleCount, 1);
    assertEquals(summary.latestAt, new Date(from + 60_000).toISOString());

    const snapshot = await store.queryFleetHostSnapshot({
      serverIds: [SERVER_A],
      metrics: ["cpuUserPercent"],
      from: fromIso,
      to: toIso,
    });
    assertEquals(snapshot.servers.length, 1);
    assertEquals(snapshot.servers[0]!.sampleCount, 1);
    assertEquals(snapshot.servers[0]!.values.cpuUserPercent, 10);

    const history = await store.queryStatusHistory({
      serverId: SERVER_A,
      from: fromIso,
      to: toIso,
    });
    assertEquals(history.events.length, 1);
    assertEquals(history.events[0]!.connected, true);
  });
});

it("stray tmp export from a crash is swept and never double-deletes hot rows", async () => {
  await withStore(async (store) => {
    const yesterday = DAY_START - MS_PER_DAY;
    await store.writeHostSample(sample({
      atMs: yesterday + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    const strayPath = `${store.paths.tmpDir}/day-crashed.parquet`;
    await Deno.writeTextFile(strayPath, "interrupted export");

    await store.runDailyArchiveOnce(DAY_START + 3600_000);

    // Stray removed; the day still sealed exactly once from the hot rows.
    let strayExists = true;
    try {
      await Deno.stat(strayPath);
    } catch {
      strayExists = false;
    }
    assertEquals(strayExists, false);

    const series = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from: new Date(yesterday).toISOString(),
      to: new Date(DAY_START).toISOString(),
      resolutionSeconds: 300,
    });
    assertEquals(series.sampleCount, 1);
  });
});

it("rows persist across close + reopen at the same path", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-restart-" });
  try {
    const first = makeStore(metricsDir);
    await first.writeHostSample(sample({
      atMs: DAY_START + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    await first.close();

    const second = makeStore(metricsDir);
    try {
      const summary = await second.queryHostSummary({
        serverId: SERVER_A,
        from: new Date(DAY_START).toISOString(),
        to: new Date(DAY_START + 600_000).toISOString(),
      });
      assertEquals(summary.sampleCount, 1);
    } finally {
      await second.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("sparse writes arm a short flush timer (a few seconds, never minutes)", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-sparse-" });
  let capturedDelay: number | undefined;
  let fireFlush: (() => void) | undefined;
  const store = new DuckDbParquetServerMetricsStore({ metricsDir }, {
    setTimeoutFn: ((handler: () => void, timeout?: number) => {
      capturedDelay = timeout;
      fireFlush = handler;
      return 0;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });
  try {
    // Default batch size (10) — a single sparse sample stays pending and
    // must arm the age timer at the short default.
    await store.writeHostSample(sample({
      atMs: DAY_START + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    assertEquals(capturedDelay, DUCKDB_WRITE_BATCH_MAX_AGE_MS);
    // The "promptly when sparse" contract: a few seconds, not minutes.
    assertEquals(DUCKDB_WRITE_BATCH_MAX_AGE_MS, 5_000);

    fireFlush!();
    await store.flushWrites();
    const summary = await store.queryHostSummary({
      serverId: SERVER_A,
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    });
    assertEquals(summary.sampleCount, 1);
  } finally {
    await store.close();
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("close() persists pending batched writes (graceful shutdown)", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-shutdown-" });
  try {
    // Default batching — one accepted sample sits in the pending buffer
    // (below the row threshold, age timer not yet fired) when close() runs.
    const first = new DuckDbParquetServerMetricsStore({ metricsDir });
    await first.writeHostSample(sample({
      atMs: DAY_START + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    await first.close();

    const second = makeStore(metricsDir);
    try {
      const summary = await second.queryHostSummary({
        serverId: SERVER_A,
        from: new Date(DAY_START).toISOString(),
        to: new Date(DAY_START + 600_000).toISOString(),
      });
      assertEquals(summary.sampleCount, 1);
    } finally {
      await second.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("retention prunes rows and partitions older than retentionDays", async () => {
  await withStore(async (store) => {
    const oldDay = DAY_START - 10 * MS_PER_DAY;
    await store.writeHostSample(sample({
      atMs: oldDay + 60_000,
      metrics: { cpuUserPercent: 10 },
    }));
    await store.writeHostSample(sample({
      atMs: DAY_START - 3600_000,
      metrics: { cpuUserPercent: 20 },
    }));

    await store.runDailyArchiveOnce(DAY_START + 3600_000);

    const summary = await store.queryHostSummary({
      serverId: SERVER_A,
      from: new Date(oldDay).toISOString(),
      to: new Date(DAY_START + 3600_000).toISOString(),
    });
    // Only yesterday's sample survives the 2-day retention.
    assertEquals(summary.sampleCount, 1);
    let oldPartitionExists = true;
    try {
      await Deno.stat(partitionFileForDay(store.paths.parquetRoot, oldDay));
    } catch {
      oldPartitionExists = false;
    }
    assertEquals(oldPartitionExists, false);
  }, { retentionDays: 2 });
});

it("resource caps default to threads=2 / memory_limit=128MiB (duckdb_settings)", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-caps-def-" });
  try {
    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) });
    try {
      const reader = await handle.connection.runAndReadAll(
        "SELECT name, value FROM duckdb_settings() " +
          "WHERE name IN ('threads', 'memory_limit')",
      );
      const settings = new Map(
        reader.getRowObjectsJS().map((row) => [
          String(row.name),
          String(row.value),
        ]),
      );
      assertEquals(settings.get("threads"), "2");
      assertEquals(settings.get("memory_limit")?.includes("128"), true);
    } finally {
      handle.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("resource cap overrides apply via SET (duckdb_settings)", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-caps-" });
  try {
    const handle = await openDuckDb({
      paths: resolveDuckDbPaths(metricsDir),
      threads: 4,
      memoryLimitMb: 256,
    });
    try {
      const reader = await handle.connection.runAndReadAll(
        "SELECT name, value FROM duckdb_settings() " +
          "WHERE name IN ('threads', 'memory_limit', 'temp_directory')",
      );
      const settings = new Map(
        reader.getRowObjectsJS().map((row) => [
          String(row.name),
          String(row.value),
        ]),
      );
      assertEquals(settings.get("threads"), "4");
      assertEquals(settings.get("memory_limit")?.includes("256"), true);
      assertEquals(
        settings.get("temp_directory"),
        resolveDuckDbPaths(metricsDir).tmpDir,
      );
    } finally {
      handle.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("90-day range across ~90 daily partitions stays within MAX_METRICS_POINTS", async () => {
  await withStore(async (store) => {
    const firstDay = DAY_START - 90 * MS_PER_DAY;
    for (let day = 0; day < 90; day++) {
      await store.writeHostSample(sample({
        atMs: firstDay + day * MS_PER_DAY + 60_000,
        metrics: { cpuUserPercent: day },
      }));
    }
    await store.runDailyArchiveOnce(DAY_START);

    const series = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from: new Date(firstDay).toISOString(),
      to: new Date(DAY_START).toISOString(),
      resolutionSeconds: 86400,
    });
    assertEquals(series.sampleCount, 90);
    assertEquals(series.points.length, 90);
    assertEquals(series.points.length <= MAX_METRICS_POINTS, true);
    assertEquals(series.points[0]!.values.cpuUserPercent, 0);
    assertEquals(series.points[89]!.values.cpuUserPercent, 89);
  }, { retentionDays: 120 });
});

it("mixed-cadence hour: bucket is interval-weighted, not a naive sample average", async () => {
  await withStore(async (store) => {
    // 30 baseline samples (60 s cadence, value 10) over the first half hour,
    // then 180 live samples (10 s cadence, value 90) over the second half.
    for (let i = 0; i < 30; i++) {
      await store.writeHostSample(sample({
        atMs: DAY_START + i * 60_000,
        intervalSeconds: 60,
        metrics: { cpuUserPercent: 10 },
      }));
    }
    for (let i = 0; i < 180; i++) {
      await store.writeHostSample(sample({
        atMs: DAY_START + 1_800_000 + i * 10_000,
        intervalSeconds: 10,
        metrics: { cpuUserPercent: 90 },
      }));
    }

    const series = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent"],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 3_600_000).toISOString(),
      resolutionSeconds: 3600,
    });
    assertEquals(series.points.length, 1);
    const point = series.points[0]!;
    assertEquals(point.sampleCount, 210);
    // Interval-weighted: (30·60·10 + 180·10·90) / (30·60 + 180·10) = 50.
    // The naive per-sample average would overweight the live burst (~78.6).
    assertEquals(point.values.cpuUserPercent, 50);
    // Expected samples derive from the observed average interval
    // (3600 s / (3600/210) s) — not from an assumed 60 s cadence (60).
    assertEquals(point.expectedSampleCount, 210);
  });
});

it("descriptor aggregation dispatch: last (storage capacity) and max (uptime)", async () => {
  await withStore(async (store) => {
    await store.writeHostSample(sample({
      atMs: DAY_START + 60_000,
      metrics: {
        cpuUserPercent: 10,
        systemStorageTotalBytes: 1000,
        uptimeSeconds: 100,
      },
    }));
    await store.writeHostSample(sample({
      atMs: DAY_START + 120_000,
      metrics: {
        cpuUserPercent: 30,
        systemStorageTotalBytes: 2000,
        uptimeSeconds: 50,
      },
    }));
    // Latest sample missing both — `last` must not blank the capacity gauge.
    await store.writeHostSample(sample({
      atMs: DAY_START + 180_000,
      metrics: { cpuUserPercent: 20 },
    }));

    const series = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ["cpuUserPercent", "systemStorageTotalBytes", "uptimeSeconds"],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
      resolutionSeconds: 300,
    });
    assertEquals(series.points.length, 1);
    const point = series.points[0]!;
    // weighted-average path: equal 60 s weights → plain average.
    assertEquals(point.values.cpuUserPercent, 20);
    // last path: latest present value, not the 1500 a weighted avg would give.
    assertEquals(point.values.systemStorageTotalBytes, 2000);
    // max path: reboot-style drop never lowers the bucket maximum.
    assertEquals(point.values.uptimeSeconds, 100);

    // The fleet snapshot shares the same descriptor dispatch.
    const snapshot = await store.queryFleetHostSnapshot({
      serverIds: [SERVER_A],
      metrics: ["systemStorageTotalBytes", "uptimeSeconds"],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    });
    assertEquals(snapshot.servers.length, 1);
    assertEquals(snapshot.servers[0]!.values.systemStorageTotalBytes, 2000);
    assertEquals(snapshot.servers[0]!.values.uptimeSeconds, 100);
  });
});
