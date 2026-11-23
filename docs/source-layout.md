# Source Layout

## Layout

Feature-first tree. The four executables stay at `src/` root. Names that match
URL prefixes stay (`client/` = end-user API surface; `daemon/` = control-plane
side of the daemon protocol, **not** `turbopaneld`). `lib/` is the kernel
(both-runtime, no DB connection import, no feature vocabulary). The import
rules are enforced by `pnpm check:import-boundaries` over all of `src/lib`;
violations that predate the wide rule are listed in
`scripts/import-boundaries-baseline.json` and may only shrink.

```text
src/
├── workers.ts · workers-vitest.ts · deno.ts · deno-dev.ts   # only executables
├── app/            # createApp, surfaces, cors, security-headers,
│                   # browser-write-protection, body-limit, write-rate-limit,
│                   # scalar-html, build-info, version, dev-mode
├── platform/
│   ├── ports/      # composition hooks the entries fill in: fleet-presence,
│   │               # load-server-status, managed-ha-recovery, tcp-probe,
│   │               # host-ipv4-discovery, register-command-runtime-ports
│   ├── workers/    # bindings, Hyperdrive binding map, connection retry,
│   │               # status edge cache, TCP probe
│   └── deno/       # server.ts, server-paths, runtime-paths, job-tick,
│                   # AMQP publisher and queues (commands, email),
│                   # filesystem execution-log store, probes,
│                   # ingress/ (self-hosted admin routes)
├── db/             # schema + factories + generic helpers; AGENTS.md
├── lib/            # kernel: loose helpers (ip-address, naming,
│                   # version-wire, machine-key, peer-address, logger,
│                   # timezones, sha512-crypt, ...) plus folders
│                   # acme/, email/mailer/, encoding/, http/,
│                   # panel-identity/, secrets/, tls/
├── contracts/      # wire shapes: commands/ (schemas, deploy-validation,
│                   # hostname, tunnel shapes), cell + cell-protocol,
│                   # metrics-contract, capability-plan, topology-*,
│                   # server-addresses, runtime-registry, update-channel
├── features/       # domain modules (organizations, servers, compose,
│                   # commands consumer, email, managed, ...)
├── client/ · admin/ · developer/ · daemon/ · webhook/ · install/ · cli/
├── jobs/           # registry.ts: the shared job table
├── query-cache/    # own AGENTS.md; holds the Hyperdrive and Redis backends
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
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main); mounts no
  developer surface
- `scripts/check-workers-bundle.mjs` — Wrangler dry-run of the deploy entrypoint
  (pre-commit / `pnpm check:workers-bundle`)
- `src/lib/machine-key.ts` — machine-key derive/normalize (Workers + Deno; no
  `@std` imports)
- `src/app/surfaces.ts` — versioned API/WS prefix constants
- `src/client/openapi/` / `src/app/scalar-html.ts` — hand-authored OpenAPI 3.1 specs +
  Scalar embed HTML
- `src/client/routes.ts` — client REST router; imports `src/client/authn/*` and
  `src/client/authz/*`
- `src/client/authn/` — session, credentials, passkeys, two-factor, step-up,
  one-time codes, install state, HTTP auth handlers; license routes live in
  `src/client/licenses/`

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
  registered from `src/platform/deno/server.ts`, so Deno only). Install helpers
  live in `src/features/install/`.

- `src/features/email/` — queue types, templates and the senders (`smtp/`,
  `mailgun/`, `mailpit/`); the Deno AMQP publisher is
  `src/platform/deno/email/deno-amqp-queue.ts` and the in-process consumer is
  `src/lib/email/mailer/deno-mailer-consumer.ts`
- `src/developer/` — developer surface, Deno development entry only
  (`src/deno-dev.ts` calls `registerDeveloperRoutes`); `routes-core.ts` holds
  the shared router builder

- `src/platform/deno/server-paths.ts` / `src/features/servers/server-registry.ts` — Unix socket path + daemon
  server row resolution
- `src/cli/` — compiled-binary verbs (`migrate`, `generate-secret`,
  `generate-self-signed-cert`) plus `duckdb-smoke`
