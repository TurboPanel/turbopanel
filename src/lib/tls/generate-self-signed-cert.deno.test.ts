/**
 * Script-level coverage for generate-self-signed-cert.mjs: the idempotent
 * fast path must still refuse a readable-but-undecodable platform CA.
 */

import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const script = join(here, "../../../scripts/generate-self-signed-cert.mjs");

async function runGenerator(
  dirs: { stateDir: string; certsDir: string },
): Promise<{ success: boolean; stderr: string; stdout: string }> {
  const proc = new Deno.Command("node", {
    args: [script],
    env: {
      ...Deno.env.toObject(),
      TURBOPANEL_STATE_DIR: dirs.stateDir,
      TURBOPANEL_TLS_CERTS_DIR: dirs.certsDir,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function setupGeneratedCerts(): Promise<{
  root: string;
  stateDir: string;
  certsDir: string;
}> {
  const root = await Deno.makeTempDir({ prefix: "tp-ssc-" });
  const stateDir = join(root, "state");
  const certsDir = join(root, "certs");
  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.mkdir(certsDir, { recursive: true });
  const first = await runGenerator({ stateDir, certsDir });
  if (!first.success) {
    throw new Error(
      `expected first generate to succeed: ${first.stderr}\n${first.stdout}`,
    );
  }
  return { root, stateDir, certsDir };
}

test("fast path refuses a readable-but-undecodable ca.crt when the leaf is up to date", async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts();
  try {
    await Deno.writeTextFile(
      join(stateDir, "tls", "ca.crt"),
      "not a certificate\n",
    );
    const second = await runGenerator({ stateDir, certsDir });
    assertEquals(second.success, false);
    const combined = `${second.stderr}\n${second.stdout}`;
    if (!combined.includes("unreadable or undecodable")) {
      throw new Error(`expected decode failure, got: ${combined}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("fast path refuses an invalid ca.key when the leaf is up to date", async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts();
  try {
    await Deno.writeTextFile(
      join(stateDir, "tls", "ca.key"),
      "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
    );
    const second = await runGenerator({ stateDir, certsDir });
    assertEquals(second.success, false);
    const combined = `${second.stderr}\n${second.stdout}`;
    if (!combined.includes("unreadable or undecodable")) {
      throw new Error(`expected key decode failure, got: ${combined}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
