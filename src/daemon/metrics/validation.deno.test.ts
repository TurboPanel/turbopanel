import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
} from "./contract.ts";
import {
  HOST_METRICS_METRIC_DESCRIPTORS,
} from "./metric-descriptors.ts";
import {
  MAX_DIMENSION_LEN,
  MAX_INTERVAL_SECONDS,
  MAX_METRICS_PAYLOAD_BYTES,
  MAX_METRICS_SKEW_MS,
  MIN_INTERVAL_SECONDS,
  METRICS_LOG_COOLDOWN_MS,
  metricsPayloadByteLength,
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
    metrics: baseMetrics({ cpuUsagePercent: 12.5, memoryUsedBytes: 1024 }),
    dimensions: BASE_DIMENSIONS,
    ...overrides,
  };
}

it("validateHostMetricsSample rejects wrong schema version", () => {
  const result = validateHostMetricsSample(
    validRaw({ version: 2 }),
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

it("validateHostMetricsSample rejects interval outside bounds", () => {
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
        cpuUsagePercent: Number.NaN,
        load1: Number.POSITIVE_INFINITY,
        memoryUsedBytes: Number.NEGATIVE_INFINITY,
      }),
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.metrics.cpuUsagePercent, null);
  assertEquals(result.sample.metrics.load1, null);
  assertEquals(result.sample.metrics.memoryUsedBytes, null);
});

it("validateHostMetricsSample clamps percentages to 0–100", () => {
  const result = validateHostMetricsSample(
    validRaw({
      metrics: baseMetrics({
        cpuUsagePercent: 150,
        memoryUsedPercent: -5,
      }),
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.metrics.cpuUsagePercent, 100);
  assertEquals(result.sample.metrics.memoryUsedPercent, 0);
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

  const metrics = baseMetrics({ cpuUsagePercent: 10 });
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
  rateLimitedMetricsLog("srv-1", "bad sample", (msg) => messages.push(msg), nowMs);
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
