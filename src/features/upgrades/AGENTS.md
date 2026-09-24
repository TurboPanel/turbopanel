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
  build.
- **Single-server** — `planSingleServer`, one fleet step, for manual per-server
  updates.

## Order (`planner.ts`)

- Self-hosted: `colocated_daemon` (daemon on the control-plane host) →
  `control_plane` (instance + UI on that host) → `fleet` (every other daemon,
  batched).
- The **fleet phase is hard-gated** (`isFleetGateSatisfied`): both the
  co-located daemon **and** the control plane must be on target.
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
  when the server reconnects.
- No progress within `UPGRADE_STEP_TIMEOUT_MS` → retry with backoff, up to
  `UPGRADE_STEP_MAX_ATTEMPTS` (3), then `needs_attention`.
- `rolled_back` → one automatic retry (`UPGRADE_ROLLBACK_MAX_ATTEMPTS`), then
  `needs_attention`.
- A failed control-plane step (`controlPlaneStepFailed`) marks the run failed
  and holds the fleet gate shut.
- Endpoints exist for retrying a step and cancelling a run.

## Saving what daemons report

Store `update-progress`, `update-result` and `instance-update-result` on the
step, on both runtimes (`instance-update-result` was dropped before this
feature). These are fire-and-forget and must **not** complete a correlated
`update` / `instance-update` request. A report is applied only when its wire
request id equals the step's current `requestId`, so a replay from an earlier
dispatch cannot overwrite the attempt that is in flight. Commit confirmation
(`noteDaemonCommit`) stays separate and does not consult that id.

Hosted maintenance ticks page active steps under `UPGRADE_TICK_STEP_BUDGET`
and keep the cursor on the `UPGRADE_TICK_CURSOR` setting between ticks. A
`waiting` step that is still waiting is not written again. Fleet totals are a
grouped `count(*)`, not a materialised server or step list.

## Surfaces

- Client gate (`../../client/servers/routes.ts`): `POST /servers/:id/update` and
  `POST /servers/updates` answer 409 `control_plane_upgrade_required` while the
  gate is closed (self-hosted) and 409 `updates_managed` on Workers; the GET
  update-status routes carry `updateBlocked` + reason. `POST /servers/updates`
  creates a batched fleet run.
- Admin API (`../../admin/instance-updates-routes.ts` + `openapi/`): status,
  preflight (with the recovery command), runs, check, history, servers list,
  step-retry, run-cancel, settings. The old `POST /instance/updates/instance`
  and `/daemon` endpoints stay as aliases that start a platform run.
