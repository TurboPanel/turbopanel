import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  computeDerivedHostValues,
  computePowerHeadroom,
  computeThermalHeadroom,
} from "./derived-metrics.ts";

it("computeDerivedHostValues: cpuUsagePercent is 100 minus idle", () => {
  assertEquals(
    computeDerivedHostValues({ cpuIdlePercent: 72 }).cpuUsagePercent,
    28,
  );
});

it("computeDerivedHostValues: cpuUsagePercent is null when idle is missing", () => {
  assertEquals(computeDerivedHostValues({}).cpuUsagePercent, null);
});

it("computeDerivedHostValues: memory used bytes/percent", () => {
  const result = computeDerivedHostValues({
    memoryTotalBytes: 1000,
    memoryAvailableBytes: 250,
  });
  assertEquals(result.memoryUsedBytes, 750);
  assertEquals(result.memoryUsedPercent, 75);
});

it("computeDerivedHostValues: memory used is null when either input is missing", () => {
  assertEquals(
    computeDerivedHostValues({ memoryTotalBytes: 1000 }).memoryUsedBytes,
    null,
  );
  assertEquals(
    computeDerivedHostValues({ memoryAvailableBytes: 250 }).memoryUsedBytes,
    null,
  );
  assertEquals(
    computeDerivedHostValues({ memoryTotalBytes: 1000 }).memoryUsedPercent,
    null,
  );
});

it("computeDerivedHostValues: memory used percent is null when total is zero", () => {
  assertEquals(
    computeDerivedHostValues({
      memoryTotalBytes: 0,
      memoryAvailableBytes: 0,
    }).memoryUsedPercent,
    null,
  );
});

it("computeDerivedHostValues: swap used bytes/percent", () => {
  const result = computeDerivedHostValues({
    swapTotalBytes: 500,
    swapFreeBytes: 100,
  });
  assertEquals(result.swapUsedBytes, 400);
  assertEquals(result.swapUsedPercent, 80);
});

it("computeDerivedHostValues: storage used bytes/percent for system/hosting/docker", () => {
  const result = computeDerivedHostValues({
    systemStorageTotalBytes: 100,
    systemStorageAvailableBytes: 40,
    hostingStorageTotalBytes: 200,
    hostingStorageAvailableBytes: 50,
    dockerStorageTotalBytes: 300,
    dockerStorageAvailableBytes: 300,
  });
  assertEquals(result.systemStorageUsedBytes, 60);
  assertEquals(result.systemStorageUsedPercent, 60);
  assertEquals(result.hostingStorageUsedBytes, 150);
  assertEquals(result.hostingStorageUsedPercent, 75);
  assertEquals(result.dockerStorageUsedBytes, 0);
  assertEquals(result.dockerStorageUsedPercent, 0);
});

it("computeDerivedHostValues: storage used is null when its part was never collected", () => {
  const result = computeDerivedHostValues({});
  assertEquals(result.systemStorageUsedBytes, null);
  assertEquals(result.hostingStorageUsedBytes, null);
  assertEquals(result.dockerStorageUsedBytes, null);
});

it("computeDerivedHostValues: httpErrorRatePercent combines 4xx and 5xx over total requests", () => {
  assertEquals(
    computeDerivedHostValues({
      caddyRequestsTotal: 200,
      caddyResponses4xxTotal: 10,
      caddyResponses5xxTotal: 6,
    }).httpErrorRatePercent,
    8,
  );
});

it("computeDerivedHostValues: httpErrorRatePercent is null when requestsTotal is zero or missing", () => {
  assertEquals(
    computeDerivedHostValues({
      caddyRequestsTotal: 0,
      caddyResponses4xxTotal: 0,
      caddyResponses5xxTotal: 0,
    }).httpErrorRatePercent,
    null,
  );
  assertEquals(
    computeDerivedHostValues({
      caddyResponses4xxTotal: 0,
      caddyResponses5xxTotal: 0,
    }).httpErrorRatePercent,
    null,
  );
});

it("computeDerivedHostValues: httpAverageLatencyMs converts seconds-sum over requests to ms", () => {
  assertEquals(
    computeDerivedHostValues({
      caddyRequestsTotal: 100,
      caddyRequestDurationSecondsSum: 5,
    }).httpAverageLatencyMs,
    50,
  );
});

it("computeDerivedHostValues: httpAverageLatencyMs is null when requestsTotal is zero or missing", () => {
  assertEquals(
    computeDerivedHostValues({
      caddyRequestsTotal: 0,
      caddyRequestDurationSecondsSum: 5,
    }).httpAverageLatencyMs,
    null,
  );
  assertEquals(
    computeDerivedHostValues({
      caddyRequestDurationSecondsSum: 5,
    }).httpAverageLatencyMs,
    null,
  );
});

it("computeThermalHeadroom: positive headroom below the limit", () => {
  assertEquals(
    computeThermalHeadroom({ valueCelsius: 70, limitCelsius: 100 }),
    30,
  );
});

it("computeThermalHeadroom: negative headroom above the limit", () => {
  assertEquals(
    computeThermalHeadroom({ valueCelsius: 110, limitCelsius: 100 }),
    -10,
  );
});

it("computeThermalHeadroom: null when either input is null or the limit is non-positive", () => {
  assertEquals(
    computeThermalHeadroom({ valueCelsius: null, limitCelsius: 100 }),
    null,
  );
  assertEquals(
    computeThermalHeadroom({ valueCelsius: 70, limitCelsius: null }),
    null,
  );
  assertEquals(
    computeThermalHeadroom({ valueCelsius: 70, limitCelsius: 0 }),
    null,
  );
});

it("computePowerHeadroom: mirrors computeThermalHeadroom for watts vs TDP", () => {
  assertEquals(
    computePowerHeadroom({ valueWatts: 150, limitWatts: 200 }),
    25,
  );
  assertEquals(
    computePowerHeadroom({ valueWatts: null, limitWatts: 200 }),
    null,
  );
  assertEquals(
    computePowerHeadroom({ valueWatts: 150, limitWatts: -1 }),
    null,
  );
});
