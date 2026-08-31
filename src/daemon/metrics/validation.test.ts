import { describe, expect, it } from "vitest";
import { HOST_METRIC_KEYS, METRICS_SCHEMA_VERSION } from "./contract.ts";
import { HOST_METRICS_METRIC_DESCRIPTORS } from "./metric-descriptors.ts";
import {
  MAX_DIMENSION_LEN,
  MAX_INTERFACE_LIST_LEN,
  MAX_INTERVAL_SECONDS,
  MAX_METRICS_PAYLOAD_BYTES,
  MAX_METRICS_SKEW_MS,
  metricsPayloadByteLength,
  MIN_INTERVAL_SECONDS,
  validateHostMetricsSample,
} from "./validation.ts";

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

  it("stamps sampledAt and collectionMode onto the sample", () => {
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
  });

  it("accepts optional sensor-identity and interface-list dimensions", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          cpuTemperatureSensor: "coretemp",
          gpuTemperatureSensor: "amdgpu",
          cpuPowerSensor: "rapl",
          gpuPowerSensor: "amdgpu",
          uplinkInterfaces: ["eth0"],
          fabricInterfaces: ["wg0", "wg1"],
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.dimensions.cpuTemperatureSensor).toBe("coretemp");
    expect(result.sample.dimensions.uplinkInterfaces).toEqual(["eth0"]);
    expect(result.sample.dimensions.fabricInterfaces).toEqual(["wg0", "wg1"]);
  });

  it("rejects oversized sensor-identity strings", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          cpuTemperatureSensor: "x".repeat(MAX_DIMENSION_LEN + 1),
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects oversized interface lists and elements", () => {
    const tooMany = validateHostMetricsSample(
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
    expect(tooMany.ok).toBe(false);

    const oversizedEntry = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          fabricInterfaces: ["x".repeat(MAX_DIMENSION_LEN + 1)],
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(oversizedEntry.ok).toBe(false);

    const nonArray = validateHostMetricsSample(
      validRaw({
        dimensions: { ...BASE_DIMENSIONS, uplinkInterfaces: "eth0" },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(nonArray.ok).toBe(false);
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
        metrics: baseMetrics({
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
        metrics: baseMetrics({
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
    const result = validateHostMetricsSample(
      validRaw({
        metrics: baseMetrics({
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
    const result = validateHostMetricsSample(
      validRaw({
        metrics: baseMetrics({
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
        metrics: baseMetrics({
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
    const result = validateHostMetricsSample(
      validRaw({
        metrics: baseMetrics({
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
          ...baseMetrics({ cpuUserPercent: 10 }),
          unknownMetric: 999,
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      "metrics metrics.unknownMetric is not in the v2 metric allowlist",
    );
  });

  it("rejects retired v1 metric keys", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: {
          ...baseMetrics({ cpuUserPercent: 10 }),
          cpuUsagePercent: 42,
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      "metrics metrics.cpuUsagePercent is not in the v2 metric allowlist",
    );
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
    const metrics = baseMetrics({ cpuUserPercent: 10 });
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
    const metrics = baseMetrics();
    (metrics as Record<string, unknown>).cpuUserPercent = "12";
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

  it("rejects oversized dimension strings", () => {
    const result = validateHostMetricsSample(
      validRaw({
        dimensions: {
          ...BASE_DIMENSIONS,
          daemonVersion: "x".repeat(MAX_DIMENSION_LEN + 1),
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
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
