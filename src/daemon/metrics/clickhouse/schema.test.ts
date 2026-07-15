import { assertEquals, assertThrows } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import { AE_DATASET_NAME } from "../analytics-engine/field-map.ts";
import {
  buildSchemaStatements,
  DEFAULT_RAW_RETENTION_DAYS,
  HOST_METRICS_TABLE,
  MIN_BYTES_FOR_WIDE_PART,
  MIN_ROWS_FOR_WIDE_PART,
} from "./schema.ts";

it("HOST_METRICS_TABLE matches the Analytics Engine dataset name", () => {
  assertEquals(HOST_METRICS_TABLE, AE_DATASET_NAME);
});

it("buildSchemaStatements creates only the shared AE-named metrics table", () => {
  const statements = buildSchemaStatements({
    retentionDays: DEFAULT_RAW_RETENTION_DAYS,
  });
  assertEquals(statements.length, 3);
  const ddl = statements[0]!;
  assertEquals(
    ddl.includes(`CREATE TABLE IF NOT EXISTS ${HOST_METRICS_TABLE}`),
    true,
  );
  assertEquals(HOST_METRICS_TABLE, "turbopanel_server_metrics");
  assertEquals(ddl.includes("host_metrics_raw"), false);
  assertEquals(ddl.includes("host_metrics_rollup"), false);
  assertEquals(ddl.includes("host_metrics_mv"), false);
});

it("buildSchemaStatements embeds configured retentionDays in TTL", () => {
  const statements = buildSchemaStatements({ retentionDays: 42 });
  const ddl = statements[0]!;
  assertEquals(ddl.includes("TTL timestamp + INTERVAL 42 DAY DELETE"), true);
  assertEquals(
    statements.some((sql) =>
      sql.includes("MODIFY TTL timestamp + INTERVAL 42 DAY DELETE")
    ),
    true,
  );
});

it("buildSchemaStatements sets compact-part thresholds on create and alter", () => {
  const statements = buildSchemaStatements({
    retentionDays: DEFAULT_RAW_RETENTION_DAYS,
  });
  const ddl = statements[0]!;
  assertEquals(
    ddl.includes(`min_bytes_for_wide_part = ${MIN_BYTES_FOR_WIDE_PART}`),
    true,
  );
  assertEquals(
    ddl.includes(`min_rows_for_wide_part = ${MIN_ROWS_FOR_WIDE_PART}`),
    true,
  );
  assertEquals(
    statements.some((sql) =>
      sql.includes(
        `MODIFY SETTING min_bytes_for_wide_part = ${MIN_BYTES_FOR_WIDE_PART}, min_rows_for_wide_part = ${MIN_ROWS_FOR_WIDE_PART}`,
      )
    ),
    true,
  );
});

it("buildSchemaStatements uses positional Float64 metric columns (AE parity)", () => {
  const statements = buildSchemaStatements({
    retentionDays: DEFAULT_RAW_RETENTION_DAYS,
  });
  const ddl = statements[0]!;
  assertEquals(ddl.includes("double1 Float64"), true);
  assertEquals(ddl.includes("double5 Float64"), true);
  assertEquals(ddl.includes("double13 Float64"), true);
  assertEquals(ddl.includes("double20 Float64"), true);
  assertEquals(ddl.includes("Nullable"), false);
  assertEquals(ddl.includes("index1 UUID"), true);
  assertEquals(ddl.includes("timestamp DateTime64(3, 'UTC')"), true);
  assertEquals(ddl.includes("blob1 LowCardinality(String)"), true);
  assertEquals(ddl.includes("ORDER BY (index1, timestamp)"), true);
  assertEquals(ddl.includes("server_id"), false);
  assertEquals(ddl.includes("received_at"), false);
  assertEquals(ddl.includes("interval_seconds"), false);
  assertEquals(ddl.includes("cpu_usage_percent"), false);
});

it("buildSchemaStatements rejects non-positive retentionDays", () => {
  assertThrows(
    () => buildSchemaStatements({ retentionDays: 0 }),
    TypeError,
    "retentionDays",
  );
});
