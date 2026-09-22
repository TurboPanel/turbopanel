/**
 * `scripts/schema-comments.mjs` — the `COMMENT ON` delta generator.
 *
 * Proves the three things a wrong answer would silently break: replaying
 * `COMMENT ON` across migrations in journal order (last statement wins,
 * `IS NULL` clears, `''` unescapes, `"public".` and lower-case accepted);
 * emitting SQL that survives reserved identifiers and apostrophes; and
 * printing only the statements whose text differs from what already
 * shipped, in snapshot order. The CLI is run through `node` the way the
 * loop in src/db/AGENTS.md invokes it.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  allStatements,
  commentStatement,
  desiredComments,
  migrationBody,
  pendingStatements,
  readAppliedComments,
  sqlLiteral,
} from "./schema-comments.mjs";
import { readLatestSnapshot } from "./schema-snapshot.mjs";
import { SCHEMA_DESCRIPTIONS } from "../src/db/schema-descriptions.ts";
import { writeFixtureMigrations } from "./schema-fixture.test-helper.ts";

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");

describe("schema-comments: SQL text", () => {
  it("doubles single quotes in literals", () => {
    assertEquals(sqlLiteral("plain"), "'plain'");
    assertEquals(sqlLiteral("the daemon's flag"), "'the daemon''s flag'");
  });

  it("quotes table and column identifiers so reserved words work", () => {
    assertEquals(
      commentStatement("user", "People."),
      `COMMENT ON TABLE "user" IS 'People.';`,
    );
    assertEquals(
      commentStatement("grant.permission", "Key: `organization:own`."),
      `COMMENT ON COLUMN "grant"."permission" IS 'Key: \`organization:own\`.';`,
    );
  });

  it("joins statements with drizzle's breakpoint and a trailing newline", () => {
    assertEquals(migrationBody([]), "");
    assertEquals(
      migrationBody(["A;", "B;"]),
      "A;--> statement-breakpoint\nB;\n",
    );
  });
});

describe("schema-comments: replaying applied comments", () => {
  it("replays in journal order with last-wins, IS NULL and unescaping", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const applied = readAppliedComments(dir);
      assertEquals(applied.get("server.machine_class"), "second wording");
      assertEquals(
        applied.get("server.is_connected"),
        "the daemon's liveness flag",
      );
      assertEquals(applied.get("server"), null, "IS NULL clears the comment");
      assertEquals(applied.has("zz_fixture"), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reads the repo's shipped comments (0004 carries every description)", () => {
    const applied = readAppliedComments();
    assertEquals(applied.get("server"), SCHEMA_DESCRIPTIONS.server.summary);
    assertEquals(
      applied.get("server.assigned_tier_id"),
      SCHEMA_DESCRIPTIONS.server.columns.assigned_tier_id,
    );
  });
});

describe("schema-comments: desired and pending", () => {
  it("wants only described tables/columns that exist in the snapshot", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const desired = desiredComments(readLatestSnapshot(dir));
      // `server` is described in schema-descriptions.ts; the fixture keeps
      // only a few of its columns, so only those may appear.
      assertEquals(desired.get("server"), SCHEMA_DESCRIPTIONS.server.summary);
      assertEquals(
        desired.get("server.machine_class"),
        SCHEMA_DESCRIPTIONS.server.columns.machine_class,
      );
      assertEquals(
        desired.has("server.hostname"),
        false,
        "not in the fixture snapshot",
      );
      assertEquals(
        desired.has("server.id"),
        false,
        "standard columns get no comment",
      );
      assertEquals(
        desired.has("server.organization_id"),
        SCHEMA_DESCRIPTIONS.server.columns.organization_id !== undefined,
        "a plain parent link is emitted only when authored",
      );
      // `zz_fixture` is described nowhere: nothing wanted, nothing invented.
      for (const key of desired.keys()) {
        assertEquals(key.startsWith("zz_fixture"), false, key);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("emits only statements whose text differs from what shipped, in snapshot order", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const snapshot = readLatestSnapshot(dir);
      const pending = pendingStatements({ snapshot, migrationsDir: dir });
      const desired = desiredComments(snapshot);
      // fixture shipped a *different* wording for machine_class and cleared
      // the table comment, so both are pending; is_connected shipped with
      // fixture text too, so it is pending as well. Everything desired is
      // pending here because nothing in the fixture matches the real text.
      assertEquals(pending.length, desired.size);
      assertEquals(
        pending[0],
        commentStatement("server", desired.get("server")),
      );
      // snapshot order: table first, then columns in declaration order
      const targets = pending.map((s: string) =>
        /COMMENT ON (?:TABLE|COLUMN) "([^"]+)"(?:\."([^"]+)")?/.exec(s)!.slice(
          1,
        )
          .filter(Boolean).join(".")
      );
      assertEquals(targets, [...desired.keys()]);

      // Now ship exactly the desired text and the delta must be empty.
      await Deno.writeTextFile(
        join(dir, "0001_amend.sql"),
        migrationBody(pending),
      );
      assertEquals(pendingStatements({ snapshot, migrationsDir: dir }), []);

      // Change one shipped wording and only that one comes back.
      const rewritten = (await Deno.readTextFile(join(dir, "0001_amend.sql")))
        .replace(desired.get("server.machine_class")!, "stale wording");
      await Deno.writeTextFile(join(dir, "0001_amend.sql"), rewritten);
      assertEquals(pendingStatements({ snapshot, migrationsDir: dir }), [
        commentStatement(
          "server.machine_class",
          desired.get("server.machine_class")!,
        ),
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("allStatements is the full dump regardless of what shipped", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const snapshot = readLatestSnapshot(dir);
      assertEquals(
        allStatements(snapshot).length,
        desiredComments(snapshot).size,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("the repo has nothing pending and --all covers every description", () => {
    assertEquals(pendingStatements(), []);
    let described = 0;
    for (const table of Object.values(SCHEMA_DESCRIPTIONS)) {
      described += 1 + Object.keys(table.columns).length;
    }
    assertEquals(allStatements().length, described);
  });
});

describe("schema-comments: CLI", () => {
  async function run(...args: string[]) {
    const out = await new Deno.Command("node", {
      args: [join(repoRoot, "scripts/schema-comments.mjs"), ...args],
      cwd: repoRoot,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  }

  it("--check passes on the repo", async () => {
    const { code, stdout } = await run("--check");
    assertEquals(code, 0);
    assertStringIncludes(stdout, "every description is carried by a migration");
  });

  it("prints an empty body when nothing is pending, and the full dump with --all", async () => {
    assertEquals((await run()).stdout, "");
    const { code, stdout } = await run("--all");
    assertEquals(code, 0);
    // every statement reaches the pipe (a process.exit() after a large
    // stdout write used to truncate this at a few hundred lines)
    assertEquals(
      stdout.split("\n").filter((l) => l.startsWith("COMMENT ON ")).length,
      allStatements().length,
    );
    assertEquals(stdout, migrationBody(allStatements()));
    assertStringIncludes(stdout, `COMMENT ON TABLE "server" IS`);
  });
});
