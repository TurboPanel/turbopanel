# Server metrics — AGENTS.md

Host-metrics ingestion (`POST /api/daemon/v1/metrics`, never wakes the DO), positional storage (Cloudflare **Analytics Engine** on Workers, **ClickHouse** on Deno), and the query/caching API. The 20-metric order in `contract.ts` is an external storage contract — do not reorder.

Root context: `../../../AGENTS.md`. Daemon cell: `../cell/AGENTS.md`. Human docs + AE cost model: `../../../../website/docs/architecture/server-metrics.mdx`.

#### Server metrics (Workers Analytics Engine)

The **primary** write path is the authenticated `POST /api/daemon/v1/metrics` HTTP route handled on the normal Worker isolate (Analytics Engine) / Deno process (ClickHouse) — `validateHostMetricsSample` → fire-and-forget `ServerMetricsStore.writeHostSample` via `getServerMetricsStore(c)`, **never** waking the Durable Object. Metrics is **disposable / statistical / may be sampled** — queries must account for `_sample_interval`. Wiring: `SERVER_METRICS` binding → `AnalyticsEngineServerMetricsStore` (`src/daemon/metrics/analytics-engine/`). Deno uses ClickHouse (`ClickHouseServerMetricsStore`). Store selection: `resolveServerMetricsStore` (always on — no enable/disable gate; incomplete backend config uses a temporary no-op store until converge wires ClickHouse/AE). WebSocket `{ type: "metrics" }` frames are **no longer accepted** — ingestion is HTTP-only via `POST /api/daemon/v1/metrics`.

| Binding / config | Value |
|---|---|
| Wrangler binding | `SERVER_METRICS` (`analytics_engine_datasets`) |
| Dataset name | `turbopanel_server_metrics` (reused across top-level / `testing` / `live` — AE datasets are account-scoped and auto-created; docs do not require unique names per env) |
| Write API | `writeDataPoint({ indexes, doubles, blobs })` — sync, non-blocking (do not `await`) |
| SQL API | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql` with `Authorization: Bearer <token>` and raw SQL body; response is the standard Cloudflare v4 envelope — rows under `result.data` (never top-level `data`) |
| Query filters | Host reads always filter `blob1 = "host"` and `blob2` to supported schema version(s) from the field map / wire contract |
| Max range | Default `AE_DEFAULT_MAX_RANGE_SECONDS` = 90 days (documented AE retention); override via `AnalyticsEngineSqlConfig.maxRangeSeconds` / `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS` |
| Env (vars) | `CLOUDFLARE_ACCOUNT_ID`; optional `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS` |
| Env (secret) | `TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN` (Account Analytics Read) |

**20-metric storage contract** (`HOST_METRIC_KEYS` in `src/daemon/metrics/contract.ts` — order is the external storage/API contract; human docs: **`../website/docs/architecture/server-metrics.mdx`**):

| `doubleN` | Metric key |
|---|---|
| `double1` | `cpuUsagePercent` |
| `double2` | `cpuUserPercent` |
| `double3` | `cpuSystemPercent` |
| `double4` | `cpuIowaitPercent` |
| `double5` | `load1` |
| `double6` | `load5` |
| `double7` | `load15` |
| `double8` | `memoryUsedPercent` |
| `double9` | `memoryUsedBytes` |
| `double10` | `memoryAvailableBytes` |
| `double11` | `swapUsedPercent` |
| `double12` | `diskUsedPercent` |
| `double13` | `diskReadBytesPerSecond` |
| `double14` | `diskWriteBytesPerSecond` |
| `double15` | `diskReadOpsPerSecond` |
| `double16` | `diskWriteOpsPerSecond` |
| `double17` | `networkReceiveBytesPerSecond` |
| `double18` | `networkTransmitBytesPerSecond` |
| `double19` | `processCount` |
| `double20` | `uptimeSeconds` |

**Positional field map** (`src/daemon/metrics/analytics-engine/field-map.ts` — sole source of double/blob positions):

| Slot | Content |
|---|---|
| `indexes[0]` / `index1` | Authenticated `serverId` UUID only — never org/account/hostname/composite/metric/timestamp |
| `double1..double20` | `HOST_METRIC_KEYS` order (`cpuUsagePercent` … `uptimeSeconds`) |
| `blob1` | event type `"host"` |
| `blob2` | schema version (string) |
| `blob3`..`blob6` | daemonVersion, operatingSystem, architecture, kernelRelease |
| `blob7`..`blob20` | reserved empty strings until schema v2 |

**Missing metrics:** AE doubles have no null. Missing values are stored as `AE_MISSING_METRIC_SENTINEL` (`-1e308`) — never coerced to `0`. All host metrics are ≥ 0, so the sentinel cannot collide. Query aggregates exclude it via `if(doubleN = sentinel, 0, …)` around the documented `_sample_interval`-weighted average (`SUM(_sample_interval * doubleN) / SUM(_sample_interval)`). On the **AE SQL** path, compare against `-pow(10, 308)` (`aeMissingMetricSentinelSql()`) — AE docs do not list scientific-notation literals or `NULLIF`, and embedding `-1e308` / `NULLIF` fails chart queries with 503. Local vitest does not bind AE (unsupported in the local runner); unit tests use fakes only.

#### Server metrics (ClickHouse — self-hosted Deno)

Deno path: `ClickHouseServerMetricsStore` (`src/daemon/metrics/clickhouse/`) over a narrow HTTP client (`X-ClickHouse-User` / `X-ClickHouse-Key`) with request deadlines (insert **5 s**, query/schema **30 s** — `ClickHouseHttpTimeoutError`; chart routes still return **503** `metrics_backend_unavailable`). Writes are **batched in-process** (default max **10** rows / **5 min** age) before `insertRows`; queries force-flush pending batches. ClickHouse runs in a **Docker container** (official `clickhouse/clickhouse-server` image) — ports (`127.0.0.1:8123`) and env-injection are unchanged. Ansible install + env injection: **`../daemon/AGENTS.md`** (ClickHouse). Schema DDL is idempotent (`ensureSchema` once per process): `CREATE TABLE IF NOT EXISTS` plus `ALTER … MODIFY SETTING` (compact-part thresholds) and `ALTER … MODIFY TTL` so retention/`min_*_for_wide_part` apply to existing tables (`turbopanel_app` has `ALTER`).

**Positional storage (AE parity):** ClickHouse stores the exact positional AE layout — `timestamp`, `index1` (serverId), `double1..double20`, `blob1..blob20` — with **no** custom snake_case mapping. Physical column names come solely from `src/daemon/metrics/analytics-engine/field-map.ts` (`doubleColumnForMetric(key)` derives `doubleN` from `HOST_METRIC_KEYS` order; `blobColumn(i)` derives `blobN`; `AE_INDEX_SERVER_ID_COLUMN` / `AE_TIMESTAMP_COLUMN`). The operational-only columns (`received_at`, `sequence`, `interval_seconds`, `schema_version`, typed dimension columns) are **not** persisted. Missing metrics use the same `AE_MISSING_METRIC_SENTINEL` (`-1e308`) as Analytics Engine — never `null` or coerced `0`. Query aggregates exclude the sentinel with the same `if(doubleN = sentinel, …)` semantics as AE (unit-weight rows in ClickHouse vs `_sample_interval`-weighted rows in AE). `expectedSampleCount` is derived from `bucket_seconds / 60` (via `defaultExpectedSamplesPerBucket`). Compact-part settings (`min_bytes_for_wide_part` / `min_rows_for_wide_part`) keep tiny wide inserts Compact until a meaningful threshold.

| Env | Purpose |
|---|---|
| `TURBOPANEL_CLICKHOUSE_URL` | HTTP base (e.g. `http://127.0.0.1:8123`) |
| `TURBOPANEL_CLICKHOUSE_DATABASE` | App DB (`turbopanel_metrics`) |
| `TURBOPANEL_CLICKHOUSE_USER` | App user (`turbopanel_app`) |
| `TURBOPANEL_CLICKHOUSE_PASSWORD` | Generated secret (runtime.dev-vars) |
| `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS` | Table TTL days (default **90**) |

| Table | Role | Default TTL |
|---|---|---|
| `turbopanel_server_metrics` | MergeTree raw samples (`ORDER BY (index1, timestamp)`) — same physical name as the AE dataset | `retentionDays` (90) |

**Query-time bucketing:** there are no rollup tables or materialized views — resolution is chosen at query time (mirrors the AE SQL API).

**Late arrivals / duplicates:** accept all inserts into MergeTree (no `ReplacingMergeTree` / `FINAL`). Metrics is **disposable / statistical / may be sampled** — queries must account for `_sample_interval` (AE) or per-row unit weight (ClickHouse); intentional simplification.

**Fail clearly vs unconfigured:** a full ClickHouse config throws on connection/query failures (reads return **503** `metrics_backend_unavailable`). Incomplete-config (pre-converge) uses a temporary no-op store. This differs from the AE store's `available: false` soft path when SQL credentials are missing. Writes stay fire-and-forget at the WS boundary (`deno-ws.ts` catches rejected promises).

#### Server metrics — query API & caching

Endpoints (`src/client/servers/metrics-routes.ts`):

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/client/v1/servers/:id/metrics/series` | session + `assertCanReadOr403('server', id)` |
| `GET` | `/api/client/v1/servers/:id/metrics/summary` | session + `assertCanReadOr403('server', id)` |

Never authorize by bare UUID possession — session middleware + resource read grant required.

**Resolution ladder** (`src/daemon/metrics/query/resolution.ts`): range ≤6 h → 60 s; ≤24 h → 300 s; ≤30 d → 3600 s; else 86400 s (ClickHouse maps 60 → 300). **`MAX_METRICS_POINTS` = 1500**; range ≤**90 days**. One combined backend query per `(server, range)` — no per-metric or per-chart queries. Backend-neutral payload includes `gapCount`, `sampleCount`, and `expectedSampleCount` so the UI distinguishes zero values from missing samples.

**Chart cache** (`src/daemon/metrics/query/cache.ts`): key = `tp:metrics:chart:` + kind + authorized `serverId` + bucket-rounded range + sorted metrics + resolution + backend + `v{schemaVersion}`. TTL: **live 45 s** / **historical 300 s**. Workers: Cloudflare Cache API; Deno: bounded in-process `Map` (256 entries). Authorization is never globally cached — cache keys always include the authorized server id. Separate from the approved-read-models query cache — see `src/query-cache/AGENTS.md`.

UI charts: **`../ui/AGENTS.md`** (Server metrics). Human docs + AE cost model: **`../website/docs/architecture/server-metrics.mdx`**.
