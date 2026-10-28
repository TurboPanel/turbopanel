# Workers Platform and Hyperdrive (`src/platform/workers/`)

### Workers Hyperdrive

`wrangler.jsonc` declares a `HYPERDRIVE` binding stub (replace the placeholder
id before deploy). Types: `worker-configuration.d.ts`
(`HYPERDRIVE?: Hyperdrive`). Regenerate with `pnpm cf-typegen` after changing
bindings.

**Local dev (`wrangler dev`):** do not commit `localConnectionString` in
`wrangler.jsonc`. The daemon's `instance-launch` Ansible role writes
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` into
`/etc/turbopanel/instance/runtime.env` (from the converge-generated Postgres
credentials), and `scripts/workers-serve.sh` symlinks it into the checkout as
`.env`. Wrangler loads `.env` into `process.env` before applying Hyperdrive
bindings — the Worker connects directly to local Postgres (no Hyperdrive
pooling/caching in this mode). **`TURBOPANEL_DATABASE_URL`** (or
**`DATABASE_URL`** for tooling) in the same file is for migrations/Drizzle/sync
and may use different credentials than the Hyperdrive runtime user in
production.

The Workers DB client uses `prepare: true` and `fetch_types: false` on
postgres.js. Hyperdrive has supported named prepared statements since June 2024
and manages their lifecycle across its internal connection pool, so per-session
state is not a concern. Hyperdrive only caches named (extended-protocol)
statements; unnamed ones are marked uncacheable. **`prepare: true` alone does
not reach drizzle queries:** drizzle runs everything through `client.unsafe()`,
whose own default is `prepare: false`. The `HYPERDRIVE_CACHED` client is
therefore wrapped with `withCacheableUnsafe` (`createWorkersDb(..., {
preparedStatements: true })`), which passes `{ prepare: true }` on each call and
refuses any statement that is not a registered read-only SELECT (see
`src/query-cache/AGENTS.md`).
`fetch_types: false` drops the `pg_catalog.pg_type` lookup postgres.js would
otherwise run on every new connection (one per request); drizzle parses the
`cidr[]`/`inet[]` columns itself.


#### ⛔ HARD RULE: one Hyperdrive/postgres.js client per request — NEVER cache a DB client across requests

> **This rule is non-negotiable. Violating it took production down** (redeploy
> that cached the client → every DB call after the first in an isolate threw
> `HTTP 500` on sign-in/session, causing a sign-in↔welcome redirect loop). Do
> **not** "optimize" DB client management by reusing a client across requests.
> If you think reuse saves a connection, you are wrong — Hyperdrive already
> pools connections server-side, so per-request creation has **zero**
> connection-startup cost.

**On Cloudflare Workers, a database client and its underlying socket are I/O
objects bound to the request (invocation) that created them.** A single V8
isolate serves many `fetch` / `queue` / cron invocations. If you store a
`postgres(...)` client in module/global scope or an isolate-level cache and
reuse it on a later invocation, Cloudflare throws and the request 500s:

- `Cannot perform I/O on behalf of a different request. I/O objects ... created in the context of one request handler cannot be accessed from a different request's handler.`
- postgres.js: `write CONNECTION_ENDED` / `write CONNECTION_DESTROYED` /
  `write CONNECTION_CLOSED`
- Creating the client in global scope instead throws
  `Disallowed operation called within global scope`.

Cloudflare's own fix (Hyperdrive troubleshooting → **Stale connection and I/O
context errors**): _"Create a new database client on every request instead of
caching it in a global variable. Hyperdrive's connection pooling already
eliminates the connection startup overhead."_ —
<https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/>
(see also
<https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/>).

**The contract in this repo:**

- `resolveWorkersDb` / `resolveWorkersCachedDb` / `openWorkersRequestDb`
  (`src/platform/workers/workers-bindings.ts`) **create a fresh client per call**. `workers.ts`
  `fetch()` / `queue()` and the offline-sweep cron each resolve their own
  client(s) for that one invocation. Do **not** add a
  `Map`/`WeakMap`/module-level singleton that returns the same client on a later
  invocation.
- **Always close** those clients when the invocation finishes:
  `closeWorkersRequestDb` via `ctx.waitUntil` on `fetch`, `endDbConnection` in
  `finally` on `queue` and `runOfflineSweep`. Leaving postgres.js pools open
  stacks memory until the isolate hits the **128 MB** limit and Cloudflare
  recycles it (sawtooth memory charts). Hyperdrive still pools server-side —
  closing only releases the Worker-side client.
- Isolate/global scope is fine for **stateless** things (derived secrets,
  rate-limiter adapters, the compiled Hono app) — never for anything holding a
  socket/stream (DB clients, in-flight request/response bodies).

**Durable Objects are a different isolate with different rules — do not conflate
them.** A DO is its own long-lived object; its Postgres projection
(`src/daemon/cell/do.ts`) opens a **short-lived** client via `createWorkersDb`
and **must** `endDbConnection` it in `finally`, because an open outbound DB
socket keeps the DO awake (non-hibernatable) and bills GB-s for the entire
WebSocket lifetime (the 71-minute / ~547 GB-s incident). So: request Worker
isolate → fresh-per-request **and** close; Durable Object → fresh-per-op, always
close. Never reuse a request-path client inside a DO or vice-versa. DO/cost
rules: `src/daemon/cell/AGENTS.md`.

**Regression guard:** `src/platform/workers/workers-bindings.workers.test.ts` asserts `resolveWorkersDb`
/ `resolveWorkersCachedDb` return a **new** client on each call (never the same
instance), and that `openWorkersRequestDb` / `closeWorkersRequestDb` end both
primary and cached clients. Source scans on `workers.ts` and `offline-sweep.ts`
assert the close paths stay wired. If you find yourself weakening those tests to
allow reuse or skip closes, stop — you are about to reintroduce either the
I/O-context outage or the 128 MB sawtooth.

Previously `prepare: false` was used because older Hyperdrive versions did not
support prepared statements. That restriction no longer applies.

**Unsupported PostgreSQL features** (do not rely on these on the
Workers/Hyperdrive path):

- SQL-level prepared statements: `PREPARE`, `DISCARD`, `DEALLOCATE`, `EXECUTE`
- [Advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- `LISTEN` / `NOTIFY`
- Any other modification to per-session state unless Cloudflare documents it as
  supported

**Cached read models:** approved read-only `SELECT` paths may use the
`HYPERDRIVE_CACHED` binding (Workers) or Redis read-through (Deno).
Authorization, sessions, and secrets must use the primary connection. See
`src/query-cache/AGENTS.md`.
