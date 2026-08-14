import { assertEquals } from "jsr:@std/assert";
import { classifyDaemonCellSqlStorageOp } from "./sql-storage-classify.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("classifyDaemonCellSqlStorageOp treats SELECT / PRAGMA / EXPLAIN as reads", () => {
  assertEquals(classifyDaemonCellSqlStorageOp("SELECT 1"), "read");
  assertEquals(
    classifyDaemonCellSqlStorageOp("  select version FROM _cell_schema"),
    "read",
  );
  assertEquals(classifyDaemonCellSqlStorageOp("PRAGMA user_version"), "read");
  assertEquals(
    classifyDaemonCellSqlStorageOp("EXPLAIN QUERY PLAN SELECT 1"),
    "read",
  );
});

test("classifyDaemonCellSqlStorageOp treats DML and DDL as writes", () => {
  assertEquals(
    classifyDaemonCellSqlStorageOp("INSERT INTO cell (server_id) VALUES (?)"),
    "write",
  );
  assertEquals(
    classifyDaemonCellSqlStorageOp("UPDATE request SET status = ?"),
    "write",
  );
  assertEquals(
    classifyDaemonCellSqlStorageOp("DELETE FROM request WHERE request_id = ?"),
    "write",
  );
  assertEquals(
    classifyDaemonCellSqlStorageOp("REPLACE INTO lease VALUES (?, ?, ?)"),
    "write",
  );
  assertEquals(
    classifyDaemonCellSqlStorageOp("CREATE TABLE IF NOT EXISTS cell (id TEXT)"),
    "write",
  );
  assertEquals(
    classifyDaemonCellSqlStorageOp("ALTER TABLE cell ADD COLUMN x TEXT"),
    "write",
  );
  assertEquals(
    classifyDaemonCellSqlStorageOp("DROP TABLE IF EXISTS requests"),
    "write",
  );
});

test("classifyDaemonCellSqlStorageOp ignores non-billed statement prefixes", () => {
  assertEquals(classifyDaemonCellSqlStorageOp("BEGIN"), null);
  assertEquals(classifyDaemonCellSqlStorageOp("COMMIT"), null);
  assertEquals(classifyDaemonCellSqlStorageOp("ROLLBACK"), null);
  assertEquals(classifyDaemonCellSqlStorageOp(""), null);
  assertEquals(classifyDaemonCellSqlStorageOp("   "), null);
});
