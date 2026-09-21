/**
 * scripts/merge-lcov.py — Vitest/Deno smart merge, including the CI case
 * where several Deno shard reports have to be unioned before that merge.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join } from "@std/path";

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
const script = join(repoRoot, "scripts/merge-lcov.py");

function record(sf: string, da: readonly string[]): string {
  const lh = da.filter((line) => !line.endsWith(",0")).length;
  return `SF:${sf}\n${da.map((line) => `DA:${line}`).join("\n")}\nLF:${da.length}\nLH:${lh}\nend_of_record\n`;
}

async function merge(args: string[], cwd: string) {
  const out = await new Deno.Command("python3", {
    args: [script, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

describe("merge-lcov", () => {
  it("unions Deno shards, then refuses Deno zero-hit lines that Vitest did not cover", async () => {
    const dir = await Deno.makeTempDir();
    await Deno.writeTextFile(
      join(dir, "vitest.lcov"),
      record("src/shared.ts", ["1,5", "2,0"]) + record("src/workers-only.ts", ["1,1"]),
    );
    await Deno.writeTextFile(
      join(dir, "deno-a.lcov"),
      record("src/shared.ts", ["1,0", "3,0"]) + record("src/deno-only.ts", ["1,1", "2,0"]),
    );
    await Deno.writeTextFile(
      join(dir, "deno-b.lcov"),
      record("src/shared.ts", ["4,2"]) + record("src/deno-only.ts", ["2,3", "3,1"]),
    );
    const out = join(dir, "out.lcov");
    const result = await merge([
      "--vitest",
      "vitest.lcov",
      "--deno",
      "deno-a.lcov",
      "--deno",
      "deno-b.lcov",
      "--out",
      out,
    ], dir);
    assertEquals(result.code, 0, result.stderr);
    const text = await Deno.readTextFile(out);
    assertStringIncludes(text, "SF:src/shared.ts");
    assertStringIncludes(text, "DA:1,5");
    assertStringIncludes(text, "DA:2,0");
    assertStringIncludes(text, "DA:4,2");
    assertEquals(text.includes("DA:3,0"), false);
    assertStringIncludes(text, "SF:src/deno-only.ts");
    assertStringIncludes(text, "DA:1,1");
    assertStringIncludes(text, "DA:2,3");
    assertStringIncludes(text, "DA:3,1");
    assertStringIncludes(text, "SF:src/workers-only.ts");
  });

  it("reads the four shard artifacts and fails when one is missing", async () => {
    const dir = await Deno.makeTempDir();
    const parts = join(dir, "parts");
    const names = [
      "lcov-vitest",
      "lcov-deno-hostfree",
      "lcov-deno-api-routes",
      "lcov-deno-db-1",
      "lcov-deno-db-2",
    ];
    for (const name of names) {
      const artifact = join(parts, name);
      await Deno.mkdir(artifact, { recursive: true });
      const file = name === "lcov-vitest" ? "lcov.info" : "deno.lcov";
      await Deno.writeTextFile(join(artifact, file), record("src/a.ts", ["1,1"]));
    }
    const out = join(dir, "merged.lcov");
    const ok = await merge(["--parts", parts, "--out", out], dir);
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(await Deno.readTextFile(out), "SF:src/a.ts");

    await Deno.remove(join(parts, "lcov-deno-db-2"), { recursive: true });
    const missing = await merge(["--parts", parts, "--out", out], dir);
    assertEquals(missing.code, 1);
    assertStringIncludes(missing.stderr, "lcov-deno-db-2");
  });

  it("fails --assert-workers when the Durable Object floors are absent", async () => {
    const dir = await Deno.makeTempDir();
    await Deno.writeTextFile(join(dir, "vitest.lcov"), record("src/other.ts", ["1,1"]));
    await Deno.writeTextFile(join(dir, "deno.lcov"), record("src/other.ts", ["1,1"]));
    const result = await merge([
      "--vitest",
      "vitest.lcov",
      "--deno",
      "deno.lcov",
      "--out",
      "out.lcov",
      "--assert-workers",
    ], dir);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "do.ts");
  });
});
