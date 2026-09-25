# Managed upgrades — AGENTS.md

Instance-wide, fleet-aware daemon/instance/UI upgrades. This directory owns the
**pure** decision layer; the orchestrator (DB + cell) composes it, the admin API
exposes it, and the maintenance tick drives it.

Root context: `../../../AGENTS.md`. Cell protocol + tolerant inbound:
`../../daemon/cell/AGENTS.md`. Settings row: `../settings/upgrade-settings.ts`.
Channel manifests: `../../contracts/update-channel.ts`. Schema (`upgrade` /
`upgradestep`): `../../db/AGENTS.md`.

## The one rule: the planner and state transitions stay pure

`planner.ts`, `transitions.ts`, `run.ts`, and `target.ts` are **host-free** — no
DB, no clock (`now` is passed), no random, no manifest fetch, no cell. They are
unit-tested with `*.hostfree.test.ts` and are the source of truth for every
ordering, batching, gating, retry, and outcome decision. The impure orchestrator
reads rows, calls these, then writes Postgres and enqueues cell messages. Do not
push a decision down into the orchestrator that belongs in a pure function, and
do not import a DB/cell module here.

| Module              | Owns                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `vocabulary.ts`     | `upgrade` / `upgradestep` enums, pinned by `../../db/enum-checks.test.ts`                                                          |
| `target.ts`         | `upgrade.target` jsonb shape + `isOnTarget` / `differsFromInstalled`                                                               |
| `target-resolve.ts` | channel manifests → `UpgradeTarget` (pinned via `pinnedChannelManifestUrl`), `channelHasInstancePackage`, latest-build setting row |
| `planner.ts`        | phases + batch sizing → the run's step list                                                                                        |
| `transitions.ts`    | per-step next action (dispatch / wait / retry / needs_attention / done)                                                            |
| `run.ts`            | batch gating, fleet hard-gate, control-plane failure, run outcome, Workers dispatch cap                                            |
| `schedule.ts`       | pure maintenance-window + auto-start decision                                                                                      |
| `prune.ts`          | bounded history prune on the maintenance tick                                                                                      |

The coordinator is `coordinator.ts` (decisions) plus `store.ts` (Postgres or the
in-memory test store). `maintenance.ts` is the tick: Deno cleanup lane every
pass, Workers offline-sweep on the 15-minute divisor. Hello, heartbeat, and
`update-progress` / `update-result` / `instance-update-result` persist through
`persist.ts` and do not enqueue. Admin routes live in
`../../admin/instance-updates-routes.ts`. The client gate is
`../../client/servers/routes.ts`.

## Detecting new builds

On the maintenance tick (Deno cleanup lane; Workers offline-sweep minute
divisor, ~15 min, budgeted), resolve the daemon / instance / UI manifests for
the channel through `resolveUpdateManifest` (cached — daemons never poll
GitHub). Compute pinned targets with `pinnedChannelManifestUrl`; the dev overlay
provider (`../../developer/dev-update-overlay.ts`) still wins for the daemon
kind. Store the latest available build in a setting row. **Check now** bypasses
the cache.

## Runs

- **Manual** — pre-flight first; 409 when a run is already active
  (`uniq_upgrade_active`).
- **Automatic** — self-hosted only when `autoUpdate` is on, Workers always. Only
  inside the maintenance window (if one is set), only when the target differs
  from what's installed (`differsFromInstalled`), and only when no run is
  active. Never replace a run in progress; the next run targets the newest
  build. Daemon drift counts **connected** servers only (`anyDaemonBehind`):
  an offline host would otherwise reopen a run on every tick, each waiting
  out the offline deadline. It is picked up by the first run after it
  reconnects.
- **Never a downgrade.** Preflight refuses a run whose control-plane or
  co-located daemon target is an older semver than what is installed
  (`isDowngrade` in `target.ts`; equal versions and unparsable ones pass). A
  fleet daemon already newer than the target gets a `skipped` step with
  `errorCode` `downgrade_refused` and is not dispatched. Going back is the
  explicit, logged rollback command, never a managed run.
- **Single-server** — `planSingleServer`, one fleet step, for manual per-server
  updates.

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
the fleet steps). Start the next batch only when every step in the current one
is terminal (`batchComplete` / `activeBatchIndex`); failed steps are terminal
and never block it (no threshold). Workers caps enqueues per tick
(`capWorkersDispatch`, `WORKERS_DISPATCH_BUDGET`) below the subrequest ceiling
it shares with the sweep, so a 100% batch drains over several ticks.

## Marking servers done

In the hello/heartbeat projection paths (`../../daemon/deno-ws.ts`, and the DO's
`#projectInbound` via `#withProjectionDb`, time-bounded and closed), a
`daemonBuild` commit change marks the matching active step `done` (this is
`reachedTarget` in `transitions.ts`). **Only write Postgres there; never enqueue
from a hello or DO handler.** The tick advances runs. Keep
`server.daemon.projection.update` in sync so the existing server badges keep
working.

## Self-healing (`transitions.ts`)

- An offline server's step becomes `waiting` (`wait_offline`) and is dispatched
  when the server reconnects. The orchestrator stamps `lastStageAt` when the
  step enters `waiting`; still waiting after `UPGRADE_OFFLINE_DEADLINE_MS`
  (60 min) it becomes `needs_attention` with `errorCode` `server_offline`, so
  one unreachable host cannot hold the single instance-wide run open. The
  step-retry endpoint reopens it.
- No progress within `UPGRADE_STEP_TIMEOUT_MS` → retry with backoff, up to
  `UPGRADE_STEP_MAX_ATTEMPTS` (3), then `needs_attention`.
- `rolled_back` → one automatic retry (`UPGRADE_ROLLBACK_MAX_ATTEMPTS`), then
  `needs_attention`.
- A failed co-located daemon or control-plane step (`failedPlatformPhase`)
  marks the run failed and holds the fleet gate shut.
- A run whose last open step settles this tick finishes this tick (the
  recount covers the whole run, not just the page the tick read).
- Endpoints exist for retrying a step and cancelling a run.

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

- Client gate (`../../client/servers/routes.ts`): `POST /servers/:id/update` and
  `POST /servers/updates` answer 409 `control_plane_upgrade_required` while the
  gate is closed (self-hosted) and 409 `updates_managed` on Workers; the GET
  update-status routes carry `updateBlocked`, the machine `updateBlockedCode`
  (`ServerUpdateBlockedCode` in `decisions.ts`: the three gate errors plus
  `colocated_with_instance`) and the human `updateBlockedReason`. Clients
  branch on the code, never the sentence. `POST /servers/updates`
  creates a batched fleet run and requires `organization:manage` on the
  organization (403 otherwise) — the same bar as `POST /servers/:id/update` —
  because it opens the one instance-wide run.
- Admin API (`../../admin/instance-updates-routes.ts` + `openapi/`): status,
  preflight (with the recovery command), runs, check, history, servers list,
  step-retry, run-cancel, settings. The old `POST /instance/updates/instance`
  and `/daemon` endpoints stay as aliases that start a platform run.
  `GET /instance/updates` gives each unit `updateAvailable` from
  `updateAvailableFor` (`target.ts`): the target names a commit the host is
  not running and installing it would not downgrade. That is the one rule; a
  client renders it and never compares version or commit strings itself.
- Error vocabulary (`vocabulary.ts`): `UPGRADE_STEP_ERROR_CODES` are the step
  `errorCode`s the control plane sets itself (`rolled_back`, `server_offline`,
  `step_timeout`, `managed_upgrade_required`, `downgrade_refused`); a daemon
  result may add its own reason code, so a client names these and shows any
  other code verbatim. `UPGRADE_RUN_ERROR_CODES` are the run `error`s
  (`colocated_daemon_failed`, `control_plane_failed`). The literals in
  `transitions.ts` / `coordinator.ts` are `satisfies`-checked against them.
