# Query cache (`src/query-cache/`)

Read-through cache for **reviewed, read-only** Postgres read models. Permission checks, session lookups, and secret-bearing reads must stay on the normal (`getDb`) connection — never the cached path.

**Not metrics:** the server metrics chart cache (`src/daemon/metrics/query/cache.ts`) is a **separate** system (AE/DuckDB query results, not Postgres). Do not add metrics read models to `approved-read-models.ts`. See instance `AGENTS.md` (Server metrics — query API & caching).

## Rules

- A cached read is declared with `defineCachedRead` in `read-models/`. Its `build` receives `CachedReadDb` (only `select()`), so it cannot write; the helper reads the statement text and parameters with `toSQL()` before anything is sent and derives the cache key from them, so an input that changes the answer cannot be left out of the key.
- Each read model has an entry in `approved-read-models.ts` with the fingerprint of its one reviewed statement (`statementFingerprint`: whitespace collapsed, `IN (...)` lists reduced to one placeholder, parameters renumbered). Changing a statement changes the fingerprint; `cached-reads.test.ts` fails until the new text is reviewed and the fingerprint updated on purpose. A read whose statement does not match runs on the primary connection and is never cached.
- The cached client (`withCacheableUnsafe`) refuses, before sending, anything that is not a single read-only `SELECT` without a volatile function or locking clause (`statement-guard.ts`), anything not in the registry, transactions, listeners and the tagged-template form. The Hyperdrive backend then re-runs the same `SELECT` once on the primary connection; so does a closed cached connection. A closed primary connection is not swallowed.
- `scripts/check-query-cache-boundaries.mjs` (`pnpm check:query-cache-boundaries`) fails the build if routes, cron, the queue consumer, Durable Objects or the daemon mention the cached binding, the cached client or `runApprovedCachedReadModel`.
- Only loaders registered in `approved-read-models.ts` and implemented under `read-models/` may call the cached database.
- Loaders must use **read-only `SELECT` statements** only: no transactions, mutations, `INSERT`/`UPDATE`/`DELETE`, or cache-bypass predicates.
- Do not use PostgreSQL **stable** or **volatile** functions (`now()`, `random()`, `nextval()`, `clock_timestamp()`, etc.) in cached SQL — they make Hyperdrive results uncacheable or stale.
- Loader return values must be **JSON-serializable** (Redis stores stringified payloads).
- TTLs are clamped to `MAX_QUERY_CACHE_TTL_SECONDS` (60s). Do not raise without review.

## Runtime behavior

| Runtime | Backend | Cached DB source |
| --- | --- | --- |
| Cloudflare Workers | Hyperdrive on `HYPERDRIVE_CACHED` | `createHyperdriveQueryCache(cachedDb)` — SQL-level cache via binding `max_age` |
| Workers (no `HYPERDRIVE_CACHED`) | Passthrough on primary `db` | `createPassthroughQueryCache(db)` — no Hyperdrive caching |
| Deno (self-hosted) | Redis read-through | `createRedisQueryCache` — honors `ttlSeconds` per key; active unconditionally including production `static` mode |

Workers must **not** fall back to the primary Hyperdrive binding as the cached connection. `resolveWorkersCachedDb()` returns a database only when `HYPERDRIVE_CACHED` is present; otherwise `resolveWorkersQueryCache` uses passthrough (no Hyperdrive caching).

On Workers, Hyperdrive only caches **named prepared statements**. Drizzle sends every query through postgres.js `unsafe()`, which defaults to `prepare: false` regardless of the client-level `prepare: true`, so the cached client is built with `preparedStatements: true` (`withCacheableUnsafe` in `cacheable-client.ts`, wired in `resolveWorkersCachedDb`), which passes `{ prepare: true }` per query. The primary `HYPERDRIVE` client stays unprepared. `PG_OPTS_WORKERS` also sets `fetch_types: false` so postgres.js does not run a `pg_type` lookup on every new connection. Source-scan and wrapper tests in `src/db/connection.test.ts` pin all three. See **Workers Hyperdrive** in `../../AGENTS.md`. Expect one distinct statement per `IN (...)` list length in `servers-list`.

### Hyperdrive binding ids

| Env | `HYPERDRIVE_CACHED` | Notes |
| --- | --- | --- |
| `live` | real id (`536236e3…d61391`, `prod-cached`) | Caching enabled against prod Postgres |
| `testing` | real id (dedicated `testing-cached` config) | Must point at the testing Postgres origin with caching enabled — **not** the placeholder (`0000…dev0`) and **not** the primary `HYPERDRIVE` id. Create or resolve via `CLOUDFLARE_API_TOKEN=… ./scripts/ensure-testing-hyperdrive-cached.sh --write-wrangler` when missing. |
| top-level / `wrangler dev` / vitest | placeholder (`0000…dev0`) | Local dev/tests use passthrough when the binding is absent or placeholder. |

### Projects, environments and workspaces

Who may see what is decided on the primary connection first. Lists call `listVisibleVersions` (the same grant check as `listVisible`, same result set, plus each row's last change) and pass those ids to the cached read, so the allowed set is part of the statement and its key; the `workspaceId` / `projectId` list filters are applied after the read so one statement serves every filter. Details call `resolveEntityVersion` (organization plus last change in one primary statement, replacing the organization lookup), compare the organization, read the row through the cache, and only then run the route's own read check. Permission decisions, `getOrgId`, the redeploy notice and every write stay on the primary connection. The stamp is `updated_at` (millisecond precision, transaction time), so two commits in the same millisecond share a stamp; the 75 second window bounds that. A row deleted between the primary lookup and the cached read can leave a cached `null` under that stamp for the same window.

## Freshness after an edit (version stamp)

Hyperdrive never purges on a write, and the self-hosted copy has no purge either; the only lever is changing the statement or its parameters. So a cached read that can be edited carries a version stamp: one bound parameter, selected as `$n::text as "_v"`, built from values the primary connection already returned in the same request (`id` and `updated_at` of the rows, from `loadServerRowsForFleetPresence`, which therefore runs first). An edit moves `updated_at`, the parameter changes, the key changes, and the new row shows at once. The stamp is only ever in the select list, never in a WHERE clause, so it can never hide a row; `cached-reads.test.ts` checks that for every entry marked `versionStamp: true`. The stamp column is dropped before the rows are returned or stored. Any update of the row (a daemon connecting, for example) also moves `updated_at` and so also skips a stale copy; the cost is a lower hit rate on rows that change often, never a stale answer. A read with no free stamp is not cached. Known gap: a licence being bound to a server does not change `server.updated_at`, so `licenseId` can lag by up to 75 seconds.

## Fallback and the failover test

The Hyperdrive backend re-runs a read on the primary connection once when the cached connection could not reach the database: closed, connect timeout, refused, or a pool that could not hand out a connection (`isCachedConnectionFailure`), or when the client refused the statement. A query that ran and failed (bad statement, statement timeout) is never retried, and a failure on the primary connection propagates so the request-level retry still sees it. `cached-read-fallback.test.ts` runs the whole path (read, guard, fallback, counters) against stand-in clients.

What the cached connection does while the database is down is not documented by the provider, so it is measured: `scripts/hyperdrive-failover-test.mjs` warms the servers list, stops the database with a command you give it, reads at set times (including past the 75 second cache window), starts the database, and reads until it recovers. Run it against a testing deployment only, then read the `db-usage` log lines for the same period to see which reads fell back.

## Counters and the request log line

Each Workers request has a `DbUsage` (`db-usage.ts`) fed by a behaviour-neutral count on the primary client and the cached client. When a request that touched the database ends, `workers.ts` writes one `db-usage` line: route, each read model with how it was served (`cached`, `primary`, `fallback`), statements on the cached and primary connections, how many primary statements the cached connection would have accepted (`primaryCacheable`; a fallback re-run is not counted), and the fallback count. Requests that used a cached read model and every fallback are always logged; other requests 1 in 20. Self-hosted (Deno) has no per-request counts.

## Cache backends (no read-model logic)

Both backends are thin wrappers — they do not decide what SQL runs or what gets stored. The split lives in runtime-agnostic read-model helpers under `read-models/`.

| Module | Role | Code change for split? |
| --- | --- | --- |
| `hyperdrive-query-cache.ts` | Calls `load(cachedDb)` for approved read models; Hyperdrive caches SQL at the connection level | **No** — only the list-rows `SELECT` reaches `cachedDb` because `runApprovedCachedReadModel` passes a narrow `load` closure from the read model |
| `redis-query-cache.ts` | Generic Redis read-through: `JSON.parse` / `JSON.stringify` around whatever `load(db)` returns; falls back to `load(db)` on Redis get/set/parse errors | **No** — caching only list rows happens automatically once the read model passes a list-rows-only `load` to `runApprovedCachedReadModel` |

## Adding a new cached read model

1. Add the id to `APPROVED_READ_MODELS` in `approved-read-models.ts`.
2. Implement a named helper in `read-models/<name>.ts` that calls `runApprovedCachedReadModel` (internal — not exported to routes as a generic loader).
3. Document every SQL statement the loader may execute in the helper’s module comment.
4. Run authorization / session / grant checks on the **normal** `db` before entering the cached path.
5. Include any authorization-relevant inputs (e.g. sorted visible entity ids) in the cache key.
6. Add route tests, including cache-staleness cases for auth-sensitive keys.

## Approved read models

**Audit outcome:** every loader under `read-models/` was reviewed. The allowlist is complete and minimal — `servers-list` and `server-detail` qualify as auth-agnostic, non-volatile read models (visibility/org checks stay on the primary connection). No loader leaks uncacheable or auth-sensitive/`daemon` statements onto the cached connection.

| Id | Helper | Cached payload | Allowed SQL on cached connection |
| --- | --- | --- | --- |
| `servers-list` | `cachedServersListReadModel` | `ServersListRow[]` (list rows only) | **Only** statement #1 — list-rows `SELECT` on `server` — see `read-models/servers-list.ts` |
| `server-detail` | `cachedServerDetailReadModel` | `ServerDetailRow \| null` (single row) | **Only** statement #1 — detail-row `SELECT` on `server` — see `read-models/server-detail.ts` |
| `projects-list` | `cachedProjectsList` | `ProjectRow[]` | One `SELECT` on `project` by visible ids — `read-models/hierarchy-reads.ts` |
| `project-detail` | `cachedProjectDetail` | `ProjectRow \| null` | One `SELECT` on `project` by id |
| `environments-list` | `cachedEnvironmentsList` | `EnvironmentRow[]` | One `SELECT` on `environment` by visible ids |
| `environment-detail` | `cachedEnvironmentDetail` | `EnvironmentRow \| null` | One `SELECT` on `environment` by id |
| `workspaces-list` | `cachedWorkspacesList` | `WorkspaceRow[]` | One `SELECT` on `workspace` by visible ids |

For `servers-list` and `server-detail`, daemon/metadata presence projections (`resolveFleetPresence`) and colocated machine-id matching (`resolveColocatedServerIdSet`) run on the **primary** connection on every request, outside the cache. Route-facing payloads assemble rows + presence after the cached read returns.

The cached payload is a plain array of row objects (no `Map`/`Set`) and remains JSON-serializable for Redis.

### Enforcement guards

Route tests (`src/client/servers/routes.test.ts`) use `createListRowsOnlyReadDb` / `createDetailRowsOnlyReadDb`, which:

- default-deny every database property except `select` (and the test-only `selectCallCount` accessor);
- allowlist the documented row column set on `select` by **exact** key membership and count;
- count `select` invocations so tests pin **exactly one** cached statement per request;
- assert `recordingCache.readModels` is `['servers-list']` or `['server-detail']` only.

### Cost note (Durable Objects)

Caching the list-rows `SELECT` reduces **primary Hyperdrive/Postgres** read load only. Server status reads are already Postgres-only (no per-request Durable Object fan-out), so this path does **not** touch the daemon cell DO and does not add DO GB‑sec pressure.

## Redis / Hyperdrive parity

Redis (`createRedisQueryCache` in `redis-query-cache.ts`, wired unconditionally from `src/deno.ts` so it is active in production `static` mode) must mirror Hyperdrive semantics for the same read models: same allowlist, same key shape (`queryCacheKey(readModel, …)`), same cached payload type per read model, per-key TTL clamped to `MAX_QUERY_CACHE_TTL_SECONDS`, and fallback to `load(db)` on Redis read/write/parse errors.

Because the split lives in the runtime-agnostic read-model code (`read-models/servers-list.ts`), both backends cache **the same payload** (`ServersListRow[]` for `servers-list`). Presence and colocated resolution always run on the primary `db` per request on **both** runtimes — neither backend ever sees those queries.

Deno honors per-key TTL; Hyperdrive honors binding `max_age`.
