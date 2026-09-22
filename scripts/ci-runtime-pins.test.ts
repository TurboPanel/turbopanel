/**
 * scripts/ci-runtime-pins.sh reads the daemon role defaults instead of a
 * second copy of the Node and Deno versions in workflow YAML.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join } from "@std/path";

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
const script = join(repoRoot, "scripts/ci-runtime-pins.sh");

async function pin(root: string, key: string) {
  const out = await new Deno.Command("sh", {
    args: [script, root, key],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

describe("ci-runtime-pins", () => {
  it("reads node_version and deno_version from the role defaults", async () => {
    const root = await Deno.makeTempDir();
    const nodeFile = join(root, "orchestration/roles/node-runtime/defaults/main.yml");
    const denoFile = join(root, "orchestration/roles/deno-runtime/defaults/main.yml");
    await Deno.mkdir(dirname(nodeFile), { recursive: true });
    await Deno.mkdir(dirname(denoFile), { recursive: true });
    await Deno.writeTextFile(nodeFile, '# comment\nnode_version: "26.7.0"\n');
    await Deno.writeTextFile(denoFile, 'deno_version: "2.9.7"\n');
    assertEquals((await pin(root, "node")).stdout, "26.7.0");
    assertEquals((await pin(root, "deno")).stdout, "2.9.7");
  });

  it("workflows read the role defaults instead of copying the version numbers", () => {
    const action = Deno.readTextFileSync(
      join(repoRoot, ".github/actions/setup-toolchain/action.yml"),
    );
    const build = Deno.readTextFileSync(join(repoRoot, ".github/workflows/build.yml"));
    const release = Deno.readTextFileSync(join(repoRoot, ".github/workflows/release.yml"));
    assertStringIncludes(action, 'sh scripts/ci-runtime-pins.sh "$root" node');
    assertStringIncludes(action, 'sh scripts/ci-runtime-pins.sh "$root" deno');
    assertStringIncludes(action, "steps.pins.outputs.node-version");
    assertStringIncludes(action, "steps.pins.outputs.deno-version");
    assertEquals(action.includes('node-version: "'), false);
    assertEquals(action.includes('deno-version: "'), false);
    assertStringIncludes(release, "./.github/actions/setup-toolchain");
    assertStringIncludes(build, "turbopanel/scripts/ci-runtime-pins.sh turbopaneld deno");
    assertEquals(build.includes('deno-version: "'), false);
    assertEquals(release.includes('node-version: "'), false);
    assertEquals(release.includes('deno-version: "'), false);
  });

  it("fails when the role file or the key is missing", async () => {
    const root = await Deno.makeTempDir();
    const missing = await pin(root, "node");
    assertEquals(missing.code, 1);
    assertStringIncludes(missing.stderr, "missing");
    const badKey = await pin(root, "ruby");
    assertEquals(badKey.code, 1);
  });
});
