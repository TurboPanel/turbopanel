import { assertEquals } from "@std/assert";
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

it("every descriptor declares unit, aggregation, and family", () => {
  for (const key of HOST_METRIC_KEYS) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    assertEquals(typeof descriptor.unit, "string");
    assertEquals(typeof descriptor.aggregation, "string");
    assertEquals(typeof descriptor.family, "string");
  }
});

it("storage-capacity keys aggregate as last; uptime as max", () => {
  const capacityKeys = [
    "systemStorageTotalBytes",
    "systemStorageAvailableBytes",
    "hostingStorageTotalBytes",
    "hostingStorageAvailableBytes",
    "dockerStorageTotalBytes",
    "dockerStorageAvailableBytes",
  ] as const;
  for (const key of capacityKeys) {
    assertEquals(HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation, "last");
    assertEquals(HOST_METRICS_METRIC_DESCRIPTORS[key].unit, "bytes");
    assertEquals(HOST_METRICS_METRIC_DESCRIPTORS[key].family, "storage");
  }
  assertEquals(
    HOST_METRICS_METRIC_DESCRIPTORS.uptimeSeconds.aggregation,
    "max",
  );
  assertEquals(
    HOST_METRICS_METRIC_DESCRIPTORS.processCount.aggregation,
    "weighted-average",
  );
});

it("temperature descriptors allow negative values and never clamp", () => {
  for (
    const key of ["cpuTemperatureCelsius", "gpuTemperatureCelsius"] as const
  ) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    assertEquals(descriptor.min < 0, true);
    assertEquals(descriptor.sanitize, "null");
    assertEquals(descriptor.unit, "celsius");
    assertEquals(descriptor.family, "hardware");
  }
  assertEquals(sanitizeMetricValue("cpuTemperatureCelsius", -15), -15);
  assertEquals(sanitizeMetricValue("cpuTemperatureCelsius", -150), null);
  assertEquals(sanitizeMetricValue("cpuTemperatureCelsius", 250), null);
});

it("power descriptors are non-negative watts", () => {
  for (const key of ["cpuPowerWatts", "gpuPowerWatts"] as const) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    assertEquals(descriptor.min, 0);
    assertEquals(descriptor.sanitize, "null");
    assertEquals(descriptor.unit, "watts");
  }
  assertEquals(sanitizeMetricValue("cpuPowerWatts", -1), null);
  assertEquals(sanitizeMetricValue("cpuPowerWatts", 65), 65);
});

it("sanitizeMetricValue: null and non-finite values become null", () => {
  assertEquals(sanitizeMetricValue("cpuUserPercent", null), null);
  assertEquals(sanitizeMetricValue("cpuUserPercent", Number.NaN), null);
  assertEquals(
    sanitizeMetricValue("cpuUserPercent", Number.POSITIVE_INFINITY),
    null,
  );
});

it("sanitizeMetricValue: percent metrics clamp out-of-range values", () => {
  assertEquals(sanitizeMetricValue("cpuUserPercent", -5), 0);
  assertEquals(sanitizeMetricValue("cpuUserPercent", 150), 100);
  assertEquals(sanitizeMetricValue("cpuUserPercent", 42.5), 42.5);
});

it("sanitizeMetricValue: load metrics null when out of range", () => {
  assertEquals(sanitizeMetricValue("load1", -0.1), null);
  assertEquals(sanitizeMetricValue("load1", 2_000_000), null);
  assertEquals(sanitizeMetricValue("load1", 1.25), 1.25);
});

it("sanitizeMetricValue: non-negative metrics reject unsafe integers when required", () => {
  assertEquals(sanitizeMetricValue("processCount", 1.5), null);
  assertEquals(
    sanitizeMetricValue("processCount", Number.MAX_SAFE_INTEGER + 1),
    null,
  );
  assertEquals(sanitizeMetricValue("processCount", 42), 42);
  assertEquals(sanitizeMetricValue("uptimeSeconds", 3600), 3600);
});

it("sanitizeMetricValue: byte counters reject negative values", () => {
  assertEquals(sanitizeMetricValue("memoryTotalBytes", -1), null);
  assertEquals(sanitizeMetricValue("memoryTotalBytes", 1024), 1024);
});

it("sanitizeMetricValue: latency metrics reject negative values", () => {
  assertEquals(sanitizeMetricValue("diskReadLatencyMs", -1), null);
  assertEquals(sanitizeMetricValue("diskReadLatencyMs", 4.2), 4.2);
});
