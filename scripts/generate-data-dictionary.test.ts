/**
 * `scripts/generate-data-dictionary.mjs` — the website data dictionary.
 *
 * Proves the rendering contract the website relies on (frontmatter every
 * page must carry, generated banner, one page per non-empty group, a
 * table anchor per physical name, FK links, PK marker, constraints block,
 * pipe escaping inside GFM cells, and the "no description yet" fallback
 * for an undescribed table) against the fixture snapshot, then runs the
 * CLI through `node` to prove `--out`, `--check`, orphan removal and the
 * missing-parent refusal.
 */
import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join } from "@std/path";
import { renderAll, tablesByGroup } from "./generate-data-dictionary.mjs";
import { readLatestSnapshot } from "./schema-snapshot.mjs";
import {
  DATA_DICTIONARY_GROUPS,
  SCHEMA_DESCRIPTIONS,
} from "../src/lib/db/schema-descriptions.ts";
import { writeFixtureMigrations } from "./schema-fixture.test-helper.ts";

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");

async function withFixture<T>(
  fn: (files: Map<string, string>) => T | Promise<T>,
) {
  const dir = await writeFixtureMigrations();
  try {
    return await fn(renderAll(readLatestSnapshot(dir)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

describe("generate-data-dictionary: rendering", () => {
  it("groups tables alphabetically and parks undescribed ones under ungrouped", async () => {
    const dir = await writeFixtureMigrations();
    try {
      const groups = tablesByGroup(readLatestSnapshot(dir));
      assertEquals(
        groups.get(SCHEMA_DESCRIPTIONS.server.group).map((
          t: { name: string },
        ) => t.name),
        ["server"],
      );
      assertEquals(
        groups.get("ungrouped").map((t: { name: string }) => t.name),
        ["zz_fixture"],
      );
      for (const key of Object.keys(DATA_DICTIONARY_GROUPS)) {
        assertEquals(groups.has(key), true, `group ${key} always present`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("writes an index, meta.json and one page per non-empty group", async () => {
    await withFixture((files) => {
      assertEquals(
        [...files.keys()].sort(),
        [
          "index.mdx",
          "meta.json",
          `${SCHEMA_DESCRIPTIONS.server.group}.mdx`,
          "ungrouped.mdx",
        ].sort(),
      );
      assertEquals(JSON.parse(files.get("meta.json")!), {
        title: "Database",
        pages: ["index", SCHEMA_DESCRIPTIONS.server.group, "ungrouped"],
      });
    });
  });

  it("every page carries zod-valid frontmatter and the generated banner with the migration tag", async () => {
    await withFixture((files) => {
      for (const [name, content] of files) {
        if (!name.endsWith(".mdx")) continue;
        assertMatch(
          content,
          /^---\ntitle: "[^"\n]+"\ndescription: "[^"\n]+"\n---\n/,
          name,
        );
        assertStringIncludes(content, "GENERATED FILE", name);
        assertStringIncludes(content, "0001_snapshot.json (0001_amend)", name);
      }
    });
  });

  it("renders the described table: anchor, summary, PK marker, FK links, sentences, constraints", async () => {
    await withFixture((files) => {
      const page = files.get(`${SCHEMA_DESCRIPTIONS.server.group}.mdx`)!;
      assertStringIncludes(page, "## `server` [#server]");
      assertStringIncludes(page, SCHEMA_DESCRIPTIONS.server.summary);
      assertStringIncludes(
        page,
        "| `id` (PK) | `uuid` | no | `uuidv7()` | Primary key",
      );
      assertStringIncludes(
        page,
        "| `organization_id` | `uuid` | yes |  | FK → [`organization`](/docs/database/organizations#organization).`id` (on delete restrict).",
      );
      // a foreign key under a non-parent name carries its authored sentence after the link
      assertStringIncludes(
        page,
        `(on delete set null). ${SCHEMA_DESCRIPTIONS.server.columns.assigned_tier_id} |`,
      );
      assertStringIncludes(page, "**Constraints and indexes**");
      assertStringIncludes(
        page,
        '- Index `idx_server_connected`: (`id`) where `"server"."is_connected"`',
      );
      assertStringIncludes(
        page,
        "- Check `server_machine_class_check`: `\"server\".\"machine_class\" IN ('physical', 'virtual')`",
      );
    });
  });

  it("renders the undescribed table honestly: fallback summary, composite PK, unique, no-description cells", async () => {
    await withFixture((files) => {
      const page = files.get("ungrouped.mdx")!;
      assertStringIncludes(page, "# Ungrouped");
      assertStringIncludes(page, "## `zz_fixture` [#zz_fixture]");
      assertStringIncludes(
        page,
        "_No description yet — add one in `schema-descriptions.ts`._",
      );
      assertStringIncludes(page, "- Primary key: (`command_id`, `seq`)");
      assertStringIncludes(page, "- Unique `uniq_zz_fixture_note`: (`note`)");
      // plain parent link named <table>_id: link only, no invented sentence
      assertStringIncludes(
        page,
        "| `command_id` (PK) | `uuid` | no |  | FK → [`command`](/docs/database/runtime#command).`id` (on delete no action). |",
      );
      // non-FK, undescribed column: explicit placeholder
      assertStringIncludes(
        page,
        "| `note` | `text` | yes |  | _No description yet._ |",
      );
    });
  });

  it("escapes pipes inside table cells", async () => {
    await withFixture((files) => {
      // the fixture check constraint has no pipe; prove the escape on the
      // index where-clause path by rendering the repo snapshot instead
      const repo = renderAll(readLatestSnapshot());
      let rows = 0;
      for (const [name, content] of repo) {
        if (!name.endsWith(".mdx")) continue;
        let width = 0;
        for (const line of content.split("\n")) {
          if (!line.startsWith("| ")) {
            width = 0;
            continue;
          }
          // an unescaped pipe inside a cell would widen the row relative
          // to its header; every row of a table must be as wide as the header
          const cells = line.replaceAll("\\|", "").split("|").length;
          if (width === 0) width = cells;
          assertEquals(cells, width, `${name}: ${line}`);
          rows++;
        }
      }
      assertEquals(rows > 700, true, "every shipped column renders one row");
      assertEquals(files.size > 0, true);
    });
  });

  it("the index links every group page and every table anchor", async () => {
    await withFixture((files) => {
      const index = files.get("index.mdx")!;
      assertStringIncludes(index, "| migration `0001_amend` | 2 | 9 |");
      assertStringIncludes(
        index,
        `| [${
          DATA_DICTIONARY_GROUPS[SCHEMA_DESCRIPTIONS.server.group].title
        }](/docs/database/${SCHEMA_DESCRIPTIONS.server.group}) | [\`server\`](/docs/database/${SCHEMA_DESCRIPTIONS.server.group}#server) |`,
      );
      assertStringIncludes(
        index,
        "| [Ungrouped](/docs/database/ungrouped) | [`zz_fixture`](/docs/database/ungrouped#zz_fixture) |",
      );
      assertStringIncludes(index, "## How to read this dictionary");
    });
  });
});

describe("generate-data-dictionary: CLI", () => {
  async function run(...args: string[]) {
    const out = await new Deno.Command("node", {
      args: [join(repoRoot, "scripts/generate-data-dictionary.mjs"), ...args],
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

  it("writes to --out, then --check passes, flags edits, and removes orphans on rewrite", async () => {
    const parent = await Deno.makeTempDir({ prefix: "tp-dd-" });
    const out = join(parent, "database");
    try {
      const first = await run("--out", out);
      assertEquals(first.code, 0, first.stderr);
      assertStringIncludes(first.stdout, "wrote");
      const files = [...Deno.readDirSync(out)].map((e) => e.name).sort();
      assertEquals(files.includes("index.mdx"), true);
      assertEquals(files.includes("meta.json"), true);
      assertEquals(files.length, renderAll().size);

      assertEquals((await run("--check", "--out", out)).code, 0);

      await Deno.writeTextFile(join(out, "index.mdx"), "hand edit\n");
      await Deno.writeTextFile(join(out, "orphan.mdx"), "---\ntitle: x\n---\n");
      const stale = await run("--check", "--out", out);
      assertEquals(stale.code, 1);
      assertStringIncludes(stale.stderr, "stale or missing: index.mdx");
      assertStringIncludes(
        stale.stderr,
        "orphan (not generated any more): orphan.mdx",
      );

      const rewrite = await run("--out", out);
      assertEquals(rewrite.code, 0);
      assertStringIncludes(rewrite.stdout, "removed 1 orphan(s): orphan.mdx");
      assertEquals((await run("--check", "--out", out)).code, 0);
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  });

  it("refuses to write when the target's parent directory does not exist", async () => {
    const parent = await Deno.makeTempDir({ prefix: "tp-dd-missing-" });
    try {
      const res = await run("--out", join(parent, "nope", "database"));
      assertEquals(res.code, 2);
      assertStringIncludes(res.stderr, "does not exist");
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  });
});
