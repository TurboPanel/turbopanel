# Container logs

Storage for the stdout/stderr a **running container** produces, stamped with
the identity of where it came from: `organization → server → environment →
service → container`. Contract in `types.ts`; every driver implements the same
`ContainerLogStore` interface.

Current status: **end to end, and default-off.** The contract, the ClickHouse
(Deno) driver, the Cloudflare (Workers) driver, the selector, the daemon
collector, the batched ingest route, the per-organization toggle, and the client
read route are all in place. Both entrypoints (`src/workers.ts`,
`src/deno-server.ts`) resolve the store at init and publish it on the Hono
context as `containerLogStore` (`AppEnv` in `src/app.ts`), so a misconfiguration
warns in production rather than only in tests.

## The pipeline, end to end

```
organization.options.containerLogsEnabled
        │  (read on every hello / heartbeat / cell ping; TTL-cached)
        ▼
presence-ack { containerLogsEnabled }  ──────────────▶  daemon collector
        │                                                 (tails, redacts,
        │                                                  ring-buffers, batches)
        │                                                        │
        │                                                        ▼
        │                              POST /api/daemon/v1/logs/containers
        │                                                        │
        │                                    org stamped from the JWT `sub`
        │                                                        ▼
        │                                          ContainerLogStore.ingest()
        ▼                                                        │
GET /api/client/v1/organizations/:id/container-logs  ◀────────────┘
```

### Enablement rides presence, not a command

`src/daemon/container-logs-presence.ts` answers every `hello` / `heartbeat` with
`{ type: "presence-ack", at, containerLogsEnabled }`, on both transports
(`daemon/deno-ws.ts` and the Durable Object's `#handlePresenceMessage`). The
daemon starts or stops its collector when the flag changes.

**A toggle has to reach an idle daemon too.** Change-detected heartbeats alone
do not: a daemon whose facts never move would keep collecting (or keep not
collecting) until some unrelated fact happened to change. Two things close that,
both reusing existing frames rather than adding a command type — the daemon
sends a bare refresh `heartbeat` on a floor cadence
(`turbopaneld/src/instance/idle-presence.ts` → `PRESENCE_REFRESH_MS`, the only
option on Workers, where the cell ping is auto-responded without waking the DO),
and the Deno transport additionally acks the once-a-minute cell ping. The
projection read is TTL-cached (`loadServerContainerLogsEnabledCached` /
`peekDaemonContainerLogsFlag`, `CONTAINER_LOGS_FLAG_TTL_MS`) so neither path
becomes a query per frame. On Workers the Durable Object peeks the cache
**before** opening Hyperdrive and warms it during connect/inbound projection
on the already-open client.

A command would have needed queueing, leasing, an outcome, and a retry story for
**one boolean that is already re-sent on the next presence frame**. The ack
costs one frame on a socket that is already open, and converges by construction
after a daemon restart, a control-plane restart, or a toggle the daemon was
offline for. It is outbound-only and is deliberately absent from
`DAEMON_INBOUND_ALLOWED`. Presence-ack Hyperdrive work is a cache miss only
(connect/inbound already warm the cache on an open client) — see
`../../daemon/cell/AGENTS.md` → Presence ack. Any
failure resolves to `false`: off is the safe direction for a billed,
high-volume feature.

### Ingest route

`POST /api/daemon/v1/logs/containers` (`daemon/api-routes.ts`, helpers in
`daemon/container-log-ingest.ts`). Like `/metrics` it must **never** touch the
Durable Object.

- **Nothing identifying is read from the body.** `serverId` comes from the
  verified JWT `sub`; `organizationId` from that server's row. The daemon sends
  both for wire-shape parity and both are overwritten. A server that belongs to
  no organization gets 403 — there is no tenant to attribute output to.
- **The org switch is re-checked on every write.** `loadContainerLogIngestTarget`
  resolves the owning organization *and* `options.containerLogsEnabled` in the
  same join, and a batch for a switched-off org is accepted-and-dropped
  (`202 { accepted: 0 }`). The presence ack is allowed to lag a toggle by a
  cache window because it only decides when a daemon *stops sending*; a write is
  what actually persists tenant output, so it honours the switch as of now.
  Deliberately not the TTL-cached presence read.
- **A malformed event rejects the whole batch** (400). Keeping the good half
  would hide a daemon bug.
- **A store failure still answers 202.** Container output is disposable
  telemetry; a 5xx would only make the daemon re-send what nowhere can hold.
- **Its own rate limiter.** `CONTAINER_LOGS_RATE_LIMITER` /
  `daemonContainerLogsRateLimitKey`, not the shared daemon REST bucket: batched
  container output is far burstier than enroll/session/decrypt and must not be
  able to starve them. Wrangler `{ limit: 60, period: 60 }` per env, mirrored by
  `resolveDaemonContainerLogsRateLimit` on the Deno/Redis side.
- **Body budget** is `MAX_CONTAINER_LOG_BATCH_BODY_BYTES` (4 MB), deliberately
  *not* `MAX_CONTAINER_LOG_INGEST_BATCH × MAX_CONTAINER_LOG_MESSAGE_BYTES` —
  that product is 160 MB and would be a denial-of-service budget, not a limit.

### Organization toggle

`organization.options.containerLogsEnabled` (single boolean, `null` clears it),
parsed by `org-settings.ts` and exposed as manage-gated
`GET`/`PUT /api/client/v1/organizations/:id/container-logs-settings`.

Deliberately **not** a cascade like `../host-defaults.ts`: retention is billed
and stored per tenant, so there is no lower layer that could sensibly override
it. Retention length is the platform-wide `CONTAINER_LOG_RETENTION_DAYS`; a
per-org override is not part of this phase. `parseContainerLogsEnabledInput`
rejects truthy non-booleans rather than coercing — `"yes"` must not switch on a
billed feature.

### Read route

`GET /api/client/v1/organizations/:id/container-logs`. The organization comes
from the **path**, after the access check; `parseContainerLogQueryParams` has no
parameter for it, so a query string cannot widen a read past the authorized org.
Defaults to the last hour when neither bound is given, clamps `limit`, and
rejects an inverted window.

The gate has **two independent inputs, checked in this order**:

1. `organization.options.containerLogsEnabled` — the authoritative retention
   switch, loaded from the org row before the store is consulted at all. Off →
   **503 `container_logs_disabled`**, however healthy the backend is. An org
   that never opted in has nothing stored, so querying a live backend for it
   would only ever return another era's rows.
2. The resolved store — backend availability. Disabled or unbound → the same
   **503 `container_logs_disabled`** rather than an empty page: "you never
   turned this on" and "your containers printed nothing" must not look alike.

A `ContainerLogStoreUnavailableError` from the public-beta Cloudflare backend
becomes 503 `container_logs_unavailable`. All four org/backend combinations are
pinned in `container-log-routes.hostfree.test.ts`.

### Daemon collector

`../../../../turbopaneld/src/logs/container-collector.ts`. Tails each container
with `docker container logs --follow --timestamps`, redacts against the same
process-wide deny-set as command transcripts (fed through
`turbopaneld/src/logs/capture.ts`), and ring-buffers with **drop-oldest**
overflow. Unlike execution logs there is **no spool file**: container output is
disposable, so a wedged uploader costs bounded memory instead of the host disk.

**Identity comes from deployment state, not from container labels.** `docker ps`
answers only "which container ids are alive" (filtered on Compose's own
`com.docker.compose.project`); the environment and service ids come from the
`deployment.json` this daemon wrote (`deploy/compose-files.ts`, whose
`serviceIds` map keys compose service name → service UUID). A
`com.turbopanel.*` label that drifted, was stripped, or was re-stamped outside
the deployment pipeline can no longer misattribute a line.

**It survives the outages it exists for.** The deny-set and the per-container /
per-environment tail cursors are process-wide, so a collector that starts late
or restarts still redacts previously decrypted values and re-attaches with
`--since <cursor>` instead of `--tail 0` — including for a *recreated*
container, which has a new id but inherits its environment's cursor. A dropped
WebSocket does **not** stop collection: the collector holds batches while the
transport is down (`readyToSend`) and ships them on reconnect.

## Why this *is* an analytics table

Container logs are queried **across servers, services and time**: "everything
my organization's `api` service logged in the last hour containing
`ECONNREFUSED`". That is a scan-with-predicates over an unbounded row set —
precisely the question a columnar store exists to answer, and precisely the
question a keyed-object layout cannot answer at all without listing and reading
every object.

This is the **mirror image** of execution logs
(`../execution-logs/AGENTS.md`), which are only ever read whole (or resumed
from an offset) for one `commandId`, and therefore correctly live as keyed
objects with no table to maintain. The two subsystems look superficially alike
("logs") and are storage opposites on purpose. **Do not unify them.** If you
find yourself wanting to put execution logs in `container_logs`, or container
logs in R2/S3, re-read both documents first.

Host metrics (`../../daemon/metrics/AGENTS.md`) are the closer relative:
same database, same ClickHouse HTTP client, same `ensureSchema()` /
`warnOnce` / disabled-fallback shape.

## Predicates fix the physical layout

`ContainerLogQuery` is deliberately a **closed** predicate set —
`organizationId` (required) plus optional `serverId`, `environmentId`,
`serviceId`, `containerId`, `stream`, `search`, over a required `[from, to)`
window. That set is not just an API surface; it is the storage plan:

```
ORDER BY (organization_id, server_id, service_id, timestamp)
PARTITION BY toYYYYMM(timestamp)
```

Most-selective-first, with `timestamp` **last** so a per-service tail is a
range read rather than a scan. `service_id` sits ahead of `timestamp` even
though it is `Nullable(UUID)` — ClickHouse orders NULL consistently, and moving
time earlier in the key would trade the common query for a rare one. MergeTree
defaults `allow_nullable_key = 0`, so both `schema.ts` and the Ansible
`bootstrap.yml` CREATE must set `SETTINGS allow_nullable_key = 1` or ClickHouse
26.x fails the table with `ILLEGAL_COLUMN` (`Sorting key contains nullable
columns`).

The same tuple is the **Iceberg partition/column plan** for the next backend,
which is why the predicate set is fixed now. Widening it later is a storage
migration, not a type change.

`environment_id` is not in the sort key: it is derivable from the service in
the common case and querying by environment alone is rare enough to accept a
partition scan.

## Tenancy

`organizationId` is a **required, non-optional** field on every query, and the
store scopes every read to it. The store has **no knowledge of authentication**
and cannot enforce anything for you:

> The caller MUST pass the *authenticated* organization id. It must never
> forward an organization id read from a request body, query string, or header.

`server.organization_id` is a real column on the control plane, so the ingest
endpoint resolves the org from the daemon's authenticated server — it does not
accept one, and the read route takes it from the authorized path parameter.
Both are covered by tests that feed a hostile `organizationId`/`serverId` in the
body and query string; **do not regress them.**

## Default-off

Unlike host metrics (always on, no gate), container logs are **opt-in**.

Two separate switches, and they answer different questions — do not conflate
them:

| Switch | Where | Question it answers |
| --- | --- | --- |
| `organization.options.containerLogsEnabled` | org row | Does *this tenant* retain container output? |
| `TURBOPANEL_CONTAINER_LOGS_ENABLED` + backend config | `deno-server.ts` / `workers.ts` | Can *this deployment* retain anything at all? |

The **org switch is the retention gate**: it is re-read on every ingest write
and on every read request. The runtime env/config is **backend availability
only** — a platform-level kill switch. `resolveContainerLogStore({ enabled })`
returns `DisabledContainerLogStore` whenever `enabled` is falsy, regardless of
runtime or how complete the ClickHouse config is, and both entrypoints then call
`setContainerLogBackendAvailable(...)` so `resolveDaemonContainerLogsFlag` ANDs
it into the presence ack. Without that, daemons on a deployment with no backend
would happily tail, redact, batch, and POST output the ingest route can only
drop. Container output is high-volume; the operator chooses to pay for it.

| Runtime | Store | Selected when |
| --- | --- | --- |
| Deno | `ClickHouseContainerLogStore` | `enabled` **and** a complete ClickHouse config |
| Workers | `PipelinesIcebergContainerLogStore` | `enabled` **and** a `CONTAINER_LOGS` Pipelines binding **and** a complete R2 SQL config |
| either | `DisabledContainerLogStore` | `enabled` is falsy, or config incomplete |

`warnOnce` fires only when the operator **asked** for container logs and
nothing can serve them, so a misconfiguration is visible instead of silent data
loss. A disabled `enabled: false` is the expected steady state and stays quiet.

Every method on the disabled store is a safe no-op, so **callers never branch
on availability**.

## ClickHouse

Table `container_logs` lives in the **same database as host metrics**
(`turbopanel_metrics`) and is written by the **same least-privilege
`turbopanel_app` user**. The Ansible bootstrap grant is already
`<database>.*`-scoped:

```sql
GRANT SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER, SHOW
  ON turbopanel_metrics.* TO turbopanel_app;
```

so the table needs **no new grant**. It is created at converge time by
`roles/clickhouse/tasks/bootstrap.yml`, which carries the same DDL as
`clickhouse/schema.ts` — a fresh install therefore has `container_logs` before
any application traffic arrives, instead of waiting for the first lazy
`ensureSchema()`. Both paths are idempotent, so whichever runs first wins and
the other reconciles; **change the DDL in both places or not at all.** See
`../../../../turbopaneld/orchestration/AGENTS.md` → ClickHouse.

`ensureSchema()` is instance-owned and idempotent (`CREATE TABLE IF NOT
EXISTS` + `ALTER … MODIFY TTL`), memoized per process and coalesced in-flight,
exactly like `ClickHouseServerMetricsStore`. Default TTL is 30 days.

The driver **reuses** `src/daemon/metrics/clickhouse/client.ts` rather than
forking a second HTTP client — there is one ClickHouse wire protocol in this
repo. It deliberately does **not** import that module's private guards; the
two small timestamp/UUID helpers are duplicated so container logs stay
decoupled from the metrics store's internals.

`ingest()` takes an **already-batched** array and issues exactly one
`JSONEachRow` insert. The daemon-side collector batches; the store never
re-batches and never inserts per event. An empty batch is a no-op that does not
even touch the schema.

### Pagination limitation (known, not hidden)

The cursor is an opaque encoding of the last row's `timestamp`, and the next
page asks for `timestamp < cursor`. There is no stable per-row tie-break in the
table (no monotonic insert sequence, and adding a column costs every row), so a
page boundary landing *inside* a run of rows sharing one millisecond drops the
remainder of that run. The alternative — `OFFSET` over a retention window —
degrades far worse. The Iceberg backend will carry a real sequence column and
retire this.

## Cloudflare (Pipelines → R2 Data Catalog → R2 SQL)

`cloudflare/pipeline-store.ts` is the Workers mirror of the ClickHouse driver:
**Pipelines in, R2 SQL out.**

Writes go to a Workers Pipelines binding (`env.CONTAINER_LOGS.send(records)`)
whose Stream sinks into an Apache Iceberg table in R2 Data Catalog. Reads go to
the R2 SQL HTTP query API:

```
POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{account_id}/r2-sql/query/{bucket}
Authorization: Bearer <R2 SQL + R2 Data Catalog + R2 storage read token>
{ "query": "SELECT … FROM namespace.table WHERE … LIMIT n" }
```

Config comes from `cloudflare/config.ts` →
`resolveContainerLogsCloudflareConfig(env)`, styled exactly like
`resolveAnalyticsEngineSqlConfig`: `CLOUDFLARE_ACCOUNT_ID`, the secret
`TURBOPANEL_CONTAINER_LOGS_R2_SQL_API_TOKEN`,
`TURBOPANEL_CONTAINER_LOGS_R2_SQL_BUCKET`, and the catalog identifier
`TURBOPANEL_CONTAINER_LOGS_ICEBERG_TABLE` (`namespace.table`, defaulted). Any
missing credential returns `null` and the selector falls back to disabled.

The Pipelines binding is consumed through a **structural** `PipelineLike`
(`{ send(records): Promise<void> }`), the same pattern as `R2BucketLike` in
`../execution-logs/r2-store.ts`, so the Deno type-check needs no Workers types.

### Column plan

The Iceberg columns are the ClickHouse `ORDER BY` tuple verbatim —
`(organization_id, server_id, service_id, timestamp)` — followed by the
remaining predicates: `environment_id`, `container_id`, `stream`, `message`.
**One column per predicate, never a JSON blob**, so the engine can prune data
files instead of parsing rows. `buildContainerLogR2Sql` emits `WHERE` clauses in
that same order for the same reason. This is why the predicate set was fixed in
`types.ts` before either driver existed.

### Batching is the cost story

`ingest()` takes an already-batched array and issues **exactly one**
`send`. R2 Data Catalog bills catalog operations per-million and compaction
per-GB and per-object, so a send-per-line write path would multiply both — many
tiny data files, each needing a catalog commit and later compaction. The
daemon-side collector batches; this store never splits, re-batches, or sends per
event, and an empty batch never touches the binding. (Concrete rates live in the
website docs, not here — pricing constants belong in exactly one place.)

### Query budget — no ceiling exists, so this path fails closed

**There is no scanned-bytes ceiling on this backend, because R2 SQL does not
offer one.** It bills on compressed bytes scanned (10 MB minimum per query),
but its HTTP query API accepts exactly one field, `{ "query": "…" }` — no
`max_bytes_scanned`, no cost cap, no timeout knob. Nothing in this repo can
enforce a per-request byte budget against it, and we deliberately do not carry
a config field that would pretend to. If Cloudflare ships one, add it to
`ContainerLogsCloudflareConfig` and to the `executeR2Sql` body in the same
change, and relax the guards below to match.

Because no hard ceiling can be *sent*, the guards that run before the request
leaves the process are deliberately conservative, and the widest reads are
**refused rather than issued**:

- **Row count** — `resolveContainerLogQueryLimit` clamps to
  `MAX_CONTAINER_LOG_QUERY_LIMIT` (1000), well inside R2 SQL's own 1–10,000
  `LIMIT` bound, and a `LIMIT` is always emitted.
- **Time window** — a `to - from` span wider than `maxRangeSeconds` is a
  `TypeError`, not a very expensive scan. The default is **24 hours**
  (`CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS`), deliberately **not** the
  30-day retention window: defaulting the read budget to "everything we retain"
  would make the accidental query the expensive one. Raise it knowingly with
  `TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_RANGE_SECONDS`.
- **Selectivity** — `organization_id` alone prunes no Iceberg data files inside
  the window, so an unfiltered read scans every file for every server the tenant
  owns. Such a query is capped at `maxUnselectiveRangeSeconds` (default **one
  hour**, `TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_UNSELECTIVE_RANGE_SECONDS`,
  never allowed above `maxRangeSeconds`); past that, `assertScanBudget` raises
  `ContainerLogStoreUnavailableError` and the route answers **503
  `container_logs_unavailable`** naming the missing ceiling. Adding any of
  `serverId` / `serviceId` / `containerId` lifts the read to the wider bound.
  The read route's own default window
  (`DEFAULT_CONTAINER_LOG_QUERY_WINDOW_MS`, one hour) sits inside the
  unfiltered bound on purpose, and a test pins that.

The first two remain *proxies* for scan cost, not caps on it: actual bytes read
still depend on data-file sizes and compaction state. The operational guardrail
is therefore compaction plus a narrow window — keep R2 Data Catalog compaction
on, and treat partition (timestamp) filters as mandatory, which
`buildContainerLogR2Sql` guarantees by requiring `[from, to)`.

There is **no parameter binding** in the R2 SQL API — it takes one SQL string,
exactly like the Analytics Engine SQL API. Every literal is therefore either
validated against a strict shape (UUID, ISO timestamp, `stdout`/`stderr`,
`namespace.table`) or escaped by `quoteR2SqlString`. `organization_id` is
injected by the store from `ContainerLogQuery.organizationId` and is always the
first predicate; a caller cannot omit, widen, or override it.

### Pagination: fixed here, unlike ClickHouse

This is the one deliberate **divergence** from the ClickHouse driver. ClickHouse
paginates on `timestamp` alone and therefore drops the tail of any run of rows
sharing one millisecond that straddles a page boundary (see above) — adding a
tie-break column there would cost every existing row. The Iceberg table is new,
so it carries a `row_id` from the first write. The values are not meaningful;
they exist only to make `(timestamp, row_id)` a **total order**, so
`ORDER BY timestamp DESC, row_id DESC` plus a keyset predicate on the pair
skips and repeats nothing. The cursor is an opaque encoding of that pair.

### Public beta

R2 Data Catalog and R2 SQL are both Cloudflare **public-beta** products. This
path must always degrade gracefully rather than hard-fail a request: config
resolution returns `null` (→ disabled store) instead of throwing, and transport
or envelope failures surface as `ContainerLogStoreUnavailableError` so the read
route can answer `503` rather than `500`. The response unwrap
(`parseR2SqlResponse`) is deliberately tolerant of both the client/v4 envelope
and a bare `{ rows }` / `{ data }` body, mirroring
`parseCloudflareV4SqlResponse` rather than inventing a second dialect — a beta
envelope that shifts should not cost a redeploy.

Wrangler config is per-env (`vars` in `wrangler.jsonc`, one block per env, plus
the token as a secret). The Stream, its sink, and the Data Catalog table are
**not** auto-created — provision them with `wrangler pipelines setup` before the
first deploy to an env, same manual-prerequisite convention as `r2_buckets` and
the Hyperdrive ids.

**No `pipelines` binding is committed for any env.** Wrangler resolves bindings
at deploy time, so a placeholder stream id would put this beta backend on the
deploy critical path for every environment — including the ones that have
container logs switched off. Each `wrangler.jsonc` env block carries a comment
showing the binding to add once its real stream exists; until then
`env.CONTAINER_LOGS` is absent and `resolveContainerLogStore` yields
`DisabledContainerLogStore`. **The runtime resolver is the only activation
gate** — never make Wrangler resource resolution a deploy prerequisite for it.
`worker-configuration.d.ts` is hand-maintained in this repo, so the
`CONTAINER_LOGS` binding and its vars were added there by hand (with a
structural `Pipeline` interface) rather than by `pnpm cf-typegen`.

## Testing

Host-free Deno unit suites cover `types.ts` guards, the disabled store, the
schema DDL shape, the query/SQL construction (fake `fetch`), the Cloudflare
config resolver, the Pipelines/R2 SQL driver (fake `PipelineLike` + fake
`fetch`), and the selector matrix.

`src/workers.entry.test.ts` (Workers pool, `vitest.config.ts` `test.include`)
covers the entry-point wiring itself: no binding → quiet disabled fallback,
enabled-but-unconfigured → exactly one warning and a still-successful request,
and a complete binding + R2 SQL config → the Pipelines store with no writes at
init. `pnpm check:workers-bundle` bundles `src/workers.ts`, so that graph now
proves this module is Workers-safe.

`store-conformance.test.ts` is a **shared behavioural suite parameterized over
both drivers** — empty-batch no-op, one write request per batch, ingest→query
round trip, organization scoping, limit clamping. Parity between backends is
asserted once there instead of being re-assumed per driver; each driver's own
file then covers only what is genuinely backend-specific. `clickhouse/store.integration.test.ts` is skipped unless
`TURBOPANEL_TEST_CLICKHOUSE_URL` points at a live server — same skip-guard
convention as the metrics integration test, and never required for a default
`deno test`.

The routed surface adds host-free Deno suites for the ingest body/ownership
helpers (`daemon/container-log-ingest.hostfree.test.ts`), the route itself —
202, JWT-derived identity, 403 for an unowned server, the dedicated limiter key
(`daemon/container-log-ingest-route.hostfree.test.ts`) — the presence ack
(`daemon/container-logs-presence.hostfree.test.ts`), the rate-limit key and its
Redis defaults (`daemon/rate-limit/container-log-keys.hostfree.test.ts`), the
org-settings parsers (`org-settings.test.ts`), and the client routes plus query
parsing (`client/organizations/container-log-routes*.hostfree.test.ts`).

Deno suites must be listed in `scripts/test-coverage.sh` or they never reach
the LCOV report. The integration suite is intentionally **not** listed.
