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

## Adding a new cached read model

1. Add the id to `APPROVED_READ_MODELS` in `approved-read-models.ts`.
2. Implement a named helper in `read-models/<name>.ts` that calls `runApprovedCachedReadModel` (internal — not exported to routes as a generic loader).
3. Document every SQL statement the loader may execute in the helper’s module comment.
4. Run authorization / session / grant checks on the **normal** `db` before entering the cached path.
5. Include any authorization-relevant inputs (e.g. sorted visible entity ids) in the cache key.
6. Add route tests, including cache-staleness cases for auth-sensitive keys.

## Approved read models

| Id | Helper | Allowed SQL (summary) |
| --- | --- | --- |
| `servers-list` | `cachedServersListReadModel` | `SELECT` on `server` for list rows, daemon/metadata projections, and colocated machine-id matching — see `read-models/servers-list.ts` |

## Redis / Hyperdrive parity

Redis (`redis-query-cache.ts`) must mirror Hyperdrive semantics for the same read models: same allowlist, same key shape (`queryCacheKey(readModel, …)`), same JSON payload types. Deno honors per-key TTL; Hyperdrive honors binding `max_age`.
