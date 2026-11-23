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

## Self-hosted job tick and hosted parity

The hosted cron (`runOfflineSweep` in `src/daemon/cell/offline-sweep.ts`, once
a minute) has no counterpart process on a self-hosted control plane. Its work
runs on one 60 s timer in `server.ts`, the job tick (`job-tick.ts`,
`createJobTick`), which builds its list from the shared job table
(`src/jobs/table.ts`: one row per job with its cadence key, the runtimes that
run it and the gate rule `due`) and runs the same job functions with the same
gates (`loadCronGates`, one statement; every flag open when it cannot be read).
`server.ts` keeps only the handler for each row (`DenoJobHandlers`, typed so a
missing one fails the check); the Workers cron asks the same `jobDue` before
each phase. A job on one runtime only carries its reason in the table, and
`src/jobs/table.hostfree.test.ts` fails when a row is missing from a runtime it
names. To add a job, add its row and a handler on each runtime.

- **Two kinds of job.** `local` jobs are the ones that must run on every
  instance, lease or not: the cell `maintain()` (its in-memory presence work,
  plus a stale-row query on the database that is safe on every instance),
  co-located self repair and the heartbeat re-read. `shared` jobs work on the database or push to servers; they run
  only while the tick holds the `OFFLINE_SWEEP_LOCK` lease
  (`offline-sweep-lease.ts`, the lease the hosted cron uses), so two control
  planes on one database never both run them. A held or unreadable lease skips
  the shared jobs for that tick.
- **Isolation.** A job that throws is logged and the rest still run. A tick has a
  time budget (`JOB_TICK_BUDGET_MS`, 45 s, under the 60 s timer so ticks do not
  overlap); jobs not started by then, or still running from an earlier tick, are
  carried and run next tick in list order with the rest. A job past the budget
  is left to finish, never started twice, and nothing new starts after the
  budget. The lease (renewed by each later tick) and the shared database client
  stay open until every job the tick started has settled, so another instance
  cannot start the same shared job and the client is not closed under it; the
  next ticks join them and the every-minute jobs (cell maintenance, stale
  presence, offline notices) keep running. A late tick catches up: a job is due
  when any minute since the previous tick was one of its slots.
  Environment is read once per tick (`ctx.env`), cadences once per tick.
- **Fresh database client.** The certificate, tunnel and ingress jobs share one
  `createDenoDb()` per tick through `ctx.resource`, closed after the tick (never
  the process-long `db`, same discipline as Hyperdrive). They are skipped while
  the command queue is the no-op one.
- **Offline threshold.** Self-hosted marks a server offline after
  `DAEMON_OFFLINE_SWEEP_MS` (150 s): the Redis cell coalesces `lastInboundAt`
  (`redis/cell.ts`). Workers keeps `OFFLINE_SWEEP_STALE_MS` (90 s). The two
  differ on purpose; do not unify them.
- **Jobs** (`server.ts`): offline detection every tick (stale presence,
  disconnect notices, host loss); the stale-command pass while a command,
  recovery or managed row is open; dispatch, webhook, nonce, pin-silence,
  orphan-folder, execution-log, history (command, audit, upgrade, peak),
  notification-prune and edge-trust jobs on their registry cadence; the upgrade
  tick every 15 minutes, and every minute while an upgrade run is pending or
  running (the `upgradeRunActive` gate);
  notification retry and digest while one is pending; the reconnect-repair
  family, certificates and tunnels exactly as `runQueuedCronSweeps`,
  `runReconnectRepairSweeps` and `runCertificateAndIngressSweeps` gate them; the
  ingress tick every minute. `edgeTrust`, `heartbeatRefresh` and `ingressTick`
  exist only for this runtime. A sweep added to `runQueuedCronSweeps` must also be
  called from `server.ts`; `tunnel-sweeps.hostfree.test.ts` fails otherwise.
- **Left alone.** Sub-minute event-driven loops (the outbox pump, the Redis block
  read) and the DuckDB hourly archive are not on the tick.

**Job cadences on self-hosted.** The tick reads the override map once per pass
through `loadJobCadences` (`features/settings/job-cadences.ts`): the
`TURBOPANEL_JOB_CADENCES` env var first (no database read), then the
`jobs.cadences` setting row through `SettingsResolver`, cached for
`JOB_CADENCES_CACHE_MS`, then the defaults. It never throws. Every job in the
table, `upgradeTick` included, follows it.
