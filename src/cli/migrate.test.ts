import { assertEquals, assertMatch } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  MIGRATION_LOCK_KEY_1,
  MIGRATION_LOCK_KEY_2,
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  MINIMUM_POSTGRES_MAJOR,
  runMigrateCommand,
} from "./migrate.ts";
import {
  describeSchemaState,
  readShippedMigrationHashes,
} from "../lib/db/schema-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));

test("the migrate subcommand uses the same lock key, table and schema as scripts/migrate-locked.mjs", async () => {
  const script = await Deno.readTextFile(
    join(ROOT, "scripts", "migrate-locked.mjs"),
  );
  const key1 = /const LOCK_KEY_1 = (0x[0-9a-fA-F]+)/.exec(script)?.[1];
  const key2 = /const LOCK_KEY_2 = (0x[0-9a-fA-F]+)/.exec(script)?.[1];
  assertEquals(Number(key1), MIGRATION_LOCK_KEY_1);
  assertEquals(Number(key2), MIGRATION_LOCK_KEY_2);
  assertMatch(script, new RegExp(`migrationsTable: '${MIGRATIONS_TABLE}'`));
  assertMatch(script, new RegExp(`migrationsSchema: '${MIGRATIONS_SCHEMA}'`));
  // drizzle.config.mjs is the other place the bookkeeping table is named.
  const config = await Deno.readTextFile(join(ROOT, "drizzle.config.mjs"));
  assertMatch(config, new RegExp(`table: '${MIGRATIONS_TABLE}'`));
  assertMatch(config, new RegExp(`schema: '${MIGRATIONS_SCHEMA}'`));
});

test("the migrate subcommand refuses the same Postgres versions as scripts/check-postgres-compat.mjs", async () => {
  const script = await Deno.readTextFile(
    join(ROOT, "scripts", "check-postgres-compat.mjs"),
  );
  assertEquals(
    Number(/const MINIMUM_POSTGRES_MAJOR = (\d+)/.exec(script)?.[1]),
    MINIMUM_POSTGRES_MAJOR,
  );
});

test("MIGRATIONS_FOLDER is the repo migrations directory, resolved from the module, not the cwd", async () => {
  assertEquals(MIGRATIONS_FOLDER, join(ROOT, "migrations"));
  const journal = JSON.parse(
    await Deno.readTextFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json")),
  );
  assertEquals(Array.isArray(journal.entries), true);
});

test("runMigrateCommand requires TURBOPANEL_DATABASE_URL and rejects a malformed one", async () => {
  const errors: string[] = [];
  const io = { log: () => {}, error: (line: string) => errors.push(line) };
  assertEquals(await runMigrateCommand({ env: {}, ...io }), 1);
  assertEquals(errors, ["TURBOPANEL_DATABASE_URL is required"]);
  assertEquals(
    await runMigrateCommand({
      env: { TURBOPANEL_DATABASE_URL: "mysql://x" },
      ...io,
    }),
    1,
  );
  assertEquals(errors[1], "invalid TURBOPANEL_DATABASE_URL");
});

test("runMigrateCommand reports an unreachable server as a refusal, not a crash", async () => {
  const errors: string[] = [];
  const code = await runMigrateCommand({
    env: { TURBOPANEL_DATABASE_URL: "postgres://tester@127.0.0.1:1/nope" },
    log: () => {},
    error: (line: string) => errors.push(line),
  });
  assertEquals(code, 1);
  assertMatch(errors[0] ?? "", /cannot reach the target PostgreSQL server/);
});

// The gates and the migrator against a real server: CI (build.yml) sets
// TURBOPANEL_DATABASE_URL and has already run `pnpm migrate`, so this is a
// second, no-op pass that still takes the lock and walks the journal; locally
// it skips without a URL, the same way the command-consumer suites do.
test("runMigrateCommand passes both gates and is a no-op on an already-migrated database", async () => {
  const url = Deno.env.get("TURBOPANEL_DATABASE_URL")?.trim();
  if (!url) {
    console.warn(
      "Skipping runMigrateCommand integration test: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runMigrateCommand({
    env: { TURBOPANEL_DATABASE_URL: url },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  assertEquals(errors, []);
  assertEquals(code, 0);
  assertMatch(logs[0] ?? "", /^PostgreSQL .* with uuidv7\(\) — ok$/);
  // The history check (src/lib/db/schema-state.ts) reports under the lock.
  // Derived from the manifest rather than written out: the count changes
  // with every migration added, and a literal here turns each addition into
  // an unrelated CI failure.
  const shipped = await readShippedMigrationHashes();
  assertEquals(logs.slice(1), [
    "waiting for the migration advisory lock…",
    describeSchemaState({
      status: "current",
      applied: shipped.length,
      shipped: shipped.length,
    }),
    "lock acquired, applying migrations…",
    "migrations applied successfully",
  ]);
});
