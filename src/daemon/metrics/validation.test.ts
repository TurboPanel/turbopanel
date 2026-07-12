import { describe, expect, it } from "vitest";
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
  metricsPayloadByteLength,
  validateHostMetricsSample,
} from "./validation.ts";

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

describe("validateHostMetricsSample", () => {
  it("rejects wrong schema version", () => {
    const result = validateHostMetricsSample(
      validRaw({ version: 2 }),
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

  it("rejects interval outside bounds", () => {
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
          cpuUsagePercent: Number.NaN,
          load1: Number.POSITIVE_INFINITY,
          memoryUsedBytes: Number.NEGATIVE_INFINITY,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.cpuUsagePercent).toBeNull();
    expect(result.sample.metrics.load1).toBeNull();
    expect(result.sample.metrics.memoryUsedBytes).toBeNull();
  });

  it("clamps percentages to 0–100", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: baseMetrics({
          cpuUsagePercent: 150,
          memoryUsedPercent: -5,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.cpuUsagePercent).toBe(100);
    expect(result.sample.metrics.memoryUsedPercent).toBe(0);
  });

  it("coerces negative byte/count/uptime to null", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: baseMetrics({
          memoryUsedBytes: -1,
          processCount: -2,
          uptimeSeconds: -10,
          diskReadOpsPerSecond: -3,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.memoryUsedBytes).toBeNull();
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
          memoryUsedBytes: Number.MAX_SAFE_INTEGER + 1,
          diskReadBytesPerSecond: Number.MAX_SAFE_INTEGER + 100,
        }),
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.load1).toBeNull();
    expect(result.sample.metrics.memoryUsedBytes).toBeNull();
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

  it("drops unknown metric keys", () => {
    const result = validateHostMetricsSample(
      validRaw({
        metrics: {
          ...baseMetrics({ cpuUsagePercent: 10 }),
          unknownMetric: 999,
        },
      }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.metrics.cpuUsagePercent).toBe(10);
    expect("unknownMetric" in result.sample.metrics).toBe(false);
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
    const metrics = baseMetrics({ cpuUsagePercent: 10 });
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
    (metrics as Record<string, unknown>).cpuUsagePercent = "12";
    const result = validateHostMetricsSample(
      validRaw({ metrics }),
      { serverId: "srv-1", receivedAt: new Date().toISOString() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      "metrics metrics.cpuUsagePercent must be a number or null",
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
