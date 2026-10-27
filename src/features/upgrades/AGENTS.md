# Managed upgrades — AGENTS.md

Instance-wide, fleet-aware daemon/instance/UI upgrades. This directory owns the
**pure** decision layer; the orchestrator (DB + cell) composes it, the admin API
exposes it, and the maintenance tick drives it.

Root context: `../../../AGENTS.md`. Cell protocol + tolerant inbound:
`../../daemon/cell/AGENTS.md`. Settings row: `../settings/upgrade-settings.ts`.
Channel manifests: `../../contracts/update-channel.ts`. Schema (`upgrade` /
`stage`): `../../db/AGENTS.md`.

## The one rule: the planner and state transitions stay pure

`planner.ts`, `transitions.ts`, `run.ts`, and `target.ts` are **host-free** — no
DB, no clock (`now` is passed), no random, no manifest fetch, no cell. They are
unit-tested with `*.hostfree.test.ts` and are the source of truth for every
ordering, batching, gating, retry, and outcome decision. The impure orchestrator
reads rows, calls these, then writes Postgres and enqueues cell messages. Do not
push a decision down into the orchestrator that belongs in a pure function, and
do not import a DB/cell module here.

| Module              | Owns                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vocabulary.ts`     | `upgrade` / `stage` enums, pinned by `../../db/enum-checks.test.ts`                                                                                                                   |
| `restart-report.ts` | the hold a daemon step gets when its host reports `restart_failed` (a hint, not a verdict: the host's commit decides, see below), and the server name snapshot kept in `stage.detail` |
| `target.ts`         | `upgrade.target` jsonb shape + `isOnTarget` / `differsFromInstalled`                                                                                                                  |
| `target-resolve.ts` | channel manifests → `UpgradeTarget` (pinned via `pinnedChannelManifestUrl`), `channelHasInstancePackage`, latest-build setting row                                                    |
| `planner.ts`        | phases + batch sizing → the run's step list                                                                                                                                           |
| `transitions.ts`    | per-step next action (dispatch / wait / skip_offline / retry / needs_attention / done)                                                                                                |
| `run.ts`            | batch gating, fleet hard-gate, control-plane failure, run outcome, settle-on-start predicate, Workers dispatch cap                                                                    |
| `schedule.ts`       | pure hourly check slot (`nextUpgradeCheckAt` / `isUpgradeCheckDue`) + auto-start decision (drift, no active run, not paused)                                                          |
| `retry-backoff.ts`  | when a server that failed a build is tried again (1 h, doubling, capped at 24 h, per server + unit + target commit)                                                                   |
| `prune.ts`          | bounded history prune on the maintenance tick                                                                                                                                         |
| `history.ts`        | how a step and a server read in the history (`stepOutcome`, worst-of `serverOutcome`, `already_current`), run `trigger`, history query parsing; SQL twin in `history-read.ts`         |

The coordinator is `coordinator.ts` (decisions) plus `store.ts` (Postgres or the
in-memory test store). `maintenance.ts` is the tick: Deno cleanup lane every
pass, Workers offline-sweep on `TURBOPANEL_UPGRADE_TICK_MINUTES` (default 15, testing 5; `tick-cadence.ts`).
Every tick advances the open run; only the hourly check (below) resolves
manifests and may start one. Hello, heartbeat, and
`update-progress` / `update-result` / `instance-update-result` persist through
`persist.ts` and do not enqueue. Admin routes live in
`../../admin/instance-updates-routes.ts`. The client gate is
`../../client/servers/routes.ts`.

## Updates are always automatic (2026-10-27)

There is no on/off switch and no manual start, retry or cancel. The routes that
did those (`POST /instance/updates/instance`, `/daemon`, `/preflight`, `/runs`,
`/check`, `/steps/:id/retry`, `/runs/:id/cancel`, client `POST /servers/updates`
and `POST /servers/:id/update`) answer **410** `updates_automatic`. The legacy
per-server updater and the client update gate are gone; the GET update-status
routes carry `updatesAutomatic: true`. `UPGRADE_SOURCES` keeps `manual` and
`server` because older history rows carry them; new runs are `auto`.

- **The hourly check.** The `UPGRADE_CHECK` setting row holds this install's
  minute of the hour (drawn at random once, then stable, so many installs never
  ask the release servers at the same minute) and `lastCheckAt`.
  `claimUpgradeCheck` (`maintenance.ts`) runs the check on the first tick at or
  after the next slot and records it before the check runs, so a failing check
  waits for the next slot instead of retrying every pass. On Workers the slot is
  taken by the first upgrade tick after it (up to `TURBOPANEL_UPGRADE_TICK_MINUTES`
  late). Before the first check the hour counts from the row's `createdAt`.
- **Pause** (`UPGRADE_PAUSE` row, `../settings/upgrade-control.ts`): `POST
/instance/updates/pause` / `resume`, admins only, recorded in the activity log
  (`upgrade.pause` / `upgrade.resume`). It snapshots who paused and when, so the
  status read needs no join. While paused no run starts (`start()` answers
  `upgrade_paused`) and each tick settles the open run's never-sent steps
  (`attempts` 0, `pending` / `waiting`, one `UPDATE`) as `skipped`
  `updates_paused`; steps already sent, and their retries, finish. The run then
  ends `cancelled` with `error` `updates_paused`. Resume just deletes the row;
  the next check starts what is waiting.
- **Automatic retry with backoff** (`retry-backoff.ts`). An automatic start
  reads, in one grouped query, earlier `failed` / `rolled_back` /
  `needs_attention` steps at the target commits. A fleet server still inside its
  backoff is planned `skipped` with `retry_later` and a "tries again after" time;
  a co-located daemon or control plane in backoff refuses the whole start
  (`upgrade_retry_later`, no run saved) because the fleet gate could never open.
  The #666 no-op rule covers both: a run whose steps are all `done` or
  `retry_later` saves nothing.
- **Late servers.** A run never grows. A server added, reconnected or still on
  an old daemon after a run was planned is picked up by the next check after
  that run ends (daemon drift counts connected servers); `uniq_upgrade_active`
  keeps it to one run at a time.
- **Batch size** stays an admin setting (`UPGRADE_SETTINGS.batch`, default 100%
  of the fleet). The maintenance window and `autoUpdate` are gone: a row saved
  before keeps its batch, the other keys are read and ignored, and a save still
  writes `autoUpdate: true` and a disabled window so a control plane rolled back
  to an older build reads a valid row with updates on.
- `GET /instance/updates` adds `automatic`, `updatesPaused`, `pausedAt`,
  `pausedBy`, `daemonsBehind` (`anyDaemonBehind`, one `limit 1` read against
  the cached daemon manifest), `updateWaiting`, `nextCheckAt`, `lastCheckAt`,
  `activeRunId`. Never read the whole server table on this path.

## Detecting new builds

On the hourly check (above), resolve the daemon / instance / UI manifests for
the channel through `resolveUpdateManifest` (cached — daemons never poll
GitHub). Compute pinned targets with `pinnedChannelManifestUrl`; the dev overlay
provider (`../../developer/dev-update-overlay.ts`) still wins for the daemon
kind. Store the latest available build in a setting row.

## Runs

- **Starting a run** (`start()`, called by the check with `source: 'auto'`;
  the manual sources remain for tests and history only) — pre-flight first; 409 when a run is already active
  (`uniq_upgrade_active`), except a run whose only open steps are fleet
  `waiting` rows (never dispatched) for servers that are not connected:
  `start()` settles those as `skipped` (`server_offline`) and opens the new
  run. If a concurrent hello, progress report or tick moved any of those steps
  first, the run stays open and the call answers 409 `upgrade_run_active`.
  Preflight reports `canStart` in that case and does not mutate. A fleet host
  that is not connected when a run is planned (manual or automatic, not a
  single-server start) gets its step `skipped` at once with `server_offline`
  and "It was offline when the update started. It updates on its own when it
  reconnects."; a connected `pending` host is never skipped.
- **Automatic** — on every runtime and channel, unless paused. Only when the target differs
  from what's installed (`differsFromInstalled`), and only when no run is
  active. Control-plane drift counts only where the run would plan the
  control-plane step (`unitsForPlannedRun`): the hosted (Workers) panel's
  deploy commit never matches the channel build and never opens a run on its
  own. An automatic start whose every step is already `done` saves no run
  (`upgrade_nothing_to_update`, tick log `nothing-to-do`); history shows real
  updates only. Manual starts and preflight are unchanged. Never replace a run in progress; the next run targets the newest
  build. Daemon drift counts **connected** servers only (`anyDaemonBehind`):
  an offline host would otherwise reopen a run on every tick. A skipped host
  that reconnects while behind makes the next check start an automatic run
  (batch limits as usual) unless updates are paused. If it drops again that run skips it
  at once, and drift ignores it while offline, so there is no loop.
- **Never a downgrade.** Preflight refuses a run whose control-plane or
  co-located daemon target is older than what is installed (`isDowngrade` in
  `target.ts`). A fleet daemon already newer than the target gets a `skipped`
  step with `errorCode` `downgrade_refused` and is not dispatched. Going back
  is the explicit, logged rollback command, never a managed run.
  - **Only the base version orders releases.** Binaries report their plain
    base version (`0.1.1`) whichever channel published them; only the manifest
    carries the label (`0.1.1-canary.<id>`, `0.1.1-rc.1`). Plain semver would
    rank every canary build of the installed base as older and refuse it —
    which kept the hosted testing fleet from ever taking a canary daemon
    (2026-09-27). So `isDowngrade` compares `major.minor.patch` only; on the
    same base, the build times (`daemonBuild.builtAt` vs the manifest's
    `builtAt`) decide when both are known, otherwise it is not a downgrade.
    Equal and unparsable versions are not downgrades.
  - `anyDaemonBehind(commit, builtAt)` applies the same rule in SQL, so a host
    built after the target never reopens a no-op run on every tick.
- **Single-server** — `planSingleServer`, one fleet step; no route starts it
  any more (kept for tests).

## Seeing what the tick decided

Every maintenance tick reports one decision through the coordinator's `trace`
dep: the resolved daemon target, `daemonDrift`, `targetDiffers`, the active
run, and whether an automatic run started (with its step counts), was refused
(with the first blocker) or was not attempted. `maintenance.ts` logs it as a
single `upgrade-tick decision …` line when it changes and at most once an hour
when it does not — in `wrangler tail` on Workers, the journal on Deno. A run
whose steps are all `skipped` shows up there as `started … skipped=N`.

## Order (`planner.ts`)

- Self-hosted: `colocated_daemon` (daemon on the control-plane host) →
  `control_plane` (instance + UI on that host) → `fleet` (every other daemon,
  batched).
- The **fleet phase is hard-gated** (`isFleetGateSatisfied`): both the
  co-located daemon **and** the control plane must be on target. So a failed
  or needs-attention step in **either** platform phase ends the run
  (`failedPlatformPhase` → `upgrade.error` `colocated_daemon_failed` /
  `control_plane_failed`); a fleet phase behind it could never open.
- Workers: `fleet` only; the control plane is deploy-managed and shown
  read-only.
- Trunk self-hosted: skip `control_plane` (no package) — the gate then needs
  only the co-located daemon on target.
- Development (developer surface, dev update overlay, source-run control plane):
  the gate is treated as satisfied; `../../developer/update-routes.ts` behaviour
  is unchanged. The legacy per-server updater (`queueServerUpdate`) runs only
  in that mode. A failed gate read elsewhere is **503** `upgrade_gate_unavailable`.
- Step rows are ordered by phase rank (`colocated_daemon`, `control_plane`,
  `fleet`), then batch index, then step id. The tick chooses the open phase
  by that rank, not by the order Postgres returned the rows.
- A run is refused until every unit it will install has a commit and a
  manifest URL. A host already on that commit is stored as a satisfied step
  and is not dispatched.
- Fleet reads use `server.is_connected` and `server.daemon.projection`. The
  cell is probed only for the co-located host and a bounded set of dispatch
  candidates (`FLEET_CELL_PROBE_BUDGET`). Admin server pages are SQL
  `limit`/`offset`.
- Preflight reserves the run id and shows the rollback command and
  `/backup/control-plane/<id>` for that id. Start reuses the id the client
  sends back.

## Dispatch

Send `update` / `instance-update` with `upgradeId`, the pinned URLs, and
`targetCommit`. A legacy daemon without `managed-upgrade-v1` still gets a plain
`update` — that is how a pre-feature co-located daemon bootstraps. The
`control_plane` step **requires** the co-located daemon to advertise
`managed-upgrade-v1` (so backup + rollback always exist); if it does not,
pre-flight fails with an explanation and the CLI command.

## Batches (`run.ts`)

Size each batch from the settings (`computeBatchSize`: a percent or a count of
the fleet steps; 100% when nothing is saved). Start the next batch only when every step in the current one
is terminal (`batchComplete` / `activeBatchIndex`); failed steps are terminal
and never block it (no threshold). Workers caps enqueues per tick
(`capWorkersDispatch`, `WORKERS_DISPATCH_BUDGET`) below the subrequest ceiling
it shares with the sweep, so a 100% batch drains over several ticks.

The batch is per environment: each control plane keeps its own `UPGRADE_SETTINGS`
row. With no row saved the default is **every server in one wave** (percent
100, owner 2026-10-27). An environment can start elsewhere with
`TURBOPANEL_UPGRADE_BATCH` (`count:N` / `percent:N`); a value saved in Admin >
Updates always wins. Not to be confused with `update_config.parallelism` (rolling
deploys of a site).

## Marking servers done

In the hello/heartbeat projection paths (`../../daemon/deno-ws.ts`, and the DO's
`#projectInbound` via `#withProjectionDb`, time-bounded and closed), a
`daemonBuild` commit change marks the matching active step `done` (this is
`reachedTarget` in `transitions.ts`). **Only write Postgres there; never enqueue
from a hello or DO handler.** The tick advances runs. Keep
`server.daemon.projection.update` in sync so the existing server badges keep
working.

## Self-healing (`transitions.ts`)

- A host already offline when a run is planned is skipped at once (see
  **Runs**). An offline server's step otherwise becomes `waiting`
  (`wait_offline`) and is dispatched when the server reconnects: a host that
  was mid-update or briefly lost its connection during the run. The
  orchestrator stamps `lastStageAt` (column `stage.status_changed_at`) when the
  step enters `waiting`, so the 15 minute clock (`UPGRADE_OFFLINE_DEADLINE_MS`)
  runs from the tick that first noticed the host offline (no last-seen
  column). The wait applies only to a never-dispatched
  (`attempts === 0`) **fleet** step on a host that went offline during the run;
  one still waiting after that is `skipped` (`skip_offline`, strictly more than
  15:00 elapsed) with `errorCode`
  `server_offline` and "It stayed offline for 15 minutes during the update. It
  updates on its own when it reconnects." The run then ends `succeeded` when
  every other step is done/skipped. Co-located daemon and control-plane steps
  still become `needs_attention` / `server_offline` (the fleet gate depends on
  them). A host that dropped mid-install (`attempts > 0`) is never skipped: it
  keeps the old path and becomes `needs_attention` / `server_offline` after the
  long wait, because its install may still finish.
- No progress within `UPGRADE_STEP_TIMEOUT_MS` → retry with backoff, up to
  `UPGRADE_STEP_MAX_ATTEMPTS` (3), then `needs_attention`.
- `rolled_back` → one automatic retry (`UPGRADE_ROLLBACK_MAX_ATTEMPTS`), then
  `needs_attention`.
- A failed co-located daemon or control-plane step (`failedPlatformPhase`)
  marks the run failed and holds the fleet gate shut.
- A run whose last open step settles this tick finishes this tick (the
  recount covers the whole run, not just the page the tick read).
- No endpoint retries a step or cancels a run: a failed server is retried by a
  later automatic run (see **Automatic retry with backoff**) and Pause stops a run.
- A control-plane (`instance`) step is never settled by the commit alone once it
  was dispatched: the new binary answers as soon as it restarts, while the
  daemon is still verifying it (and may roll it back). Only the daemon's `done`
  stage or an ok `instance-update-result` settles it, so the run stays active
  until then and `start()` answers 409 `upgrade_run_active` (with
  `activeRunId`) to a second update.
- A step still `dispatched` after `UPGRADE_DISPATCH_ACK_TIMEOUT_MS` (5 min) is
  stuck, not slow: it retries (up to the attempt limit) and then goes to
  `needs_attention` / `step_timeout`; a dispatch the daemon refused as busy
  (`inProgressRefused`) is an answer: the earlier install may still finish the
  step, so it keeps the 15-minute window and then goes to `needs_attention`
  without a retry. Steps that reported a stage keep
  `UPGRADE_STEP_TIMEOUT_MS` (15 min).
- A control-plane step that restarted (`restarting` / `verifying`) is never
  retried: a second install on top of a build the daemon is still checking
  can only make it worse. Quiet past `UPGRADE_VERIFY_TIMEOUT_MS` (20 min;
  `TURBOPANEL_UPGRADE_VERIFY_TIMEOUT_MINUTES`, whole minutes 5..180) it goes to
  `needs_attention` / `verify_timeout`, whose `errorMessage` says whether this
  control plane runs the target commit. This holds while the daemon is
  disconnected too (it reconnects to the restarted control plane), so a tick in
  that gap never turns the step into `waiting` and re-installs. The run then
  ends in that tick with `control_plane_failed`, so the console never spins
  forever and the next Update can start. Keep the window longer than the
  daemon's own health budget (10 min by default;
  `TURBOPANEL_UPDATE_HEALTH_TIMEOUT_SECONDS` on the host, up to 60 min), after
  which the daemon has reported `done` or rolled back. Canary update #2
  (2026-10-01) sat in `verifying` because the daemon's health check never
  matched a canary label (`0.1.7` vs `0.1.7-canary.56`; fixed in turbopaneld).
- `start()` reads the active run before anything else, before the target is
  even resolved, so a second press answers 409 `upgrade_run_active` even when
  the manifest host is unreachable. A run that waits only on offline fleet
  hosts is settled first instead of 409. The run endpoints return every step
  with a boolean `connected` (live link) and `attempts` (dispatch count) beside `phase`, so the console can tell
  an offline-waiting step from a connected one.

## Saving what daemons report

Store `update-progress`, `update-result` and `instance-update-result` on the
step, on both runtimes (`instance-update-result` was dropped before this
feature). These are fire-and-forget and must **not** complete a correlated
`update` / `instance-update` request. A report is applied only when its wire
request id equals the step's current `requestId`, so a replay from an earlier
dispatch cannot overwrite the attempt that is in flight. Commit confirmation
(`noteDaemonCommit`) stays separate and does not consult that id.

A stall retry mints a new request id, and the install it retried may still be
running. Each dispatch moves the previous id into `detail.priorRequestIds`
(bounded, `MAX_PRIOR_REQUEST_IDS`). Then:

- The daemon refuses a dispatch that lands while an install of that unit is
  running (`errorCode` `preflight_in_progress`, on both the `failed` progress
  frame and the result). That is **not** a failure: the step stays in flight,
  `lastStageAt` moves, and `detail.inProgressRefused` marks the earlier
  install as the live one.
- A success (a progress stage or `ok` result) from any earlier id of the step
  counts. A failure from an earlier id counts only after the current dispatch
  was refused as in progress; while the newer dispatch is live it is ignored.
- The attempts ceiling still bounds an install that never finishes.

A control-plane rollback arrives as a `rolled-back` progress stage and then a
failed `instance-update-result` whose `errorCode` is the rollback's reason.
The result keeps the step `rolled_back` (so the one automatic retry fires)
instead of recording a failure. `instance-update-result` carries `errorCode`
and `upgradeId` through the cell protocol like `update-result` does.

Hosted maintenance ticks page active steps under `UPGRADE_TICK_STEP_BUDGET`
and keep the cursor on the `UPGRADE_TICK_CURSOR` setting between ticks. A
`waiting` step that is still waiting is not written again. Fleet totals are a
grouped `count(*)`, not a materialised server or step list.

## Surfaces

- Client routes (`../../client/servers/routes.ts`): `POST /servers/:id/update`
  and `POST /servers/updates` answer 410 `updates_automatic`. The GET
  update-status routes carry `updatesAutomatic: true`; only the control
  plane's own host still reports `updateBlockedCode` `colocated_with_instance`
  (`ServerUpdateBlockedCode` in `decisions.ts`). Clients branch on the code,
  never the sentence.
- Admin API (`../../admin/instance-updates-routes.ts` + `openapi/`): status,
  pause, resume, runs, history, servers list, batch settings; the retired
  manual routes answer 410. `GET /instance/updates/run` answers
  `{ run, lastRun }`: when nothing is active, `lastRun` is the most recent
  finished run (steps, `error`, each step's `errorCode` / `errorMessage`) if it
  ended within `UPGRADE_LAST_RUN_VISIBLE_MS` (24 h). A run leaves `activeRun`
  the moment it fails, so without it the console dropped the failure and its
  reason and went back to "update available". `GET /instance/updates` gives each unit `updateAvailable` from
  `updateAvailableFor` (`target.ts`): the target names a commit the host is
  not running and installing it would not downgrade. That is the one rule; a
  client renders it and never compares version or commit strings itself.
- **Update history** (`history-read.ts`, read-only): `GET /instance/updates/history`
  pages runs newest first (`idx_upgrade_created_at`) with `status` / `trigger`
  filters; without `status` it answers finished runs only, as before. Every
  run carries `trigger` and a per-server `summary`. `GET
/instance/updates/runs/:id/servers` pages one row per server (steps grouped
  by `server_id`, `idx_stage_upgrade_server`) with sort, outcome /
  organization / free-text filters, `statusCounts` for quick filters, an
  organization facet and `components` per unit. A step `done` with
  `attempts` 0 was never sent (the host was already on target): it reads
  `already_current` and is never counted as updated, so a run that changed
  nothing shows as already up to date rather than `0.1.15 → 0.1.15`. Last
  heartbeat is a cell read for the page's ids only, capped at
  `FLEET_CELL_PROBE_BUDGET` (one Durable Object call per id on Workers). Once retention prunes a
  run's steps its `summary.detail` is `pruned` and `updated` is null. Neither
  route loads every step (`withSteps` and `fleetFacts` stay off these paths).
  `stage.started_at` (first dispatch, kept across retries) and
  `stage.finished_at` (first terminal save, cleared by a retry) are stamped
  inside `store.saveStep` on database time (a step planned already settled
  takes its planning time as `finished_at`), so the coordinator never sets
  them; rows written before 0002 read `finished` from `status_changed_at` and
  `started` as unknown.
- Error vocabulary (`vocabulary.ts`): `UPGRADE_STEP_ERROR_CODES` are the step
  `errorCode`s the control plane sets itself (`rolled_back`, `server_offline`,
  `step_timeout`, `verify_timeout`, `dispatch_failed`, `managed_upgrade_required`, `downgrade_refused`, `updates_paused`, `retry_later`); a daemon
  result may add its own reason code, so a client names these and shows any
  other code verbatim. `UPGRADE_RUN_ERROR_CODES` are the run `error`s
  (`colocated_daemon_failed`, `control_plane_failed`, `updates_paused`). The literals in
  `transitions.ts` / `coordinator.ts` are `satisfies`-checked against them.

## A reported restart error is a hint

The daemon's own restart (`sudo systemctl restart --no-block`) can exit nonzero
or be cut off by the restart it asked for even though the host comes back on the
new build (seen on slow low-memory hosts). So a daemon step that gets a
`restart_failed` stage or result is **not** failed: `holdForReconnect` keeps it
`restarting` with the report in `detail.restartPending`. The host's commit then
decides: the target build marks the step `done` with a plain `restartNote`;
past `UPGRADE_RESTART_RECONNECT_MS` without it the tick fails the step with
`restart_failed` and the exact state (never reconnected, still the old build,
some other build). A real install failure (any other code) still fails at once.
Older daemons send only the code and are held the same way.

Run steps carry `serverName` / `hostname`: the live server row first, then the
snapshot saved in `detail` when the step was planned. A step row goes with its
server (cascade), so the snapshot only covers a name later cleared.
