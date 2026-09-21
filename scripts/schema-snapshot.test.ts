/**
 * `scripts/schema-snapshot.mjs` — the latest-snapshot reader both schema
 * description generators depend on. Proven against a fixture migrations
 * directory (`schema-fixture.test-helper.ts`): it picks the newest journal
 * entry, keeps column order, resolves single-column foreign keys with a
 * defaulted on-delete, folds composite primary keys into the per-column
 * flag, and flattens uniques, indexes and checks.
 */
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { readJournal, readLatestSnapshot } from "./schema-snapshot.mjs";
import {
  FIXTURE_SERVER_COLUMNS,
  writeFixtureMigrations,
} from "./schema-fixture.test-helper.ts";

describe("schema-snapshot", () => {
  it("reads the journal in order", async () => {
    const dir = await writeFixtureMigrations();
    try {
      assertEquals(
        readJournal(dir).map((e: { tag: string }) => e.tag),
        ["0000_init", "0001_amend"],
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("resolves the newest journal entry's snapshot, not the first", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const snapshot = readLatestSnapshot(dir);
      assertEquals(snapshot.tag, "0001_amend");
      assertEquals(snapshot.idx, 1);
      assertEquals(snapshot.id, "11111111-1111-1111-1111-111111111111");
      assertEquals(
        snapshot.tables.map((t: { name: string }) => t.name),
        ["server", "zz_fixture"],
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("keeps snapshot column order and carries type, null, default and primary key", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const server = readLatestSnapshot(dir).tables[0];
      assertEquals(
        server.columns.map((c: { name: string }) => c.name),
        FIXTURE_SERVER_COLUMNS.map((c) => c.name),
      );
      const id = server.columns[0];
      assertEquals(id, {
        name: "id",
        type: "uuid",
        notNull: true,
        primaryKey: true,
        default: "uuidv7()",
        foreignKey: undefined,
      });
      const machineClass = server.columns[4];
      assertEquals(machineClass.notNull, false);
      assertEquals(machineClass.default, undefined);
      assertEquals(server.primaryKey, ["id"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("maps single-column foreign keys and defaults a missing on-delete to no action", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const [server, fixture] = readLatestSnapshot(dir).tables;
      const byName = (t: { columns: { name: string }[] }, n: string) =>
        t.columns.find((c) => c.name === n) as {
          foreignKey?: { table: string; column: string; onDelete: string };
        };
      assertEquals(byName(server, "organization_id").foreignKey, {
        table: "organization",
        column: "id",
        onDelete: "restrict",
      });
      assertEquals(byName(server, "assigned_tier_id").foreignKey, {
        table: "tier",
        column: "id",
        onDelete: "set null",
      });
      assertEquals(byName(server, "machine_class").foreignKey, undefined);
      // single-column FK with no onDelete in the snapshot
      assertEquals(byName(fixture, "command_id").foreignKey, {
        table: "command",
        column: "id",
        onDelete: "no action",
      });
      // the composite FK never lands on a column
      assertEquals(byName(fixture, "seq").foreignKey, undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("folds a composite primary key into the per-column flag", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const fixture = readLatestSnapshot(dir).tables[1];
      assertEquals(fixture.primaryKey, ["command_id", "seq"]);
      assertEquals(
        fixture.columns.map((c: { primaryKey: boolean }) => c.primaryKey),
        [true, true, false],
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("flattens uniques, indexes (with their where clause) and checks", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const [server, fixture] = readLatestSnapshot(dir).tables;
      assertEquals(server.indexes, [
        {
          name: "idx_server_connected",
          columns: ["id"],
          isUnique: false,
          where: '"server"."is_connected"',
        },
      ]);
      assertEquals(server.checks, [
        {
          name: "server_machine_class_check",
          value: `"server"."machine_class" IN ('physical', 'virtual')`,
        },
      ]);
      assertEquals(server.uniques, []);
      assertEquals(fixture.uniques, [
        { name: "uniq_zz_fixture_note", columns: ["note"] },
      ]);
      assertEquals(fixture.indexes, []);
      assertEquals(fixture.checks, []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reads the repo's own latest snapshot by default", () => {
    const snapshot = readLatestSnapshot();
    assertEquals(snapshot.tables.length > 0, true);
    assertEquals(
      snapshot.tables.every((t: { primaryKey: string[] }) =>
        t.primaryKey.length > 0
      ),
      true,
      "every shipped table has a primary key",
    );
  });
});
