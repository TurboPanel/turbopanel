/**
 * Locate the architecture-appropriate `libduckdb.so` shipped by the pinned
 * `@duckdb/node-api` bindings package, looking only at build inputs: the
 * pnpm-managed `node_modules` first (this repo is BYONM), then Deno's npm
 * cache. It never consults the vendored tree — this is the *source* the
 * daemon's instance-build role copies FROM into
 * `/opt/turbopanel/vendor/duckdb/lib` (the directory the compiled instance
 * unit puts on `LD_LIBRARY_PATH`), and the fallback `deno task duckdb:smoke`
 * uses when no vendored copy exists yet.
 *
 * CLI (used by orchestration/roles/instance-build in ../turbopaneld): prints
 * the directory containing `libduckdb.so`; exits non-zero when the pinned
 * bindings package is absent so a compiled converge fails instead of shipping
 * a binary that cannot start.
 */

const repoRoot = new URL('..', import.meta.url).pathname

async function runCapture(cmd: string, args: string[]): Promise<string> {
  const output = await new Deno.Command(cmd, {
    args,
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

/** Pinned @duckdb version from deno.json, e.g. "1.5.5-r.4". */
export async function pinnedDuckdbVersion(): Promise<string> {
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${repoRoot}deno.json`),
  )
  const specifier: string = denoJson.imports['@duckdb/node-api']
  const match = /@duckdb\/node-api@([^/]+)$/.exec(specifier)
  if (!match) throw new TypeError(`unexpected specifier: ${specifier}`)
  return match[1]
}

/**
 * Directory holding the built `libduckdb.so`: pnpm-managed node_modules
 * (this repo is BYONM — pnpm downloads the npm packages), then Deno's own
 * npm cache (populated by `deno task compile`, which bundles `duckdb.node`
 * from there). Throws when neither holds the pinned bindings package.
 */
export async function locateBuiltLibduckdbDir(): Promise<string> {
  const arch = Deno.build.arch === 'aarch64' ? 'arm64' : 'x64'
  const version = await pinnedDuckdbVersion()
  const info = JSON.parse(await runCapture(Deno.execPath(), ['info', '--json']))
  const candidates: string[] = []
  for (const suffix of ['', '-musl']) {
    const pkg = `node-bindings-linux-${arch}${suffix}`
    candidates.push(
      `${repoRoot}node_modules/.pnpm/@duckdb+${pkg}@${version}/node_modules/@duckdb/${pkg}`,
      `${info.npmCache}/registry.npmjs.org/@duckdb/${pkg}/${version}`,
    )
  }
  for (const dir of candidates) {
    try {
      await Deno.stat(`${dir}/libduckdb.so`)
      return dir
    } catch {
      // keep looking
    }
  }
  throw new Error(
    'libduckdb.so not found in node_modules or Deno npm cache — run `pnpm install` or `deno task compile` first',
  )
}

if (import.meta.main) {
  console.log(await locateBuiltLibduckdbDir())
}
