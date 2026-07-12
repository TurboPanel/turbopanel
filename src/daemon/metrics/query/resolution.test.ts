import { assertEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  bucketFloor,
  canonicalizeMetricsRange,
  MAX_METRICS_POINTS,
  MAX_METRICS_RANGE_SECONDS,
  parseMaxPoints,
  selectResolutionSeconds,
  validateMetricsRange,
} from "./resolution.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

it("selectResolutionSeconds: ladder mapping", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  assertEquals(
    selectResolutionSeconds({ fromMs: base, toMs: base + HOUR_MS }),
    60,
  );
  assertEquals(
    selectResolutionSeconds({ fromMs: base, toMs: base + 6 * HOUR_MS }),
    60,
  );
  assertEquals(
    selectResolutionSeconds({ fromMs: base, toMs: base + 24 * HOUR_MS }),
    300,
  );
  assertEquals(
    selectResolutionSeconds({ fromMs: base, toMs: base + 7 * DAY_MS }),
    3600,
  );
  assertEquals(
    selectResolutionSeconds({ fromMs: base, toMs: base + 30 * DAY_MS }),
    3600,
  );
  assertEquals(
    selectResolutionSeconds({ fromMs: base, toMs: base + 90 * DAY_MS }),
    86400,
  );
});

it("selectResolutionSeconds: honors requested resolution", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs: base + HOUR_MS,
      requested: 3600,
    }),
    3600,
  );
});

it("selectResolutionSeconds: clamps up for max points", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = base + 90 * DAY_MS;
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs,
      requested: 60,
      maxPoints: 100,
    }),
    86400,
  );
});

it("selectResolutionSeconds: oversized maxPoints cannot bypass server cap", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const toMs = base + 90 * DAY_MS;
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs,
      requested: 60,
      maxPoints: 200_000,
    }),
    86400,
  );
});

it("parseMaxPoints: rejects values above MAX_METRICS_POINTS", () => {
  const parsed = parseMaxPoints(String(MAX_METRICS_POINTS + 1));
  assertEquals(parsed.ok, false);
  if (!parsed.ok) {
    assertEquals(parsed.message.includes(String(MAX_METRICS_POINTS)), true);
  }
  assertEquals(parseMaxPoints("100").ok, true);
  if (parseMaxPoints("100").ok) {
    assertEquals(parseMaxPoints("100").value, 100);
  }
});

it("canonicalizeMetricsRange: bucket-aligns from and to", () => {
  const fromMs = Date.parse("2026-01-01T00:07:30.000Z");
  const toMs = Date.parse("2026-01-01T00:12:45.000Z");
  const range = canonicalizeMetricsRange(fromMs, toMs, 300);
  assertEquals(range.fromMs, Date.parse("2026-01-01T00:05:00.000Z"));
  assertEquals(range.toMs, Date.parse("2026-01-01T00:10:00.000Z"));
  assertEquals(range.fromIso, "2026-01-01T00:05:00.000Z");
  assertEquals(range.toIso, "2026-01-01T00:10:00.000Z");
});

it("validateMetricsRange: rejects invalid and oversized ranges", () => {
  assertEquals(
    validateMetricsRange(Number.NaN, 1),
    {
      ok: false,
      code: "invalid_range",
      message: "from and to must be valid timestamps",
    },
  );
  assertEquals(
    validateMetricsRange(2, 1),
    {
      ok: false,
      code: "invalid_range",
      message: "from must be before or equal to to",
    },
  );
  const fromMs = 0;
  const toMs = (MAX_METRICS_RANGE_SECONDS + 1) * 1000;
  const tooLarge = validateMetricsRange(fromMs, toMs);
  assertEquals(tooLarge.ok, false);
  if (!tooLarge.ok) {
    assertEquals(tooLarge.code, "range_too_large");
  }
});

it("bucketFloor: aligns to resolution boundary", () => {
  const ms = Date.parse("2026-01-01T00:07:30.000Z");
  assertEquals(
    bucketFloor(ms, 300),
    Date.parse("2026-01-01T00:05:00.000Z"),
  );
});
