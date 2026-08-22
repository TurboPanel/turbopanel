import { it } from "@std/testing/bdd";
/**
 * Optional ClickHouse integration test.
 *
 * Skipped unless `TURBOPANEL_TEST_CLICKHOUSE_URL` is set (never required for
 * default `deno test`). Example against a disposable container:
 *
 * ```sh
 * docker run --rm -d --name tp-ch-test -p 18123:8123 -p 19000:9000 \
 *   clickhouse/clickhouse-server:26.5
 * export TURBOPANEL_TEST_CLICKHOUSE_URL=http://127.0.0.1:18123
 * export TURBOPANEL_TEST_CLICKHOUSE_DATABASE=default
 * export TURBOPANEL_TEST_CLICKHOUSE_USER=default
 * export TURBOPANEL_TEST_CLICKHOUSE_PASSWORD=
 * deno test --allow-env --allow-net src/daemon/metrics/clickhouse/store.integration.test.ts
 * docker rm -f tp-ch-test
 * ```
 */

import { assertEquals } from "@std/assert";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { HOST_METRIC_KEYS } from "../contract.ts";
import type { AuthenticatedHostMetricsSample } from "../types.ts";
import { ClickHouseServerMetricsStore } from "./store.ts";

function readOptionalEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name)?.trim() || undefined;
  } catch {
    // No --allow-env: treat as unset so the suite stays skippable by default.
    return undefined;
  }
}

const testUrl = readOptionalEnv("TURBOPANEL_TEST_CLICKHOUSE_URL");

function sample(): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  metrics.cpuUsagePercent = 42;
  return {
    serverId: "22222222-2222-4222-8222-222222222222",
    at: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    intervalSeconds: 60,
    sequence: 1,
    schemaVersion: METRICS_SCHEMA_VERSION,
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "linux",
      architecture: "aarch64",
      kernelRelease: "6.12.0",
    },
    metrics,
  };
}

it({
  name: "ClickHouse integration: writeHostSample + queryHostSummary round-trip",
  ignore: !testUrl,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const store = new ClickHouseServerMetricsStore({
      url: testUrl!,
      database: readOptionalEnv("TURBOPANEL_TEST_CLICKHOUSE_DATABASE") ??
        "default",
      user: readOptionalEnv("TURBOPANEL_TEST_CLICKHOUSE_USER") ?? "default",
      password: readOptionalEnv("TURBOPANEL_TEST_CLICKHOUSE_PASSWORD") ?? "",
      retentionDays: 7,
    });
    await store.writeHostSample(sample());
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const summary = await store.queryHostSummary({
      serverId: "22222222-2222-4222-8222-222222222222",
      from,
      to,
    });
    assertEquals(summary.kind, "clickhouse");
    assertEquals(summary.available, true);
    assertEquals(summary.sampleCount >= 1, true);
  },
});
