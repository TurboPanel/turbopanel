import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { HOST_METRIC_KEYS, METRIC_KEY_PARTS, METRIC_PARTS } from "./contract.ts";
import {
  HOST_METRICS_METRIC_DESCRIPTORS,
  MAX_METRICS_PER_PART,
  sanitizeMetricValue,
} from "./metric-descriptors.ts";

it("HOST_METRICS_METRIC_DESCRIPTORS covers every host metric key", () => {
  for (const key of HOST_METRIC_KEYS) {
    assertEquals(HOST_METRICS_METRIC_DESCRIPTORS[key].key, key);
  }
});

it("every descriptor declares unit, aggregation, family, and a valid part", () => {
  for (const key of HOST_METRIC_KEYS) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    assertEquals(typeof descriptor.unit, "string");
    assertEquals(typeof descriptor.aggregation, "string");
    assertEquals(typeof descriptor.family, "string");
    assertEquals((METRIC_PARTS as readonly string[]).includes(descriptor.part), true);
  }
});

it("descriptor parts exactly partition HOST_METRIC_KEYS with no gaps or overlaps", () => {
  const countByPart = new Map<string, number>();
  for (const key of HOST_METRIC_KEYS) {
    const part = HOST_METRICS_METRIC_DESCRIPTORS[key].part;
    countByPart.set(part, (countByPart.get(part) ?? 0) + 1);
  }
  assertEquals(new Set(countByPart.keys()), new Set(METRIC_PARTS));
  for (const part of METRIC_PARTS) {
    const count = countByPart.get(part) ?? 0;
    assertEquals(count > 0, true, `part ${part} has no members`);
    assertEquals(
      count <= MAX_METRICS_PER_PART,
      true,
      `part ${part} has ${count} keys, exceeding ${MAX_METRICS_PER_PART}`,
    );
  }
  const total = [...countByPart.values()].reduce((sum, n) => sum + n, 0);
  assertEquals(total, HOST_METRIC_KEYS.length);
});

it("descriptor parts match contract.ts METRIC_KEY_PARTS for every key", () => {
  for (const key of HOST_METRIC_KEYS) {
    assertEquals(
      HOST_METRICS_METRIC_DESCRIPTORS[key].part,
      METRIC_KEY_PARTS[key],
      `part mismatch for ${key}`,
    );
  }
});

it("accepts the sum aggregation and rpm unit added for v3 traffic/fan metrics", () => {
  assertEquals(HOST_METRICS_METRIC_DESCRIPTORS.caddyRequestsTotal.aggregation, "sum");
  assertEquals(HOST_METRICS_METRIC_DESCRIPTORS.cpuFanRpm.unit, "rpm");
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
    const key of [
      "cpuTemperatureCelsius",
      "gpuTemperatureCelsius",
      "disk1TemperatureCelsius",
      "disk2TemperatureCelsius",
      "ambient1TemperatureCelsius",
      "ambient2TemperatureCelsius",
      "boardTemperatureCelsius",
    ] as const
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

it("fan descriptors are non-negative rpm", () => {
  for (
    const key of [
      "gpuFanRpm",
      "cpuFanRpm",
      "systemFan1Rpm",
      "systemFan2Rpm",
    ] as const
  ) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    assertEquals(descriptor.min, 0);
    assertEquals(descriptor.unit, "rpm");
    assertEquals(descriptor.part, "sensors");
  }
  assertEquals(sanitizeMetricValue("cpuFanRpm", -1), null);
  assertEquals(sanitizeMetricValue("cpuFanRpm", 1800), 1800);
});

it("gpuUtilizationPercent is hardware-family percent, not cpu-family", () => {
  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS.gpuUtilizationPercent;
  assertEquals(descriptor.unit, "percent");
  assertEquals(descriptor.family, "hardware");
  assertEquals(descriptor.part, "sensors");
  assertEquals(sanitizeMetricValue("gpuUtilizationPercent", 150), 100);
  assertEquals(sanitizeMetricValue("gpuUtilizationPercent", -5), 0);
});

it("nic slot rates are sensors-part network rates", () => {
  for (
    const key of [
      "nic1ReceiveBytesPerSecond",
      "nic1TransmitBytesPerSecond",
      "nic2ReceiveBytesPerSecond",
      "nic2TransmitBytesPerSecond",
    ] as const
  ) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    assertEquals(descriptor.unit, "bytesPerSecond");
    assertEquals(descriptor.family, "network");
    assertEquals(descriptor.part, "sensors");
  }
});

it("caddy traffic counters sum, gauges weighted-average", () => {
  const counters = [
    "caddyRequestsTotal",
    "caddyResponses2xxTotal",
    "caddyResponses3xxTotal",
    "caddyResponses4xxTotal",
    "caddyResponses5xxTotal",
    "caddyRequestBytesTotal",
    "caddyResponseBytesTotal",
    "caddyRequestDurationSecondsSum",
    "caddyRequestsUnder100msTotal",
    "caddyRequestsUnder1sTotal",
  ] as const;
  for (const key of counters) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[key];
    assertEquals(descriptor.aggregation, "sum");
    assertEquals(descriptor.family, "traffic");
    assertEquals(descriptor.part, "traffic");
  }
  assertEquals(
    HOST_METRICS_METRIC_DESCRIPTORS.caddyRequestsInFlight.aggregation,
    "weighted-average",
  );
});

it("proxysql counters sum, gauges weighted-average", () => {
  for (
    const key of [
      "proxysqlQueriesTotal",
      "proxysqlSlowQueriesTotal",
      "proxysqlConnectionErrorsTotal",
    ] as const
  ) {
    assertEquals(HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation, "sum");
  }
  for (
    const key of [
      "proxysqlClientConnections",
      "proxysqlBackendConnections",
      "proxysqlBackendsUp",
    ] as const
  ) {
    assertEquals(
      HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation,
      "weighted-average",
    );
  }
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
