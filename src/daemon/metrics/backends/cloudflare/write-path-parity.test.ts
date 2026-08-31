/**
 * Write-path parity for the two-datapoint Cloudflare layout.
 *
 * Pins the invariants the split depends on: the core/extended parts are an
 * exact partition of the v2 metric allowlist, `double20` is reserved for
 * `intervalSeconds` on both parts (never a metric slot), and one logical
 * host sample is exactly two `writeDataPoint` calls with full 20/20
 * doubles/blobs shapes.
 */

import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
  type HostMetricKey,
} from "../../contract.ts";
import type { AuthenticatedHostMetricsSample } from "../../types.ts";
import {
  AE_BLOB_COUNT,
  AE_BLOB_PART_INDEX,
  AE_DOUBLE_COUNT,
  AE_DOUBLE_INTERVAL_INDEX,
  AE_METRIC_DOUBLE_SLOT_COUNT,
  AE_PART_CORE,
  AE_PART_EXTENDED,
  CORE_METRIC_KEYS,
  doubleColumn,
  EXTENDED_METRIC_KEYS,
  intervalSecondsColumn,
} from "./field-map.ts";
import {
  CloudflareAnalyticsEngineServerMetricsStore,
  type AnalyticsEngineDatasetLike,
} from "./store.ts";

function sample(): AuthenticatedHostMetricsSample {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  return {
    serverId: "11111111-2222-4333-8444-555555555555",
    at: "2026-01-01T00:00:00.000Z",
    sampledAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    intervalSeconds: 60,
    sequence: 1,
    schemaVersion: METRICS_SCHEMA_VERSION,
    collectionMode: "baseline",
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "1.0.0",
      operatingSystem: "linux",
      architecture: "arm64",
      kernelRelease: "6.12.0",
      collectionMode: "baseline",
    },
    metrics,
  };
}

it("CORE ∪ EXTENDED === HOST_METRIC_KEYS with no duplicates or overlap", () => {
  const core = new Set<HostMetricKey>(CORE_METRIC_KEYS);
  const extended = new Set<HostMetricKey>(EXTENDED_METRIC_KEYS);
  // No duplicates within a part.
  assertEquals(core.size, CORE_METRIC_KEYS.length);
  assertEquals(extended.size, EXTENDED_METRIC_KEYS.length);
  // No metric appears in both parts.
  for (const key of core) {
    assertEquals(extended.has(key), false, `${key} is in both parts`);
  }
  // Union covers the allowlist exactly — no gaps, nothing extra.
  const union = new Set<HostMetricKey>([...core, ...extended]);
  assertEquals(union, new Set(HOST_METRIC_KEYS));
  assertEquals(
    CORE_METRIC_KEYS.length + EXTENDED_METRIC_KEYS.length,
    HOST_METRIC_KEYS.length,
  );
});

it("double20 is reserved for intervalSeconds on both parts", () => {
  assertEquals(AE_DOUBLE_INTERVAL_INDEX, 19);
  assertEquals(intervalSecondsColumn(), "double20");
  assertEquals(doubleColumn(AE_DOUBLE_INTERVAL_INDEX), "double20");
  // Metric-key arrays stop before the interval slot — no metric can occupy it.
  assertEquals(CORE_METRIC_KEYS.length, AE_METRIC_DOUBLE_SLOT_COUNT);
  assertEquals(EXTENDED_METRIC_KEYS.length, AE_METRIC_DOUBLE_SLOT_COUNT);
  assertEquals(AE_METRIC_DOUBLE_SLOT_COUNT, AE_DOUBLE_INTERVAL_INDEX);
});

it("writeHostSample: exactly two data points — blob2 core/extended, 20 doubles / 20 blobs", () => {
  const calls: Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }> =
    [];
  const dataset: AnalyticsEngineDatasetLike = {
    writeDataPoint(event) {
      calls.push(event);
    },
  };
  const store = new CloudflareAnalyticsEngineServerMetricsStore(dataset);
  const input = sample();
  store.writeHostSample(input);

  assertEquals(calls.length, 2);
  assertEquals(calls[0]!.blobs![AE_BLOB_PART_INDEX], AE_PART_CORE);
  assertEquals(calls[1]!.blobs![AE_BLOB_PART_INDEX], AE_PART_EXTENDED);
  for (const call of calls) {
    assertEquals(call.doubles!.length, AE_DOUBLE_COUNT);
    assertEquals(call.blobs!.length, AE_BLOB_COUNT);
    assertEquals(call.indexes, [input.serverId]);
    assertEquals(call.doubles![AE_DOUBLE_INTERVAL_INDEX], 60);
  }
});
