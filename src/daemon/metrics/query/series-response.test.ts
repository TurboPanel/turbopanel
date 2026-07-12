import { assertEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  computeSeriesGapCount,
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResult,
} from "./series-response.ts";
import type { HostSeriesResult } from "../types.ts";

it("defaultExpectedSamplesPerBucket: one sample per minute of bucket", () => {
  assertEquals(defaultExpectedSamplesPerBucket(60), 1);
  assertEquals(defaultExpectedSamplesPerBucket(300), 5);
  assertEquals(defaultExpectedSamplesPerBucket(3600), 60);
});

it("computeSeriesGapCount: counts fully missing buckets", () => {
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
  // Three buckets (00:00, 00:05, 00:10); only 00:05 has data.
  assertEquals(gapCount, 10);
});

it("computeSeriesGapCount: counts partial buckets", () => {
  const fromMs = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = Date.parse("2026-01-01T00:00:00.000Z");
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
  assertEquals(finalized.gapCount, 15);
});
