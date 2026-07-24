# Query cache (`src/query-cache/`)

Read-through cache for **reviewed, read-only** Postgres read models. Permission checks, session lookups, and secret-bearing reads must stay on the normal (`getDb`) connection — never the cached path.

**Not metrics:** the server metrics chart cache (`src/daemon/metrics/query/cache.ts`) is a **separate** system (AE/ClickHouse query results, not Postgres). Do not add metrics read models to `approved-read-models.ts`. See instance `AGENTS.md` (Server metrics — query API & caching).

## Rules

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

On Workers, Hyperdrive caching for approved read models relies on **`prepare: true`** on the postgres.js client (`PG_OPTS_WORKERS` in `src/db.ts`). With `prepare: false`, Hyperdrive treats parameterized `SELECT`s as uncacheable. See **Workers Hyperdrive** in `../../AGENTS.md` (instance repo root). A source-scan regression test in `src/db.test.ts` pins `prepare: true` so it cannot silently regress.

### Hyperdrive binding ids

| Env | `HYPERDRIVE_CACHED` | Notes |
| --- | --- | --- |
| `live` | real id (`d9c4…5d67`, `prod-cached`) | Caching enabled against prod Postgres |
| `testing` | real id (dedicated `testing-cached` config) | Must point at the testing Postgres origin with caching enabled — **not** the placeholder (`0000…dev0`) and **not** the primary `HYPERDRIVE` id. Create or resolve via `CLOUDFLARE_API_TOKEN=… ./scripts/ensure-testing-hyperdrive-cached.sh --write-wrangler` when missing. |
| top-level / `wrangler dev` / vitest | placeholder (`0000…dev0`) | Local dev/tests use passthrough when the binding is absent or placeholder. |

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
