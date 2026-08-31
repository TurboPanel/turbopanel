# Server metrics — AGENTS.md

Host-metrics ingestion (`POST /api/daemon/v1/metrics`, never wakes the DO), backend storage, and the query/caching API. `HOST_METRIC_KEYS` in `contract.ts` is a **named logical allowlist** (schema v2, 38 metrics) for the API/query surface only — it carries no storage ordering; physical positions are backend-private.

Root context: `../../../AGENTS.md`. Daemon cell: `../cell/AGENTS.md`. Human docs + AE cost model: `../../../../website/docs/architecture/server-metrics.mdx`.

#### Server metrics (Workers Analytics Engine)

The **primary** write path is the authenticated `POST /api/daemon/v1/metrics` HTTP route handled on the normal Worker isolate (Analytics Engine) / Deno process (DuckDB) — `validateHostMetricsSample` → fire-and-forget `ServerMetricsStore.writeHostSample` via `getServerMetricsStore(c)`, **never** waking the Durable Object. Metrics is **disposable / statistical / may be sampled** — queries must account for `double20 * _sample_interval` (AE) / `interval_seconds` (DuckDB). Wiring: `SERVER_METRICS` binding → `CloudflareAnalyticsEngineServerMetricsStore` (`src/daemon/metrics/backends/cloudflare/`). Deno uses DuckDB + Parquet (`DuckDbParquetServerMetricsStore`, `src/daemon/metrics/backends/duckdb/`). Store selection: `resolveServerMetricsStore` (always on — no enable/disable gate; a backend that cannot be constructed falls back to a temporary no-op store). WebSocket `{ type: "metrics" }` frames are **no longer accepted** — ingestion is HTTP-only via `POST /api/daemon/v1/metrics`.

**Two-datapoint layout:** one AE data point only holds 20 doubles, so each v2 host sample (38 metrics) is written as **two** data points — `blob2 = "core"` and `blob2 = "extended"`, 19 fixed metrics each (`CORE_METRIC_KEYS` / `EXTENDED_METRIC_KEYS` in `field-map.ts`), with `double20 = intervalSeconds` reserved on both. Cost: 2 writes/sample ≈ 2,880 writes/day/server at the 60 s baseline — well under Cloudflare's 250-datapoints-per-invocation limit.

| Binding / config | Value |
|---|---|
| Wrangler binding | `SERVER_METRICS` (`analytics_engine_datasets`) |
| Dataset name | `turbopanel_server_telemetry` (reused across top-level / `testing` / `live` — AE datasets are account-scoped and auto-created; docs do not require unique names per env). Brand-new name for the two-part layout — the retired single-datapoint dataset `turbopanel_server_metrics` is never queried |
| Write API | `writeDataPoint({ indexes, doubles, blobs })` — sync, non-blocking (do not `await`); host samples call it twice (core, then extended) |
| SQL API | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql` with `Authorization: Bearer <token>` and raw SQL body; response is the standard Cloudflare v4 envelope — rows under `result.data` (never top-level `data`) |
| Query filters | Host reads always filter `blob1 = "metrics"`, `blob3` to supported schema version(s) from the field map / wire contract, and first recombine the two part rows into one **logical sample per `(index1, timestamp)`** in a subquery (part-scoped `blob2` aggregates; logical rows without a core part — orphaned extended writes — are dropped) before bucket/server aggregation, so `sample_count` / `latest_at` / metric averages all describe the same logical rows; `sample_count` counts the core part only. All ranges are canonical half-open `[from, to)` (exclusive right edge, same as DuckDB) |
| Max range | Default `AE_DEFAULT_MAX_RANGE_SECONDS` = 90 days (documented AE retention); override via `CloudflareAnalyticsSqlConfig.maxRangeSeconds` / `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS` |
| Env (vars) | `CLOUDFLARE_ACCOUNT_ID`; optional `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS` |
| Env (secret) | `TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN` (Account Analytics Read) |

**Metrics contract** (`HOST_METRIC_KEYS` in `src/daemon/metrics/contract.ts` — schema v2, 38 metrics; human docs: **`../website/docs/architecture/server-metrics.mdx`**): a **named logical allowlist** for the wire/API/query surface. Positional storage (Cloudflare doubles/blobs, DuckDB columns) is defined per-backend in backend-owned field-map/schema files introduced by the backend phases — never derived from this list's order.

**Backend-private physical layout** (stable non-metric slot invariants below; **metric-value slot assignment is backend-private** — which `doubleN` holds which v2 metric is defined solely by the backend-owned field-map/schema files introduced by the backend phases, e.g. `src/daemon/metrics/backends/cloudflare/field-map.ts` for AE. Never derive physical positions from `HOST_METRIC_KEYS` order or from this document — the v2 allowlist is logical-only and carries no ordering contract):

| Slot | Content |
|---|---|
| `indexes[0]` / `index1` | Authenticated `serverId` UUID only — never org/account/hostname/composite/metric/timestamp |
| `double1`..`double19` | metrics rows: the part's 19 metric values in `CORE_METRIC_KEYS` / `EXTENDED_METRIC_KEYS` order (backend-private) |
| `double20` | metrics rows (both parts): the sample's `intervalSeconds` (`AE_DOUBLE_INTERVAL_INDEX`) — the weighting term for all aggregates |
| `blob1` | event type discriminator — `"metrics"` (host sample part) or `"status"` (connection-status transition; see below) |
| `blob2` | metrics rows: part discriminator `"core"` / `"extended"` (empty on status rows) |
| `blob3` | schema version (string, both event types) |
| `blob4`..`blob7` | metrics rows: daemonVersion, operatingSystem, architecture, kernelRelease |
| `blob8`..`blob10` | metrics rows: collectionMode, daemon `at` timestamp (ISO), sequence |
| `blob11`..`blob14` | metrics rows: cpuTemperature / gpuTemperature / cpuPower / gpuPower sensor identities (empty when unselected) |
| `blob15`..`blob16` | metrics rows: uplink / fabric interface selections (comma-joined; empty when unselected) |
| `blob17` | status rows only: transition reason (empty on metrics rows) |
| `blob18`..`blob20` | reserved empty strings on every event type |

**Missing metrics:** AE doubles have no null. Missing values are stored as `AE_MISSING_METRIC_SENTINEL` (`-1e308`) — never coerced to `0`. All host metrics are ≥ 0, so the sentinel cannot collide. Query aggregates exclude it via `if(doubleN = sentinel, 0.0, …)` around the interval-and-sampling-weighted average, scoped to the part that owns the metric: `SUM(value * double20 * _sample_interval) / SUM(double20 * _sample_interval)` with rows of the other part (and sentinel rows) contributing `0.0` to both sides (`weightedAvgExpressionForMetric` in `sql-api.ts`). On the **AE SQL** path, compare against `-pow(10, 308)` (`aeMissingMetricSentinelSql()`) — AE docs do not list scientific-notation literals or `NULLIF`, and embedding `-1e308` / `NULLIF` fails chart queries with 503. Local vitest does not bind AE (unsupported in the local runner); unit tests use fakes only.

#### Status event stream (`blob1 = "status"`)

Every genuine `connected` flip on the `server` row (never a heartbeat/identity/daemonBuild-only touch) also fires a fire-and-forget **status event** — on AE into the same shared dataset as host samples (one row per transition, discriminated from host rows by `blob1`); on Deno/DuckDB into its own typed `server_status_events` table (never shared with host samples). Source: `emitServerStatusEvent` (`src/daemon/metrics/status-events.ts`), called from `projectServerDaemon` (`src/daemon/cell/postgres-projection.ts`) on every `existingStatus.connected !== nextStatus.connected` write, and registered per-runtime (request isolate, DO isolate, cron-only offline-sweep isolate, Deno process) via `setServerStatusEventSink` / `getServerStatusEventSink` — there is no shared request context across those four runtimes.

**Slot layout for `blob1 = "status"` rows** (`backends/cloudflare/field-map.ts`):

| Slot | Content |
|---|---|
| `blob1` | `AE_STATUS_EVENT_TYPE` = `"status"` |
| `blob3` | schema version (string) — same slot as metrics rows |
| `blob17` | `AE_BLOB_STATUS_REASON_INDEX` — `ServerStatusTransitionReason`: `"connect"` \| `"disconnect"` \| `"sweep_stale"` \| `"self_heal"` (closed enum, `src/daemon/metrics/types.ts`) |
| `double1` | `AE_DOUBLE_STATUS_CONNECTED_INDEX` — `1` (connected) or `0` (disconnected) |
| all other `double`/`blob` slots | `AE_MISSING_METRIC_SENTINEL` / empty string — a status row carries no host metrics and no part discriminator (`blob2` stays empty) |

AE stamps its own ingestion `timestamp` for status rows (`event.at` is not sent); DuckDB stores `event.at` directly as `at`, batched onto the same pending buffer/flush timer as host samples but inserted into `server_status_events` (durability window is ≤ the batch max-age unless a query force-flushes; status history is disposable like host metrics).

**Query path (AE + DuckDB parity):** `queryStatusHistory` (`ServerMetricsStore`) resolves `{ from, to }` into two reads — prior state (last known `connected` strictly before `from` — `buildStatusPriorStateSql` on AE, an `ORDER BY at DESC LIMIT 1` over `server_status_events` on DuckDB) and in-range transitions (`buildStatusEventsSql` on AE; capped at `MAX_STATUS_EVENTS` on both, `resolveTruncatedStatusEvents` marks `truncated: true` + a `knownUntilMs` when the cap is hit). Both backends hand their rows to the shared, backend-neutral `computeStatusUptime` (`src/daemon/metrics/query/uptime.ts`) so AE and DuckDB produce identical `uptimeSeconds` / `downtimeSeconds` / `unknownSeconds` / `uptimePercent` for the same range — the same parity-seam pattern as `finalizeHostSeriesResult` / `computeSeriesGapCount` for host series. A `null` prior state (nothing before `from`) or the truncated suffix after `knownUntilMs` accrues to `unknownSeconds`, never uptime/downtime. Exposed via `GET /api/client/v1/servers/:id/metrics/connection` (`src/client/servers/metrics-routes.ts`), cached the same way as `/metrics/series` (see below).

**History-only — never authoritative for liveness.** This event stream (and everything derived from it: uptime/downtime charts, the `/metrics/connection` endpoint) exists purely for historical reporting. It is asynchronous, best-effort, sampled/disposable like all server metrics, and **must never be read to determine whether a server is currently online**. The Postgres `server.is_connected` / `server.status_changed_at` columns (via `src/daemon/cell/server-status.ts`) are the sole source of truth for current liveness — see `src/lib/db/AGENTS.md` (`server` table) and `src/daemon/cell/AGENTS.md` (Postgres status read model). Do not add a code path that gates any online/offline decision on AE/DuckDB status history.

#### Server metrics (DuckDB + Parquet — self-hosted Deno)

Deno path: `DuckDbParquetServerMetricsStore` (`src/daemon/metrics/backends/duckdb/`) over the embedded `@duckdb/node-api` engine — no external service, no credentials. Everything lives under the metrics state root (`resolveMetricsDir()` — `TURBOPANEL_METRICS_DIR`, default `<stateDir>/metrics`): `metrics.duckdb` (hot database), `parquet/` (sealed daily partitions), `tmp/` (DuckDB spill + in-flight exports). Writes are **batched in-process** (default max **10** rows / **5 s** age — loaded instances flush on row count, sparse traffic flushes promptly on age) into one transaction; queries force-flush pending batches, and `deno-server.ts` closes the store on SIGINT/SIGTERM so pending accepted rows persist across a graceful shutdown. Schema DDL is idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`, applied once per open in `database.ts`).

**Two real typed tables — no positional layout, no sentinel** (`schema.ts` is the DuckDB backend's own private field map, independent of `backends/cloudflare/field-map.ts`):

| Table | Columns |
|---|---|
| `server_metric_samples` | `server_id UUID`, `sampled_at TIMESTAMP`, `received_at TIMESTAMP`, `interval_seconds SMALLINT`, `collection_mode VARCHAR`, plus one nullable `DOUBLE` per `HOST_METRIC_KEY` named via `metricColumnName(key)` (snake_case, e.g. `cpu_user_percent`) |
| `server_status_events` | `server_id UUID`, `at TIMESTAMP`, `connected BOOLEAN`, `reason VARCHAR` |

Missing metrics are **real SQL `NULL`s** — never `AE_MISSING_METRIC_SENTINEL`, never coerced `0`. Bucket aggregation is **per-metric**, driven by the active `HOST_METRICS_METRIC_DESCRIPTORS[key].aggregation` policy (`src/daemon/metrics/metric-descriptors.ts`; same policy map on both backends): `weighted-average` metrics use an `interval_seconds`-weighted average over the present rows (`SUM(value * interval_seconds) / SUM(interval_seconds) FILTER (WHERE value IS NOT NULL)`), `last` metrics (slow-moving storage capacities) keep the latest observed value in the bucket, and `max` metrics (`uptimeSeconds`) take the bucket maximum. `expectedSampleCount` is **interval-aware** (`defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSeconds)` in `query/series-response.ts`): buckets with data divide the bucket width by the bucket's observed average collection interval (so fast-cadence live sessions do not read as over-full), and empty buckets fall back to the 60 s baseline interval. Query parameters are bound as DuckDB prepared parameters (UUIDs included) — never string-quoted interpolation.

**Daily Parquet archive** (`parquet.ts`; timer armed once at boot by `deno-server.ts` via `startDailyArchiveTimer()`, drivable in tests via `runDailyArchiveOnce()`): each completed UTC day is sealed out of the hot table into `parquet/server-metrics/year=YYYY/month=MM/day=DD/metrics.parquet` — export to `tmp/`, validate the produced file's row count by re-reading it, atomic rename into the partition tree, and only then delete the hot rows. Interrupted exports (`tmp/*.parquet`) are swept on the next tick and never mistaken for sealed partitions. Reads union the hot table with the partitions overlapping the range (`read_parquet([...], union_by_name := true)`). Retention (`TURBOPANEL_SERVER_METRICS_RETENTION_DAYS`, default **90**) prunes expired partitions plus any hot/status rows past the cutoff (defense-in-depth for missed archive days).

| Env | Purpose |
|---|---|
| `TURBOPANEL_METRICS_DIR` | Metrics state root override (see `resolveMetricsDir`) |
| `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS` | Retention days (default **90**) |
| `TURBOPANEL_SERVER_METRICS_DUCKDB_THREADS` | DuckDB `SET threads` cap (default **2**) |
| `TURBOPANEL_SERVER_METRICS_DUCKDB_MEMORY_LIMIT` | DuckDB `SET memory_limit` in MiB (default **128**) |

**Query-time bucketing:** there are no rollup tables — resolution is chosen at query time (mirrors the AE SQL API). All DuckDB reads honor the canonical half-open `[from, to)` range — upper bounds are exclusive (`sampled_at < to`, `"at" < to`, and partition scans use `dayStartMs < toMs`) so adjacent ranges never double-count the right edge (matches `computeSeriesGapCount` / cache-range canonicalization).

**Late arrivals / duplicates:** accept all inserts. A late sample for an already sealed day is merged on the next archive tick — `sealDayToParquet` rebuilds the partition from the union of the existing sealed file and the day's hot rows (idempotent, one file per day, never drops archived rows). Metrics is **disposable / statistical / may be sampled** — queries must account for `_sample_interval` (AE) or `interval_seconds` weights (DuckDB); intentional simplification.

**Fail clearly vs unconfigured:** DuckDB/filesystem failures on reads throw (chart routes return **503** `metrics_backend_unavailable`). A store that cannot even be constructed (metrics directory not creatable) falls back to a temporary no-op store with a warn-once. This differs from the AE store's `available: false` soft path when SQL credentials are missing. Writes stay fire-and-forget at the ingest boundary.

**Cross-backend parity:** `src/daemon/metrics/backends/cloudflare/write-path-parity.test.ts` pins the two-part write invariants — `CORE_METRIC_KEYS ∪ EXTENDED_METRIC_KEYS === HOST_METRIC_KEYS` (no overlap/gaps), `double20` reserved for `intervalSeconds` on both parts, and exactly two `writeDataPoint` calls per host sample (`blob2 = "core"` / `"extended"`, full 20/20 shapes). Shape parity across backends is held by the shared backend-neutral seams (`computeStatusUptime`, `finalizeHostSeriesResult` / `computeSeriesGapCount`) both stores flow through.

#### Server metrics — query API & caching

Endpoints (`src/client/servers/metrics-routes.ts`):

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/client/v1/servers/:id/metrics/series` | session + `assertCanReadOr403('server', id)` |
| `GET` | `/api/client/v1/servers/:id/metrics/summary` | session + `assertCanReadOr403('server', id)` |
| `GET` | `/api/client/v1/servers/:id/metrics/connection` | session + `assertCanReadOr403('server', id)`; status-event history (uptime/downtime) — see "Status event stream" above |
| `GET` | `/api/client/v1/servers/metrics/latest` | session + `listVisible('server')`; one fleet snapshot (CPU / memory / swap % over a fixed ~10 min lookback) for the org servers overview — **never** N per-server chart calls |

Never authorize by bare UUID possession — session middleware + resource read grant required. Fleet latest never accepts client-supplied serverIds (always filters to `listVisible`).

**Resolution ladder** (`src/daemon/metrics/query/resolution.ts`): range ≤10 min → 10 s; ≤1 h → 60 s; ≤6 h → 300 s; ≤24 h → 900 s; ≤7 d → 3600 s; ≤30 d → 21600 s; else 43200 s (allowed steps: `10 / 60 / 300 / 900 / 3600 / 21600 / 43200` — `METRICS_RESOLUTION_SECONDS`; a client-requested resolution must be one of these, and the chosen step is clamped upward until the range fits `maxPoints`). **`MAX_METRICS_POINTS` = 1500**; range ≤**90 days**. One combined backend query per `(server, range)` — no per-metric or per-chart queries. Backend-neutral payload includes `gapCount`, `sampleCount`, and `expectedSampleCount` so the UI distinguishes zero values from missing samples. **Coverage grid is half-open `[from, to)` on bucket starts** (`computeSeriesGapCount` / UI `normalizeMetricsGrid`) — inclusive end would always expect the in-progress `to` bucket on live charts (e.g. 1 h @ 60 s → 61 slots) so coverage could almost never hit 100%.

**Fleet latest snapshot** (`queryFleetHostSnapshot` / `GET …/servers/metrics/latest`): one AE/DuckDB `GROUP BY server_id` over authorized ids with `_sample_interval`-weighted (AE) / `interval_seconds`-weighted (DuckDB) averages for the fleet usage metric set (`cpuUsagePercent` + CPU breakdown + load averages + memory/swap). Used by the UI servers overview totals + usage bars. Cap `MAX_FLEET_SNAPSHOT_SERVERS` = 500.

**Chart cache** (`src/daemon/metrics/query/cache.ts`): key = `tp:metrics:chart:` + kind + authorized `serverId` + bucket-rounded range + sorted metrics + resolution + backend + `v{schemaVersion}`. TTL: **live 45 s** / **historical 300 s**. Workers: Cloudflare Cache API; Deno: bounded in-process `Map` (256 entries). Authorization is never globally cached — cache keys always include the authorized server id. Separate from the approved-read-models query cache — see `src/query-cache/AGENTS.md`.

UI charts: **`../ui/AGENTS.md`** (Server metrics). Human docs + AE cost model: **`../website/docs/architecture/server-metrics.mdx`**.
