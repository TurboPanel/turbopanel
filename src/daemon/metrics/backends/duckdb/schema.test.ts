import { assertEquals, assertThrows } from "@std/assert";
import { it } from "@std/testing/bdd";
import { HOST_METRIC_KEYS, type HostMetricKey } from "../../contract.ts";
import {
  buildSchemaStatements,
  HOST_METRICS_TABLE,
  hostMetricsInsertColumns,
  metricColumnName,
  STATUS_EVENTS_TABLE,
} from "./schema.ts";

it("metricColumnName maps v2 keys to snake_case identifiers", () => {
  assertEquals(metricColumnName("cpuUserPercent"), "cpu_user_percent");
  assertEquals(metricColumnName("memoryTotalBytes"), "memory_total_bytes");
  assertEquals(metricColumnName("load1"), "load1");
  assertEquals(metricColumnName("load15"), "load15");
  assertEquals(
    metricColumnName("uplinkReceiveBytesPerSecond"),
    "uplink_receive_bytes_per_second",
  );
  assertThrows(
    () => metricColumnName("nope" as HostMetricKey),
    TypeError,
    "unknown host metrics metric",
  );
});

it("metric column names are unique valid identifiers for all 38 keys", () => {
  const columns = HOST_METRIC_KEYS.map((key) => metricColumnName(key));
  assertEquals(new Set(columns).size, HOST_METRIC_KEYS.length);
  for (const column of columns) {
    assertEquals(/^[a-z][a-z0-9_]*$/.test(column), true, column);
  }
});

it("hostMetricsInsertColumns lists base columns then all metric columns", () => {
  const columns = hostMetricsInsertColumns();
  assertEquals(columns.length, 5 + HOST_METRIC_KEYS.length);
  assertEquals(columns.slice(0, 5), [
    "server_id",
    "sampled_at",
    "received_at",
    "interval_seconds",
    "collection_mode",
  ]);
  assertEquals(columns.includes("cpu_user_percent"), true);
});

it("buildSchemaStatements emits idempotent DDL for both typed tables", () => {
  const statements = buildSchemaStatements();
  const joined = statements.join("\n");
  assertEquals(
    statements.every((sql) =>
      sql.startsWith("CREATE TABLE IF NOT EXISTS") ||
      sql.startsWith("CREATE INDEX IF NOT EXISTS")
    ),
    true,
  );
  assertEquals(joined.includes(`CREATE TABLE IF NOT EXISTS ${HOST_METRICS_TABLE}`), true);
  assertEquals(joined.includes(`CREATE TABLE IF NOT EXISTS ${STATUS_EVENTS_TABLE}`), true);
  // Range-scan indexes for (server_id, <time>).
  assertEquals(joined.includes(`ON ${HOST_METRICS_TABLE} (server_id, sampled_at)`), true);
  assertEquals(joined.includes(`ON ${STATUS_EVENTS_TABLE} (server_id, "at")`), true);
  // Every metric key gets a nullable DOUBLE column; no positional AE slots.
  for (const key of HOST_METRIC_KEYS) {
    assertEquals(joined.includes(`${metricColumnName(key)} DOUBLE`), true, key);
  }
  assertEquals(/\bdouble\d+\b/.test(joined), false);
  assertEquals(/\bblob\d+\b/.test(joined), false);
  assertEquals(joined.includes("index1"), false);
});
