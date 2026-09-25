/**
 * Deploy-env gate: migrate URL must name the env Hyperdrive origin's
 * host/port/database. The Postgres role may differ.
 */
import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  assertMigrateTargetMatchesEnv,
  compareTarget,
  migrateTargetFromUrl,
  readHyperdriveIdForEnv,
} from "./check-deploy-env.mjs";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
const wranglerPath = join(repoRoot, "wrangler.jsonc");

const origin = {
  host: "db.example.com",
  port: 26571,
  database: "testing",
  user: "testing",
};

test("compareTarget ignores a different migrate role", () => {
  const target = {
    host: "db.example.com",
    port: 26571,
    database: "testing",
    user: "testing_migrate",
  };
  assertEquals(compareTarget(target, origin), []);
});

test("compareTarget reports host, port, and database mismatches", () => {
  const target = {
    host: "other.example.com",
    port: 5432,
    database: "dev",
    user: "testing_migrate",
  };
  assertEquals(compareTarget(target, origin), [
    "host other.example.com ≠ db.example.com",
    "port 5432 ≠ 26571",
    "database dev ≠ testing",
  ]);
});

test("migrateTargetFromUrl reads host, port, database, and user", () => {
  assertEquals(
    migrateTargetFromUrl(
      "postgresql://testing_migrate@db.example.com:26571/testing",
    ),
    {
      host: "db.example.com",
      port: 26571,
      database: "testing",
      user: "testing_migrate",
    },
  );
});

test("assertMigrateTargetMatchesEnv skips when CLOUDFLARE_ENV is unset", async () => {
  assertEquals(
    await assertMigrateTargetMatchesEnv({}),
    "CLOUDFLARE_ENV unset — environment check skipped",
  );
});

test("readHyperdriveIdForEnv reads env.testing's HYPERDRIVE binding", () => {
  const { id } = readHyperdriveIdForEnv("testing", wranglerPath);
  assertEquals(id, "3fcb0ba1b38143508e8fe60c3b45b3e6");
});
