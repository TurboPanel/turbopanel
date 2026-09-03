import { describe, expect, it } from "vitest";
import { HOST_METRIC_KEYS, METRICS_SCHEMA_VERSION } from "./contract.ts";
import { HOST_METRICS_METRIC_DESCRIPTORS } from "./metric-descriptors.ts";
import {
  MAX_DIMENSION_LEN,
  MAX_INTERVAL_SECONDS,
  MAX_METRICS_PAYLOAD_BYTES,
  MAX_METRICS_SKEW_MS,
  metricsPayloadByteLength,
  MIN_INTERVAL_SECONDS,
  validateHostMetricsSample,
} from "./validation.ts";

const BASE_DIMENSIONS = {
  schemaVersion: METRICS_SCHEMA_VERSION,
  collectionMode: "baseline",
  hardwareProfileGeneration: 1,
  trafficSources: { caddy: false, proxysql: false },
};

/** Metrics fixture scoped to exactly the declared parts — mirrors the wire contract. */
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

describe("validateHostMetricsSample", () => {
  it("rejects wrong schema version", () => {
    const result = validateHostMetricsSample(
      validRaw({ version: 1 }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects dimensions schemaVersion mismatch", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: { ...BASE_DIMENSIONS, schemaVersion: 99 },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing collectionMode", () => {
    const dimensions: Record<string, unknown> = { ...BASE_DIMENSIONS };
    delete dimensions.collectionMode;
    const result = validateHostMetricsSample(
      validRaw({ dimensions }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'metrics dimensions.collectionMode must be "baseline" or "live"',
    );
  });

  it("rejects invalid collectionMode", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: { ...BASE_DIMENSIONS, collectionMode: "turbo" },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("requires hardwareProfileGeneration as a safe non-negative integer", () => {
    const missing: Record<string, unknown> = { ...BASE_DIMENSIONS };
    delete missing.hardwareProfileGeneration;
    const missingResult = validateHostMetricsSample(
      validRaw({ dimensions: missing }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(missingResult.ok).toBe(false);

    const negative = validateHostMetricsSample(
      validRaw({
        dimensions: { ...BASE_DIMENSIONS, hardwareProfileGeneration: -1 },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(negative.ok).toBe(false);

    const fractional = validateHostMetricsSample(
      validRaw({
        dimensions: { ...BASE_DIMENSIONS, hardwareProfileGeneration: 1.5 },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(fractional.ok).toBe(false);
  });

  it("accepts a real daemon sample carrying dimensions.trafficSources and derives the blob8 marker", () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.dimensions.trafficSources).toEqual({
      caddy: true,
      proxysql: true,
    });
    expect(result.sample.trafficSources).toEqual(["caddy", "proxysql"]);
  });

  it("derives an empty blob8 marker when no traffic source contributed", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          trafficSources: { caddy: false, proxysql: false },
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.trafficSources).toEqual([]);
  });

  it("rejects a missing or malformed dimensions.trafficSources", () => {
    const missing: Record<string, unknown> = { ...BASE_DIMENSIONS };
    delete missing.trafficSources;
    const missingResult = validateHostMetricsSample(
      validRaw({ dimensions: missing }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) return;
    expect(missingResult.reason).toBe(
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
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.reason).toBe(
      "metrics dimensions.trafficSources.caddy and .proxysql must be boolean",
    );
  });

  it("rejects the retired v2 required string dimensions", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          daemonVersion: "1.0.0",
          operatingSystem: "linux",
          architecture: "arm64",
          kernelRelease: "6.12.0",
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects retired v2 sensor identity and interface list dimension fields", () => {
    const sensorIdentity = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          cpuTemperatureSensor: "k10temp",
          gpuTemperatureSensor: "amdgpu",
          cpuPowerSensor: "rapl",
          gpuPowerSensor: "amdgpu",
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(sensorIdentity.ok).toBe(false);

    const interfaceLists = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          uplinkInterfaces: ["eth0"],
          fabricInterfaces: ["eth1"],
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(interfaceLists.ok).toBe(false);
  });

  it("stamps sampledAt, collectionMode, and parts onto the sample", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: { ...BASE_DIMENSIONS, collectionMode: "live" },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.sampledAt).toBe(result.sample.at);
    expect(result.sample.collectionMode).toBe("live");
    expect(result.sample.schemaVersion).toBe(METRICS_SCHEMA_VERSION);
    expect(result.sample.parts).toEqual(["core", "extended"]);
  });

  it("accepts optional dimensions.runtimeMode", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: { ...BASE_DIMENSIONS, runtimeMode: "development" },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.dimensions.runtimeMode).toBe("development");
  });

  it("rejects oversized dimension strings", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          runtimeMode: "x".repeat(MAX_DIMENSION_LEN + 1),
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a valid all-four-parts sample", () => {
    const parts = ["core", "extended", "sensors", "traffic"];
    const result = validateHostMetricsSample(
      validRaw({
        parts,
        metrics: metricsForParts(parts, {
          cpuUserPercent: 12.5,
          memoryTotalBytes: 1024,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.parts).toEqual(parts);
    for (const key of HOST_METRIC_KEYS) {
      expect(key in result.sample.metrics).toBe(true);
    }
  });

  it("accepts core + extended without sensors/traffic", () => {
    const parts = ["core", "extended"];
    const result = validateHostMetricsSample(
      validRaw({ parts, metrics: metricsForParts(parts) }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of HOST_METRIC_KEYS) {
      const declared = HOST_METRICS_METRIC_DESCRIPTORS[key].part === "core" ||
        HOST_METRICS_METRIC_DESCRIPTORS[key].part === "extended";
      expect(key in result.sample.metrics).toBe(declared);
    }
  });

  it("accepts a collector-shaped sensorless VM sample (parts: core + extended only, no sensor keys on the wire)", () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("cpuTemperatureCelsius" in result.sample.metrics).toBe(false);
    expect("cpuPowerWatts" in result.sample.metrics).toBe(false);
  });

  it("rejects a parts list missing core", () => {
    const result = validateHostMetricsSample(
      validRaw({
        parts: ["extended"],
        metrics: metricsForParts(["extended"]),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('metrics parts must include "core"');
  });

  it("rejects a parts list missing extended", () => {
    const result = validateHostMetricsSample(
      validRaw({
        parts: ["core"],
        metrics: metricsForParts(["core"]),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('metrics parts must include "extended"');
  });

  it("rejects an unknown part string", () => {
    const result = validateHostMetricsSample(
      validRaw({ parts: ["core", "bogus"] }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("invalid part");
  });

  it("rejects a duplicate part", () => {
    const result = validateHostMetricsSample(
      validRaw({ parts: ["core", "core"] }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("duplicate part");
  });

  it("rejects an empty parts array", () => {
    const result = validateHostMetricsSample(
      validRaw({ parts: [] }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a key present that belongs to an undeclared part", () => {
    const result = validateHostMetricsSample(
      validRaw({
        parts: ["core", "extended"],
        metrics: metricsForParts(["core", "extended"], {
          gpuUtilizationPercent: 50,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("gpuUtilizationPercent");
    expect(result.reason).toContain("not declared in parts");
  });

  it("rejects a declared part missing one of its required keys", () => {
    const metrics = metricsForParts(["core", "extended"]);
    delete metrics.load1;
    const result = validateHostMetricsSample(
      validRaw({ parts: ["core", "extended"], metrics }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("metrics metrics.load1 is required");
  });

  it("rejects timestamp outside skew window", () => {
    const nowMs = Date.now();
    const result = validateHostMetricsSample(
      validRaw({
        at: new Date(nowMs - MAX_METRICS_SKEW_MS - 1_000).toISOString(),
      }),
      { serverId: "srv-1", receivedAt: new Date(nowMs).toISOString(), nowMs },
    );
    expect(result.ok).toBe(false);
  });

  it("accepts timestamp within skew window", () => {
    const nowMs = Date.now();
    const result = validateHostMetricsSample(
      validRaw({
        at: new Date(nowMs - MAX_METRICS_SKEW_MS + 1_000).toISOString(),
      }),
      { serverId: "srv-1", receivedAt: new Date(nowMs).toISOString(), nowMs },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects interval outside bounds, including zero", () => {
    const zero = validateHostMetricsSample(
      validRaw({ intervalSeconds: 0 }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(zero.ok).toBe(false);

    const tooLow = validateHostMetricsSample(
      validRaw({ intervalSeconds: MIN_INTERVAL_SECONDS - 1 }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(tooLow.ok).toBe(false);

    const tooHigh = validateHostMetricsSample(
      validRaw({ intervalSeconds: MAX_INTERVAL_SECONDS + 1 }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(tooHigh.ok).toBe(false);
  });

  it("maps NaN and Infinity metrics to null", () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.cpuUserPercent).toBeNull();
    expect(result.sample.metrics.load1).toBeNull();
    expect(result.sample.metrics.memoryTotalBytes).toBeNull();
  });

  it("clamps percentages to 0–100", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: metricsForParts(["core", "extended"], {
          cpuUserPercent: 150,
          cpuIdlePercent: -5,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.cpuUserPercent).toBe(100);
    expect(result.sample.metrics.cpuIdlePercent).toBe(0);
  });

  it("preserves negative temperatures but nulls negative power", () => {
    // cpuTemperatureCelsius/cpuPowerWatts are sensors-part keys — "sensors"
    // must be declared for them to be accepted at all.
    const parts = ["core", "extended", "sensors"];
    const result = validateHostMetricsSample(
      validRaw({
        parts,
        metrics: metricsForParts(parts, {
          cpuTemperatureCelsius: -15,
          gpuTemperatureCelsius: -150,
          cpuPowerWatts: -5,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.cpuTemperatureCelsius).toBe(-15);
    expect(result.sample.metrics.gpuTemperatureCelsius).toBeNull();
    expect(result.sample.metrics.cpuPowerWatts).toBeNull();
  });

  it("coerces negative byte/count/uptime to null", () => {
    const parts = ["core", "extended"];
    const result = validateHostMetricsSample(
      validRaw({
        parts,
        metrics: metricsForParts(parts, {
          memoryTotalBytes: -1,
          processCount: -2,
          uptimeSeconds: -10,
          diskReadOpsPerSecond: -3,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.memoryTotalBytes).toBeNull();
    expect(result.sample.metrics.processCount).toBeNull();
    expect(result.sample.metrics.uptimeSeconds).toBeNull();
    expect(result.sample.metrics.diskReadOpsPerSecond).toBeNull();
  });

  it("nulls negative load averages", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: metricsForParts(["core", "extended"], {
          load1: -0.5,
          load5: -1,
          load15: -10,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.load1).toBeNull();
    expect(result.sample.metrics.load5).toBeNull();
    expect(result.sample.metrics.load15).toBeNull();
  });

  it("nulls oversized finite metric values", () => {
    const parts = ["core", "extended"];
    const result = validateHostMetricsSample(
      validRaw({
        parts,
        metrics: metricsForParts(parts, {
          load1: 1_000_001,
          memoryTotalBytes: Number.MAX_SAFE_INTEGER + 1,
          diskReadBytesPerSecond: Number.MAX_SAFE_INTEGER + 100,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.load1).toBeNull();
    expect(result.sample.metrics.memoryTotalBytes).toBeNull();
    expect(result.sample.metrics.diskReadBytesPerSecond).toBeNull();
  });

  it("rejects unsafe sequences", () => {
    const result = validateHostMetricsSample(
      validRaw({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);

    const fractional = validateHostMetricsSample(
      validRaw({ sequence: 1.5 }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(fractional.ok).toBe(false);
  });

  it("rejects unknown metric keys", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: {
          ...metricsForParts(["core"], { cpuUserPercent: 10 }),
          unknownMetric: 999,
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      `metrics metrics.unknownMetric is not in the v${METRICS_SCHEMA_VERSION} metric allowlist`,
    );
  });

  it("rejects retired v1 metric keys", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: {
          ...metricsForParts(["core"], { cpuUserPercent: 10 }),
          cpuUsagePercent: 42,
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      `metrics metrics.cpuUsagePercent is not in the v${METRICS_SCHEMA_VERSION} metric allowlist`,
    );
  });

  it("rejects the removed v2 memoryFreeBytes key", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: {
          ...metricsForParts(["core"], { cpuUserPercent: 10 }),
          memoryFreeBytes: 1024,
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing metrics", () => {
    const raw = validRaw();
    delete (raw as { metrics?: unknown }).metrics;
    const result = validateHostMetricsSample(
      raw,
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("metrics metrics must be an object");
  });

  it("rejects non-object metrics", () => {
    const result = validateHostMetricsSample(
      validRaw({ metrics: null }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("metrics metrics must be an object");

    const arrayResult = validateHostMetricsSample(
      validRaw({ metrics: [] }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(arrayResult.ok).toBe(false);
    if (arrayResult.ok) return;
    expect(arrayResult.reason).toBe("metrics metrics must be an object");
  });

  it("rejects missing allowlisted metric keys", () => {
    const metrics = metricsForParts(["core"], { cpuUserPercent: 10 });
    delete metrics.load1;
    const result = validateHostMetricsSample(
      validRaw({ metrics }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("metrics metrics.load1 is required");
  });

  it("rejects non-number non-null metric values", () => {
    const metrics = metricsForParts(["core"]) as Record<string, unknown>;
    metrics.cpuUserPercent = "12";
    const result = validateHostMetricsSample(
      validRaw({ metrics }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      "metrics metrics.cpuUserPercent must be a number or null",
    );
  });

  it("rejects oversized payload bytes", () => {
    const result = validateHostMetricsSample(
      validRaw(),
      {
        serverId: "srv-1",
        receivedAt: new Date().toISOString(),
        payloadBytes: MAX_METRICS_PAYLOAD_BYTES + 1,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(String(MAX_METRICS_PAYLOAD_BYTES));
  });

  it("accepts payload at the size limit", () => {
    const result = validateHostMetricsSample(
      validRaw(),
      {
        serverId: "srv-1",
        receivedAt: new Date().toISOString(),
        payloadBytes: MAX_METRICS_PAYLOAD_BYTES,
      },
    );
    expect(result.ok).toBe(true);
  });

  it("always uses ctx.serverId", () => {
    const result = validateHostMetricsSample(
      {
        ...validRaw(),
        serverId: "client-spoofed-id",
      },
      { serverId: "auth-server-id", receivedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.serverId).toBe("auth-server-id");
    expect(result.sample.receivedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("HOST_METRICS_METRIC_DESCRIPTORS", () => {
  it("covers every allowlisted metric", () => {
    expect(
      Object.keys(HOST_METRICS_METRIC_DESCRIPTORS).sort((a, b) =>
        a.localeCompare(b)
      ),
    ).toEqual(
      [...HOST_METRIC_KEYS].sort((a, b) => a.localeCompare(b)),
    );
    for (const key of HOST_METRIC_KEYS) {
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
      expect(descriptor.key).toBe(key);
      expect(Number.isFinite(descriptor.min)).toBe(true);
      expect(Number.isFinite(descriptor.max)).toBe(true);
      expect(descriptor.min <= descriptor.max).toBe(true);
    }
  });
});

describe("metricsPayloadByteLength", () => {
  it("measures UTF-8 bytes", () => {
    expect(metricsPayloadByteLength("abc")).toBe(3);
    expect(metricsPayloadByteLength("é")).toBe(2);
    const buffer = new TextEncoder().encode("hello").buffer;
    expect(metricsPayloadByteLength(buffer)).toBe(5);
  });
});
