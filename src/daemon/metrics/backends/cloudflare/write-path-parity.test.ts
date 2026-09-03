/**
 * Write-path parity for the four-part conditional Cloudflare layout.
 *
 * Pins the invariants the split depends on: the four `MetricPart` key
 * arrays are an exact partition of `HOST_METRIC_KEYS`, `double20` is
 * reserved for `intervalSeconds` on every part (never a metric slot), and
 * one logical host sample is 2-4 `writeDataPoint` calls — one per declared
 * part with at least one resolved metric, always `core` + `extended` even
 * when entirely null — with full 20/20 doubles/blobs shapes.
 *
 * The `sum`-aggregation read-path policy (`_sample_interval`-only
 * weighting, never `intervalSeconds`; missing-vs-zero via the 0/0=NaN
 * idiom) is documented in `../../AGENTS.md` ("Missing metrics") and
 * exercised end to end in `sql-api.test.ts`, not here — this file only
 * pins the write-path shape.
 */

import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  HOST_METRIC_KEYS,
  type HostMetricKey,
  type MetricPart,
  METRICS_SCHEMA_VERSION,
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
  AE_PART_SENSORS,
  AE_PART_TRAFFIC,
  CORE_METRIC_KEYS,
  doubleColumn,
  EXTENDED_METRIC_KEYS,
  intervalSecondsColumn,
  SENSOR_METRIC_KEYS,
  TRAFFIC_METRIC_KEYS,
} from "./field-map.ts";
import {
  type AnalyticsEngineDatasetLike,
  CloudflareAnalyticsEngineServerMetricsStore,
} from "./store.ts";

function metricsWith(
  overrides: Partial<Record<HostMetricKey, number | null>> = {},
): AuthenticatedHostMetricsSample["metrics"] {
  const metrics = {} as AuthenticatedHostMetricsSample["metrics"];
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  return { ...metrics, ...overrides };
}

function sample(
  overrides: Partial<AuthenticatedHostMetricsSample> = {},
): AuthenticatedHostMetricsSample {
  const metrics = metricsWith();
  return {
    serverId: "11111111-2222-4333-8444-555555555555",
    at: "2026-01-01T00:00:00.000Z",
    sampledAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    intervalSeconds: 60,
    sequence: 1,
    schemaVersion: METRICS_SCHEMA_VERSION,
    collectionMode: "baseline",
    parts: ["core", "extended"],
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      collectionMode: "baseline",
      hardwareProfileGeneration: 1,
      trafficSources: { caddy: false, proxysql: false },
    },
    metrics,
    ...overrides,
  };
}

it("CORE ∪ EXTENDED ∪ SENSOR ∪ TRAFFIC === HOST_METRIC_KEYS with no duplicates or overlap", () => {
  const core = new Set<HostMetricKey>(CORE_METRIC_KEYS);
  const extended = new Set<HostMetricKey>(EXTENDED_METRIC_KEYS);
  const sensors = new Set<HostMetricKey>(SENSOR_METRIC_KEYS);
  const traffic = new Set<HostMetricKey>(TRAFFIC_METRIC_KEYS);

  // No duplicates within a part.
  assertEquals(core.size, CORE_METRIC_KEYS.length);
  assertEquals(extended.size, EXTENDED_METRIC_KEYS.length);
  assertEquals(sensors.size, SENSOR_METRIC_KEYS.length);
  assertEquals(traffic.size, TRAFFIC_METRIC_KEYS.length);

  // No metric appears in more than one part.
  const parts = [core, extended, sensors, traffic];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      for (const key of parts[i]!) {
        assertEquals(parts[j]!.has(key), false, `${key} is in two parts`);
      }
    }
  }

  // Union covers the allowlist exactly — no gaps, nothing extra.
  const union = new Set<HostMetricKey>([
    ...core,
    ...extended,
    ...sensors,
    ...traffic,
  ]);
  assertEquals(union, new Set(HOST_METRIC_KEYS));
  assertEquals(
    CORE_METRIC_KEYS.length + EXTENDED_METRIC_KEYS.length +
      SENSOR_METRIC_KEYS.length + TRAFFIC_METRIC_KEYS.length,
    HOST_METRIC_KEYS.length,
  );

  // Every part fits in one AE data point's metric-value slots.
  for (
    const keys of [
      CORE_METRIC_KEYS,
      EXTENDED_METRIC_KEYS,
      SENSOR_METRIC_KEYS,
      TRAFFIC_METRIC_KEYS,
    ]
  ) {
    assertEquals(keys.length > 0, true);
    assertEquals(keys.length <= AE_METRIC_DOUBLE_SLOT_COUNT, true);
  }
});

it("double20 is reserved for intervalSeconds on every part", () => {
  assertEquals(AE_DOUBLE_INTERVAL_INDEX, 19);
  assertEquals(intervalSecondsColumn(), "double20");
  assertEquals(doubleColumn(AE_DOUBLE_INTERVAL_INDEX), "double20");
  // No metric-key array reaches the interval slot.
  for (
    const keys of [
      CORE_METRIC_KEYS,
      EXTENDED_METRIC_KEYS,
      SENSOR_METRIC_KEYS,
      TRAFFIC_METRIC_KEYS,
    ]
  ) {
    assertEquals(keys.length <= AE_DOUBLE_INTERVAL_INDEX, true);
  }
});

function writeAndCollect(
  input: AuthenticatedHostMetricsSample,
): Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }> {
  const calls: Array<
    { indexes?: string[]; doubles?: number[]; blobs?: string[] }
  > = [];
  const dataset: AnalyticsEngineDatasetLike = {
    writeDataPoint(event) {
      calls.push(event);
    },
  };
  const store = new CloudflareAnalyticsEngineServerMetricsStore(dataset);
  store.writeHostSample(input);
  return calls;
}

function assertFullShapeCalls(
  calls: Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }>,
  input: AuthenticatedHostMetricsSample,
): void {
  for (const call of calls) {
    assertEquals(call.doubles!.length, AE_DOUBLE_COUNT);
    assertEquals(call.blobs!.length, AE_BLOB_COUNT);
    assertEquals(call.indexes, [input.serverId]);
    assertEquals(call.doubles![AE_DOUBLE_INTERVAL_INDEX], 60);
  }
}

const SCENARIOS: Array<{
  parts: MetricPart[];
  blob2Sequence: string[];
  metricsOverride?: Partial<Record<HostMetricKey, number | null>>;
}> = [
  {
    parts: ["core", "extended"],
    blob2Sequence: [AE_PART_CORE, AE_PART_EXTENDED],
  },
  {
    parts: ["core", "extended", "sensors"],
    blob2Sequence: [AE_PART_CORE, AE_PART_EXTENDED, AE_PART_SENSORS],
    // A part only writes once at least one of its metrics actually resolved.
    metricsOverride: { [SENSOR_METRIC_KEYS[0]!]: 42 },
  },
  {
    parts: ["core", "extended", "traffic"],
    blob2Sequence: [AE_PART_CORE, AE_PART_EXTENDED, AE_PART_TRAFFIC],
    metricsOverride: { [TRAFFIC_METRIC_KEYS[0]!]: 7 },
  },
  {
    parts: ["core", "extended", "sensors", "traffic"],
    blob2Sequence: [
      AE_PART_CORE,
      AE_PART_EXTENDED,
      AE_PART_SENSORS,
      AE_PART_TRAFFIC,
    ],
    metricsOverride: {
      [SENSOR_METRIC_KEYS[0]!]: 42,
      [TRAFFIC_METRIC_KEYS[0]!]: 7,
    },
  },
];

for (const scenario of SCENARIOS) {
  it(`writeHostSample: parts=[${scenario.parts.join(",")}] → ${scenario.blob2Sequence.length} data points in canonical part order`, () => {
    const input = sample({
      parts: scenario.parts,
      metrics: metricsWith(scenario.metricsOverride),
    });
    const calls = writeAndCollect(input);
    assertEquals(calls.length, scenario.blob2Sequence.length);
    scenario.blob2Sequence.forEach((part, i) => {
      assertEquals(calls[i]!.blobs![AE_BLOB_PART_INDEX], part);
    });
    assertFullShapeCalls(calls, input);
  });
}

it("writeHostSample: a declared but entirely-null optional part writes no row (row-budget invariant)", () => {
  // sensors and traffic are declared, but every metric in `sample()`'s
  // default metrics map is null — neither sidecar/sensor actually resolved
  // data this tick, so writing either part would be a wasted empty row.
  const input = sample({ parts: ["core", "extended", "sensors", "traffic"] });
  const calls = writeAndCollect(input);
  assertEquals(calls.length, 2);
  assertEquals(
    calls.map((c) => c.blobs![AE_BLOB_PART_INDEX]),
    [AE_PART_CORE, AE_PART_EXTENDED],
  );
});

it("writeHostSample: core and extended still write even when every metric in them is null", () => {
  const input = sample({ parts: ["core", "extended"] });
  const calls = writeAndCollect(input);
  assertEquals(calls.length, 2);
});
