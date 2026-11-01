# Deno Platform and Packaging (`src/platform/deno/`)

## DuckDB packaging (`deno compile` + native addon)

The self-hosted metrics store is embedded DuckDB (`@duckdb/node-api`, pinned
exactly in `deno.json` imports **and** `package.json` — this repo is BYONM, so
pnpm owns the actual package install). Spike-verified packaging facts, encoded
in `src/deno-compile-permissions.test.ts` and gated by `deno task duckdb:smoke`:

- `deno compile` bundles the `duckdb.node` addon from `node_modules`
  automatically and **self-extracts it at runtime**; loading it needs
  FFI permission, **scoped** to `--allow-ffi=/tmp/deno-compile-<binary name>`
  (the permission check names `/tmp/deno-compile-turbopanel/node_modules/…/duckdb.node`;
  `turbopanel-dev` gets `/tmp/deno-compile-turbopanel-dev`). Never bare
  `--allow-ffi`: it lets the process load any shared object and defeats every
  other permission. If the binary is renamed, the scope must follow.
- It does **not** extract the companion `libduckdb.so` the addon links via
  `RUNPATH $ORIGIN`, and `--include` cannot help (the compiled binary's VFS is
  invisible to the dynamic linker). The daemon's `instance-build` role stages
  `libduckdb.so` under `/opt/turbopanel/vendor/duckdb/lib` on every compiled
  converge (locating it via `scripts/duckdb-native-lib.ts`; converge fails when
  it cannot be staged) and the instance unit puts that directory on
  `LD_LIBRARY_PATH` (see `resolveDuckdbNativeLibraryPath` in
  `src/platform/deno/server-paths.ts`). Source mode (`deno run --allow-ffi=<instance dir>/node_modules`) needs neither —
  addon and `.so` are real sibling files under `node_modules`.
- Metrics state lives at `resolveMetricsDir()` (`<stateDir>/metrics`,
  `TURBOPANEL_METRICS_DIR` override); the compile tasks and the daemon's
  instance-launch unit grant read+write on it. DuckDB is fully in-process — the
  metrics store needs no network grant on either surface.
- `deno task duckdb:smoke` builds the **real** production artifact
  (`deno task compile` → `dist/turbopanel`) and drives its
  `duckdb-smoke` subcommand (`src/cli/duckdb-smoke.ts`, routed by `src/deno.ts`) to
  prove DB create → restart durability → Parquet round trip against the exact
  binary that ships. **Run it inside the Vagrant guest on both linux-x64 and
  linux-arm64** (`../dev/AGENTS.md` → Testing), never on the host.

## Self-hosted ingress (`ingress/`)

Code that only the self-hosted build may carry lives in `ingress/`; its rules
are in [`ingress/AGENTS.md`](./ingress/AGENTS.md).
