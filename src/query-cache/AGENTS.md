# Query cache (`src/query-cache/`)

Read-through cache for **reviewed, read-only** Postgres read models. Permission checks, session lookups, and secret-bearing reads must stay on the normal (`getDb`) connection — never the cached path.

## Rules

- Only loaders registered in `approved-read-models.ts` and implemented under `read-models/` may call the cached database.
- Loaders must use **read-only `SELECT` statements** only: no transactions, mutations, `INSERT`/`UPDATE`/`DELETE`, or cache-bypass predicates.
- Do not use PostgreSQL **stable** or **volatile** functions (`now()`, `random()`, etc.) in cached SQL — they make Hyperdrive results uncacheable or stale.
- Loader return values must be **JSON-serializable** (Redis stores stringified payloads).
- TTLs are clamped to `MAX_QUERY_CACHE_TTL_SECONDS` (60s). Do not raise without review.

## Runtime behavior

| Runtime | Backend | Cached DB source |
| --- | --- | --- |
| Cloudflare Workers | Hyperdrive on `HYPERDRIVE_CACHED` | `createHyperdriveQueryCache(cachedDb)` — SQL-level cache via binding `max_age` |
| Workers (no `HYPERDRIVE_CACHED`) | Passthrough on primary `db` | `createPassthroughQueryCache(db)` — no Hyperdrive caching |
| Deno (self-hosted) | Redis read-through | `createRedisQueryCache` — honors `ttlSeconds` per key |

Workers must **not** fall back to the primary Hyperdrive binding as the cached connection. `resolveWorkersCachedDb()` returns a database only when `HYPERDRIVE_CACHED` is present.

On Workers, Hyperdrive caching for approved read models relies on **`prepare: true`** on the postgres.js client (`createWorkersDb` in `src/db.ts`). With `prepare: false`, Hyperdrive treats parameterized `SELECT`s as uncacheable. See **Workers Hyperdrive** in `../../AGENTS.md` (instance repo root).

## Cache backends (no read-model logic)

Both backends are thin wrappers — they do not decide what SQL runs or what gets stored. The split lives in runtime-agnostic read-model helpers under `read-models/`.

| Module | Role | Code change for split? |
| --- | --- | --- |
| `hyperdrive-query-cache.ts` | Calls `load(cachedDb)` for approved read models; Hyperdrive caches SQL at the connection level | **No** — only the list-rows `SELECT` reaches `cachedDb` because `runApprovedCachedReadModel` passes a narrow `load` closure from the read model |
| `redis-query-cache.ts` | Generic Redis read-through: `JSON.parse` / `JSON.stringify` around whatever `load(db)` returns | **No** — caching only list rows happens automatically once the read model passes a list-rows-only `load` to `runApprovedCachedReadModel` |

## Adding a new cached read model

1. Add the id to `APPROVED_READ_MODELS` in `approved-read-models.ts`.
2. Implement a named helper in `read-models/<name>.ts` that calls `runApprovedCachedReadModel` (internal — not exported to routes as a generic loader).
3. Document every SQL statement the loader may execute in the helper’s module comment.
4. Run authorization / session / grant checks on the **normal** `db` before entering the cached path.
5. Include any authorization-relevant inputs (e.g. sorted visible entity ids) in the cache key.
6. Add route tests, including cache-staleness cases for auth-sensitive keys.

## Approved read models

| Id | Helper | Cached payload | Allowed SQL on cached connection |
| --- | --- | --- | --- |
| `servers-list` | `cachedServersListReadModel` | `ServersListRow[]` (list rows only) | **Only** statement #1 — list-rows `SELECT` on `server` — see `read-models/servers-list.ts` |

For `servers-list`, daemon/metadata presence projections (`resolveFleetPresence`) and colocated machine-id matching (`resolveColocatedServerIdSet`) run on the **primary** connection on every request, outside the cache. The route-facing `ServersListDisplayPayload` (`rows` + `presence` + `colocatedIds`) is assembled after the cached read returns.

The cached payload is a plain array of row objects (no `Map`/`Set`) and remains JSON-serializable for Redis.

## Redis / Hyperdrive parity

Redis (`createRedisQueryCache` in `redis-query-cache.ts`) must mirror Hyperdrive semantics for the same read models: same allowlist, same key shape (`queryCacheKey(readModel, …)`), same cached payload type per read model.

Because the split lives in the runtime-agnostic read-model code (`read-models/servers-list.ts`), both backends cache **the same payload** (`ServersListRow[]` for `servers-list`). Presence and colocated resolution always run on the primary `db` per request on **both** runtimes — neither backend ever sees those queries.

Deno honors per-key TTL; Hyperdrive honors binding `max_age`.
