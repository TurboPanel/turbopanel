import { assertEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import { HOST_METRIC_KEYS } from "./contract.ts";
import {
  HOST_METRICS_METRIC_DESCRIPTORS,
  sanitizeMetricValue,
} from "./metric-descriptors.ts";

it("HOST_METRICS_METRIC_DESCRIPTORS covers every host metric key", () => {
  for (const key of HOST_METRIC_KEYS) {
    assertEquals(HOST_METRICS_METRIC_DESCRIPTORS[key].key, key);
  }
});

it("sanitizeMetricValue: null and non-finite values become null", () => {
  assertEquals(sanitizeMetricValue("cpuUsagePercent", null), null);
  assertEquals(sanitizeMetricValue("cpuUsagePercent", Number.NaN), null);
  assertEquals(sanitizeMetricValue("cpuUsagePercent", Number.POSITIVE_INFINITY), null);
});

it("sanitizeMetricValue: percent metrics clamp out-of-range values", () => {
  assertEquals(sanitizeMetricValue("cpuUsagePercent", -5), 0);
  assertEquals(sanitizeMetricValue("cpuUsagePercent", 150), 100);
  assertEquals(sanitizeMetricValue("cpuUsagePercent", 42.5), 42.5);
});

it("sanitizeMetricValue: load metrics null when out of range", () => {
  assertEquals(sanitizeMetricValue("load1", -0.1), null);
  assertEquals(sanitizeMetricValue("load1", 2_000_000), null);
  assertEquals(sanitizeMetricValue("load1", 1.25), 1.25);
});

it("sanitizeMetricValue: non-negative metrics reject unsafe integers when required", () => {
  assertEquals(sanitizeMetricValue("processCount", 1.5), null);
  assertEquals(sanitizeMetricValue("processCount", Number.MAX_SAFE_INTEGER + 1), null);
  assertEquals(sanitizeMetricValue("processCount", 42), 42);
  assertEquals(sanitizeMetricValue("uptimeSeconds", 3600), 3600);
});

it("sanitizeMetricValue: byte counters reject negative values", () => {
  assertEquals(sanitizeMetricValue("memoryUsedBytes", -1), null);
  assertEquals(sanitizeMetricValue("memoryUsedBytes", 1024), 1024);
});
