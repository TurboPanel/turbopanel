import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  computeSeriesGapCount,
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResult,
  parseRequestedMetrics,
  toHostSeriesChartResponse,
} from "./series-response.ts";
import type { HostSeriesResult } from "../types.ts";

it("defaultExpectedSamplesPerBucket: one sample per minute of bucket", () => {
  assertEquals(defaultExpectedSamplesPerBucket(60), 1);
  assertEquals(defaultExpectedSamplesPerBucket(300), 5);
  assertEquals(defaultExpectedSamplesPerBucket(3600), 60);
});

it("computeSeriesGapCount: counts fully missing buckets on half-open range", () => {
  const fromMs = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = Date.parse("2026-01-01T00:10:00.000Z");
  const gapCount = computeSeriesGapCount({
    fromMs,
    toMs,
    resolutionSeconds: 300,
    points: [{
      at: "2026-01-01T00:05:00.000Z",
      sampleCount: 5,
      expectedSampleCount: 5,
    }],
  });
  // Half-open [00:00, 00:10): buckets 00:00 and 00:05; only 00:05 has data.
  assertEquals(gapCount, 5);
});

it("computeSeriesGapCount: counts partial buckets", () => {
  const fromMs = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = Date.parse("2026-01-01T00:05:00.000Z");
  const gapCount = computeSeriesGapCount({
    fromMs,
    toMs,
    resolutionSeconds: 300,
    points: [{
      at: "2026-01-01T00:00:00.000Z",
      sampleCount: 2,
      expectedSampleCount: 5,
    }],
  });
  assertEquals(gapCount, 3);
});

it("computeSeriesGapCount: zero-width aligned range expects no buckets", () => {
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  const gapCount = computeSeriesGapCount({
    fromMs: at,
    toMs: at,
    resolutionSeconds: 300,
    points: [],
  });
  assertEquals(gapCount, 0);
});

it("computeSeriesGapCount: ignores the exclusive end bucket even if present", () => {
  const fromMs = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = Date.parse("2026-01-01T01:00:00.000Z");
  const points = [];
  for (let minute = 0; minute < 60; minute += 1) {
    const atMs = fromMs + minute * 60_000;
    points.push({
      at: new Date(atMs).toISOString(),
      sampleCount: 1,
      expectedSampleCount: 1,
    });
  }
  // In-progress end bucket at 01:00 must not inflate expected/gaps.
  points.push({
    at: "2026-01-01T01:00:00.000Z",
    sampleCount: 0,
    expectedSampleCount: 1,
  });
  const gapCount = computeSeriesGapCount({
    fromMs,
    toMs,
    resolutionSeconds: 60,
    points,
  });
  assertEquals(gapCount, 0);
});

it("computeSeriesGapCount: skips points with invalid at timestamps", () => {
  const fromMs = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = Date.parse("2026-01-01T00:05:00.000Z");
  const gapCount = computeSeriesGapCount({
    fromMs,
    toMs,
    resolutionSeconds: 300,
    points: [
      { at: "not-a-date", sampleCount: 5, expectedSampleCount: 5 },
      {
        at: "2026-01-01T00:00:00.000Z",
        sampleCount: 5,
        expectedSampleCount: 5,
      },
    ],
  });
  assertEquals(gapCount, 0);
});

it("computeSeriesGapCount: defaults expected samples from resolution", () => {
  const fromMs = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = Date.parse("2026-01-01T00:05:00.000Z");
  const gapCount = computeSeriesGapCount({
    fromMs,
    toMs,
    resolutionSeconds: 300,
    points: [{ at: "2026-01-01T00:00:00.000Z", sampleCount: 2 }],
  });
  assertEquals(gapCount, 3);
});

it("parseRequestedMetrics: empty or omitted returns all metrics", () => {
  const all = parseRequestedMetrics(undefined);
  assertEquals(all.ok, true);
  if (all.ok) {
    assertEquals(all.metrics.length, 20);
  }
  const blank = parseRequestedMetrics("   ");
  assertEquals(blank.ok, true);
});

it("parseRequestedMetrics: accepts a comma-separated subset", () => {
  const parsed = parseRequestedMetrics("cpuUsagePercent, load1 ");
  assertEquals(parsed.ok, true);
  if (parsed.ok) {
    assertEquals(parsed.metrics, ["cpuUsagePercent", "load1"]);
  }
});

it("parseRequestedMetrics: rejects unknown metric names", () => {
  const parsed = parseRequestedMetrics("cpuUsagePercent,notReal");
  assertEquals(parsed.ok, false);
  if (!parsed.ok) {
    assertEquals(parsed.error, "unknown metrics metric: notReal");
  }
});

it("finalizeHostSeriesResult: passthrough when unavailable or unbucketed", () => {
  const unavailable: HostSeriesResult = {
    kind: "disabled",
    available: false,
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    points: [],
    resolutionSeconds: null,
    gapCount: 0,
    sampleCount: 0,
  };
  assertEquals(
    finalizeHostSeriesResult("2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", unavailable),
    unavailable,
  );

  const noResolution: HostSeriesResult = {
    ...unavailable,
    available: true,
    resolutionSeconds: null,
  };
  assertEquals(
    finalizeHostSeriesResult("2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", noResolution),
    noResolution,
  );
});

it("finalizeHostSeriesResult: passthrough when range timestamps are invalid", () => {
  const result: HostSeriesResult = {
    kind: "analytics-engine",
    available: true,
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    points: [],
    resolutionSeconds: 300,
    gapCount: 0,
    sampleCount: 0,
  };
  const finalized = finalizeHostSeriesResult("not-a-date", "2026-01-01T01:00:00.000Z", result);
  assertEquals(finalized.gapCount, 0);
});

it("toHostSeriesChartResponse: maps series result into chart payload", () => {
  const result: HostSeriesResult = {
    kind: "clickhouse",
    available: true,
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    points: [{
      at: "2026-01-01T00:00:00.000Z",
      values: { cpuUsagePercent: 12.5 },
      sampleCount: 5,
      expectedSampleCount: 5,
    }],
    resolutionSeconds: 300,
    gapCount: 0,
    sampleCount: 5,
  };
  const chart = toHostSeriesChartResponse({
    serverId: result.serverId,
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T00:05:00.000Z",
    result,
  });
  assertEquals(chart.ok, true);
  assertEquals(chart.backend, "clickhouse");
  assertEquals(chart.points.length, 1);
  assertEquals(chart.points[0]?.values.cpuUsagePercent, 12.5);
  assertEquals(chart.points[0]?.expectedSampleCount, 5);
  assertEquals(chart.gapCount, 0);
});

it("finalizeHostSeriesResult: replaces store gapCount with grid count", () => {
  const result: HostSeriesResult = {
    kind: "analytics-engine",
    available: true,
    serverId: "11111111-1111-4111-8111-111111111111",
    metrics: ["cpuUsagePercent"],
    points: [],
    resolutionSeconds: 300,
    gapCount: 0,
    sampleCount: 0,
  };
  const finalized = finalizeHostSeriesResult(
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:10:00.000Z",
    result,
  );
  // Half-open [00:00, 00:10): two empty 5-minute buckets.
  assertEquals(finalized.gapCount, 10);
});
