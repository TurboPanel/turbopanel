import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { HOST_METRIC_KEYS, METRICS_SCHEMA_VERSION } from "./contract.ts";
import { HOST_METRICS_METRIC_DESCRIPTORS } from "./metric-descriptors.ts";
import {
  MAX_DIMENSION_LEN,
  MAX_INTERFACE_LIST_LEN,
  MAX_INTERVAL_SECONDS,
  MAX_METRICS_PAYLOAD_BYTES,
  MAX_METRICS_SKEW_MS,
  METRICS_LOG_COOLDOWN_MS,
  metricsPayloadByteLength,
  MIN_INTERVAL_SECONDS,
  rateLimitedMetricsLog,
  resetMetricsRateLimitForTests,
  validateHostMetricsSample,
} from "./validation.ts";

/**
 * Deno twin of validation.test.ts (Vitest) so Sonar LCOV attributes
 * validateHostMetricsSample coverage from the Deno coverage profile.
 */

const BASE_DIMENSIONS = {
  schemaVersion: METRICS_SCHEMA_VERSION,
  daemonVersion: "1.0.0",
  operatingSystem: "linux",
  architecture: "arm64",
  kernelRelease: "6.12.0",
  collectionMode: "baseline",
};

function baseMetrics(
  overrides: Record<string, number | null> = {},
): Record<string, number | null> {
  const metrics: Record<string, number | null> = {};
  for (const key of HOST_METRIC_KEYS) {
    metrics[key] = null;
  }
  return { ...metrics, ...overrides };
}

function validRaw(overrides: Record<string, unknown> = {}) {
  return {
    type: "metrics",
    version: METRICS_SCHEMA_VERSION,
    at: new Date().toISOString(),
    intervalSeconds: 60,
    sequence: 1,
    metrics: baseMetrics({ cpuUserPercent: 12.5, memoryTotalBytes: 1024 }),
    dimensions: BASE_DIMENSIONS,
    ...overrides,
  };
}

it("validateHostMetricsSample rejects wrong schema version", () => {
  const result = validateHostMetricsSample(
    validRaw({ version: 1 }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
});

it("validateHostMetricsSample rejects dimensions schemaVersion mismatch", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: { ...BASE_DIMENSIONS, schemaVersion: 99 },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
});

it("validateHostMetricsSample rejects missing collectionMode", () => {
  const dimensions: Record<string, unknown> = { ...BASE_DIMENSIONS };
  delete dimensions.collectionMode;
  const result = validateHostMetricsSample(
    validRaw({ dimensions }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(
    result.reason,
    'metrics dimensions.collectionMode must be "baseline" or "live"',
  );
});

it("validateHostMetricsSample rejects invalid collectionMode", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: { ...BASE_DIMENSIONS, collectionMode: "turbo" },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
});

it("validateHostMetricsSample stamps sampledAt and collectionMode", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: { ...BASE_DIMENSIONS, collectionMode: "live" },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.sampledAt, result.sample.at);
  assertEquals(result.sample.collectionMode, "live");
  assertEquals(result.sample.schemaVersion, METRICS_SCHEMA_VERSION);
});

it("validateHostMetricsSample accepts sensor and interface dimensions", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        cpuTemperatureSensor: "coretemp",
        gpuPowerSensor: "amdgpu",
        uplinkInterfaces: ["eth0"],
        fabricInterfaces: ["wg0", "wg1"],
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.dimensions.cpuTemperatureSensor, "coretemp");
  assertEquals(result.sample.dimensions.gpuPowerSensor, "amdgpu");
  assertEquals(result.sample.dimensions.uplinkInterfaces, ["eth0"]);
  assertEquals(result.sample.dimensions.fabricInterfaces, ["wg0", "wg1"]);
});

it("validateHostMetricsSample rejects oversized sensor strings and interface lists", () => {
  const oversizedSensor = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        cpuTemperatureSensor: "x".repeat(MAX_DIMENSION_LEN + 1),
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(oversizedSensor.ok, false);

  const tooManyInterfaces = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        uplinkInterfaces: Array.from(
          { length: MAX_INTERFACE_LIST_LEN + 1 },
          (_, i) => `eth${i}`,
        ),
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(tooManyInterfaces.ok, false);

  const oversizedInterface = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        fabricInterfaces: ["x".repeat(MAX_DIMENSION_LEN + 1)],
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(oversizedInterface.ok, false);
});

it("validateHostMetricsSample rejects timestamp outside skew window", () => {
  const nowMs = Date.now();
  const result = validateHostMetricsSample(
    validRaw({
      at: new Date(nowMs - MAX_METRICS_SKEW_MS - 1_000).toISOString(),
    }),
    { serverId: "srv-1", receivedAt: new Date(nowMs).toISOString(), nowMs },
  );
  assertEquals(result.ok, false);
});

it("validateHostMetricsSample accepts timestamp within skew window", () => {
  const nowMs = Date.now();
  const result = validateHostMetricsSample(
    validRaw({
      at: new Date(nowMs - MAX_METRICS_SKEW_MS + 1_000).toISOString(),
    }),
    { serverId: "srv-1", receivedAt: new Date(nowMs).toISOString(), nowMs },
  );
  assertEquals(result.ok, true);
});

it("validateHostMetricsSample rejects interval outside bounds, including zero", () => {
  const zero = validateHostMetricsSample(
    validRaw({ intervalSeconds: 0 }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(zero.ok, false);

  const tooLow = validateHostMetricsSample(
    validRaw({ intervalSeconds: MIN_INTERVAL_SECONDS - 1 }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(tooLow.ok, false);

  const tooHigh = validateHostMetricsSample(
    validRaw({ intervalSeconds: MAX_INTERVAL_SECONDS + 1 }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(tooHigh.ok, false);
});

it("validateHostMetricsSample maps NaN and Infinity metrics to null", () => {
  const result = validateHostMetricsSample(
    validRaw({
      metrics: baseMetrics({
        cpuUserPercent: Number.NaN,
        load1: Number.POSITIVE_INFINITY,
        memoryTotalBytes: Number.NEGATIVE_INFINITY,
      }),
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.metrics.cpuUserPercent, null);
  assertEquals(result.sample.metrics.load1, null);
  assertEquals(result.sample.metrics.memoryTotalBytes, null);
});

it("validateHostMetricsSample clamps percentages to 0–100", () => {
  const result = validateHostMetricsSample(
    validRaw({
      metrics: baseMetrics({
        cpuUserPercent: 150,
        cpuIdlePercent: -5,
      }),
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.metrics.cpuUserPercent, 100);
  assertEquals(result.sample.metrics.cpuIdlePercent, 0);
});

it("validateHostMetricsSample keeps negative temperatures, nulls negative power", () => {
  const result = validateHostMetricsSample(
    validRaw({
      metrics: baseMetrics({
        cpuTemperatureCelsius: -15,
        cpuPowerWatts: -5,
      }),
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.metrics.cpuTemperatureCelsius, -15);
  assertEquals(result.sample.metrics.cpuPowerWatts, null);
});

it("validateHostMetricsSample rejects unknown metric keys", () => {
  const unknown = validateHostMetricsSample(
    validRaw({
      metrics: {
        ...baseMetrics({ cpuUserPercent: 10 }),
        unknownMetric: 999,
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(unknown.ok, false);
  if (unknown.ok) return;
  assertEquals(
    unknown.reason,
    "metrics metrics.unknownMetric is not in the v2 metric allowlist",
  );

  const retiredV1 = validateHostMetricsSample(
    validRaw({
      metrics: {
        ...baseMetrics({ cpuUserPercent: 10 }),
        cpuUsagePercent: 42,
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(retiredV1.ok, false);
  if (retiredV1.ok) return;
  assertEquals(
    retiredV1.reason,
    "metrics metrics.cpuUsagePercent is not in the v2 metric allowlist",
  );
});

it("validateHostMetricsSample rejects unsafe sequences", () => {
  const result = validateHostMetricsSample(
    validRaw({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);

  const fractional = validateHostMetricsSample(
    validRaw({ sequence: 1.5 }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(fractional.ok, false);
});

it("validateHostMetricsSample rejects missing and invalid metric payloads", () => {
  const raw = validRaw();
  delete (raw as { metrics?: unknown }).metrics;
  assertEquals(
    validateHostMetricsSample(raw, {
      serverId: "srv-1",
      receivedAt: new Date().toISOString(),
    }).ok,
    false,
  );

  assertEquals(
    validateHostMetricsSample(validRaw({ metrics: null }), {
      serverId: "srv-1",
      receivedAt: new Date().toISOString(),
    }).ok,
    false,
  );

  const metrics = baseMetrics({ cpuUserPercent: 10 });
  delete metrics.load1;
  assertEquals(
    validateHostMetricsSample(validRaw({ metrics }), {
      serverId: "srv-1",
      receivedAt: new Date().toISOString(),
    }).ok,
    false,
  );
});

it("validateHostMetricsSample rejects oversized payload bytes", () => {
  const result = validateHostMetricsSample(
    validRaw(),
    {
      serverId: "srv-1",
      receivedAt: new Date().toISOString(),
      payloadBytes: MAX_METRICS_PAYLOAD_BYTES + 1,
    },
  );
  assertEquals(result.ok, false);
});

it("validateHostMetricsSample always uses ctx.serverId", () => {
  const result = validateHostMetricsSample(
    {
      ...validRaw(),
      serverId: "client-spoofed-id",
    },
    { serverId: "auth-server-id", receivedAt: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.serverId, "auth-server-id");
  assertEquals(result.sample.receivedAt, "2026-01-01T00:00:00.000Z");
});

it("validateHostMetricsSample accepts optional dimensions.runtimeMode", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: { ...BASE_DIMENSIONS, runtimeMode: "development" },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.dimensions.runtimeMode, "development");
});

it("validateHostMetricsSample rejects wrong envelope type", () => {
  const result = validateHostMetricsSample(
    validRaw({ type: "heartbeat" }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, 'metrics type must be "metrics"');
});

it("validateHostMetricsSample rejects oversized dimension strings", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        daemonVersion: "x".repeat(MAX_DIMENSION_LEN + 1),
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
});

it("HOST_METRICS_METRIC_DESCRIPTORS covers every allowlisted metric", () => {
  assertEquals(
    Object.keys(HOST_METRICS_METRIC_DESCRIPTORS).sort((a, b) =>
      a.localeCompare(b)
    ),
    [...HOST_METRIC_KEYS].sort((a, b) => a.localeCompare(b)),
  );
});

it("metricsPayloadByteLength measures UTF-8 bytes", () => {
  assertEquals(metricsPayloadByteLength("abc"), 3);
  assertEquals(metricsPayloadByteLength("é"), 2);
  const buffer = new TextEncoder().encode("hello").buffer;
  assertEquals(metricsPayloadByteLength(buffer), 5);
});

it("rateLimitedMetricsLog deduplicates within cooldown", () => {
  resetMetricsRateLimitForTests();
  const messages: string[] = [];
  const nowMs = 1_000_000;
  rateLimitedMetricsLog(
    "srv-1",
    "bad sample",
    (msg) => messages.push(msg),
    nowMs,
  );
  rateLimitedMetricsLog(
    "srv-1",
    "bad sample",
    (msg) => messages.push(msg),
    nowMs + METRICS_LOG_COOLDOWN_MS - 1,
  );
  assertEquals(messages, ["bad sample"]);

  rateLimitedMetricsLog(
    "srv-1",
    "bad sample",
    (msg) => messages.push(msg),
    nowMs + METRICS_LOG_COOLDOWN_MS,
  );
  assertEquals(messages, ["bad sample", "bad sample"]);
  resetMetricsRateLimitForTests();
});
