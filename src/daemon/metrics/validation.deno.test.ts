import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { HOST_METRIC_KEYS, METRICS_SCHEMA_VERSION } from "./contract.ts";
import { HOST_METRICS_METRIC_DESCRIPTORS } from "./metric-descriptors.ts";
import {
  MAX_DIMENSION_LEN,
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
  collectionMode: "baseline",
  hardwareProfileGeneration: 1,
  trafficSources: { caddy: false, proxysql: false },
};

function metricsForParts(
  parts: readonly string[],
  overrides: Record<string, number | null> = {},
): Record<string, number | null> {
  const declared = new Set(parts);
  const metrics: Record<string, number | null> = {};
  for (const key of HOST_METRIC_KEYS) {
    if (declared.has(HOST_METRICS_METRIC_DESCRIPTORS[key].part)) {
      metrics[key] = null;
    }
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
    parts: ["core", "extended"],
    metrics: metricsForParts(["core", "extended"], {
      cpuUserPercent: 12.5,
      memoryTotalBytes: 1024,
    }),
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

it("validateHostMetricsSample requires hardwareProfileGeneration", () => {
  const missing: Record<string, unknown> = { ...BASE_DIMENSIONS };
  delete missing.hardwareProfileGeneration;
  const missingResult = validateHostMetricsSample(
    validRaw({ dimensions: missing }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(missingResult.ok, false);

  const fractional = validateHostMetricsSample(
    validRaw({
      dimensions: { ...BASE_DIMENSIONS, hardwareProfileGeneration: 1.5 },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(fractional.ok, false);
});

it("validateHostMetricsSample accepts a real daemon sample carrying dimensions.trafficSources and derives the blob8 marker", () => {
  const parts = ["core", "extended", "traffic"];
  const result = validateHostMetricsSample(
    validRaw({
      parts,
      metrics: metricsForParts(parts),
      dimensions: {
        ...BASE_DIMENSIONS,
        trafficSources: { caddy: true, proxysql: true },
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.sample.dimensions.trafficSources, {
    caddy: true,
    proxysql: true,
  });
  assertEquals(result.sample.trafficSources, ["caddy", "proxysql"]);
});

it("validateHostMetricsSample rejects a missing or malformed dimensions.trafficSources", () => {
  const missing: Record<string, unknown> = { ...BASE_DIMENSIONS };
  delete missing.trafficSources;
  const missingResult = validateHostMetricsSample(
    validRaw({ dimensions: missing }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(missingResult.ok, false);
  if (missingResult.ok) return;
  assertEquals(
    missingResult.reason,
    "metrics dimensions.trafficSources must be an object",
  );

  const malformed = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        trafficSources: { caddy: "yes", proxysql: false },
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(malformed.ok, false);
  if (malformed.ok) return;
  assertEquals(
    malformed.reason,
    "metrics dimensions.trafficSources.caddy and .proxysql must be boolean",
  );
});

it("validateHostMetricsSample stamps sampledAt, collectionMode, and parts", () => {
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
  assertEquals(result.sample.parts, ["core", "extended"]);
});

it("validateHostMetricsSample accepts a valid all-four-parts sample", () => {
  const parts = ["core", "extended", "sensors", "traffic"];
  const result = validateHostMetricsSample(
    validRaw({ parts, metrics: metricsForParts(parts) }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const key of HOST_METRIC_KEYS) {
    assertEquals(key in result.sample.metrics, true);
  }
});

it("validateHostMetricsSample accepts a collector-shaped sensorless VM sample (parts: core + extended only, no sensor keys on the wire)", () => {
  // Mirrors LinuxMetricsCollector on a VM / when readSensors() fails: only
  // core+extended keys are ever put on the wire, and no sensors-part key
  // (cpuTemperatureCelsius, cpuPowerWatts, ...) is present at all. This
  // fixture is a literal key list independent of HOST_METRICS_METRIC_DESCRIPTORS
  // so it actually catches descriptor/contract part drift instead of
  // trivially passing whatever the descriptors currently say.
  const collectorMetrics: Record<string, number | null> = {
    cpuUserPercent: 12.5,
    cpuSystemPercent: 3.1,
    cpuNicePercent: 0,
    cpuIdlePercent: 84.4,
    cpuIowaitPercent: 0,
    cpuIrqPercent: 0,
    cpuSoftirqPercent: 0,
    cpuStealPercent: 0,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    memoryTotalBytes: 1024,
    memoryAvailableBytes: 512,
    swapTotalBytes: 0,
    swapFreeBytes: 0,
    processCount: 120,
    uptimeSeconds: 3600,
    systemStorageTotalBytes: 1_000_000,
    systemStorageAvailableBytes: 500_000,
    hostingStorageTotalBytes: null,
    hostingStorageAvailableBytes: null,
    dockerStorageTotalBytes: null,
    dockerStorageAvailableBytes: null,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    diskReadOpsPerSecond: 0,
    diskWriteOpsPerSecond: 0,
    diskReadLatencyMs: 0,
    diskWriteLatencyMs: 0,
    interfaceReceiveBytesPerSecond: 0,
    interfaceTransmitBytesPerSecond: 0,
    fabricReceiveBytesPerSecond: null,
    fabricTransmitBytesPerSecond: null,
    gpuTemperatureCelsius: null,
    gpuPowerWatts: null,
    // Deliberately absent: cpuTemperatureCelsius, cpuPowerWatts, and every
    // other sensors/traffic-part key — this is the exact shape
    // LinuxMetricsCollector emits when readSensors() finds nothing.
  };
  const result = validateHostMetricsSample(
    validRaw({ parts: ["core", "extended"], metrics: collectorMetrics }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals("cpuTemperatureCelsius" in result.sample.metrics, false);
  assertEquals("cpuPowerWatts" in result.sample.metrics, false);
});

it("validateHostMetricsSample rejects parts missing core", () => {
  const result = validateHostMetricsSample(
    validRaw({ parts: ["extended"], metrics: metricsForParts(["extended"]) }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, 'metrics parts must include "core"');
});

it("validateHostMetricsSample rejects parts missing extended", () => {
  const result = validateHostMetricsSample(
    validRaw({ parts: ["core"], metrics: metricsForParts(["core"]) }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, 'metrics parts must include "extended"');
});

it("validateHostMetricsSample rejects a key from an undeclared part", () => {
  const result = validateHostMetricsSample(
    validRaw({
      parts: ["core", "extended"],
      metrics: metricsForParts(["core", "extended"], {
        gpuUtilizationPercent: 50,
      }),
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
});

it("validateHostMetricsSample rejects oversized runtimeMode strings", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        runtimeMode: "x".repeat(MAX_DIMENSION_LEN + 1),
      },
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
      metrics: metricsForParts(["core", "extended"], {
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
      metrics: metricsForParts(["core", "extended"], {
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
  // cpuTemperatureCelsius/cpuPowerWatts are sensors-part keys — "sensors"
  // must be declared for them to be accepted at all.
  const parts = ["core", "extended", "sensors"];
  const result = validateHostMetricsSample(
    validRaw({
      parts,
      metrics: metricsForParts(parts, {
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
        ...metricsForParts(["core"], { cpuUserPercent: 10 }),
        unknownMetric: 999,
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(unknown.ok, false);
  if (unknown.ok) return;
  assertEquals(
    unknown.reason,
    `metrics metrics.unknownMetric is not in the v${METRICS_SCHEMA_VERSION} metric allowlist`,
  );

  const retiredV1 = validateHostMetricsSample(
    validRaw({
      metrics: {
        ...metricsForParts(["core"], { cpuUserPercent: 10 }),
        cpuUsagePercent: 42,
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(retiredV1.ok, false);
  if (retiredV1.ok) return;
  assertEquals(
    retiredV1.reason,
    `metrics metrics.cpuUsagePercent is not in the v${METRICS_SCHEMA_VERSION} metric allowlist`,
  );
});

it("validateHostMetricsSample rejects the removed v2 memoryFreeBytes key", () => {
  const result = validateHostMetricsSample(
    validRaw({
      metrics: {
        ...metricsForParts(["core"], { cpuUserPercent: 10 }),
        memoryFreeBytes: 1024,
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  assertEquals(result.ok, false);
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

  const metrics = metricsForParts(["core"], { cpuUserPercent: 10 });
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

it("validateHostMetricsSample rejects the retired v2 daemonVersion dimension", () => {
  const result = validateHostMetricsSample(
    validRaw({
      dimensions: {
        ...BASE_DIMENSIONS,
        daemonVersion: "x".repeat(MAX_DIMENSION_LEN + 1),
      },
    }),
    { serverId: "srv-1", receivedAt: new Date().toISOString() },
  );
  // Retired v2 dimension fields are rejected outright — only declared fields
  // (schemaVersion, collectionMode, hardwareProfileGeneration, runtimeMode,
  // trafficSources) are recognized.
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
