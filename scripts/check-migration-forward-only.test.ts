/**
 * Forward-only migration guard: additive SQL passes; drops, renames, retypes
 * and NOT NULL tightening fail unless the file carries a breaking-ok reason.
 */
import { assertEquals } from "@std/assert";
import { findBreakingStatements } from "./check-migration-forward-only.mjs";

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno);

test("additive migration passes", () => {
  const sql = 'CREATE TABLE "x" ("id" uuid);--> statement-breakpoint\n' +
    'ALTER TABLE "y" ADD COLUMN "z" text;\nCREATE INDEX "i" ON "y" ("z");';
  assertEquals(findBreakingStatements(sql), []);
});

test("breaking statements are named", () => {
  assertEquals(findBreakingStatements('DROP TABLE "a";'), ["DROP TABLE"]);
  assertEquals(findBreakingStatements('ALTER TABLE "a" DROP COLUMN "b";'), [
    "DROP COLUMN",
  ]);
  assertEquals(
    findBreakingStatements('ALTER TABLE "a" RENAME COLUMN "b" TO "c";'),
    [
      "RENAME COLUMN",
    ],
  );
  assertEquals(findBreakingStatements('ALTER TABLE "a" RENAME TO "c";'), [
    "RENAME TO (table, index or constraint)",
  ]);
  assertEquals(
    findBreakingStatements('ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;'),
    [
      "SET NOT NULL",
    ],
  );
  assertEquals(
    findBreakingStatements(
      'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE int;',
    ),
    [
      "ALTER COLUMN TYPE",
    ],
  );
  assertEquals(
    findBreakingStatements('ALTER TABLE "a" ALTER COLUMN "b" TYPE int;'),
    [
      "ALTER COLUMN TYPE",
    ],
  );
  assertEquals(findBreakingStatements('TRUNCATE "a";'), ["TRUNCATE"]);
});

test("dropping a constraint or index is allowed", () => {
  assertEquals(
    findBreakingStatements(
      'ALTER TABLE "a" DROP CONSTRAINT "c";\nDROP INDEX "i";',
    ),
    [],
  );
});

test("a comment mentioning DROP TABLE does not trip", () => {
  assertEquals(findBreakingStatements("-- no DROP TABLE here\nSELECT 1;"), []);
});

test("breaking-ok with a reason opts out; without one it does not", () => {
  const reason = "-- breaking-ok: the old worker never read this column\n";
  assertEquals(
    findBreakingStatements(reason + 'ALTER TABLE "a" DROP COLUMN "b";'),
    [],
  );
  assertEquals(findBreakingStatements('-- breaking-ok:\nDROP TABLE "a";'), [
    "DROP TABLE",
  ]);
});
