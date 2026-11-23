# Source Layout

## Layout

Feature-first tree. The four executables stay at `src/` root. Names that match
URL prefixes stay (`client/` = end-user API surface; `daemon/` = control-plane
side of the daemon protocol, **not** `turbopaneld`). `lib/` is an admitted
kernel only (both-runtime, no DB connection import, no feature vocabulary).

```text
src/
├── workers.ts · workers-vitest.ts · deno.ts · deno-dev.ts   # only executables
├── app/            # createApp, surfaces, cors, security-headers,
│                   # browser-write-protection, scalar-html, build-info,
│                   # version, developer-surface gate (dev-mode)
├── platform/
│   ├── ports/      # command-queue, execution-log-store, rate-limiter,
│   │               # query-cache, email-queue
│   ├── workers/    # bindings, Hyperdrive, Workers queue, R2, Mailgun
│   └── deno/       # server.ts (was deno-server), server-paths, runtime-paths,
│                   # AMQP, filesystem/S3 stores, Redis, SMTP, DuckDB
├── db/             # schema + factories + generic helpers; AGENTS.md
├── lib/            # kernel: ip-address, naming, version-wire, machine-key,
│                   # peer-address, display-name-format, timezones,
│                   # optional-fields, logger, log-compat, sha512-crypt,
│                   # secrets/{secrets,data-encryption,generate-secret},
│                   # http/, tls/
├── contracts/      # command schemas, deploy-validation, hostname,
│                   # metrics-contract, capability-plan, topology,
│                   # cell + cell-protocol, server-addresses,
│                   # runtime-registry, update-channel
├── features/       # domain modules (organizations, servers, compose,
│                   # commands consumer, email queue, managed, …)
├── client/ · admin/ · developer/ · daemon/ · webhook/ · install/ · cli/
├── query-cache/    # keep (own AGENTS.md); backends live in platform/
└── test-fixtures/
```

- `src/app/app.ts` — shared Hono factory (`/api/health` + client/daemon routers)
- `src/deno.ts` — production Deno entry (`platform/deno/server.ts` + no developer
  modules)
- `src/deno-dev.ts` — development Deno entry; registers install routes,
  developer surface, `/api/daemon/v1/version`, daemon WS, and the dev update
  overlay (`src/developer/dev-update-overlay.ts` — client update UI resolves
  the target from the local daemon checkout's `dist/manifest.json`, whatever
  channel the instance follows, and rebuilds the overlay before enqueueing
  updates, instead of reading the public rail; the control plane and web
  interface get no target, since both run from the checkouts)
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main); registers
  `developer/routes-core` once per isolate
- `scripts/check-workers-bundle.mjs` — Wrangler dry-run of the deploy entrypoint
  (pre-commit / `pnpm check:workers-bundle`)
- `src/lib/machine-key.ts` — machine-key derive/normalize (Workers + Deno; no
  `@std` imports)
- `src/app/surfaces.ts` — versioned API/WS prefix constants
- `src/client/openapi/` / `src/app/scalar-html.ts` — hand-authored OpenAPI 3.1 specs +
  Scalar embed HTML
- `src/client/routes.ts` — client REST router; imports `src/client/authn/*` and
  `src/client/authz/*`
- `src/client/authn/` — session, credentials, PAM install gate, license CRUD,
  HTTP auth handlers

- `src/daemon/` — control-plane side of `/api/daemon/v1` + `/ws/daemon/v1`
  (see `src/daemon/AGENTS.md`). Cell protocol types live in `src/contracts/`;
  the Durable Object + Redis pair stay under `src/daemon/cell/`.
- `src/features/licenses/verify-daemon-license.ts` — daemon hello license
  verification (`verifyDaemonLicense`)
- `src/daemon/authn/` — daemon JWT issue/verify + keyring + server-key
- `src/features/servers/daemon-state.ts` / `server-identity-db.ts` — `server.daemon`
  jsonb parsers and DB helpers
- `src/db/schema.ts` — Drizzle table definitions (`server`, etc.; see
  `src/db/AGENTS.md`); connection factories stay in `src/db/connection.ts`
- `src/install/routes.ts` — self-hosted install wizard (`/api/install/v1/*`;
  Deno-only registration). Install helpers live in `src/features/install/`.

- `src/features/email/` — shared queue types/templates; SMTP (Deno/AMQP) and
  Mailgun (Workers) backends live under `src/platform/`
- `src/developer/` — developer surface (Deno-only routes + Workers-safe
  `routes-core.ts`)

- `src/platform/deno/server-paths.ts` / `src/features/servers/server-registry.ts` — Unix socket path + daemon
  server row resolution
- `src/cli/` — compiled-binary verbs (`migrate`, `generate-secret`,
  `generate-self-signed-cert`) plus `duckdb-smoke`

## Layout check and its baseline

`pnpm check:source-layout` (`scripts/check-source-layout.mjs`, wired into
`pnpm test:hook`, `pnpm verify:ci` and CI) enforces four rules over `src/`:

- `runtime`: no `Deno.*` and no Workers binding (`cloudflare:*` imports,
  `DurableObject*`, `KVNamespace`, `R2Bucket`, `D1Database`, `Hyperdrive`,
  `Fetcher`, `Queue`) in a non-test file outside `src/platform/`,
  `src/developer/`, `src/cli/`, `src/test-fixtures/` and the entry files
  (`src/deno.ts`, `src/deno-dev.ts`, `src/workers.ts`, `src/workers-vitest.ts`).
- `size`: at most 1,500 lines per non-test source file.
- `barrel`: no new `index.ts`. Do not add re-export barrels; import the module.
- `test-name`: a test file is `<name>.<kind>.ts` where `<name>` has no dots and
  `<kind>` is one of `test`, `hostfree.test`, `deno.test`, `workers.test`,
  `workers-e2e.test`, `entry.test` or `test.support`.

Violations that existed when the check landed are listed in
`scripts/source-layout-baseline.json`: `runtime`, `barrel` and `test-name` are
lists of paths, `size` maps a path to its line count. The baseline only
shrinks:

- A new violation, or a baselined file that grew past its recorded size, fails
  the check. Fix the code; never add to the baseline.
- A baselined entry that is fixed (moved under `src/platform/`, split below
  1,500 lines, renamed, deleted) also fails until it is removed. Run
  `node scripts/check-source-layout.mjs --prune` to drop fixed entries (it never
  adds one) and commit the smaller file with the fix.
- When you split an oversized file but it is still over 1,500 lines, lower its
  recorded number by hand in the same change.
