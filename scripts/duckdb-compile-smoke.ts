/**
 * `deno task duckdb:smoke` — build/packaging gate for the DuckDB metrics
 * store. It proves the REAL compiled TurboPanel artifact — `deno task compile`
 * (tasks.compile, entry src/deno.ts) → `dist/turbopanel-instance` — can open
 * embedded DuckDB with the permission shape TurboPanel ships, via the
 * binary's `duckdb-smoke` subcommand (src/duckdb-smoke.ts).
 *
 * **Run inside the Vagrant guest on BOTH architectures** (linux-x64 and
 * linux-arm64) per dev/AGENTS.md → Testing — never on the host. One-shot:
 *
 *   vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/deno/current:$PATH"; \
 *     cd ~/turbopanel && deno task duckdb:smoke'
 *
 * What it does:
 *   1. `deno task compile` — the exact production build/permission shape
 *      (~2 min cold; skipped when --bin=<path> points at an already-compiled
 *      instance binary, e.g. dist/turbopanel-instance).
 *   2. Runs the compiled binary three times — `duckdb-smoke write` →
 *      `duckdb-smoke verify` (fresh process, restart durability) →
 *      `duckdb-smoke parquet` (COPY TO + read_parquet round trip) — against a
 *      scratch TURBOPANEL_METRICS_DIR under /var/lib/turbopanel/metrics, the
 *      metrics tree baked into the binary's --allow-read/--allow-write (a
 *      temp dir would be outside the compiled permission grants).
 *
 * Native-artifact findings this gate encodes (see also
 * src/server-paths.ts → resolveDuckdbNativeLibraryPath):
 *   - `deno compile` bundles `duckdb.node` from the npm cache automatically
 *     (no node_modules / nodeModulesDir needed) and self-extracts it.
 *   - It does NOT extract the companion `libduckdb.so` (`--include` cannot
 *     help: the VFS is invisible to the dynamic linker), so the compiled
 *     binary needs the vendored `.so` on LD_LIBRARY_PATH. This gate uses the
 *     vendored copy when present (exactly what the instance unit does), else
 *     the build-input copy located by scripts/duckdb-native-lib.ts — the same
 *     locator the daemon's instance-build role uses to stage the vendor tree.
 */
import {
  DEFAULT_METRICS_DIR,
  resolveDuckdbNativeLibraryPath,
} from '../src/server-paths.ts'
import { locateBuiltLibduckdbDir } from './duckdb-native-lib.ts'

const repoRoot = new URL('..', import.meta.url).pathname

async function run(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const output = await new Deno.Command(cmd, {
    args,
    env,
    cwd: repoRoot,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const stdout = new TextDecoder().decode(output.stdout)
  const stderr = new TextDecoder().decode(output.stderr)
  if (!output.success) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${stdout}\n${stderr}`)
  }
  return stdout
}

const binArg = Deno.args.find((a) => a.startsWith('--bin='))?.slice('--bin='.length)

// Scratch metrics root inside the compiled binary's baked --allow-write tree.
const workDir = `${DEFAULT_METRICS_DIR}/compile-smoke-${crypto.randomUUID()}`
try {
  await Deno.mkdir(workDir, { recursive: true })
} catch (err) {
  throw new Error(
    `cannot create ${workDir} — the compiled binary's permissions are baked to ` +
      `${DEFAULT_METRICS_DIR}, so this gate needs a converged Vagrant guest ` +
      `(dev user in the turbopanel group). See dev/AGENTS.md → Testing.`,
    { cause: err },
  )
}

try {
  let bin = binArg
  if (!bin) {
    console.log('deno task compile (real production artifact, ~2 min cold)…')
    await run(Deno.execPath(), ['task', 'compile'])
    bin = `${repoRoot}dist/turbopanel-instance`
  }

  const vendored = resolveDuckdbNativeLibraryPath()
  const libDir = vendored
    ? vendored.slice(0, vendored.lastIndexOf('/'))
    : await locateBuiltLibduckdbDir()
  console.log(`libduckdb.so dir: ${libDir}`)
  const env = {
    TURBOPANEL_METRICS_DIR: workDir,
    LD_LIBRARY_PATH: libDir,
  }

  for (const mode of ['write', 'verify', 'parquet']) {
    const stdout = await run(bin, ['duckdb-smoke', mode], env)
    if (!stdout.includes(`smoke:ok ${mode}`)) {
      throw new Error(`${mode} did not report success:\n${stdout}`)
    }
    console.log(stdout.trimEnd())
  }
  console.log(
    'duckdb:smoke PASS (real compiled artifact → restart durability → parquet)',
  )
} finally {
  await Deno.remove(workDir, { recursive: true })
}
