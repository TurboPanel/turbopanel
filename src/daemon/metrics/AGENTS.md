# Server metrics — AGENTS.md

Host-metrics ingestion (`POST /api/daemon/v1/metrics`, never wakes the DO),
backend storage, and the query/caching API — **v7 stored schema**
(`metrics-contract.ts`, `METRICS_SCHEMA_VERSION = 7`; v6-stamped samples are still
accepted on the wire and written as v7 rows, see "Metrics v7" below). Metrics are grouped by **entity**
(host, network device, filesystem, block device, GPU, hardware signal, ingress
source, database proxy) with a stable logical id per entity, every leaf value is
`number | null` (missing is always `null`, never coerced to `0`), and no value's
presence is inferred from bitmask/part membership. Ingest accepts
`metadata.version` 6 or 7 (`METRICS_WIRE_VERSIONS`) during the daemon transition
and rejects anything else; every stored row carries blob3 `"7"`.

## Metrics v7 (authoritative for new rows)

The v7 layout is **fixture-pinned**: `V7-LAYOUT.md` (generated) and
`testing/v7-layout.fixture.json` are the spec, produced from the owner-sealed
plan by `scripts/metrics-v7-layout/generate.mjs`; `backends/cloudflare/v7-layout.ts`
must reproduce them exactly (`v7-layout.test.ts`). The family catalog and blob
tables below describe the **v6** layout, kept only as the read-side reference for
v6 rows; where they disagree with `V7-LAYOUT.md`, v7 wins.

- **Dataset** `turbopanel_server_metrics_v${METRICS_SCHEMA_VERSION}` (hard cut, per-env `<env>_` prefix); pinned for every wrangler environment by `wrangler-datasets.test.ts`. Readers accept blob3 in `AE_SUPPORTED_SCHEMA_VERSIONS` = [6, 7].
- **Rows**: `host.system` (liveness, bare serverId index), `host.io`, `host.network`, `host.web` on every host; `managed.database` only with managed databases; `block` (>1 drive, 3/row), `network` (NIC 3+, 3/row), `filesystem` (9/row; exactly one extra filesystem is folded into `host.network`), `gpu` (3/row, physical or real passthrough), `hardware.physical` (physical, up to 19 signals). VPS 4 rows, physical 5-6, +1 with databases.
- **Envelope**: blob1 kind, blob2 family, blob3 `"7"` (the storage constant, never the wire version), blob4 topology generation, blob5 sample time as UTC text `YYYY-MM-DD hh:mm:ss`, blob6 entity ids, content text from blob7, double20 interval. Sequence, plan generation and page are no longer written. Event and status rows keep their v6 blob positions except blob3 and the blob5 text format.
- **Wire negotiation**: wire feature `metrics-v7` (`DAEMON_WIRE_FEATURES`, both repos). A daemon stamps `METRICS_LEGACY_WIRE_VERSION` (6) until the control plane it is attached to advertises it. v7 data rides the optional `extended` section and `metadata.durable`; a v6 sample writes the same v7 rows with sentinels and empty text for the absent data.
- **Caddy is totals only** (no per-site fields anywhere); slow families are still re-sent every sample.
- **Reads**: the missing-metric sentinel is tested as `col > -pow(10, 307)` (`aePresentValueSql`), never by equality; a delta-sum over an absent family is null, not 0. The v6+v7 dual-dataset merge and descriptors for the new v7 metrics (OOM kills, Docker health, cert expiry, text blobs) are reader work.

Root context: `../../../AGENTS.md`. Daemon cell: `../cell/AGENTS.md`. Operator
glossary (what each console chart means): `../../../../website/docs/metrics/`.
Human docs + AE cost model:
`../../../../website/docs/architecture/server-metrics.mdx`.

The store surface is unsuffixed: `ServerMetricsStore`,
`resolveServerMetricsStore`, binding `SERVER_METRICS`, dataset
`turbopanel_server_metrics_v7`. `DuckDbParquetServerMetricsStore` implements
only `ServerMetricsStore` — its
`queryHostSeries`/`queryHostSummary`/`queryFleetHostSnapshot` accept the current
canonical metric names. `app.ts`/`db.ts`/`workers.ts` carry only the
`serverMetricsStore` binding. `do.ts`/`offline-sweep.ts`'s status sink and
offline-sweep's AE-direct liveness read both resolve through
`resolveServerMetricsStore` / `SERVER_METRICS`. Shared HTTP/SQL transport
primitives, the generic `{timestamp, connected, reason}` status-row parser, the
validation rate-limit helpers, and
`MetricsBackendKind`/`ServerStatusEvent`/`StatusHistoryQuery`/
`StatusHistoryResult` live in `sql-api.ts`, `validation.ts`, and `types.ts`.

#### The family catalog

Every family is a row-kind (`"metrics"`) with a `hostedFamily`
(`metric-descriptors.ts`'s `HostedFamily`) discriminator. Two are the
**universal baseline** — present on every sample regardless of hardware — the
rest are **presence-gated** (the entity/subsystem must actually exist on the
machine) or **capability-gated** (the org/server's `MetricsCapabilityPlan` must
allow it, see below), or both.

| Family                   | Shape                                                                                                                                                                                                                                                                                | Gating                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.system`            | single row: all 11 `cpu` fields then all 8 `memory` fields — exactly 19 doubles, nothing overflowed                                                                                                                                                                                  | universal baseline — always emitted                                                                                                                                                                                                                                     |
| `host.io`                | single row: `kernel` (double1-2) + `storage` (double3-9) + spare (double10) + `network` (double11-12) + spare (double13), plus the embedded primary NIC(s) at double14-19 when `SlotMapping` resolves them                                                                           | universal baseline — always emitted                                                                                                                                                                                                                                     |
| `network`                | one row per unaccounted-for network device                                                                                                                                                                                                                                           | presence-gated (only devices not embedded in `host.io` and not a fabric device page)                                                                                                                                                                                    |
| `filesystem`             | one row per filesystem beyond the root filesystem                                                                                                                                                                                                                                    | presence-gated + capability-gated (`extraFilesystemSlots`)                                                                                                                                                                                                              |
| `block`                  | one row per block device (per-disk detail, 2 drives/row, `blockRows = ceil(blockDevices/2)`)                                                                                                                                                                                         | presence-gated + capability-gated (`detailedBlockDeviceSlots`, default **2** — two drives are the v5 floor, and the row fits exactly 2 slots (8 doubles each, 16 of 19); same "base entitlement" pattern as `gpuSlots`; collector emits `isServiceDevice` devices only) |
| `gpu`                    | one row per GPU (3 GPUs/row at 6 doubles each, `gpuRows = ceil(gpus/3)`)                                                                                                                                                                                                             | presence-gated + capability-gated (`gpuSlots`, default 1 — "the base entitlement includes one GPU slot; the GPU family is presence-gated": a plan can _entitle_ GPU reporting without a machine _emitting_ any GPU rows)                                                |
| `hardware.physical`      | one row per physical sensor signal — **every** temperature/power reading in the contract, including per-GPU temp/memory-temp/power and per-service-drive temp (never fan RPM)                                                                                                        | presence-gated + capability-gated (`physicalHardwareSignalSlots`; virtual machines default to 0)                                                                                                                                                                        |
| `managed.ingress`        | one row per ingress source (**Caddy only** since v6) — 19/19 doubles: 8 request/response/byte counters, a raw per-interval duration **sum**, 6 cumulative-`le` latency buckets (10ms/50ms/100ms/500ms/1s/5s), in-flight + upstream health + retries                                  | presence-gated + capability-gated (`managedIngressEnabled`)                                                                                                                                                                                                             |
| `managed.router`         | **single row** (host-wide, no entity id — same shape as `host.diagnostics`): the shared hosting Traefik's backend/service/router counts, retries, 5xx, backend latency + requests, open connections, config reloads/age, soonest TLS expiry. 12/19 doubles, 7 spares held for growth | presence-gated + capability-gated (`managedIngressEnabled` — the same "traffic visibility" entitlement that gates `managed.ingress`; splitting Traefik out was a layout change, not a new thing to sell)                                                                |
| `managed.database_proxy` | one row per database-proxy source (ProxySQL) — 17/19 doubles (2 spares): queries + slow queries, two latency means, active transactions, client/backend connection counts and churn, max-conns rejections, connection errors, backend up/total, byte flow                            | presence-gated + capability-gated (`databaseProxyMetricsEnabled`)                                                                                                                                                                                                       |
| `managed.storage`        | **single row** (host-wide, no entity id): hosting/backup/Docker/logs used bytes, hosting/backup/logs free bytes, then the postgres/mysql/mariadb census (instances running + healthy, connections used + max) flattened to `<engine><Field>`. 19/19 doubles, no spares               | presence-gated only — ungated by the plan, like `host.diagnostics`. Absent until the daemon's directory-usage walker completes its first walk                                                                                                                           |
| `managed.docker`         | **single row** (host-wide, no entity id): Docker's `GET /system/df` breakdown — layer bytes, image/container/volume counts and bytes, build-cache bytes, and the reclaimable subset of each. 10/19 doubles, 9 spares held for per-image/per-volume depth                             | presence-gated + capability-gated (`managedDockerEnabled`)                                                                                                                                                                                                              |
| `host.diagnostics`       | single row: 7 host-wide freq/sched scalars (double1-7) then 12 meminfo/vmstat gauges and rates (double8-19)                                                                                                                                                                          | presence-gated only — v6 merged v5's two capability-gated `cpu.detail`/`memory.detail` rows into this one always-on row                                                                                                                                                 |

**Percentiles and averages are never stored.** `managed.ingress` ships a raw
per-interval `requestDurationSecondsSum` plus six cumulative-`le` bucket
counters; `query/derived-metrics.ts` computes the mean (`sum / requests`) and
p50/p90/p99 (`histogram_quantile`-style: locate the bucket holding the target
rank, interpolate within it) at read time. The reason is that neither shape
aggregates: an average of per-interval averages is not the window average, and a
quantile stored at one resolution cannot be re-bucketed at a coarser one. A sum
and a set of bucket counts both add cleanly, so a 5-minute view and a 24-hour
view derive from identical math. **p999 is deliberately not offered** — six
buckets topping out at 5s cannot support it, and the number would be dominated
by the last-bound clamp. `managed.database_proxy` gets means but no percentiles
at all, because ProxySQL exposes cumulative time counters and no histogram to
derive them from.

**Storage accounting is not the same thing as storage I/O.** `host.storage` (on
the `host.io` row) is block-layer throughput/latency/pressure plus root capacity
— how the disk is _behaving_. `managed.storage` answers what is _consuming_ it:
the hosting root, the backup root (`TURBOPANEL_BACKUP_DIR`, `/backup` by
default), the Docker data root and the log directory, each with used bytes and
its filesystem's free bytes. The used figures are **directory** usage, computed
by the daemon's `collector/directory-usage.ts` on its own 15-minute interval and
cached — never walked on the 60 s sample tick — and a path that is its own mount
point is read straight from `statfs` instead of walked. A bounded walk that hits
its entry/depth limit reports `null` rather than a partial total, because an
under-count of a filling disk is worse than a gap. `managed.docker` is the same
discipline against Docker's own `GET /system/df`, polled every 5 minutes by
`collector/docker-usage.ts`; `storage.dockerUsedBytes` is the total that
breakdown sums to.

**The twelve per-engine census fields are collected by the daemon's managed-engine census** (`turbopaneld/src/metrics/collector/managed-engines.ts`, a 5-minute sampler over the Docker socket plus one `docker exec` readiness/connection probe per running instance; an engine with no instance on the host stays `null`, one with instances reports real counts).
`storage.postgres*` / `mysql*` / `mariadb*` therefore read `null` only for an
engine the host does not run, or before the daemon's first census lands — the
instance side treats them like every other nullable leaf and needs no
special case.

**There is no NUMA family.** v5 carried a fully-shaped but never-populated
`numaNodes` (`NumaNodeSample`) reserved family plus a `numaNodeSlots` plan knob;
v6 deleted both — contract, capability plan, cadence tier, and wire schema. A
NUMA family, if it ever ships, arrives with a collector that populates it.

**There is no per-core family.** `cpu.core.live` (one row per online logical
core) and the old `cpu.detail`'s four embedded busiest-core hotspot slots were
both deleted outright — contract, descriptors, AE field map, the
`server_cpu_hotspot_samples` / `server_cpu_core_samples` DuckDB tables, and the
`cpuLiveCoreSlots` plan knob. This is deliberately not a defaulted-off
capability: a 64-core host must cost the same rows as a 2-core one, and no knob
should be able to change that. `host.cpu.saturatedCoreCount` (cores at or above
90% busy) replaced v4's `maxCoreBusyPercent` as a single host scalar.

**Retired host metrics** (v4 → v5): `host.cpu.maxCoreBusyPercent` →
`saturatedCoreCount`; `host.memory.availableBytes` → `usedBytes` +
`cachedFilesBytes` (used is what the UI wants, and reconstructing it from a
capacity is what made history rewritable — see **Capacities by generation**);
`host.storage.diskReadLatencyMs` + `diskWriteLatencyMs` → one combined
`diskLatencyMs`, since the per-drive split now rides the storage row;
`host.storage.maxBlockDeviceUtilPercent` removed, as a rollup that only existed
for plans with zero block-device slots.

**Entitlement vs. emission**, restated: a capability-plan slot count (e.g.
`gpuSlots: 1`) is what a server is _allowed_ to report; whether it actually
emits that family's rows depends entirely on whether the daemon detected the
hardware. Hosted ingest enforces the ceiling with
`truncateSampleToCapabilityPlan` (`capability-plan.ts`) — truncates the sample
to at most `N` entries per capability-gated array. Self-hosted ingest skips
truncation. On attach, a self-hosted control plane also sends
`capability-plan-clear` so a remote daemon that previously stored a hosted
plan deletes `metrics/capability-plan.json` and stops truncating outbound
samples. Truncation can only shrink what the daemon already reports, never
fabricate rows for absent hardware.

**Representative row-count matrix** (`testing/representative-machines.ts` — 17
fixed machine shapes, pinned by
`backends/cloudflare/representative-row-counts.test.ts`): `1-nic-vm` = 2,
`2-nic-vm` = 2, `2-nic-fabric-vm` = 2, `1-gpu-vm` = 3, `web-vm` = 3,
`web-gpu-vm` = 4, `db-only-vm` = 2, `db-proxysql-vm` = 3,
`bare-metal-low-signals` = 3, `bare-metal-gpu` = 4, `4-nic` = 3, `8-nic` = 4,
`16-gpu` = 8, `24-block-devices` = 14, `12-extra-filesystems` = 4,
`large-cpu-ram` = 4, `vm-with-event` = 3. Every machine writes at least the
2-row baseline (`host.system` + `host.io`); additional rows are
`ceil(count / entitiesPerPage)` per presence-gated family actually populated on
that shape (e.g. `16-gpu`: 2 baseline + `ceil(16/3)` = 6 GPU rows = 8 total).

#### Ingest write path

The **only** write path is the authenticated `POST /api/daemon/v1/metrics` HTTP
route (`api-routes.ts`), handled on the normal Worker isolate (Analytics Engine)
/ Deno process (DuckDB) — **never** waking the Durable Object. The license-tier
hardware floor is **not** applied here (or on WS hello): refusing samples would
hide an incident rather than bill for it, and a hello-path floor read would
open Hyperdrive on every presence tick (see `../cell/AGENTS.md` hibernation
rules). Session issuance (`POST /auth/session`) is the cut-off. Pipeline:
`validateMetricsSample` (`validation.ts`) →
`resolveIngestPlanAndReconcileTopology` (plan + `slotMapping`) → truncate
(`truncateSampleToCapabilityPlan`, **hosted only**) → live-session check
(`query/live-session.ts`) → cache the sample (`cacheLiveSample`) **or**
fire-and-forget `ServerMetricsStore.writeSample(sample, slotMapping)` via
`getServerMetricsStore(c)`, where `slotMapping` is the caller-resolved
`(topology generation) -> SlotMapping`
(`client/servers/topology-slot-mapping.ts`), computed once by the ingest route
(it already does that work for capability planning) and threaded straight into
the store — never re-derived by the store itself. WebSocket
`{ type: "metrics" }` frames are **not** accepted — ingestion is HTTP-only.

#### Ingest gate — one stored sample a minute per server

`ingest-gate.ts` holds every server to one stored sample a minute, with no
Postgres involved. The rules are one pure function (`decideAdmission`); the
state lives where the runtime can keep it exact:

- **Workers:** `MetricsGateObject` (`ingest-gate-object.ts`), one Durable Object
  per server (`METRICS_GATE`, `getByName(serverId)`). A Durable Object runs one
  request at a time, so racing samples cannot both pass: exact. It is not the
  daemon cell (`DAEMON_CELL`), which ingest must never wake. Analytics Engine
  cannot do this job: it is write-only, and its SQL cannot drop duplicate
  sample times before averaging.
- **Self-hosted:** `createInMemoryMetricsGate`, a bounded in-process map.
  Exact while the process lives; a restart forgets the last stored time.

Best effort, not exact: the Analytics Engine write after an admitted sample is
fire-and-forget, so an admitted sample can still be lost.

A sample at or before the last stored one is a duplicate or replay; one at
least 50 s after it is on time; an earlier one spends a catch-up token (5,
refilling one a minute). Refused samples get 429 with `Retry-After`; a gate
error (the object unreachable) answers 503 rather than writing unmetered.
Events are stored while a 120-an-hour budget lasts, most severe first; the
rest are dropped and the sample is still stored. Live (non-durable) samples
are never stored and skip the gate.

#### Cadence — one interval everywhere

Every family writes on every sample. There is no per-family cadence and no
ingest decimation step: `cadence-tiers.ts` is gone. Doubles inside a row are
free on Analytics Engine, so the pipeline never chooses which families to drop.

**Live samples feed the overlay; only the 60 s baseline is stored.** A live-session
marker (`markServerLiveSessionActive`, keyed under `tp:metrics:live-session:`)
tracks active lease ids per server and is added/removed by `POST`/`DELETE
/servers/:id/metrics/live`; concurrent viewers share it. A sample with
`metadata.durable === false` (a v7 daemon's 10 s live sample) is cached for the
overlay (`cacheLiveSample`, even if this colo never saw the marker) and **never**
reaches `store.writeSample`. The parallel 60 s baseline (`durable` true or
absent) is stored and, while a lease is active, also cached. A sample with no
flag (every v6 daemon, which replaces its cadence during a lease) is stored as
before, so lease windows are never gaps. Query routes overlay the buffered point
only while the marker is active. Hosted ingest first applies the pure allowlist
backstop (`ingest-allowlist.ts`: pseudo mounts, loop/ram/zram/md devices and
partitions of kept disks, lo/veth/bridge NICs except fabric, virtual-display and
all-null GPUs), then plan truncation. Queries weight by `interval_seconds` and
`_sample_interval`.

A missing bucket is always a genuine gap. There is no slow tier left to hold a
reading across empty host-grid buckets.

#### Capacities by generation

Static host facts also ride the snapshot since v6: `machineClass` (the
daemon's own DMI verdict, which `inferServerMachineClass` prefers over the
sensor proxy) and `paths` (`backup` / `logs` from the daemon's environment,
surfaced read-only as `layoutPaths` on the server DTOs). Both are absent on
pre-v6 snapshots. Capacity totals (`memoryTotalBytes`, `swapTotalBytes`,
`rootFilesystemTotalBytes`) are the denominator of every derived percentage.
They are **topology, not metrics**: they live on the `topologyGeneration`
record, never in a sample.

Each bucket carries the generation it was sampled under, so
`toHostSeriesChartResponse` divides by _that_ generation's capacities
(`buildCapacitiesByGeneration` + `getTopologyGenerations`), falling back to the
latest context for a generation with no recorded snapshot. v4 resolved
capacities once from the latest generation, which meant adding RAM or resizing a
volume silently restated every historical point against the new total — a box
that was at 90% memory last week read as 45% today. Only the generations a range
actually spans are fetched.

Store selection: `resolveServerMetricsStore` (`store-selection.ts` /
`store-selection-workers.ts`) — always on, no enable/disable gate; a backend
that cannot be constructed falls back to `UnavailableServerMetricsStore` (reads
reject with `metrics_backend_unavailable`, writes stay silent no-ops), and a
genuinely unconfigured Workers binding falls back to
`DisabledServerMetricsStore` (`available: false`, never a 503).

#### Server metrics (Workers Analytics Engine)

Wiring: `SERVER_METRICS` binding → `CloudflareAnalyticsEngineServerMetricsStore`
(`src/daemon/metrics/backends/cloudflare/store.ts`, `field-map.ts`,
`sql-api.ts`). Deno uses DuckDB + Parquet (`DuckDbParquetServerMetricsStore`,
below).

| Binding / config | Value                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrangler binding | `SERVER_METRICS` (`analytics_engine_datasets`)                                                                                                                                               |
| Dataset name     | `turbopanel_server_metrics_v7` by default (`AE_DATASET_NAME`, `field-map.ts`; always `turbopanel_server_metrics_v${METRICS_SCHEMA_VERSION}`); every hosted environment has its own `<testing | staging | live>_turbopanel_server_metrics_v7`: wrangler.jsonc sets it on the `SERVER_METRICS`binding (writes) AND as`TURBOPANEL_SERVER_METRICS_AE_DATASET`(the SQL read side,`resolveCloudflareAnalyticsSqlConfig`); `wrangler-datasets.test.ts` keeps the two equal and unique per env |
| Write API        | `writeDataPoint({ indexes, doubles, blobs })` — sync, non-blocking; one call per family row actually emitted (2 baseline + 0..N presence-gated), full 20/20 doubles/blobs shape on every row |
| SQL API          | `POST .../analytics_engine/sql` with `Authorization: Bearer <token>`; response envelope rows under `result.data`                                                                             |
| Max range        | Default `AE_DEFAULT_MAX_RANGE_SECONDS` = 90 days; override via `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS`                                                                              |

**AE SQL refusals DuckDB never shows** (both hit testing on 2026-09-27; the
fake engine in `testing/fake-analytics-engine.ts` now mirrors them as `422`):

- **10,000-character statement cap** (`AE_SQL_MAX_LENGTH`). Host series, the
  fleet snapshot and entity series pack their metric/field lists (and server
  / entity ids) into statements under `AE_SQL_CHUNK_BUDGET` (9,000) with
  `packItemsBySqlLength` / `packRowsAndColumns`, run at most
  `AE_SQL_CHUNK_CONCURRENCY` at once, and merge rows back by bucket / server /
  entity. `executeSql` refuses an over-long statement before sending it.
- **No aggregate over a String blob** (`cannot use the String type as argument
1 in max(`). Aggregate `doubleN` columns only; the topology generation
  (`blob7`, a stringified integer) is compared as `MIN/MAX(toUInt32(blob7))`.
- Emit only functions on Cloudflare's AE SQL reference pages —
  `sql-limits.test.ts` keeps an allowlist and checks every builder's
  worst-case statements against all three rules. Errors name the query
  (`AE SQL HTTP 422 (hostSeries 2/3): …`), never the token.

**Envelope (every row kind: `"metrics"` / `"event"` / `"status"`)** —
`AE_BLOB_*_INDEX` constants in `field-map.ts`:

| Slot           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index1`       | `<serverId>` for `host.system` and status rows; `<serverId>:<family>` (and `<serverId>:event`) for every other row — AE samples writes per index, so one sample's burst on a single index was stored ~1-in-2 (`_sample_interval = 2`, 2026-09-27). Readers match `index1 IN (serverId, serverId:<family>…)` (`serverFamiliesPredicate`), which also covers rows written before the split; the fleet snapshot groups by `substring(index1, 1, 36)`. |
| `blob1`        | row-kind discriminator: `"metrics"` / `"event"` / `"status"`                                                                                                                                                                                                                                                                                                                                                                                       |
| `blob2`        | `"metrics"` rows: the `HostedFamily`; `"event"` rows: `MetricEventKind`; empty on `"status"` rows                                                                                                                                                                                                                                                                                                                                                  |
| `blob3`        | schema version (stringified `4`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `blob4`        | reserved, always empty in v6 — v5 stamped the sample's collection mode (`"baseline"` / `"live"`) here; cadence is now carried by `intervalSeconds` (double20) alone                                                                                                                                                                                                                                                                                |
| `blob5`        | sample/event timestamp; empty on `"status"` rows (AE stamps its own ingestion timestamp there)                                                                                                                                                                                                                                                                                                                                                     |
| `blob6`        | sample sequence (stringified integer); empty on `"status"` rows                                                                                                                                                                                                                                                                                                                                                                                    |
| `blob7`        | `metadata.topologyGeneration` (stringified integer); empty on `"status"` rows — v5's replacement for v3's `hardwareProfileGeneration`                                                                                                                                                                                                                                                                                                              |
| `blob8`        | reserved for a future capability-plan-generation hash (always `""` today)                                                                                                                                                                                                                                                                                                                                                                          |
| `blob9`        | page index within a paged per-entity family (`"0"` for unpaged rows) — **backend-private**, never referenced outside `backends/cloudflare/`                                                                                                                                                                                                                                                                                                        |
| `blob10`       | family-conditional: `sourceId` (`managed.*`), comma-joined per-page entity ids (`gpu`/`network`/`filesystem`/`block`/`hardware.physical`), `event.source` (`"event"` rows), empty on `host.system`/`host.io` — **backend-private**                                                                                                                                                                                                                 |
| `blob11`–`13`  | `"event"` rows only: `entityId`, JSON `payload`, `eventId`                                                                                                                                                                                                                                                                                                                                                                                         |
| `blob14`–`16`  | reserved empty                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `blob17`       | `"status"` rows: transition reason; `"event"` rows: severity; empty on `"metrics"` rows                                                                                                                                                                                                                                                                                                                                                            |
| `blob18`–`20`  | reserved empty                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `double1`–`19` | `"metrics"` rows: the family's field values in field-map-declared order (test-pinned against `metric-descriptors.ts`); `"status"` rows: `double1` = connected (1/0)                                                                                                                                                                                                                                                                                |
| `double20`     | `"metrics"`/`"event"` rows: `intervalSeconds` (the weighting term for aggregation). v4 never assigned it on `"event"` rows, contradicting this invariant; the row-count suite asserted it but no fixture carried an event, so it never fired — `vm-with-event` now covers it                                                                                                                                                                       |

The paged-entity "page identity" symbols (`AE_BLOB_PAGE_INDEX`,
`AE_BLOB_SOURCE_OR_IDENTITY_INDEX`, `entityIdInPageIdentityPredicate`,
`splitPageIdentity`) are backend-private per `field-map.ts` and `sql-api.ts`'s
own doc comments — never inline positional literals or reference these symbols
outside `backends/cloudflare/`; `scripts/check-metrics-boundaries.mjs` enforces
this at CI (see below).

**Identity-addressed slotting:** when a `SlotMapping` is available (resolved
from the sample's `metadata.topologyGeneration` via `topology-slot-mapping.ts`'s
`computeSlotMapping`), `host.io`'s `double14`..`double19` (after its 13 leading
slots — 2 `host.kernel`, 7 `host.storage`, a spare, 2 `host.network`, a spare)
embed the first two monitored NIC slots (`slotMapping.normalNicSlots[0..1]`)
directly — so the common 1-NIC/2-NIC host never writes a `network` page at all —
slots 3+ (self-hosted / higher-tier operators) page as `network` rows in slot
order, and TurboFabric mesh devices (`slotMapping.fabricDeviceIds`) never page
as `network` rows. `normalNicSlots` is an ordered array (slot 1 first, at most
`MAX_NIC_SLOTS` = 11 — the S7 / SX entitlement — mirrored from the daemon in `topology-types.ts`): the
operator's `hardwareProfile.nicSlotDeviceIds` list wins outright, otherwise
exactly the uplink the daemon flagged `defaultRoute` (the gateway NIC; first
sorted uplink as fallback). `PUT /servers/:id/metrics/hardware-profile`
validates every listed id as an `uplink` in the last recorded topology and
rejects a list longer than the server's effective `normalNicSlots`
(`nicSlotLimit` on `/series` and `/summary` tells the UI that limit).
`gpu`/`network`/`filesystem`/`block` pages order entities by the matching
`*PageOrder` list (new-since-recorded-generation entities append in sample
order). No recorded generation yet (first sample, resync pending) degrades
gracefully to pre-topology positional packing — never a dropped sample.

**Missing metrics:** same `-1e308` sentinel idiom as v3
(`AE_MISSING_METRIC_SENTINEL`), never coerced to `0`; all host metrics are ≥ 0
so no collision. Query aggregates exclude it the same way v3's did
(`weightedAvgExpressionForMetric`/`sumExpressionForMetric` analogues in
`sql-api.ts`).

#### Metrics events (`blob1 = "event"`)

A closed catalog of discrete state-change/fault signals distinct from the
continuous numeric families — `METRIC_EVENT_KINDS` in `contract.ts` (OOM kills,
hung tasks, conntrack exhaustion, filesystem state changes, SMART/NVMe/RAID
faults, NIC link state, TurboFabric mesh state, fan/thermal/ PSU/voltage/ECC
faults, GPU faults, clock-sync state, topology/boot generation bumps).
`isHardwareHealthEventKind` classifies each kind as a physical-hardware-health
signal or not (`HARDWARE_HEALTH_EVENT_KIND`, a `Record` so an unclassified new
kind fails to compile rather than silently defaulting);
`hardwareHealthEventsEnabled` on the capability plan gates only the
hardware-health half — OS/kernel/filesystem/fabric/clock/generation events are
always allowed regardless of plan. No v3 equivalent — v3 has no discrete event
stream. Exposed via `GET /api/client/v1/servers/:id/metrics/events`
(`ServerMetricsStore.queryMetricEvents`, optional-on-interface —
`available: false`, never a 503, when the resolved store doesn't implement it).

#### Status event stream (`blob1 = "status"`)

Every genuine `connected` flip on the `server` row also fires a fire-and-forget
status event — on AE into the v5 dataset (discriminated by `blob1`); on
Deno/DuckDB into its own typed `server_status_events` table. Source:
`emitServerStatusEvent` (`status-events.ts`), called from `projectServerDaemon`
(`src/daemon/cell/postgres-projection.ts`), registered per-runtime via
`setServerStatusEventSink`/`getServerStatusEventSink` (no shared request context
across the request isolate, DO isolate, cron-only offline-sweep isolate, and
Deno process).

`queryStatusHistory` is **optional-on-interface** on `ServerMetricsStore` —
`CloudflareAnalyticsEngineServerMetricsStore` is the one store that implements
it (via `queryStatusHistoryViaSqlApi`); `DisabledServerMetricsStore` does not.
`client/servers/metrics-routes.ts`'s `/connection` route checks
`store?.queryStatusHistory` and falls back to an inline `available: false`
result — **not** to the v3 store — when absent. Resolves `{ from, to }` into
prior-state + in-range-transitions reads, fed through the shared backend-neutral
`computeStatusUptime` (`query/uptime.ts`) for
`uptimeSeconds`/`downtimeSeconds`/`unknownSeconds`/`uptimePercent` parity across
backends. Exposed via `GET /api/client/v1/servers/:id/metrics/connection`.

**History-only — never authoritative for liveness.** This stream (and everything
derived from it) is asynchronous, best-effort, sampled/disposable metrics
history and **must never** be read to determine whether a server is currently
online. Postgres `server.is_connected`/`server.status_changed_at`
(`src/daemon/cell/server-status.ts`) is the sole source of truth for current
liveness — see `src/db/AGENTS.md` and `src/daemon/cell/AGENTS.md`. Do not
add a code path that gates any online/offline decision on AE/DuckDB status
history.

#### Server metrics (DuckDB + Parquet — self-hosted Deno)

`DuckDbParquetServerMetricsStore` (`backends/duckdb/`) over the embedded
`@duckdb/node-api` engine — no external service, no credentials. State root:
`resolveMetricsDir()` (`TURBOPANEL_METRICS_DIR`, default `<stateDir>/metrics`)
holding `metrics.duckdb`, `parquet/`, `tmp/`, `schema-version`. Writes are
batched in-process (default 10 rows / 5 s age) into one transaction; queries
force-flush pending batches.

**One real typed table per entity family — no positional layout, no sentinel,
arbitrary cardinality** (`schema.ts`, `DUCKDB_SCHEMA_MARKER_VERSION` currently
`7` — bumped from 6 when `managed.router` gained its own table and the
ingress/database-proxy tables gained columns; every DDL statement is
`CREATE TABLE IF NOT EXISTS`, so without the bump an existing file would keep
its old, narrower columns and reject every insert):

| Table                               | Family                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `server_host_samples`               | `host.system` + `host.io` + `host.diagnostics`'s CPU half (`cpu_diagnostics_*` columns), one wide row |
| `server_network_samples`            | `network`                                                                                             |
| `server_filesystem_samples`         | `filesystem`                                                                                          |
| `server_block_samples`              | `block`                                                                                               |
| `server_gpu_samples`                | `gpu`                                                                                                 |
| `server_hardware_signal_samples`    | `hardware.physical`                                                                                   |
| `server_ingress_samples`            | `managed.ingress`                                                                                     |
| `server_database_proxy_samples`     | `managed.database_proxy`                                                                              |
| `server_router_samples`             | `managed.router` (singleton per sample, no entity id)                                                 |
| `server_memory_diagnostics_samples` | `host.diagnostics`'s memory half                                                                      |
| `server_metric_events`              | metrics events (`MetricEvent`)                                                                        |
| `server_status_events`              | connection-status transitions                                                                         |

Every metric column is real, independently-nullable `DOUBLE` (or typed identity
column) — missing is a real SQL `NULL`, never a sentinel or a part-membership
flag. Entity tables carry arbitrary cardinality per sample (one row per reported
entity), unlike v3's fixed-width part tables.

**Schema on open** (`database.ts`): `CREATE TABLE IF NOT EXISTS` /
`CREATE INDEX IF NOT EXISTS` for the current layout (schema marker **9**). A
marker-8 database is discarded like any older version (hard cut, no migration); a sidecar marker holding an older version number discards `metrics.duckdb`, `parquet/`,
`tmp/`, and `schema-version` before the current store is created. A missing marker beside existing data, or an empty, unparseable, or newer marker, fails the open without deleting anything — there is no
in-place migration and no supported path for older DuckDB files. The marker is a
discard-on-mismatch counter, not a monotonic migration version. **The three
version counters move together, always**: `METRICS_SCHEMA_VERSION` (the wire
contract), `DUCKDB_SCHEMA_MARKER_VERSION` (this on-disk layout), and the
chart-cache `schemaVersion` token. Configured retention still prunes expired
points (`TURBOPANEL_SERVER_METRICS_RETENTION_DAYS`, default 90). Analytics
Engine has no SQL `DELETE`; hosted points age out after Cloudflare's ~3-month
retention. The sidecar marker is written before the database file is first created, so a crash between the two leaves a current marker and no data (the next open continues) instead of a database file nothing vouches for.

**Daily Parquet archive**, partitioned per family
(`parquet/<family-table>/year=YYYY/month=MM/day=DD/*.parquet`; timer armed by
`platform/deno/server.ts`'s `startDailyArchiveTimer()`): each completed UTC day is sealed
out of the hot tables — export to `tmp/`, validate row count by re-reading,
atomic rename, then delete hot rows. Interrupted exports (`tmp/*.parquet`) are
swept on the next tick. Reads union the hot tables with overlapping partitions.
Retention (`TURBOPANEL_SERVER_METRICS_RETENTION_DAYS`, default 90) prunes
expired partitions plus any hot rows past the cutoff.

**Cross-backend regression net:** `representative-machines.ts` (16 machine
shapes) feeds `representative-row-counts.test.ts` (exact AE row count + family
order per shape), `cross-backend-parity.test.ts` (AE vs. DuckDB agree on the
same logical sample), `topology-generation-guard.test.ts` (re-interpreting a
sample under a stale topology generation never corrupts identity-addressed
slots), `orphan-row-semantics.test.ts`, and `counter-reset-end-to-end.test.ts`
(storage/query never fabricates a value in place of a daemon-emitted `null`
after a monotonic counter reset — daemon half of the battery lives in
`turbopaneld/src/metrics/collector/baseline-reset-battery.test.ts`). **New
metrics `*.test.ts` files must be claimed** in `scripts/test-coverage.sh` (Deno
`@std/assert` suites) or `vitest.config.ts` `test.include` (`validation.test.ts`
is the Workers-pool exception) — then `pnpm check:test-inventory`. Unclaimed
suites fail `test:hook` / CI and never reach Sonar LCOV. Root `AGENTS.md` →
**Adding tests (inventory)**. The AE/v6-boundary guard
(`scripts/check-metrics-boundaries.mjs`, run by the `checks` job in
`build.yml` and by `verify-ci.sh`) enforces: (1) AE positional
tokens (`doubleN`/`blobN` literals, the `-1e308` sentinel) stay confined to
`backends/cloudflare/`; (2) backend-private page-identifier symbols
(`AE_BLOB_PAGE_INDEX`, `AE_BLOB_SOURCE_OR_IDENTITY_INDEX`,
`entityIdInPageIdentityPredicate`) never leak outside `backends/cloudflare/`.
Ingest accepts wire versions 6 and 7 (v7 adds the optional `extended`
section); any other version is rejected outright.

#### Server metrics — query API & caching

Endpoints (`src/client/servers/metrics-routes.ts`):

| Method | Path                                              | Notes                                                                                           |
| ------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`  | `/api/client/v1/servers/:id/metrics/series`       | per-entity selectors (`parseSeriesMetricSelectors`) grouped by family                           |
| `GET`  | `/api/client/v1/servers/:id/metrics/summary`      | host summary + `cpuLimits`/`temperatureUnit` envelope                                           |
| `GET`  | `/api/client/v1/servers/:id/metrics/connection`   | status-event history (uptime/downtime)                                                          |
| `GET`  | `/api/client/v1/servers/:id/metrics/events`       | metrics-event history; `available: false` (never 503) when unsupported by the store             |
| `GET`  | `/api/client/v1/servers/:id/metrics/capabilities` | live daemon round trip for the hardware-profile picker (409 `server_offline` when disconnected) |
| `GET`  | `/api/client/v1/servers/metrics/latest`           | one fleet snapshot per org server — never N per-server chart calls                              |

Never authorize by bare UUID possession — session middleware + resource read
grant required. Fleet latest never accepts client-supplied serverIds.

**Backend-neutral entity-scoped query/cache layer:** `resolveStoreBackendKind`
(`metrics-routes-helpers.ts`) classifies the resolved `ServerMetricsStore`
instance (`disabled` / `analytics-engine` / `duckdb`) purely by instance type

- runtime, never by config presence — every route builds its cache key from
  `backend` so an AE-shaped and a DuckDB-shaped cache entry for the same
  server/range can never collide. **Chart cache** (`query/cache.ts`): key =
  `tp:metrics:chart:` + kind + authorized `serverId` + bucket-rounded range +
  sorted metrics + resolution + backend + `v{schemaVersion}` (callers pass
  `schemaVersion: 6` explicitly, required) + `tg{topologyGeneration}` when a
  caller scopes to one topology generation. TTL: live 45 s / historical 300 s.
  Workers: Cloudflare Cache API; Deno: bounded in-process `Map` (256 entries).

**Resolution ladder** (`query/resolution.ts`): range ≤10 min → 10 s; ≤1 h → 60
s; ≤6 h → 300 s; ≤24 h → 900 s; ≤7 d → 3600 s; ≤30 d → 21600 s; else 43200 s.
`MAX_METRICS_POINTS` = 1500; range ≤90 days.

**MetricsCapabilityPlan enforcement point:** the capability plan is resolved
**once**, at ingest (`resolveEffectiveMetricsCapabilityPlan`). Hosted ingest
then enforces it with `truncateSampleToCapabilityPlan` before the sample reaches
a store; self-hosted ingest skips truncation (the operator's own disk is
uncapped) but still resolves `slotMapping` for identity-addressed packing. Query
routes never re-check capability, they only ever see already- truncated (hosted)
or untruncated (self-hosted) data (the hardware-profile PUT re-resolves it only
to reject an over-limit `nicSlotDeviceIds` list up front). `networks` truncation
keeps the slot-mapped NICs within `normalNicSlots` (slot order) plus fabric
devices when `turboFabricEnabled`; without a resolved mapping the first
`normalNicSlots` entries survive positionally. `normalNicSlots` defaults by
**deployment** (`MetricsDeploymentKind`, from the runtime passed to
`registerDaemonApiRoutes` / `registerServerMetricsRoutes` — never inferred from
`typeof Deno`): 2 on the hosted platform (Workers; more will need a licensing
tier later), `MAX_NIC_SLOTS` (11) self-hosted (Deno); org/server overrides are
clamped to 11. `MetricsCapabilityPlan` fields: `liveMinIntervalSeconds`,
`normalNicSlots`, `turboFabricEnabled`, `extraFilesystemSlots`,
`detailedBlockDeviceSlots`, `gpuSlots`, `gpuInterconnectEnabled`,
`physicalHardwareSignalSlots`, `managedIngressEnabled`,
`databaseProxyMetricsEnabled`, `managedDockerEnabled`,
`hardwareHealthEventsEnabled` (v7 tier mapping: Docker metrics are on every plan, `managedDockerEnabled` is never tier-gated; the entry tier keeps 1 extra filesystem and the same 19 physical sensor slots as every plan; GPU slots S1 0, S2 1, S3 1, then 4, 4, 6, 8, 8; drive slots 3, 6, 6, 9, 12, 18, 21, 24; GPU-only sensor signals never make a machine physical; real whole disks, RAID members included, take drive slots while md arrays and partitions never count as drives) — deliberately no pricing-tier names/literals,
only slot counts and toggles. v6 removed `baselineIntervalSeconds` (the daemon's
steady cadence is fixed, not sold), `cpuDetailEnabled`/ `memoryDetailEnabled`
(depth is always on — doubles inside a row are free, so gating them only
produced permanently-blank panels), and `numaNodeSlots` (no NUMA family exists).
Resolution order: platform default → org
(`organization.options.metricsCapabilityPlan`) → server
(`server.options.metricsCapabilityPlan`), mirroring
`resolveEffectiveCpuThermalLimits`.

UI charts: **`../ui/AGENTS.md`** (Server metrics). Operator glossary:
**`../website/docs/metrics/`**. Human docs + AE cost model:
**`../website/docs/architecture/server-metrics.mdx`**.

## Durable invariants

1. Every sample writes at least the 2-row universal baseline (`host.system` +
   `host.io`) — never fewer, regardless of capability plan or hardware.
2. A capability-plan slot count is an _entitlement_; a presence-gated family's
   row count reflects _emission_ (actual detected hardware), truncated down to
   (never up to) the entitlement.
3. Missing metric values are `null` (contract) / SQL `NULL` (DuckDB) / `-1e308`
   sentinel (AE) — never coerced to `0`, on any backend.
4. AE positional tokens (`doubleN`/`blobN` literals, `-1e308`) never appear
   outside `backends/cloudflare/` — always go through `field-map.ts`.
5. The page-identifier symbols (`AE_BLOB_PAGE_INDEX`,
   `AE_BLOB_SOURCE_OR_IDENTITY_INDEX`, `entityIdInPageIdentityPredicate`) never
   appear outside `backends/cloudflare/`.
6. Ingest accepts wire versions 6 and 7 only and rejects any other version
   outright. There is no migration of existing metrics data — enforced by
   `validateMetricsSample`.
7. `DuckDbParquetServerMetricsStore` is the single Deno store instance — never
   two independently constructed instances opening two DuckDB handles on one
   database file.
8. `queryStatusHistory` is optional-on-interface on `ServerMetricsStore`; an
   absent implementation degrades to an inline `available: false` result, never
   to a v3 store read.
9. AE/DuckDB status history is never authoritative for current liveness — only
   Postgres `server.is_connected` is.
10. `slotMapping` is resolved once by the ingest route and threaded through to
    the store — stores never re-derive it themselves.
11. An unresolved topology generation (no recorded `SlotMapping` yet) degrades
    gracefully to positional packing — never a dropped sample.
12. `HARDWARE_HEALTH_EVENT_KIND` is a `Record` over every `MetricEventKind` — a
    new event kind that isn't classified fails to compile, never silently
    defaults either way.
13. `hardwareHealthEventsEnabled` gates only hardware-health events;
    OS/kernel/filesystem/fabric/clock/generation events are always allowed.
14. A backend that fails to construct returns `UnavailableServerMetricsStore`
    (reads reject, 503) — never silently degrades to the disabled store's
    `available: false`, which is reserved for a genuinely unconfigured binding.
15. Cache keys always include the authorized `serverId`, the resolved `backend`,
    and `schemaVersion` — a v5-shaped and a v6-shaped entry for the same
    server/range can never collide.
16. `truncateSampleToCapabilityPlan` runs at ingest on the **hosted** path,
    before the sample reaches any store. Self-hosted ingest skips truncation.
    Query routes never re-check capability.
17. DuckDB missing-column reads are real SQL `NULL`s; bucket aggregation honors
    each metric's declared aggregation policy (`weighted-average` / `last` /
    `max` / `sum`) identically on AE and DuckDB.
18. Both AE and DuckDB honor the canonical half-open `[from, to)` range — upper
    bounds are exclusive so adjacent ranges never double-count.
19. A late-arriving sample for an already-sealed Parquet day is merged on the
    next archive tick, never dropped — `sealDayToParquet` rebuilds from the
    union of the sealed file and the day's hot rows.
20. The store/binding/dataset are unsuffixed. `app.ts`/`db.ts`/`workers.ts`/
    `do.ts`/`offline-sweep.ts`/`store-selection*.ts` carry only
    `serverMetricsStore`, `resolveServerMetricsStore`, and `SERVER_METRICS`
    (dataset `turbopanel_server_metrics_v7`). Do not reintroduce a
    version-suffixed parallel store, binding, or dataset.

## Coverage and gaps

A host-series bucket carries `lastSampleAt` and `sampleSpacingSeconds` (collection interval × the store's sampling weight — an AE row with `_sample_interval = 2` stands for two samples). `computeSeriesCoverage` (`query/series-response.ts`) marks an empty bucket as a gap only when the next sample was due inside it; empty buckets on a grid finer than the cadence, or behind a down-sampled row, are not missing data, and buckets ending within the ingest lag of now are pending. The response's `gapBuckets` lists the real gaps; the ui bands only those and draws through the rest.
