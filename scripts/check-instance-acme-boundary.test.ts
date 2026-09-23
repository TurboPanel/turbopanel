/**
 * The boundary guard must fail for a violation in either direction, and
 * the real tree must stay clean.
 */
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { checkInstanceAcmeBoundary } from "./check-instance-acme-boundary.mjs";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");

async function writeTree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await Deno.mkdir(dirname(abs), { recursive: true });
    await Deno.writeTextFile(abs, body);
  }
}

test("checkInstanceAcmeBoundary fails both directions and passes a clean tree", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-boundary-" });
  try {
    await writeTree(root, {
      "src/client/tls/bad.ts":
        "export const leaked = 'INSTANCE_ACME_SETTINGS'\n",
      "src/admin/instance-hostname-routes.ts":
        "export const opted = 'acmeEnabled'\n",
    });
    const failures = checkInstanceAcmeBoundary({ root });
    assert(
      failures.some((line) => line.includes("INSTANCE_ACME_SETTINGS")),
      failures.join("\n"),
    );
    assert(
      failures.some((line) => line.includes("acmeEnabled")),
      failures.join("\n"),
    );

    await writeTree(root, {
      "src/client/tls/bad.ts": "export const leaked = 1\n",
      "src/admin/instance-hostname-routes.ts": "export const opted = 1\n",
    });
    assertEquals(checkInstanceAcmeBoundary({ root }), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("checkInstanceAcmeBoundary passes on this checkout", () => {
  assertEquals(checkInstanceAcmeBoundary({ root: repoRoot }), []);
});
