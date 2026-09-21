/**
 * Guard: `schema-descriptions.ts` describes exactly the shipped schema, and
 * every description has already been carried into a `COMMENT ON` migration.
 *
 * The descriptions file feeds two generated surfaces — the Postgres
 * comments (`scripts/schema-comments.mjs`) and the website data dictionary
 * (`scripts/generate-data-dictionary.mjs`). Neither can tell a forgotten
 * column from a deliberately silent one, so this suite holds the file to
 * the latest drizzle snapshot: every table has a group and a summary, every
 * non-obvious column has a sentence, nothing describes a table or column
 * that no longer exists, and the sentence obeys the length / character
 * rules the generated surfaces depend on. The last test runs the pending
 * delta and fails when a description has no migration yet — the loop in
 * src/lib/db/AGENTS.md ("Schema descriptions") is how to clear it.
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  DATA_DICTIONARY_GROUPS,
  FORBIDDEN_DESCRIPTION_CHARS,
  isObviousColumn,
  MAX_DESCRIPTION_LENGTH,
  SCHEMA_DESCRIPTIONS,
  STANDARD_COLUMNS,
} from "./schema-descriptions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const repoRoot = join(here, "../../..");
const migrationsDir = join(repoRoot, "migrations");

type SnapshotColumn = {
  name: string;
  foreignKey: { table: string; column: string; onDelete: string } | undefined;
};
type SnapshotTable = { name: string; columns: SnapshotColumn[] };
type LatestSnapshot = { tag: string; tables: SnapshotTable[] };

async function latestSnapshot(): Promise<LatestSnapshot> {
  const mod = await import("../../../scripts/schema-snapshot.mjs");
  return mod.readLatestSnapshot(migrationsDir) as LatestSnapshot;
}

function describeFailures(failures: string[], hint: string): void {
  assertEquals(failures, [], `${hint}\n  - ${failures.join("\n  - ")}`);
}

test("every shipped table has a group and a one-sentence summary", async () => {
  const snapshot = await latestSnapshot();
  const failures: string[] = [];
  for (const table of snapshot.tables) {
    const description = SCHEMA_DESCRIPTIONS[table.name];
    if (!description) {
      failures.push(`${table.name}: missing entry`);
      continue;
    }
    if (!(description.group in DATA_DICTIONARY_GROUPS)) {
      failures.push(`${table.name}: unknown group "${description.group}"`);
    }
    if (!description.summary?.trim()) {
      failures.push(`${table.name}: empty summary`);
    }
  }
  describeFailures(
    failures,
    `tables in ${snapshot.tag} without a description:`,
  );
});

test("every non-obvious column of every shipped table is described", async () => {
  const snapshot = await latestSnapshot();
  const failures: string[] = [];
  for (const table of snapshot.tables) {
    const columns = SCHEMA_DESCRIPTIONS[table.name]?.columns ?? {};
    for (const column of table.columns) {
      const obvious = isObviousColumn(column.name, column.foreignKey?.table);
      if (!obvious && !columns[column.name]?.trim()) {
        failures.push(`${table.name}.${column.name}`);
      }
    }
  }
  describeFailures(
    failures,
    "columns that are neither standard nor a plain parent link and have no description:",
  );
});

test("nothing describes a table or column that is not in the shipped schema", async () => {
  const snapshot = await latestSnapshot();
  const byName = new Map(
    snapshot.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]),
  );
  const failures: string[] = [];
  for (const [tableName, description] of Object.entries(SCHEMA_DESCRIPTIONS)) {
    const columns = byName.get(tableName);
    if (!columns) {
      failures.push(
        `${tableName}: not in ${snapshot.tag} (dropped or renamed?)`,
      );
      continue;
    }
    for (const columnName of Object.keys(description.columns)) {
      if (!columns.has(columnName)) {
        failures.push(`${tableName}.${columnName}: no such column`);
      }
      if (columnName in STANDARD_COLUMNS) {
        failures.push(
          `${tableName}.${columnName}: standard column — described once in STANDARD_COLUMNS`,
        );
      }
    }
  }
  describeFailures(failures, "descriptions with no matching table/column:");
});

test("descriptions are single sentences that survive SQL, GFM tables and MDX", () => {
  const failures: string[] = [];
  const check = (where: string, text: string) => {
    if (text !== text.trim()) {
      failures.push(`${where}: leading/trailing whitespace`);
    }
    if (text.length > MAX_DESCRIPTION_LENGTH) {
      failures.push(
        `${where}: ${text.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
      );
    }
    const bad = FORBIDDEN_DESCRIPTION_CHARS.exec(text);
    if (bad) {
      failures.push(
        `${where}: contains forbidden character ${JSON.stringify(bad[0])}`,
      );
    }
    if (!/[.!?)`']$/.test(text)) {
      failures.push(`${where}: does not end a sentence`);
    }
  };
  for (const [tableName, description] of Object.entries(SCHEMA_DESCRIPTIONS)) {
    check(tableName, description.summary);
    for (const [columnName, text] of Object.entries(description.columns)) {
      check(`${tableName}.${columnName}`, text);
    }
  }
  for (const [name, text] of Object.entries(STANDARD_COLUMNS)) {
    check(`STANDARD_COLUMNS.${name}`, text);
  }
  for (const [name, group] of Object.entries(DATA_DICTIONARY_GROUPS)) {
    assert(group.title.trim().length > 0, `group ${name}: empty title`);
    assert(group.blurb.trim().length > 0, `group ${name}: empty blurb`);
  }
  describeFailures(failures, "descriptions breaking the writing rules:");
});

test("every description is already carried by a COMMENT ON migration", async () => {
  const mod = await import("../../../scripts/schema-comments.mjs");
  const pending = mod.pendingStatements({ migrationsDir }) as string[];
  assertEquals(
    pending,
    [],
    "descriptions with no migration yet — `pnpm drizzle-kit generate --custom --name <summary>`, " +
      "paste `node scripts/schema-comments.mjs` output into it, then " +
      "`node scripts/check-migration-freeze.mjs --update`",
  );
});
