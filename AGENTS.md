# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and **Deno**.

## Speed doctrine (turbo)

TurboPanel is named for speed; keep it fast on every path.

- **Cache runtimes & deps.** Deno/Node/Caddy live under `/opt/turbopanel/vendor/<tool>/current`; install only when the pinned version is missing. Don't re-download or re-`pnpm install` when nothing changed. Caddy follows the same `vendor/caddy/<version>/caddy` + `current` layout (no `versions/` subdir); `scripts/download-caddy.mjs` and the `caddy` Ansible role are aligned.
- **Idempotent fast-paths.** Bootstrap/install steps must short-circuit when already satisfied (the Ansible roles do; mirror that in scripts).
- **Avoid redundant work.** No polling loops or periodic git/`systemctl` forks unless essential (the version watcher and auto-update poll were removed for this reason).
- **Parallelize** independent I/O (e.g. `Promise.all` for per-daemon fan-out, as in the admin routes).
- **Push, don't poll** for cross-process signals where practical (WS messages over fallback timers).

## Platform model: Ansible owns installs

The **daemon is the constant** installed on every TurboPanel-managed host and is the only party that runs Ansible to install/update everything else (runtimes, users, the instance, UI, Caddy). The instance does not install itself. In co-located dev the daemon runs the `instance-dev-install` playbook (see `../daemon/AGENTS.md`) when `TURBOPANEL_DEV_INSTANCE=1`. Nothing auto-updates — updates are operator-driven (admin **Upgrade System** button or **Sync Dev Build**).

## Users, group & socket permissions

**Development (co-located):** a **single dev user** runs everything — no `turbopanel`, `turbopaneli`, or `turbopanelc` service accounts are created. Source repos live under `$HOME` (`~/daemon`, `~/instance`, `~/ui`, `~/website`) and are owned by the dev user. Mutable data (`/etc/turbopanel`, `/var/lib/turbopanel`, `/var/log/turbopanel`, `/run/turbopanel`) is dev-user-owned. Per-service runtime state may still live in gitignored checkout dirs (`instance/.local`, `ui/.local`, `ui/.expo`, `.config` trees). `/run/turbopanel` is owned by the dev user; the instance hardens its socket to **`0660`** owned by the dev user so the co-located daemon can connect.

**Production:** dedicated service users — see `../daemon/AGENTS.md` (Filesystem layout) and the systemd table below for `turbopanel` / `turbopaneli` / `turbopanelc` ownership, ACLs, and `/run/turbopanel` **`2770 turbopanel:turbopanel`** (setgid).

## Documentation discipline

**Keep this file current.** When you learn something durable about how TurboPanel works — architecture, env vars, gotchas, cross-repo contracts, operational steps — add or update a note here in the same PR/session as the code change. Future agents read `AGENTS.md` first.

- Prefer extending an existing section over appending orphan bullets.
- Record **why** when the reason is non-obvious (e.g. a missing Debian package that breaks Ansible).
- If a fact belongs in another repo (`daemon`, `ui`), put the canonical detail there and add a short cross-reference here when the instance is involved.
- Do not record secrets, tokens, or machine-specific credentials.
- Remove or correct notes that prove wrong.

### TypeScript style (SonarQube)

- Prefer **`String#replaceAll()`** over **`String#replace()` with a global regex** when replacing every occurrence of a substring (`typescript:S7781`).
- Use **`String.raw`** for string literals that contain backslashes so escapes stay readable and correct (`typescript:S7780`).
- Prefer **optional chaining** (`obj?.prop`) over `!obj || obj.prop` (`typescript:S6582`).
- Use **`new TypeError()`** for type/shape assertions in tests (`typescript:S7786`).
- Avoid **nested ternaries** — use `if`/`switch` or helpers (`typescript:S3358`).
- Extract helpers when **cognitive complexity** exceeds 15 (`typescript:S3776`).
- Sort strings with **`.sort((a, b) => a.localeCompare(b))`** (`typescript:S2871`).
- Mark React component props **`Readonly<{…}>`** (`typescript:S6759`).
- Omit optional parameters instead of passing redundant **`undefined`** (`typescript:S4623`).
- Prefer **`String#codePointAt()`** over **`charCodeAt()`** when decoding byte strings (`typescript:S7758`).
- Use **`RegExp.exec()`** instead of `String.match()` for single-match extraction (`typescript:S6594`).
- Do not leave **`TODO`** in code — use `Future:` in a normal comment (`typescript:S1135`).
- Use **RFC 5737 TEST-NET** addresses (e.g. `203.0.113.x`) in tests, not arbitrary public IPs (`typescript:S1313`).
- Add **`// NOSONAR rule-key — reason`** when a semantic type alias or path check is intentional (`typescript:S6564`, `typescript:S5443`).

### Ansible style (SonarQube)

- Prefer **`mode: "0640"`** / **`0750"`** with explicit **`owner`** / **`group`** over world-readable modes (`ansible:S2612`).

`README.md` is for humans getting started; `AGENTS.md` is for agents maintaining the system.

Unit tests use non-production secrets from `src/test-fixtures/secrets.ts` (`TEST_ONLY_TURBOPANEL_SECRET`). Vitest Workers config uses the same naming convention in `wrangler.vitest.jsonc`. The secret scanner allowlists only exact fixture lines in `.secretscan-allowlist` — do not add broad exclusions.

## Setup

- **Deno** — <https://docs.deno.com/runtime/getting_started/installation/>
- **pnpm** — <https://pnpm.io/installation>
- **Node.js** and **openssl** — required for cert generation (`scripts/*.mjs`); Node.js also used for Caddy download
- Run `./console` from the `turbopanel-dev` checkout. The console installs Deno, clones the daemon, and drives the full dev stack via `scripts/bootstrap-orchestration.ts` + `scripts/install-daemon-systemd.sh` (shared orchestration under `/opt/turbopanel/vendor/` — not `orchestration/runtime/venv`).
- Managed/co-located installs: secret-bearing runtime env lives in the instance config dir (`runtime.env`, `runtime.dev-vars`) — **never** in the git checkout root. Standalone scripts (`scripts/generate-self-signed-cert.mjs`, `scripts/workers-serve.sh`, `scripts/drizzle-studio-serve.sh`) default to the FHS location **`/etc/turbopanel/instance/runtime.env`** when `TURBOPANEL_INSTANCE_RUNTIME_ENV` is unset. Both managed and co-located dev use **`/etc/turbopanel/instance/`** (dev-user-owned in development). The unit injects `TURBOPANEL_INSTANCE_RUNTIME_ENV` accordingly. `scripts/generate-self-signed-cert.mjs` and daemon `public-urls-apply` read/write `runtime.env` there. Do not reintroduce checkout-root `.env` / `.dev.vars` generation.
- `pnpm install` — installs Hono and Wrangler into `node_modules/` for Workers bundling
- Local **Tilt** Wrangler secrets still live in `dev/.env` → `sync-env.sh` → instance `.dev.vars`; that path is separate from managed Ansible installs above.
- `pnpm dev` (wrangler) still runs the **Cloudflare Workers** path for full-stack testing — unchanged. **`wrangler.jsonc` `dev.ip` is `0.0.0.0`** so Docker Caddy (`host.docker.internal`) can reach the dev server; default localhost-only bind causes Caddy **502**s.
- **`pnpm deploy`** — applies pending migrations (`TURBOPANEL_DATABASE_URL` or `DATABASE_URL` required for tooling) then deploys to Cloudflare Workers (`CLOUDFLARE_ENV` required, e.g. `live` or `testing`). Works from any environment with internet access to the database — self-hosted dev, CI, or production. Requires **Node** only (`pnpm migrate` runs `drizzle-kit migrate`; no Deno prerequisite). Equivalent to `pnpm migrate && wrangler deploy --env $CLOUDFLARE_ENV --minify`.
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts`
- The Ansible `instance-certs` / `caddy` / `node-runtime` roles supersede the standalone `pnpm cert:generate` / `pnpm caddy:install` scripts for managed hosts (the scripts remain for manual use).

### Systemd (dev services run as the dev user; production uses dedicated users)

Installed and managed by the daemon via the `instance-launch` Ansible role:

| Unit | User (dev) | User (production) | Notes |
|---|---|---|---|
| `turbopanel-instance.service` | current dev user | `turbopaneli:turbopanel` | Deno instance on the Unix socket |
| `turbopanel-caddy.service` | current dev user | `turbopaneli:turbopanel` | TLS + reverse proxy on `:8443` (`GOMAXPROCS=1`, `CPUQuota=100%`) |
| `turbopanel-ui.service` | current dev user | `turbopaneli:turbopanel` | Expo web dev server (`:8081`, dev only) |
| `turbopaneld.service` | current dev user | `turbopanel:turbopanel` | runs Ansible; has sudo (production only) |

- `systemd/turbopanel-instance.service` was removed — the canonical unit is templated by the `instance-launch` role in `../daemon`.
- Logs: `journalctl -u turbopanel-instance -u turbopanel-caddy -u turbopanel-ui -f`
- Co-located daemon: `../daemon/scripts/install-daemon-systemd.sh`

## Unix domain sockets

In Deno mode (development and production), the Hono instance listens on a **Unix domain socket** instead of a TCP port. Caddy terminates TLS and proxies `/api/*` and `/ws/*` to that socket.

### Directory layout

All TurboPanel runtime sockets live under **`/run/turbopanel/`** (on Linux, `/var/run` symlinks to `/run`). In **development** the directory is owned by the dev user. In **production** it is **`2770 turbopanel:turbopanel`** (setgid) so the `turbopaneli` user (in group `turbopanel`) can bind:

| Socket file | Service |
|---|---|
| `/run/turbopanel/instance.sock` | Hono instance (dev: mode `0660`, dev user; prod: mode `0660`, group `turbopanel`) |
| `/run/turbopanel/postgres/.s.PGSQL.5432` | PostgreSQL 18 (Docker bind-mount) |
| `/run/turbopanel/<name>.sock` | Reserved for future services |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TURBOPANEL_SOCKET` | — | Full socket path override |
| `TURBOPANEL_SOCKET_DIR` | `/run/turbopanel` | Directory when using the default filename |
| `TURBOPANEL_SOCKET_DIAL` | `run/turbopanel/instance.sock` | Caddy `unix//` dial path (no leading slash) |
| `TURBOPANEL_UI_MODE` | `static` | `dev` proxies to Expo; `static` serves exported UI |
| `TURBOPANEL_UI_ROOT` | `/opt/turbopanel/share/ui` | Directory of `expo export --platform web` output (local manual dev typically sets `../ui/dist`) |
| `TURBOPANEL_UI_SERVICE` | `turbopanel-ui` | Name of the Expo systemd unit on managed hosts (injected for orchestration; no instance API surface today) |
| `CADDY_PORT` | `8443` | HTTPS listen port |
| `CADDY_HTTP_PORT` | `8880` | Dev-only plaintext HTTP listener mirroring the HTTPS entrypoint |
| `TURBOPANEL_DEV_HTTP_CONTROL_PLANE` | off | Must be `"1"` to serve plaintext traffic on `CADDY_HTTP_PORT`; injected automatically in co-located dev via `turbopanel_dev_user` |
| `CADDY_TLS_CERT` | `./certs/self-signed.crt` | Server leaf certificate (signed by platform CA) |
| `CADDY_TLS_KEY` | `./certs/self-signed.key` | Server leaf private key |
| `TURBOPANEL_TLS_EXTRA_SANS` | — | Comma-separated DNS names for the server cert (e.g. `turbopanel.lan`) |
| `TURBOPANEL_PUBLIC_URLS` | — | Comma-separated list of URLs/hosts this control plane is reachable at (e.g. `https://panel.example.com,https://huey.lan:8443`). Persisted in the `setting` table by the admin API; read by `generate-self-signed-cert.mjs` to derive cert SANs. Also consulted by `resolvePublicBaseUrl` as the preferred install-command host. |

Path resolution lives in `src/server-paths.ts`. It ships **FHS defaults** — config `/etc/turbopanel`, state `/var/lib/turbopanel`, logs `/var/log/turbopanel`, runtime `/run/turbopanel`, static UI `/opt/turbopanel/share/ui` — and every path is env-overridable (`TURBOPANEL_CONFIG_DIR`, `TURBOPANEL_STATE_DIR`, `TURBOPANEL_LOG_DIR`, `TURBOPANEL_RUN_DIR`, `TURBOPANEL_UI_ROOT`, `TURBOPANEL_SOCKET(_DIR)`). Co-located dev uses the same FHS mutable paths by default, all **dev-user-owned**; source repos live under `$HOME` (`~/daemon`, `~/instance`, `~/ui`, `~/website`). The module has no separate dev-mode branch — Ansible (`instance-launch`) and manual commands may override individual paths via env when needed. `resolveInstanceRuntimeConfigPaths` composes `<configDir>/instance/runtime.env` (+ `runtime.dev-vars`). Managed production installs also run the daemon as **`turbopaneld.service`** from `/opt/turbopanel/bin/turbopaneld` (see `../daemon/AGENTS.md` → Filesystem layout & path model). Defaults and overrides are pinned by `src/server-paths.deno.test.ts` (`deno task test:paths`).

## Database (Drizzle + Postgres.js)

The instance uses **Drizzle ORM** over **postgres.js**. The Workers/Hyperdrive client uses `prepare: true` (see Workers Hyperdrive below); the Deno client uses `prepare: false` (direct Postgres, no Hyperdrive). Connection factories live in `src/db.ts`; schema in `src/lib/db/schema.ts`; drizzle-kit config in `drizzle.config.ts`. **Read `src/lib/db/AGENTS.md` before touching schema or the database.** Schema changes are versioned in `migrations/`; `pnpm migrate` applies pending SQL during Workers deploy. Applied versions are recorded in `public.migration`.

| Runtime | Factory | When connected |
|---|---|---|
| Cloudflare Workers | `createWorkersDb(env.HYPERDRIVE)` or `createWorkersDb({ connectionString })` | `HYPERDRIVE` binding in `wrangler.jsonc` (all named envs including `testing`); **`wrangler dev`** may fall back to `TURBOPANEL_DATABASE_URL` when Hyperdrive is absent |
| Deno (self-hosted) | `createDenoDb()` | `TURBOPANEL_DATABASE_URL` set by `instance-launch` |

Route handlers read the per-request client via `getDb(c)` (set by `createApp({ db })`). **Deno boot requires `TURBOPANEL_DATABASE_URL`:** `createDenoDb()` throws before `createApp()` when the variable is missing or blank, so the process exits instead of serving without a database.

| Variable | Purpose |
|---|---|
| `TURBOPANEL_DATABASE_URL` | Full postgres connection URL. **Deno mode:** required at boot — `createDenoDb()` throws immediately when missing or blank (self-hosted instance will not start). Passed directly to postgres.js (supports Unix socket URLs: `postgresql://user:pass@/db?host=/var/run/turbopanel/postgres`). **Workers runtime:** prefers the `HYPERDRIVE` binding; `src/workers.ts` falls back to this env var when Hyperdrive is unset (local `wrangler dev` without a binding). When the URL uses `?host=` for a Unix socket, ensure Deno has read access to that directory (`/run/turbopanel` covers the default Docker bind-mount path). |
| `DATABASE_URL` | **Tooling only** (drizzle-kit, `pnpm migrate`, `./introspect.sh` / `./sync.sh` overrides). Accepted as a fallback when `TURBOPANEL_DATABASE_URL` is unset — common in CI and Cloudflare dashboard deploy workflows. Not read by the Deno instance or Workers runtime at request time. |

### Workers Hyperdrive

`wrangler.jsonc` declares a `HYPERDRIVE` binding stub (replace the placeholder id before deploy). Types: `worker-configuration.d.ts` (`HYPERDRIVE?: Hyperdrive`). Regenerate with `pnpm cf-typegen` after changing bindings.

**Local dev (`wrangler dev`):** do not commit `localConnectionString` in `wrangler.jsonc`. Tilt `sync-env.sh` writes `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` to `instance/.env` (derived from `dev/.env` `POSTGRES_*`, or override in `dev/.env`). Wrangler loads `.env` into `process.env` before applying Hyperdrive bindings — the Worker connects directly to local Postgres (no Hyperdrive pooling/caching in this mode). **`TURBOPANEL_DATABASE_URL`** (or **`DATABASE_URL`** for tooling) in the same file is for migrations/Drizzle/sync and may use different credentials than the Hyperdrive runtime user in production.

The Workers DB client uses `prepare: true` on postgres.js. Hyperdrive has supported named prepared statements since June 2024 and manages their lifecycle across its internal connection pool — per-session state is not a concern. Setting `prepare: true` is **required** for Hyperdrive to cache parameterized `SELECT` queries on the `HYPERDRIVE_CACHED` binding; with `prepare: false`, Hyperdrive sends every query as a simple (unprepared) query and marks all parameterized reads as uncacheable.

Previously `prepare: false` was used because older Hyperdrive versions did not support prepared statements. That restriction no longer applies.

**Unsupported PostgreSQL features** (do not rely on these on the Workers/Hyperdrive path):

- SQL-level prepared statements: `PREPARE`, `DISCARD`, `DEALLOCATE`, `EXECUTE`
- [Advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- `LISTEN` / `NOTIFY`
- Any other modification to per-session state unless Cloudflare documents it as supported

**Cached read models:** approved read-only `SELECT` paths may use the `HYPERDRIVE_CACHED` binding (Workers) or Redis read-through (Deno). Authorization, sessions, and secrets must use the primary connection. See `src/query-cache/AGENTS.md`.

### Tooling

- `pnpm install` — pulls `drizzle-orm`, `postgres`, `drizzle-kit`
- After editing `schema.ts`, run `pnpm drizzle-kit generate` to create SQL in `migrations/`; apply locally with `TURBOPANEL_DATABASE_URL=… pnpm migrate` or `DATABASE_URL=… pnpm migrate`. Workers deploy runs `pnpm migrate` automatically (Node only — no Deno). Deno dev can still use `./sync.sh` (`push`) — see `src/lib/db/AGENTS.md`.

### Caddy dial format

Caddy uses `unix//<path>` where `<path>` has **no leading slash**:

```caddyfile
reverse_proxy unix//run/turbopanel/instance.sock
```

`TURBOPANEL_SOCKET_DIAL` is passed into the `Caddyfile` placeholders.

### Development

The daemon's `runtime-sockets` role (and `scripts/ensure-socket-dir.mjs` for manual runs) ensures `/run/turbopanel` exists and is owned by the dev user in development (**`2770 turbopanel:turbopanel`** in production), using passwordless `sudo` when needed. After bind, the instance hardens the socket file to `0660` (owner+group only) so the daemon can connect.

The instance Deno process runs with scoped permissions (see the `instance-launch` unit template): `--allow-env --allow-sys=networkInterfaces --allow-read=/run/turbopanel,<daemon dir>,<instance dir> --allow-write=/run/turbopanel --allow-run=git,systemctl,tar` (`tar` is needed for the dev-sync tarball). TCP listeners and Unix-domain connects (Postgres `.s.PGSQL.5432`, Redis `redis.sock`, instance listen sock) go on `--allow-net` — Deno 2.9+ treats Unix-socket connect as net, not read. TCP dev Postgres adds `--allow-net=127.0.0.1:5432`.

### Production

The daemon's orchestration bootstrap runs the `socket-dirs-setup` Ansible playbook, which installs `/etc/tmpfiles.d/turbopanel.conf` and applies it with `systemd-tmpfiles --create`. The directory is recreated on boot automatically.

## Caddy (dev + production)

Caddy terminates TLS and routes traffic from a single HTTPS entrypoint:

- `/api/*` and `/ws/*` → Deno instance (`unix:///run/turbopanel/instance.sock`)
- everything else → Expo dev server (**dev**) or static export (**production**)

`reverse_proxy` to the Unix socket sets `X-Real-IP {remote_host}` on `/api/*` and `/ws/*`. The instance uses that header to deduplicate daemon WebSocket reconnects (without it, every reconnect looked like a new fleet member behind the proxy).

In **dev** mode, the Expo upstream proxy must forward `Host {http.request.hostport}` (not `127.0.0.1:8081`, and not `{http.request.host}` alone). Expo's CORS middleware compares `Origin`'s URL `.host` (which includes the port, e.g. `tpdev.lan:8880`) to `req.headers.host`; `{http.request.host}` strips the port so LAN origins get HTML 500s that show up as `Unexpected token '<'` in the browser.

### Development

Caddy/cert installs are handled by the daemon's `caddy` and `instance-certs` Ansible roles; `turbopanel-caddy.service` runs as the **dev user** in development (`turbopaneli` in production).

- Entrypoint: `https://<host>:8443` (Caddy, defined in `Caddyfile`) — binds all interfaces; use `localhost` or the machine's LAN IP.
- Self-hosted TLS uses a **platform CA** (`certs/ca.crt` + `certs/ca.key`) that signs a **server leaf cert** (`certs/self-signed.crt` + `.key`) presented by Caddy (`auto_https off`, no Let's Encrypt). **`auto_https off` is mandatory and must never be removed.** Caddy must never auto-provision certs via ACME or on-demand TLS. All cert issuance goes through `scripts/generate-self-signed-cert.mjs` (self-hosted, platform CA) or an explicitly-configured publicly-trusted cert. The `instance-certs-apply.yml` playbook is the runtime cert-regen path triggered by the admin public-URL apply action. The CA is long-lived and can issue additional certificates later; daemons fetch it from `GET /api/daemon/v1/instance/ca`. Trust `certs/ca.crt` in browsers/OS to avoid warnings.
- Override the resolved binary with `TURBOPANEL_CADDY` (and `TURBOPANEL_DENO` for Deno).

#### Dev-only plaintext HTTP entrypoint (`:8880`)

Co-located dev also exposes `http://<host>:8880` (`CADDY_HTTP_PORT`, default `8880`) — a plaintext mirror of every route on `:8443` with no TLS termination. It exists to bypass self-signed TLS friction when troubleshooting daemon WebSocket connections and to attach a daemon without any CA/cert setup. The block serves `/api/*`, `/ws/*` (including the `@workers_runtime` branch to `WRANGLER_DEV_PORT`), the Expo dev proxy, `/downloads/daemon/*`, `/run.sh`, and the production static-file fallback identically to the HTTPS entrypoint, regardless of `TURBOPANEL_INSTANCE_RUNTIME` (`deno` or `workers`), since both runtimes share this single Caddy proxy. Requests are rejected with **403** unless `TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1`; Ansible sets that flag automatically only when `turbopanel_dev_user` is set (co-located dev hosts). It is never enabled on managed or production installs.

### Daemon TLS trust model (3 paths)

The daemon validates the instance server cert on **every** connect — both chain trust **and** hostname (SAN). There is **no** insecure/skip-verification mode at runtime (the old `TURBOPANEL_TLS_INSECURE` daemon env was dead and was removed; `run.sh --insecure-tls` only affects the bootstrap `curl -k` downloads). Three valid configurations:

| Path | CA trust | SAN requirement |
|---|---|---|
| **Self-signed (self-hosted)** | Daemon trusts the downloaded platform CA (`TURBOPANEL_INSTANCE_CA`, fetched from `GET /api/daemon/v1/instance/ca`) | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname. |
| **Let's Encrypt** | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`) | The real cert already covers the public hostname. |
| **Cloudflare tunnel / proxy** | Cloudflare's edge cert is publicly-valid → **system trust** | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. |

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does not replace them), so configuring the platform CA does not break validation of publicly-trusted certs.

### Production (static UI)

When `TURBOPANEL_UI_MODE=static`, Caddy serves the exported web build from `TURBOPANEL_UI_ROOT` (default `/opt/turbopanel/share/ui`), `isDeveloperSurfaceEnabled()` is disabled (see `src/dev-mode.ts`), and `turbopanel-ui.service` is stopped/disabled by the `instance-launch` role.

Build the static export locally or switch via the dev console **Switch to production build** (runs `ui-build` → `instance-build` → `instance-launch`). For a compiled instance binary, `deno task compile` in this repo produces `dist/turbopanel-instance` with all `--allow-*` flags baked in at compile time (mirrors the `turbopanel-instance.service` `ExecStart` permissions).

Manual export + Caddy:

```bash
cd ../ui && pnpm export
cd ../turbopanel
TURBOPANEL_UI_ROOT=../ui/dist caddy run --config Caddyfile --adapter caddyfile
```

Caddy serves files from `TURBOPANEL_UI_ROOT` (default `/opt/turbopanel/share/ui`; the local manual dev example above sets `../ui/dist`) and falls back to `/index.html` for client-side routes (SPA), matching the Cloudflare Workers asset routing in `ui/wrangler.jsonc`.

Set `CADDY_TLS_CERT` / `CADDY_TLS_KEY` only when overriding the default server leaf certificate paths.

## API / WS surfaces (versioned)

Four versioned surfaces each have REST + WS namespaces (where applicable). Prefixes live in `src/surfaces.ts`; `GET /api/health` is the single deliberately-unversioned probe.

| Surface | REST | WS | Notes |
|---|---|---|---|
| Client (end-user UI) | `/api/client/v1/*` | `/ws/client/v1` | greenfield stubs |
| Install (self-hosted wizard) | `/api/install/v1/*` | — | Deno only for POST endpoints; PAM-gated; no session/cookie on bootstrap |
| Developer (dev console) | `/api/developer/v1/*` | `/ws/developer/v1` (stub) | fleet, diagnostics, shell, addresses, `system/upgrade`, `instance/tunnel-token`, `daemon/(:id/)sync-dev` |
| Admin | `/api/admin/v1/*` | — | Mounted on both Deno and Workers; `superadmin` or `admin` role required; OpenAPI/Scalar at `/api/admin/v1/openapi.json` + `/reference` in development only |
| Daemon | `/api/daemon/v1/*` | `/ws/daemon/v1` | `version`, `instance/ca`; daemons connect on the WS path |

- Route modules: `src/daemon/api-routes.ts`, `src/client/routes.ts`, `src/lib/install/routes.ts` (registered from `deno.ts` only); Deno-only routes `src/developer/system-routes.ts`, `src/developer/dev-sync.ts`, `src/developer/tunnel-routes.ts`, and the version route are registered in `src/deno.ts`. `src/admin/routes.ts` is mounted on both Deno and Workers (admin/superadmin session required). Workers-safe developer REST lives in `src/developer/routes-core.ts` (`workers.ts`); full Deno developer surface in `src/developer/routes.ts`.
- The turbopanel-dev console calls developer routes via `src/instance-client.ts` (Unix socket + HTTPS fallback).
- Hard cutover: daemon, UI, Caddy (`/ws/*`), and Workers routes (`wrangler.jsonc`) moved together. The external CDN node installer must fetch the CA from the new `/api/daemon/v1/instance/ca` path.

## Daemon Cell (`/ws/daemon/v1`)

> **Cost warning:** Durable Objects and Redis are scarce, billable, and cost-sensitive resources. Keep the cell lean — it owns live connection state and projects meaningful changes to Postgres; never use DOs/Redis as UI polling or read APIs. Never fan one dashboard page into one DO/Redis request per server; use Postgres/Hyperdrive for cheap status reads. Avoid heartbeat write amplification and per-viewer cell invocations. Any new cell RPC must justify why Postgres, cache, or a normal API cannot serve the use case. TurboPanel is bootstrapped and must protect Cloudflare costs aggressively.

> **Durable Object hibernation (Workers):** DO GB‑sec billing explodes when the object stays awake. **Never** use `setInterval` / `setTimeout` / `scheduler.wait` inside the cell — schedule work with `ctx.storage.setAlarm()` only for genuine pending work (outbox pump, request/outbox expiry, terminal retention); skip `setAlarm` when the target is unchanged. **Never** use standard `server.accept()` — attach with `ctx.acceptWebSocket()` and the hibernation WebSocket API so idle sockets do not keep the DO hot. **Never** run polling loops, long-running `await`s, or unresolved promises inside DO handlers; finish each RPC quickly and return so the object can hibernate. **Always** close outbound Hyperdrive/postgres.js connections in a `finally` block — an open DB socket prevents hibernation. **One stable DO id per server** via `getByName(serverId)` — never `newUniqueId()` / `idFromName()` per attach. Heartbeat Postgres projection is throttled (≤ once/60 s for `lastSeenAt`; steady-state heartbeats skip DB entirely). Enforced in `src/daemon/cell/do.ts` (banner + `#withProjectionDb`) and `src/daemon/ws-handlers.test.ts` (source scan).

#### Durable Object billing model (SQLite-backed)

TurboPanel daemon cells use SQLite-backed Durable Objects — do not add legacy KV-backed Durable Object storage pricing.

**Compute (Workers Paid):** Requests 1M/mo included then $0.15/M — billing includes HTTP requests, RPC sessions, WebSocket messages, alarm invocations; WebSocket connection establishment counts as a request; **incoming** WS messages billed 20:1 (100 incoming = 5 billable); outgoing WS messages and protocol pings not charged. Duration 400,000 GB-s/mo included then $12.50/M GB-s, billed at 128 MB/DO; a DO incurs duration while executing JS or idle-but-not-hibernatable; standard `accept()` sockets bill for the full connection lifetime, so use the Hibernation API for idle daemon sockets; `state.setWebSocketAutoResponse()` auto-responses add no wall-clock time.

**Compute (Workers Free):** 100,000 requests/day; 13,000 GB-s/day.

**SQLite storage (Workers Paid):** Rows read first 25B/mo then $0.001/M; rows written first 50M/mo then $1.00/M; SQL stored data 5 GB-month then $0.20/GB-month. KV-style `get()/put()/delete()/list()` are hidden SQLite tables billed as rows read/written; **each `setAlarm()` = 1 row written**; **deletes count as rows written**; stored data billable until removed.

**SQLite storage (Workers Free):** 5M rows read/day; 100,000 rows written/day; 5 GB total.

#### Anti-regression rules (daemon cell)

- SQLite-backed DOs only; no legacy KV pricing/guidance.
- Never use DO storage as a polling scratchpad.
- No recurring heartbeat writes unless product correctness requires it; prefer WS lifecycle events + hibernation.
- Never call `storage.list()` (or table scans) in hot paths without documenting why.
- Don't repeatedly read cell metadata for every ping/message; cache stable cell state in memory after init.
- Treat `setAlarm()` as a row write (only call when the target changes).
- Document every new storage key/table/column; any new storage op must state its billing impact.
- Any WS code must preserve hibernation eligibility unless documented.
- **Every DO DB op must be time-bounded.** Wrap Hyperdrive/postgres.js work in `runWithDbTimeout` (`src/db.ts`, hard `DB_OP_TIMEOUT_MS` = 8 s client-side deadline) and always close the pool in `finally`. Never `await` an unbounded DB round-trip inside the DO or hand one to `ctx.waitUntil` — a stalled connect/query holds the object non-hibernatable and bills wall time for the **entire WebSocket lifetime** (root cause of a 71-min / ~547 GB-s single-socket incident: `#projectConnected` → `#withProjectionDb` hung with 0 CPU). The `do.ts` source-scan guard (`ws-handlers.test.ts`) asserts `runWithDbTimeout` + `endDbConnection` stay present. `createWorkersDb` also sets `connect_timeout` + `statement_timeout` as defence-in-depth; the DO projection factory passes the tightest values.
- JWKS must never expose raw platform secrets; daemon-verifiable JWTs use public verification material (asymmetric).

> **Parity:** Cloudflare Workers (Durable Object) mode and self-hosted Deno/Redis mode must keep behavioral parity. DO and Redis are implementation details only — the user-facing API and status semantics are the same on both runtimes.

**WebSocket watchdog (Workers cost cap):** the DO cannot self-terminate a socket that stays awake via some unforeseen path, so the once-a-minute offline-sweep cron's read-only `checkLiveness` (`/rpc/liveness`) also force-closes unhealthy daemon sockets before reporting presence — `#reapUnhealthySockets` + the pure policy in `src/daemon/cell/socket-health.ts` (`evaluateSocketHealth`). Two triggers: **half-open** (auto-response/cell-ping older than `HALF_OPEN_CLOSE_MS` = 150 s, safely above the 60 s ping cadence) and an absolute **max age** (`MAX_WS_CONNECTION_AGE_MS` = 2 h) as a catastrophic backstop. Attach stores `connectedAtMs` in the serialized attachment for the age check. Closing is in-memory only (no SQLite, hibernation-safe); the normal `webSocketClose` path then runs lease cleanup + Postgres demotion, and the daemon reconnects (full-jitter backoff + connect rate limit). This adds **no** per-DO periodic alarm — it reuses the existing cron so there is no recurring row-write cost. Greppable: `daemon-cell event=watchdog-close serverId=… reason=half_open|max_age`.

**Daemon rate limiting (Workers + Deno):** two Wrangler `ratelimits` bindings gate reconnect storms and expensive daemon REST before the cell does work. Counters are account-global for a shared `namespace_id`, so each env uses distinct ids:

| Binding | Purpose | dev `namespace_id` | testing | live | `simple` |
|---|---|---|---|---|---|
| `DAEMON_CONNECT_RATE_LIMITER` | WS upgrade / reconnect storms | `"1001"` | `"2001"` | `"3001"` | `{ limit: 6, period: 60 }` |
| `DAEMON_REST_RATE_LIMITER` | enroll / challenge / session / lease / decrypt | `"1002"` | `"2002"` | `"3002"` | `{ limit: 30, period: 60 }` |

Keys use stable identifiers (`serverId` / `licenseId`, or the `enroll-challenge` sentinel for anonymous enrollment challenges), never IP — see `src/daemon/rate-limit/keys.ts`. Workers resolution lives in `resolveWorkersDaemonRateLimiters` (`workers-bindings.ts`); absent bindings become noops. After JWT verify on `GET /ws/daemon/v1`, a failed connect limit returns **429** before `DAEMON_CELL.getByName` so the Durable Object never wakes. REST returns `{ ok:false, error:"rate_limited" }` with **429**. Inside the DO, an in-memory per-`connectionId` inbound-message cap (`TURBOPANEL_DAEMON_WS_INBOUND_LIMIT` default 120 / `TURBOPANEL_DAEMON_WS_INBOUND_WINDOW_MS` default 60000) drops floods without timers (auto-response pings never hit `webSocketMessage`).

**Deno/Redis parity** shares the same `RateLimiter` interface and keys (`daemonConnectRateLimitKey` / `daemonRestRateLimitKey`). `createRedisRateLimiter` (`src/daemon/rate-limit/redis-rate-limiter.ts`) implements an atomic token-bucket Lua script under `tp:ratelimit:*` (`rateLimitKey` in `src/daemon/cell/redis/keys.ts`); `deno.ts` wires connect + REST limiters from the existing Redis cell client into `registerDaemonWebSocket` / `registerDaemonApiRoutes`. Limits are env-tunable via `TURBOPANEL_DAEMON_CONNECT_RATE_LIMIT` / `TURBOPANEL_DAEMON_CONNECT_RATE_PERIOD` (defaults `{6,60}`) and `TURBOPANEL_DAEMON_REST_RATE_LIMIT` / `TURBOPANEL_DAEMON_REST_RATE_PERIOD` (defaults `{30,60}`); Redis errors fail open so a hiccup never locks out daemons. Inbound floods use the shared pure gate in `src/daemon/rate-limit/inbound-window.ts` (same `TURBOPANEL_DAEMON_WS_INBOUND_*` defaults as the DO). Deno also counts the wire `DAEMON_CELL_PING` against that gate because each ping does real Redis `recordInbound` work (unlike the free Workers auto-response).

Server nodes are tracked by a **Daemon Cell** abstraction keyed by `serverId`. There is no authoritative daemon state in the main instance process or UI read path — presence, outbox, and pending request records live in the cell backend (Redis or DO SQLite), and UI/API status reads come from Postgres. The cell implementation intentionally caches stable runtime state in memory after initialization (`#serverId`, `#runtimeConnected`, live WebSocket attachments on Workers; Redis meta HASH for the same fields on Deno) and persists only the documented SQLite/Redis columns below. Do **not** reintroduce `connection_id` or `connected` as persisted cell columns — they belong in memory, WS attachments, and (on Redis) the meta HASH only.

| Runtime | Backend | Storage |
|---|---|---|
| Deno (self-hosted) | `RedisDaemonCell` (`src/daemon/cell/redis/`) | Redis Streams + HASH + SET at `tp:cell:{serverId}:*`; Unix socket `/run/turbopanel/redis.sock` |
| Cloudflare Workers | `DaemonCellObject` (`src/daemon/cell/do.ts`) | SQLite-backed Durable Object per server, named by `serverId` |

Postgres remains canonical for business data (`server`). The cell is the low-latency hot projection and coordination layer for **presence only** — no monitor tables, no monitor wire payloads, and no HTTP heartbeat ingestion path.

**Postgres status read model:** `server.daemon.status` jsonb holds the UI/API liveness read model. Default status reads are Postgres-only (no read-time `getSnapshots`): `GET /api/client/v1/servers`, `GET /api/client/v1/servers/status`, and `GET /api/client/v1/servers/:id/status`. `GET /api/client/v1/servers/:id/cell` is admin/debug-only and reads live cell snapshots (`withSnapshots: true`).

**Presence model:** daemons send `{ type: "hello", at, agent }` once on connect. After ~60 s of inbound silence they send the wire cell ping (`DAEMON_CELL_PING`) only — **ping-only steady state** on Workers (zero DO SQLite writes/min for an idle connected server). App-level `{ type: "heartbeat", at, agent? }` follows **only when the agent commit changed** (after an update). Clean disconnects mark offline immediately via attach/close. On **Workers**, offline detection is **disconnect-first** via `webSocketClose`/`webSocketError` → `#cleanupWebSocket`; there is **no periodic stale-sweep alarm**. A silent half-open socket self-heals on reconnect (lease force-detach) or command dispatch (outbox requeue → consumer timeout). `#collectStaleDemotions` (`DAEMON_OFFLINE_SWEEP_MS`) is an opportunistic backstop that runs only when `alarm()` already fired for real work — it derives staleness from `getWebSocketAutoResponseTimestamp`, not SQLite `last_seen_at`. On **Redis (Deno)**, timer-driven `maintain()` + `sweepStalePresence` (`DAEMON_CELL_MAINTAIN_MS`, demote at `DAEMON_OFFLINE_SWEEP_MS`) remains the offline path — cost-safe because there is no DO billing. `DaemonCellSnapshot` holds `connected`, `connectedAt`, `lastInboundAt`, `lastSeenAt`, and optional `agent`. On Workers, `last_seen_at` in SQLite is written **only on attach/detach** — not per-message or per-alarm. Projection debounce for inbound hello/heartbeat uses per-isolate in-memory `#lastProjectedAtMs` / `#lastKnownAgent` instead of the removed `last_projected_at` column.

**Offline sweep (Workers, ungraceful disconnects):** a hard power-off or network partition never fires `webSocketClose`/`webSocketError`, so the disconnect-first path above never runs and the DO happily reports "connected" until something else notices — Cloudflare will eventually reap the dead socket, but on no fixed schedule. `src/daemon/cell/offline-sweep.ts` closes that gap with a Cron Trigger (`wrangler.jsonc` `triggers.crons`, `"* * * * *"` — 60s, Cloudflare's finest cron granularity) that every tick: (1) reads servers Postgres currently believes are `connected` (`listConnectedServersForSweep`) plus recently-offline rows for self-heal (`listRecentlyOfflineServersForSweep`), (2) applies **deterministic rotation** (`rotateSweepBatch` in `postgres-projection.ts`) with separate budgets for connected stale-checks (`CONNECTED_SWEEP_BUDGET` 700) and recently-offline self-heal (`SELF_HEAL_SWEEP_BUDGET` 200) so self-heal candidates are not starved by connected rows, (3) fans out a **read-only** `checkLiveness()` RPC (`DaemonCell.checkLiveness`, `do.ts` `/rpc/liveness`) to each selected candidate — it only reads the runtime-tracked WebSocket auto-response timestamp (`ctx.getWebSocketAutoResponseTimestamp`, the same value the free `DAEMON_CELL_PING`/pong keeps warm) and never touches SQLite, so a healthy server costs one Workers subrequest and nothing else, and (4) demotes stale connected servers via `onDaemonDisconnected` (reusing the existing projection) plus `notifyServerWentOffline`, and **self-heals** live+warm servers Postgres still marks offline via `onDaemonConnected`. Null-ping grace uses in-memory first-null observation bookkeeping per cron isolate (`firstNullObservedAtMs` in `offline-sweep.ts`) — a live socket whose auto-response timestamp is still null is never demoted on its first sweep observation, even when Postgres `connectedAt` is old; after the marker ages past `OFFLINE_SWEEP_STALE_MS`, demotion proceeds. Fan-out is capped at `MAX_SWEEP_FANOUT` (900 total across both budgets, under the Workers-paid 1000-subrequest-per-invocation ceiling) and bounded to `FANOUT_CONCURRENCY` (25) in-flight RPCs at a time; servers beyond the per-tick budget are picked up on later ticks via rotation. This does **not** reintroduce a per-DO recurring alarm — every `setAlarm()` reschedule is a billed SQLite row write (see "Alarm / hibernation" below and the DO billing model), so centralizing the "when to check" clock in one Cron Trigger keeps cost proportional to churn, not fleet size. Redis/Deno does not need this cron — it already has `sweepStalePresence` above. Detection latency: up to one cron tick plus the stale grace, so worst case is close to two minutes; typical case is under one.

**Sparse Postgres projection:** connect/disconnect/missed-heartbeat transitions and debounced heartbeats (≤ once/60 s for `lastSeenAt`) project to `server.daemon.status` via `onDaemonConnected` / `onDaemonDisconnected` / `onDaemonHeartbeat` (`control-plane-monitor.ts` → `postgres-projection.ts`). Agent identity from `hello` is stored on `server.daemon.projection`. `ServerFleetPresence` in `server-status.ts` exposes the read model for routes.

**Server geolocation (Workers-only today):** connecting-IP geo is persisted on `server.metadata.geo` (`ServerGeo` in `src/lib/geo/server-geo.ts`). **Cloudflare Workers** resolve geo from `request.cf` via `extractCloudflareGeo()` in `src/daemon/workers-ws.ts`. **Self-hosted Deno** calls `resolveSelfHostedGeo()` in `src/lib/geo/self-hosted-geo-provider.ts` on connect but always returns `null` — there is no bundled IP lookup on managed/self-hosted installs yet (co-located dev uses `__direct__` / Unix socket anyway). Projection (`geoRefreshDue` in `postgres-projection.ts`) writes geo when incoming geo exists and stored `metadata.geo` is missing/invalid, or when `remoteAddress` changes; `geoEquals` ignores `capturedAt` so timestamp-only churn does not rewrite Postgres.

**Host OS (`server.metadata.os`):** daemons send an `os` block on WS `hello` (from `/etc/os-release`, plus point-release / Raspberry Pi detection). Deno WS and the Workers DO hello path call `touchServerMetadata` to merge it into `server.metadata.os` (idempotent). `resolveFleetPresence` surfaces `os` on the primary-DB enrichment path (not in the cached `servers-list` rows). `GET /api/client/v1/servers` returns `os`, `osDisplay` from `formatServerOsDisplay()` (e.g. `"Debian 13.5 (Trixie)"` / `"Raspberry Pi OS 12.11 (Bookworm)"`), and `osLogo` (`debian` | `raspberry-pi-os` | null) from `resolveServerOsLogoKey()`.

#### Server metrics (Workers Analytics Engine)

Host metrics from daemon WS `{ type: "metrics" }` frames are validated in the DO (`validateHostMetricsSample`) then written fire-and-forget via `ServerMetricsStore.writeHostSample` — **no** SQLite, **no** `setAlarm`, **no** await/retry. Metrics is **disposable / statistical / may be sampled** — queries must account for `_sample_interval`. Wiring: `SERVER_METRICS` binding → `AnalyticsEngineServerMetricsStore` (`src/daemon/metrics/analytics-engine/`). Deno uses ClickHouse (`ClickHouseServerMetricsStore`). Store selection: `resolveServerMetricsStore` (always on — no enable/disable gate; incomplete backend config uses a temporary no-op store until converge wires ClickHouse/AE).

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

**Missing metrics:** AE doubles have no null. Missing values are stored as `AE_MISSING_METRIC_SENTINEL` (`-1e308`) — never coerced to `0`. All host metrics are ≥ 0, so the sentinel cannot collide. Query aggregates exclude it via `if(doubleN = AE_MISSING_METRIC_SENTINEL, 0, …)` around the documented `_sample_interval`-weighted average (`SUM(_sample_interval * doubleN) / SUM(_sample_interval)`). Local vitest does not bind AE (unsupported in the local runner); unit tests use fakes only.

#### Server metrics (ClickHouse — self-hosted Deno)

Deno path: `ClickHouseServerMetricsStore` (`src/daemon/metrics/clickhouse/`) over a narrow HTTP client (`X-ClickHouse-User` / `X-ClickHouse-Key`). ClickHouse now runs in a **Docker container** (official `clickhouse/clickhouse-server` image) — ports (`127.0.0.1:8123`) and env-injection are unchanged. Ansible install + env injection: **`../daemon/AGENTS.md`** (ClickHouse). Schema DDL is idempotent (`ensureSchema` once per process).

**Positional storage (AE parity):** ClickHouse stores the exact positional AE layout — `timestamp`, `index1` (serverId), `double1..double20`, `blob1..blob20` — with **no** custom snake_case mapping. Physical column names come solely from `src/daemon/metrics/analytics-engine/field-map.ts` (`doubleColumnForMetric(key)` derives `doubleN` from `HOST_METRIC_KEYS` order; `blobColumn(i)` derives `blobN`; `AE_INDEX_SERVER_ID_COLUMN` / `AE_TIMESTAMP_COLUMN`). The operational-only columns (`received_at`, `sequence`, `interval_seconds`, `schema_version`, typed dimension columns) are **not** persisted. Missing metrics use the same `AE_MISSING_METRIC_SENTINEL` (`-1e308`) as Analytics Engine — never `null` or coerced `0`. Query aggregates exclude the sentinel with the same `if(doubleN = sentinel, …)` semantics as AE (unit-weight rows in ClickHouse vs `_sample_interval`-weighted rows in AE). `expectedSampleCount` is derived from `bucket_seconds / 60` (via `defaultExpectedSamplesPerBucket`).

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

**Cheap fleet index:** `listOnlineServerIds()` reads the Redis online set (Deno) or the sparse `server.daemon.projection.connected` field (Workers) — it does not fan out across all cells.

**WS upgrade flow:** JWT verified in the main isolate/process → cell `attachDaemonSocket` acquires the single-writer lease → outbox delivery is alarm-scheduled (`#pumpOutboxToDaemonSockets`; not a perpetual in-DO loop) → `detachDaemonSocket` releases the lease on close.

**DO storage schema (Workers):** SQLite tables in `DaemonCellObject` (`#ensureSchema` in `src/daemon/cell/do.ts`). One-time DDL is gated by `_cell_schema.version` (`CELL_SCHEMA_VERSION`) — Durable Object SQLite rejects `PRAGMA user_version` (`SQLITE_AUTH`), so a singleton version row is the cheap gate. `#ensureSchema` is **lazy**: the constructor restores hibernation WebSocket attachments only (no schema/version read); schema runs only on paths that touch SQLite (WS upgrade, storage RPCs, non-metrics `webSocketMessage`, close/error cleanup, `alarm`). Host `metrics` frames, `/rpc/diagnostics`, and `/rpc/liveness` must return with **zero** DO SQLite reads/writes and no alarm changes — including on a cold wake — so hibernation stays free of schema churn. When `#ensureSchema` does run on an already-initialized cell it performs **only a version read** (try `PRAGMA user_version`, else `SELECT version FROM _cell_schema WHERE id = 1`); DDL for `_cell_schema` plus the four business tables runs only when the stamp table/row is missing or stale — no per-table `sqlite_master` probing and no always-throwing `ALTER`. Socket-less wakes (`checkLiveness` / `/rpc/liveness`) take `serverId` from `X-Turbopanel-Cell-Server-Id` (or RPC body) and touch zero business rows; a `server_id`-only fallback exists for header-less snapshot/alarm callers. After `#schemaReady` is set in-memory, warm storage paths short-circuit with zero SQLite; a cold isolate that hits a storage path against an already-stamped cell pays at most the version read.

| Table | Columns |
|---|---|
| `cell` | `server_id` (PK), `remote_address`, `connected_at`, `last_seen_at`, `key_last_used_at`, `agent_json`, `updated_at` |
| `leases` | `lease_name` (PK), `holder`, `expires_at` |
| `outbox` | `seq`, `request_id`, `delivery_id`, `kind`, `payload_json`, `status`, `created_at`, `expires_at`, `sent_at`, `acked_at`, `retry_count`, `retry_at` |
| `requests` | `request_id` (PK), `request_kind`, `command_text`, `status`, `result_json`, `error`, `created_at`, `updated_at`, `expires_at`, `ack_at`, `finished_at`, `sent_at`, `daemon_received_at`, `daemon_responded_at` |

| Removed from cell storage | New home |
|---|---|
| `session_id` | not persisted — JWT is stateless (`jti` only) |
| `key_id` | JWT `kid` / JWKS path; passed via attach meta to the Postgres projection |
| `hostname`, `machine_id` | Postgres `server.metadata` (via `touchServerMetadata`) |
| `connection_id` | in-memory + WS attachment (`serializeAttachment`) / `leases.holder` |
| `connected` (persisted int) | in-memory `#runtimeConnected` + `getWebSockets()` |
| `last_projected_at` | per-isolate in-memory `#lastProjectedAtMs` (projection debounce only) |

The DO caches `#serverId` (and live-socket presence) once in the constructor via `#initializeFromStorage()`. Steady-state `webSocketMessage` performs **no SQLite cell writes** for hello/heartbeat/ping paths.

**Lease model:** the daemon-socket single-writer lease is keyed by `connectionId` (stored in `leases` as `DAEMON_SOCKET_LEASE_NAME` with `holder` = connectionId). `DaemonCellLease` is `{ holder, expiresAt }` (no duplicate `token`). The **delivery** lease (`claimDeliveryLease` / `renewDeliveryLease` / `releaseDeliveryLease`) is distinct and owns outbox in-flight delivery. Safety-critical single-daemon guarantee: `IdlePresence` + `ensure-single-daemon.sh` flock (see daemon `AGENTS.md`). Redis keeps `connectionId` / `connected` in the `tp:cell:{serverId}:meta` HASH because Redis has no per-connection isolate memory (needed by the Lua sweep + orphan reclaim).

**Requests vs outbox:** `outbox` = instance→daemon durable delivery queue keyed by `deliveryId` (retryable frames via `retry_count` / `retry_at`, deleted on ack, ephemeral once delivered). `requests` = correlation/response-tracking rows keyed by `requestId` (`PendingRequestRecord` lifecycle queued→sent→acked→done/failed/expired; terminal rows retained `TERMINAL_UPDATE_RETENTION_MS`). Daemon replies (`handleInbound`) mutate the request row = completed responses; the WS send is ephemeral in-memory delivery. See `src/daemon/cell/contracts.ts`.

**Alarm / hibernation (Workers, disconnect-first):** `#scheduleNearestAlarm` arms an alarm only for genuine pending work (deliverable/retry/inflight outbox, request/outbox expiry, terminal retention) and skips `setAlarm` when the target is unchanged (`#scheduledAlarmMs` cache). No periodic stale-sweep alarm.

**Co-located daemon** (`__direct__`): stored in the `cell` table (`remote_address = '__direct__'`) so `tryAssignColocatedDaemonToInstalledOrganization` and tunnel routing still work.

**Challenge stores:** enrollment and auth challenges are **stateless HMAC-signed tokens** (`src/daemon/cell/stateless-challenge.ts`). `issue()` returns a self-contained `challengeId = base64url(payload).base64url(HMAC)` signed with the `daemon-challenge-signing` derived key. `consume()` re-derives and verifies — no storage, no DO, no Redis key. Replay protection relies on the short TTL (60s) and the daemon's Ed25519 private key requirement.

**`DAEMON_INBOUND_ALLOWED`** is defined in `src/daemon/cell/protocol.ts` (not `hub.ts`).

**Auto-response liveness (cell ping):** the DO registers `setWebSocketAutoResponse(DAEMON_CELL_PING → DAEMON_CELL_PONG)` in its constructor (`protocol.ts` constants). The runtime answers `{type:"ping"}` with `{type:"pong"}` **without waking the DO** — this is the primary idle liveness path on Workers. The daemon's `IdlePresence` sends that wire ping after ~60 s of inbound silence; app-level `{type:"heartbeat"}` is reserved for agent-commit changes only (see daemon `AGENTS.md`). Redis parity relies on the same wire ping updating `lastSeenAt` in cell meta. **Deno/Redis coalesce skew:** `recordInbound` coalesces Redis `lastInboundAt` writes with a 10s timer-skew floor (`HEARTBEAT_COALESCE_MS - 10_000`) so a nominal 60s ping cadence still refreshes meta every minute — without the skew, early `setInterval` ticks were coalesced and a single missed ping could trip `DAEMON_OFFLINE_SWEEP_MS` (150s) while the socket was still alive. The Deno WS ping path also re-projects Postgres online when Redis or Postgres still shows offline after a false demotion (Workers DO path unchanged — auto-response never wakes the object for pings).

**Verbose cell tracing (`TURBOPANEL_DAEMON_DEBUG`):** setting `TURBOPANEL_DAEMON_DEBUG=1`/`true` (checked via `isDaemonDebugEnabled()` in `src/logger.ts`, and `#isDaemonDebug()` in `src/daemon/cell/do.ts`) enables verbose, structured tracing of the daemon cell, its storage backend, and the daemon WS message flow. The flag applies on process restart — there is no live toggle. Traced events include WS attach/detach, inbound/outbound daemon messages, `DAEMON_CELL_PING`/pong liveness, `enqueue`/`markSent`/`handleInbound` (with pending-request status transitions), delivery lease acquire/renew/release, outbox `readOutboxBatch`/`ackOutbox`, `putSnapshot`, the command pipeline's `command-dispatch → sent → ack/outcome` lifecycle (`src/lib/commands/consumer.ts`), and the correlated `createRequestAndWait`/`waitForRequest` round-trips for dev-sync, tunnel-token, public-urls apply, and addresses requests. Greppable log tokens: `cellTrace()` (in `src/logger.ts`) emits `daemon-cell event=<name> …` lines shared by both the Redis backend (`src/daemon/cell/redis/cell.ts`) and Deno WS (`src/daemon/deno-ws.ts`); the Durable Object emits equivalent `daemon-cell event=…` lines via its private `#trace()` in `src/daemon/cell/do.ts` so wrangler-captured stdout stays filterable alongside Deno logs. The correlated `createRequestAndWait`/`waitForRequest` call sites in `src/developer/dev-sync.ts`, `src/developer/tunnel-routes.ts`, `src/admin/routes.ts`, and `src/developer/routes-core.ts` also log via `cellTrace()` under the `daemon-cell` component (`request-start`, `request-enqueued`, `request-result`). Filter `command-consumer` for the command pipeline only — `src/lib/commands/consumer.ts` uses `commandConsumerTrace()` and emits `command-consumer event=<name> …` lines (`dispatch-start`, `dispatch-enqueued`, `dispatch-sent`, `dispatch-result`, `dispatch-failed`). Debug mode also emits per-call-site DO storage-op counters (`storageReads`, `storageWrites`, `storageByCallSite`) on `CellDiagnostics`, surfaced via `getDiagnostics()` / `GET /rpc/diagnostics`, incremented by the `#sql(callSite,…)` / `#setAlarm` / `#deleteAlarm` wrappers (thin pass-through when debug is off). Redis exposes equivalent counters via `#bumpMethodRoute` / `#bumpDiag`. These counters are the billing-audit baseline. Tracing is logging-only on both backends, and the DO path remains hibernation-safe (no timers, no held-open connections) per the hibernation-warning rules above.

**Enqueue-then-poll request contract:** correlated outbound work (dev-sync, tunnel-token, public-urls apply, command dispatch) uses `createRequestAndWait` / `waitForRequest` on `DaemonCell`. The backend **enqueues once and returns immediately** — it must not block inside the DO or Redis cell. The **caller-side adapter** polls `getRequest(requestId)` until the `PendingRequestRecord` reaches a terminal status or the deadline (`do-registry.ts` jittered sleep on Workers; `redis/cell.ts` `setTimeout` poll in the Deno process — cost-safe there because there is no DO billing). On Workers, `#waitForRequest` inside `do.ts` is intentionally single-shot (current row only); long waits happen in the worker isolate so the DO hibernates between RPCs. Command consumer (`src/lib/commands/consumer.ts`) follows the same pattern after outbox enqueue.

**Purge:** `DELETE /api/client/v1/servers/:id` hard-deletes the Postgres row and calls `DaemonCell.purge()` to wipe all `tp:cell:{serverId}:*` keys (Redis) or DO SQLite state (Workers). Blocked for the co-located control-plane server (403). Preflight blockers today: `network` rows referencing the server (409 `server_has_blockers` via `src/client/servers/delete-guards.ts`); future service placement checks extend the same helper. **Self-hosted (Deno):** after the server row is deleted, invalidates that server's `license_id` when set (even if cell purge fails); co-located server delete remains blocked separately so the control-plane license is never removed this way. **Workers:** keeps the license active for reuse (billing hook reserved in `src/client/authn/license-lifecycle.ts`).

**License invalidate (not delete):** `DELETE /api/client/v1/licenses/:id` sets `license.revoked_at`, revokes daemon keys on bound servers, and rejects `POST /api/daemon/v1/auth/session` when the server's `license_id` is inactive. Co-located control-plane license remains non-invalidateable. Server rows stay until separately deleted.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/daemon/v1/jwks.json` | public | Ed25519 public JWKS for daemon JWT verification (`Cache-Control: public, max-age=300`) |
| `POST /api/daemon/v1/commands/lease` | daemon JWT | Poll for pending commands (stub — returns `{ commands: [] }`) |
| `POST /api/daemon/v1/secrets/decrypt` | daemon JWT | Batch-decrypt `tpsecret.v1` envelopes (`{ ciphertexts }` → `{ plaintexts }`; null per failed entry) |

- No `version` push / auto-update: the daemon never self-updates.

## Command Pipeline

Commands are canonical in Postgres (`command` table). Queues are transport only — Cloudflare Queues on Workers, RabbitMQ on Deno. The Daemon Cell is live delivery, presence, and request correlation only.

> **Cost / hibernation:** the command consumer enqueues a `command-dispatch` envelope into the cell outbox, then **polls** `waitForRequest` from the worker/Deno process — it never blocks inside the Durable Object. Do not add timers, polling loops, or long-lived promises inside `DaemonCellObject`; do not hold Hyperdrive connections open across handler returns. Never build general command queues inside Durable Objects — Cloudflare Queues / RabbitMQ own durable transport; the cell owns only the live WS outbox + pending-request row. Cloudflare Workers (Durable Object) mode and self-hosted Deno/Redis mode must keep behavioral parity for every command feature. Production daemon commands must be typed handlers — never arbitrary shell strings.

| Status | Meaning |
|---|---|
| `queued` | Record created, envelope enqueued |
| `dispatching` | Consumer received, checking presence |
| `sent` | Envelope enqueued into cell outbox |
| `acked` | Daemon sent `command-ack` (non-terminal) |
| `running` | Daemon executing (future use) |
| `succeeded` | Terminal — `command-outcome ok:true` received |
| `failed` | Terminal — offline, validation error, or `ok:false` |
| `timed_out` | Terminal — no outcome within `expires_at` |
| `cancelled` | Terminal — operator-cancelled |

All lifecycle timestamps and status live in the `metadata` jsonb blob on the `command` row. `transitionCommand` merges patches atomically. `serializeCommandRecord` exposes a flat `CommandRecord` to callers. Organization is derived from the server — there is no `organization_id` column on `command`. Do not store large logs or streaming output in Postgres — `result` and `error` are bounded summaries only.

### Queue transport

- **Workers:** `TURBOPANEL_COMMAND_QUEUE` binding → per-env queue names in `wrangler.jsonc`: `live` uses `daemon-commands` / `daemon-commands-dlq`; `testing` uses `staging-daemon-commands` / `staging-daemon-commands-dlq`; local top-level worker uses `dev-daemon-commands` / `dev-daemon-commands-dlq` (max 3 retries). Declared under `queues.producers` and `queues.consumers`. Consumer handler: `queue(batch, env, ctx)` in `src/workers.ts`.
- **Deno:** `TURBOPANEL_AMQP_URL` (same URL as email queue, different topology). Exchange `turbopanel.commands`, queue `turbopanel.commands.dispatch`, routing key `command.dispatch`, DLX `turbopanel.commands.dlx` → DLQ `turbopanel.commands.dispatch.dlq`. Consumer: `startCommandConsumer()` in `src/lib/commands/deno-consumer.ts`, started in-process from `src/deno.ts`. **TODO:** extract to a dedicated `turbopanel-command-consumer.service` systemd unit in a future pass (mirrors the mailer pattern).
- Shared abstraction: `CommandQueue` interface in `src/lib/commands/queue.ts`; `getCommandQueue(c)` Hono accessor. Envelope schema in `src/lib/commands/envelope.ts` — small (ids + type + timestamps; no large payloads). The `CommandEnvelope` no longer carries `organizationId` — org is derived from the server at consume time.

### Client endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/client/v1/servers/:id/commands/ping` | session + read | Create `daemon.ping` command, enqueue |
| `POST` | `/api/client/v1/servers/:id/hostname` | session + manage | Validate hostname, create `server.hostname.set` command, enqueue |
| `POST` | `/api/client/v1/servers/:id/commands/reboot` | session + manage | Create `server.reboot` command, enqueue |
| `POST` | `/api/client/v1/environments/:id/deploy` | session + manage | Merge project+env ComposeDocuments → runtime YAML; create `environment.deploy` on target `serverId`; persists `environment.metadata.serverId`. Poll via existing command GET (Postgres only). |
| `GET` | `/api/client/v1/servers/:id/commands/:commandId` | session + read | Poll status; ping includes latency breakdown |
| `GET` | `/api/client/v1/servers/:id/commands` | session + read | List recent commands (optional) |

Authz: ping/get require read (`assertCanReadOr403`); hostname and reboot require manage (`assertCanManageOr403`). Daemon authz must not leak into these session-authenticated routes.

### Consumer behavior

`processCommandEnvelope` in `src/lib/commands/consumer.ts` is the single source that writes terminal `command` rows. The WS inbound path (`command-ack`, `command-outcome`) only updates the hot `PendingRequestRecord` in the cell. For MVP, `daemon.ping`, `server.hostname.set`, `server.reboot`, and `environment.deploy` fail fast when the daemon is offline. For `server.hostname.set` success, the consumer calls `touchServerMetadata` to update `server.metadata.hostname` — the instance never updates hostname speculatively.

`server.reboot` requires `organization:manage`, carries an empty payload, uses a 120s consumer timeout, has no `touchServerMetadata` side-effect, and is executed daemon-side via `sudo systemctl reboot` (handler implemented in a separate phase).

`environment.deploy` uses a 600s consumer timeout. Compose merge + Traefik label injection + Docker/Caddy bootstrap run on the daemon (`daemon/src/instance/commands/deploy-environment.ts`). **Cost:** one cell outbox enqueue; UI polls Postgres command rows only — never Durable Object reads for deploy status. Hosting-edge Caddy (`:80`/`:443`, LE off) is distinct from control-plane Caddy (`:8443`). Future: multi-server compose placement, WireGuard, swarm-style replicas — seams only.

### Compose documents (`src/lib/compose/`)

`project.options.compose` / `environment.options.compose` store a **ComposeDocument** (`version: 1`, `data`, `presentation`) so YAML comments, blank lines, and section order survive editor round-trips. APIs and deploy reject anything that is not a ComposeDocument (or an intentionally empty value). Deploy uses `composeDocumentToRuntimeYaml` (presentation stripped). Overlay merge: `mergeComposeOverlay`.

Future webhook-triggered operations — deploy service, rebuild app, rotate tunnel token, update daemon, restart service, collect diagnostics, stream logs — reuse the same `command` table, `CommandQueue` abstraction, and typed-handler model on the daemon. No new queue infrastructure is needed.

`src/lib/commands/` is pure TypeScript (no Deno/Workers-only imports) so it is importable from both runtimes and the in-process consumer:

- `types.ts` — `CommandType`, `CommandStatus`, `TERMINAL_COMMAND_STATUSES`
- `schemas.ts` — per-type payload/result validators (`parseCommandPayload`, `parseCommandResult`)
- `envelope.ts` — `CommandEnvelope`, `encodeCommandEnvelope`, `parseCommandEnvelope`
- `hostname.ts` — `isValidHostname`, `assertValidHostname` (RFC-1123 allowlist; canonical — daemon mirrors it)
- `ids.ts` — `newCorrelationId()`, `nowIso()`
- `queue.ts` — `CommandQueue` interface, `getCommandQueue`
- `command-amqp-topology.ts` — Deno AMQP topology constants + `assertCommandAmqpTopology`
- `deno-amqp-queue.ts` — Deno RabbitMQ producer
- `workers-queue.ts` — Workers Cloudflare Queues producer
- `noop-command-queue.ts` — fallback when broker/binding unavailable
- `consumer.ts` — `processCommandEnvelope` (shared consumer logic)
- `deno-consumer.ts` — `startCommandConsumer` (Deno in-process AMQP consumer)

DB helpers: `src/lib/db/command-records.ts` — `createCommandRecord`, `getCommandRecord`, `listServerCommands`, `transitionCommand` — all return the flat `CommandRecord` (serialized from the `metadata` jsonb blob).

### Dev sync (push a daemon build without git)

`src/developer/dev-sync.ts` tars the local `../daemon` checkout, base64-encodes it, and streams `dev-sync-begin` → `dev-sync-chunk*` → `dev-sync-end` over the daemon WS; the daemon unpacks, `deno cache`s, replies `dev-sync-result`, and restarts. Developer routes: `POST /api/developer/v1/daemon/:id/sync-dev` and `…/daemon/sync-dev` (all). Dev console: **Sync Dev Build** in the fleet section.

### Instance Cloudflare tunnel

`POST /api/developer/v1/instance/tunnel-token` (`src/developer/tunnel-routes.ts`) sends a `tunnel-token` WS message to the co-located daemon, which writes `cloudflared/tunnels/instance.token` and (re)starts cloudflared. External remote daemons then reach this instance via the tunnel → Caddy → socket. Dev console: **Save Tunnel Token** in the fleet section (empty token tears it down).

Correlated outbound work uses `createRequestAndWait` / `waitForRequest` (see **Enqueue-then-poll request contract** above) for dev-sync, tunnel-token, and public-urls apply.

### Public URL apply

**Public URL apply**: `POST /api/admin/v1/instance/public-urls/apply` (Deno only) sends a `public-urls-update` WS message to the co-located daemon with the current URL list. The daemon writes `TURBOPANEL_PUBLIC_URLS` to **`/etc/turbopanel/instance/runtime.env`** — never the checkout, re-runs the `instance-certs` Ansible role (regenerating the leaf cert with updated SANs, CA preserved), and reloads `turbopanel-caddy`. Replies with `public-urls-update-result { ok, error? }`. On Workers, the endpoint returns 422 (cert apply not applicable). Timeout: 60 s.

```mermaid
sequenceDiagram
    participant UI
    participant Instance as Instance API (Deno)
    participant Cell as Daemon Cell (Redis)
    participant Daemon as Co-located Daemon

    UI->>Instance: POST /api/admin/v1/instance/public-urls/apply
    Instance->>Instance: setPublicUrls(db, urls)
    Instance->>Cell: enqueue public-urls-update envelope
    Cell->>Daemon: WS: { type: "public-urls-update", urls }
    Daemon->>Daemon: write runtime.env, run instance-certs, reload caddy
    Daemon->>Cell: WS: { type: "public-urls-update-result", ok }
    Cell->>Instance: PendingRequestRecord { status: "done" }
    Instance-->>UI: { ok: true, applied: true }
```

## Authentication

The instance uses a **custom PAM-style auth model** built entirely on the **Web Crypto API** (`crypto.subtle`, `crypto.getRandomValues`). There is no dependency on Node.js crypto or `nodejs_compat` mode — the same primitives run on both Deno and Cloudflare Workers.

**`nodejs_compat` is enabled** in `wrangler.jsonc` as a toolchain compatibility shim (required for drizzle-kit and postgres.js during the migration step). **Rarely use Node.js APIs in application code** — always prefer Cloudflare-native APIs: Web Crypto API (`crypto.subtle`, `crypto.getRandomValues`), Cloudflare Cache API, etc. Do not use `nodejs_compat` as justification for pulling in Node.js-specific libraries in application routes.

#### Password hashing

Credential-account passwords use **PBKDF2-HMAC-SHA256** via `crypto.subtle` (`src/client/authn/password.ts`). This is the strongest password-hashing primitive available in native Workers/Deno Web Crypto — Argon2 and scrypt are not exposed, and WASM Argon2 is heavier and awkward in Workers. Stored format: `$pbkdf2-sha256$<iterations>$<base64url-salt>$<base64url-hash>`. New hashes use `TURBOPANEL_PBKDF2_ITERATIONS` (default **600,000** when unset); the iteration count is embedded so existing hashes still verify. Verification uses constant-time byte comparison. Do not use plain SHA-256 for passwords.

**Daemon key authentication:** daemon auth now starts with HTTP-first enrollment/session issuance, then uses a short-lived stateless daemon JWT for protected daemon REST and daemon WebSocket upgrade authentication.
- **Enrollment challenge + proof**: daemon requests `POST /api/daemon/v1/auth/challenge` (no credentials), signs `buildEnrollmentPayload()` (`turbopanel-daemon-enroll-v1` canonical format), then calls `POST /api/daemon/v1/enroll` with `{ licenseId, licenseToken, publicJwk, challengeId, signature, ... }`. The instance verifies license + proof-of-possession, resolves/creates `server`, and stores the daemon public key on the server row.
- **Auth challenge + session token**: enrolled daemon requests `POST /api/daemon/v1/auth/challenge` with `{ serverId, keyId }`, signs `buildAuthPayload()` (`turbopanel-daemon-auth-v1` canonical format), then calls `POST /api/daemon/v1/auth/session` to receive a **15-minute stateless JWT**. Session issuance records key use in Postgres (`touchDaemonKeyLastUsed` on `server.daemon.key.lastUsedAt`) only — it does **not** call `DaemonCell.putSnapshot()` or wake the cell.
- **JWT enforcement**: protected daemon REST routes use `requireDaemonJwt` middleware (`Authorization: Bearer <token>`) only on `/commands/lease` and `/secrets/decrypt`; exempt routes include `GET /readiness`, `GET /instance/ca`, `GET /jwks.json`, `GET /openapi.json`, `GET /reference`, `POST /auth/challenge`, `POST /enroll`, and `POST /auth/session`. JWT verification checks signature, expiry, and claims only — no session row lookup.
- **Rate limits (Workers)**: `DAEMON_REST_RATE_LIMITER` gates `/auth/challenge` (by `serverId` when present; anonymous enrollment challenges use the stable `enroll-challenge` sentinel via `daemonEnrollChallengeRateLimitKey`), `/enroll` (by `licenseId`), `/auth/session` (by `serverId`), `/commands/lease`, and `/secrets/decrypt`. Public reads (`/readiness`, `/instance/ca`, `/jwks.json`, `/openapi.json`, `/reference`) are unlimited. `DAEMON_CONNECT_RATE_LIMITER` gates the `/ws/daemon/v1` upgrade after JWT verify and before the cell wakes. Shared keys live in `src/daemon/rate-limit/`; Deno wiring is still a noop this phase.
- Remote WSS connections require a valid daemon JWT at upgrade time; unauthenticated server row creation from `hostname`/`machineId` alone is disallowed.
- Co-located socket daemons use the same auth model; there is no unauthenticated bypass.
- `DAEMON_INBOUND_ALLOWED` in `src/daemon/cell/protocol.ts` is a static set of accepted post-auth message types — not an authz system.
- Daemon identity is stored on the `server` row as typed jsonb `server.daemon` (`key` only). Hot-path timestamps live in `server.daemon_key_last_used_at` and `server.last_seen_at`. No `serverkey` or `daemonsession` tables.
- Re-enrollment or recovery with a valid license replaces `server.daemon` entirely; old daemon keys are not kept for MVP.
- JWT payload: `sub` (serverId), `kid` (`server.daemon.key.id`), `jti` (random uuid, logging only), `iss`, `aud`, `typ`, `iat`, `exp`. No `sid`. Daemon JWTs are **EdDSA (Ed25519)** signed; header carries `alg: "EdDSA"`, `typ: "JWT"`, and a string `kid` (SHA-256 fingerprint of the public JWK). Verification selects the public key by `kid`.
- Revoking daemon auth: set `server.daemon.key.revokedAt`. Existing JWTs remain valid until their 15-minute expiry. New JWT issuance fails.

```mermaid
sequenceDiagram
    participant Daemon
    participant Instance as Instance API

    Daemon->>Instance: POST /api/daemon/v1/auth/challenge
    Instance-->>Daemon: { challengeId, nonce, expiresAt }
    Daemon->>Instance: POST /api/daemon/v1/auth/session (signed payload)
    Instance-->>Daemon: { token, expiresAt }
    Daemon->>Instance: GET /ws/daemon/v1\nAuthorization: Bearer <token>
    Instance-->>Daemon: 101 Switching Protocols
    Note over Daemon,Instance: WS open - live streaming only
    Instance->>Daemon: ping
    Daemon-->>Instance: pong
```

#### Session model

Sessions are **opaque DB-backed tokens** with a signed cookie:

- A 32-byte random token is generated and stored in the `session` table (`token`, `userId`, `expiresAt`, `ipAddress`, `userAgent`).
- The cookie value sent to the browser is `<token>.v<version>.<HMAC-SHA256-signature>`, where the signature is computed over the raw token using the session secret for that version.
- On every request the signature is verified first (constant-time); only then is the DB queried for the session row.
- Cookie name: `turbopanel.session_token` on HTTP, `__Secure-turbopanel.session_token` on HTTPS (resolved from the request URL in `src/client/authn/crypto.ts`).
- Cookie attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` (7 days). `Secure` is added automatically when the request URL is HTTPS.

#### Host PAM install gate (Deno only, install wizard)

On the **Deno runtime**, initial setup is gated by host PAM — **`root`** or any user in the **`sudo` / `wheel` / `admin`** groups. Host auth **never** receives a session or cookie. In **production** the instance process runs as **`turbopaneli`**; in **development** it runs as the dev user. It runs **`pamtester login "$username" authenticate`** via **`sudo -n`** and a shell pipe (see `src/client/authn/credentials.ts`). **`pamtester`** must be installed on managed hosts (the daemon `daemon-prereqs` role). Sudoers: **`turbopaneli`** gets `NOPASSWD: /usr/bin/pamtester login * authenticate` in `instance-launch` `upgrade-sudoers.yml` (production). The instance systemd unit must grant **`--allow-run=/bin/sh,sudo,/usr/bin/sudo`**.

**Dev mode bypass (`TURBOPANEL_DEV_HOST_AUTH=group-only`):** When this env var is set, `verifyInstallHostCredentials` skips `verifyPamLogin` entirely. The password field must still be non-empty (the UI requires it), but it is not verified against PAM. Group membership (`sudo`/`wheel`/`admin`) is still checked via `id -nG`. This var is injected automatically by `dev/scripts/instance-serve.sh` in Tilt dev — it is never set on managed production hosts. `pamtester` is only required on managed hosts (installed by the daemon `daemon-prereqs` role).

**Install flow:** `POST /api/install/v1/bootstrap` verifies host PAM and returns `{ ok: true }` only (no cookies). The UI keeps host username/password in the form and reveals superadmin fields client-side. `POST /api/install/v1/` re-verifies host PAM, creates org (**Default Organization**) + team (**Default Team**) + **superadmin** user (`role: superadmin`, email + credential `account`), assigns the co-located daemon, and returns a signed session cookie for the superadmin only. Host accounts cannot sign in via `/auth/sign-in`. This path is **never active on Workers**.

Superadmin-only routes (`createRootOnlyMiddleware`, `resolveRootSession`) authorize by **`user.role === 'superadmin'`**, not PAM root. `user.role` ∈ `superadmin | admin | user` is **instance authority only** and is distinct from resource access profiles. **`superadmin` and `admin`** both bypass resource authorization checks — `can()` and `listVisible()` short-circuit in SQL without requiring any `grant` rows. Future superadmin-only platform operations (developer reset-dev, etc.) remain restricted to `superadmin` via middleware, not `admin`.

#### Session secret configuration

Both runtimes read the same root secret env vars. **`TURBOPANEL_SECRET`** = single-key mode (normalized to `v1` when `TURBOPANEL_SECRETS` is unset). **`TURBOPANEL_SECRETS`** = plural keyring (`2:secret,1:secret`; highest version is current signing key). **First key signs / all keys verify.** Every key yields a stable `kid`; JWT headers include the active `kid`.

`deriveSecretsConfig()` HKDF-derives HMAC keys for `session-signing` and `daemon-challenge-signing`. `deriveEncryptionSecretsConfig()` derives AES-256-GCM keys for `data-encryption`. The **daemon-facing JWT** uses `deriveDaemonJwtKeyring()` (`src/daemon/authn/daemon-jwt-keyring.ts`: Ed25519, HKDF salt `turbopanel`, info `daemon-jwt-eddsa`) — the legacy HMAC `daemon-jwt-signing` purpose is no longer used for daemon JWTs.

**JWKS** (`GET /api/daemon/v1/jwks.json`) publishes all currently-valid **public** Ed25519 verification keys only — never `TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS` or any HMAC key material. Old keys stay in JWKS during rotation and are removed once old tokens expire (≤15 min).

**Rotation:** add a new active key at the highest version, deploy, old tokens verify during their ≤15-min window, then drop the old key from the keyring/JWKS.

| Variable | Behaviour when missing |
|---|---|
| `TURBOPANEL_SECRET` | Single 48-char root key (`src/generate-secret.ts`); normalized to `v1` when `TURBOPANEL_SECRETS` is unset |
| `TURBOPANEL_SECRETS` | Versioned list `2:secret,1:secret`; highest version is current signing key |

| Runtime | Source |
|---|---|
| Deno | `TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS` env vars (`instance-launch` injects them on managed hosts) |
| Workers | Same names as Wrangler bindings / `.dev.vars` (Tilt `sync-env.sh` writes them from `dev/.env`) |

**Root secret format:** 48 characters from `[A-Za-z0-9_]`, always at least one `_` between positions 2–47 (never in position 1 or 48). Implementation: `scripts/generate-secret.mjs` (re-exported from `src/generate-secret.ts`). Generate with `pnpm generate:secret` in `instance/`. HKDF uses the UTF-8 bytes of the string as key material (`deriveKey` in `src/client/authn/secrets.ts`). Same helper (`generatePassword`) is the canonical generator for random passwords.

At least one of `TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS` must be set in production. Workers always fail fast when both are missing. Co-located dev Ansible (`instance-launch`) persists a single signing secret at `/etc/turbopanel/instance/.instance_secret` and injects it into `runtime.dev-vars` for **both** Deno and Workers runtimes so session cookies and daemon JWTs survive runtime toggles; the Deno unit also loads `runtime.dev-vars` via `EnvironmentFile`. Without that file, Deno co-located dev (`TURBOPANEL_UI_MODE` ≠ `static`) falls back to an ephemeral random key (sessions do not survive restarts or switches).

Add a `TURBOPANEL_SECRET` to `dev/.env` before running `pnpm dev` (Tilt syncs it to `instance/.dev.vars` — see `dev/.env.example`).

#### Data encryption

Shared symmetric encryption for multi-server secret storage, keyed off the same root secret via HKDF (`info: "data-encryption"` → AES-256-GCM). Envelope format: `tpsecret.v1.<keyVersion>.<ivB64u>.<ciphertextWithTagB64u>`. The embedded `keyVersion` enables direct lookup against `DerivedSecretsConfig.current` / `.fallbacks` during rotation — no trial decryption. All persisted secret values must be sealed envelopes; decryption rejects any value that is not a valid `tpsecret` or `tpdaemon` envelope.

**Boundary:** client/UI code imports only `encryptSecret` (`src/client/authn/data-encryption.ts`); decryption is exposed solely through `POST /api/daemon/v1/secrets/decrypt` on the daemon surface (daemon JWT). The symmetric key never leaves the instance — remote daemons request decryption over their authenticated channel. Any valid daemon JWT may decrypt any envelope today (org scoping is a future hardening option).

**CORS (Scalar / docs site):** when `TURBOPANEL_UI_CORS_ORIGINS` is set (comma-separated browser origins), `src/cors.ts` reflects matching `Origin` headers on API responses. Co-located dev injects `http://localhost:{WEBSITE_PORT}` and `http://127.0.0.1:{WEBSITE_PORT}` via `instance-launch` on the Deno instance unit (and Workers `.dev.vars` when `turbopanel_instance_runtime=workers`) so the docs site can fetch OpenAPI through Caddy cross-origin. Cloudflare Workers production/testing set matching website origins in `wrangler.jsonc` (`live`: `https://turbopanel.io`; `testing`: `https://testing.turbopanel.io`).

**Public sign-up (Workers dev):** `TURBOPANEL_IS_SIGNUP_ENABLED=1` (or `true`) in `dev/.env` → `sync-env.sh` writes it to `instance/.dev.vars`. Env override wins over the `IS_SIGNUP_ENABLED` DB setting. Local Tilt defaults it to `1` in `.env.example`.

#### Auth routes

Client auth lives under `CLIENT_API_PREFIX` (`/api/client/v1`):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/client/v1/auth/sign-in` | Verify DB user credentials, create session (rejects root; use install wizard) |
| `POST` | `/api/client/v1/auth/sign-out` | Delete session, clear cookie |
| `POST` | `/api/client/v1/auth/sign-up` | Create a regular user account when signup is enabled (`IS_SIGNUP_ENABLED = '1'` in DB, or `TURBOPANEL_IS_SIGNUP_ENABLED=1`/`true` env override); no session returned — user must sign in. Generates a 24h email verification token and enqueues a `signup-verification` email job (Deno → RabbitMQ → mailer → SMTP/Mailpit; Workers → Mailgun directly). Also logs the token and verify URL to console in dev |
| `GET` | `/api/client/v1/auth/verify-email?token=<token>` | Consume a 24-hour email verification token; sets `user.isEmailVerified = true` |
| `GET` | `/api/client/v1/authn/session` | Return current user session or 401 |
| `GET` | `/api/client/v1/status` | Public: `{ needsInstall, isInstallMode, isSignupEnabled }` — Deno: install mode until org + superadmin exist; Workers: always `needsInstall: false`, `isSignupEnabled` from DB + env override |
| `POST` | `/api/install/v1/bootstrap` | Deno: verify host PAM (root or sudo user), no cookies |
| `POST` | `/api/install/v1/` | Deno: host PAM + superadmin setup → superadmin session only |
| `GET` | `/api/client/v1/servers` | Session required: servers visible to the user via `listVisible`, with live `connected` / `hostname` from the daemon hub |
| `GET` | `/api/client/v1/servers/:id/update` | Read update status (current agent commit vs trunk manifest commit); requires server read access |
| `POST` | `/api/client/v1/servers/:id/update` | Trigger a trunk update on the connected daemon; requires `organization:manage` on the server's org |
| `POST` | `/api/client/v1/invitations/{id}/accept` | Accept a pending invitation; atomically claims the row, materializes `invitation.grants` into `grant` rows (default: `organization:manage` grant on the org), updates session `organizationId` |
| `GET` | `/api/client/v1/permissions` | Permission catalog — four fixed keys (`organization:own`, `organization:manage`, `team:own`, `team:manage`); any authenticated user |
| `GET` | `/api/client/v1/access?resourceId=<uuid>` | List access grants for a resource; requires `organization:own` on the resource (via `getAccessManagementPermission`); returns `{ access: AccessRecord[] }` with `subjectKind`, `resourceId`, `effect`, and `permissionKey` |
| `GET` | `/api/client/v1/access/check?resourceId=<uuid>&permissionKey=…` | Check a single permission for the signed-in user; `permissionKey` must be one of `organization:own`, `organization:manage`, `team:own`, `team:manage`; returns `{ allowed: boolean }` |
| `GET` | `/api/client/v1/access/resource-id?kind=<kind>&itemId=<uuid>` | Resolve `resourceId` for an entity in the session org; returns `{ resourceId, kind, itemId }` |
| `POST` | `/api/client/v1/access` | Create an access grant; body accepts `{ subjectKind, subjectId, resourceId, effect, permissionKey }` where `permissionKey` is required and must be from the four-value catalog |
| `DELETE` | `/api/client/v1/access/{id}` | Revoke a `grant` row; requires `organization:own` on the grant's target resource |
| `GET` | `/api/client/v1/workspaces` | List workspaces visible via `listVisible` (org-level `organization:own` / `organization:manage` grants); full CRUD table in `src/lib/db/AGENTS.md` |
| `GET` | `/api/client/v1/project-catalog` | Session required: UI-safe project catalog summaries (`code`, `kind`, `displayName`, `description`); static code-bundled list — no compose internals or secret default values |
| `POST` | `/api/client/v1/projects` | Create project in a workspace; optional `type` (`docker-compose` \| `template` \| `managed`, default `docker-compose`) and `code` (required for template/managed from catalog); unknown types rejected; managed type inserts a `managed` row, sets `project.metadata.managed_id`, scaffolds environments/variables from catalog, seals secret defaults via `encryptSecret` |
| `GET` | `/api/client/v1/projects` / `GET …/projects/:id` | Returns `metadata` (read-only) and `options` (`options.compose` holds base Docker Compose JSON) |
| `PATCH` | `/api/client/v1/projects/:id` | Accepts patchable `options`; `metadata` is read-only (set by create flow) |
| `GET` | `/api/client/v1/environments` / `GET …/environments/:id` | Returns `metadata` and `options` (`options.compose` holds per-environment overlay) |
| `POST` | `/api/client/v1/environments` | Optional `options` on create |
| `PATCH` | `/api/client/v1/environments/:id` | Optional `options` patch |
| `GET` | `/api/client/v1/variables` | List variables (optional `?environmentId=`); org owner/manager |
| `GET` | `/api/client/v1/variables/:id` | Get variable; sealed secret values are never returned (`value: null` when `isSecret`) |
| `POST` | `/api/client/v1/variables` | Create variable under an environment; `isSecret=true` seals via `encryptSecret` (instance imports encrypt only — decryption is daemon-only via `POST /api/daemon/v1/secrets/decrypt`) |
| `PATCH` | `/api/client/v1/variables/:id` | Update variable; re-seals on secret value update |
| `DELETE` | `/api/client/v1/variables/:id` | Delete variable |
| `GET` | `/api/client/v1/licenses` | List licenses (`organization:own`) |
| `POST` | `/api/client/v1/licenses` | Create a license (`organization:own`) |
| `DELETE` | `/api/client/v1/licenses/{id}` | Invalidate a license (`organization:own`; soft `revoked_at`, disconnects bound servers) |

**Install mode (Deno self-hosted):** `isInstanceInstalled()` is false on a fresh DB. The UI `/install` page first verifies host PAM (`POST /api/install/v1/bootstrap`, client-side gate only), then collects superadmin email/password. Org/team names are fixed defaults. `completeInstanceInstall` inserts exactly one `organization:own` grant on the org and one `team:own` grant on the default team for the superadmin user. After install, sign-in uses superadmin email/password only. The co-located daemon's `server.organization_id` is assigned to **Default Organization** on install (`assignColocatedDaemonToOrganization` in `install-state.ts`, resolving the server row from the live hub or by `metadata.machineId` / hostname) and again when the Unix-socket daemon sends `hello` if still unassigned.

#### New files

| File | Purpose |
|---|---|
| `src/client/authn/crypto.ts` | Web Crypto primitives: session cookie signing |
| `src/client/authn/session-store.ts` | `createSession`, `getSession`, `deleteSession`; `SessionData` type (`role` included) |
| `src/client/authn/credentials.ts` | `verifyCredentials`, `verifyInstallHostCredentials`; PAM host install gate + DB credential users |
| `src/client/authn/password.ts` | PBKDF2-SHA256 hash/verify for credential accounts |
| `src/client/authn/email-verification.ts` | `createEmailVerificationToken` / `consumeEmailVerificationToken` — token lifecycle against the `verification` table (`identifier` = email, `value` = 64-char hex, `expiresAt` = 24h) |
| `src/client/authn/http.ts` | `registerAuthRoutes` — sign-in / sign-out / session / verify-email HTTP handlers |
| `src/lib/install/routes.ts` | `registerInstallRoutes` — self-hosted install wizard (`/api/install/v1/*`; Deno entry only) |
| `src/client/authn/install-state.ts` | Install detection, validation, `completeInstanceInstall`, colocated server assignment |
| `src/client/authn/middleware.ts` | Session + superadmin middleware helpers |

## Email

The `src/lib/email/` module defines a queue abstraction (`EmailQueue`, `EmailJob`, `getEmailQueue`) shared by both runtimes.

### Deno vs Workers paths

- **Deno (self-hosted)** — always publishes email jobs through RabbitMQ via `src/lib/email/smtp/deno-amqp-queue.ts`. The Deno instance itself does not deliver email — it only publishes to RabbitMQ; the **`mailer/`** consumer (`turbopanel-mailer.service`) handles delivery. The mailer is installed by the `instance-launch` role; in Tilt dev it is the `mailer` resource. When the broker is unreachable (or `TURBOPANEL_AMQP_URL` is explicitly empty), the instance uses a noop queue — it does not send Mailgun directly from the instance process.
- **Workers** — `src/lib/email/mailgun/workers-queue.ts` (`createWorkersMailgunQueue`) sends directly to Mailgun inside `enqueue` via `sendMailgunJob`. There is no AMQP/RabbitMQ involvement. Cloudflare Workers provides concurrency control, retries, and durability at the platform level, so a queue consumer is unnecessary. Confirmed in `src/workers.ts`: `resolveWorkersEmailQueue` yields a `WorkersMailgunQueue` (or noop) which is passed to the app and used per-request.

The **`mailer/`** consumer runs as **`turbopanel-mailer.service`** on managed hosts (installed by the `instance-launch` role). In Tilt dev it is the standalone `mailer` resource (Deno mode only). See "Deno mailer throttling and prefetch" below for rate/burst/prefetch behavior.

- **Deno instance** — publishes jobs to RabbitMQ via AMQP. In dev, Ansible injects `TURBOPANEL_SYSTEM_EMAIL__PROVIDER=smtp`, `TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST=127.0.0.1`, and `TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT=1025` so the instance can resolve the `from` address and SMTP config without any DB configuration.
- **Mailer worker (`turbopanel-mailer.service`)** — in dev, Ansible injects `TURBOPANEL_SYSTEM_EMAIL__PROVIDER=mailpit` and `MAILPIT_API_URL=http://127.0.0.1:8025`, so the mailer uses `MailerMailpitSender` (Mailpit HTTP API) — **no SMTP installation required on the worker platform**. In production, uses `smtp` or `mailgun` from DB/env settings.

| Variable | Runtime | Purpose |
|---|---|---|
| `TURBOPANEL_AMQP_URL` | Deno | RabbitMQ connection URL (from `/etc/turbopanel/rabbitmq/.rabbitmq_pass`; Tilt dev default `amqp://guest:guest@localhost:19828`) |
| `TURBOPANEL_DATABASE_URL` | Deno mailer | Postgres for DB-backed SMTP settings (`setting` table); same URL as the instance |
| `TURBOPANEL_REDIS_SOCKET` | Deno | Unix socket path used by the Daemon Cell Redis backend (`src/daemon/cell/redis/client.ts`); default `/run/turbopanel/redis.sock` |
| `TURBOPANEL_BASE_URL` | Deno | Public base URL for verification links (falls back to request origin) |
| `TURBOPANEL_SYSTEM_EMAIL__PROVIDER` | Deno instance (dev) / Deno mailer (dev) | Injected by Ansible in dev: `smtp` on the instance unit (SMTP → Mailpit port 1025); `mailpit` on the mailer unit (Mailpit HTTP API, no SMTP install needed) |
| `TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST` / `TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT` | Deno instance (dev) | Ansible injects Mailpit SMTP host/port into **`turbopanel-instance.service`** so the instance can resolve `from`/SMTP settings when enqueueing to RabbitMQ — the instance does not send over SMTP |
| `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE` | Deno mailer | Token-bucket rate limit (default 60) |
| `MAILPIT_API_URL` | Deno mailer (dev) | Mailpit HTTP API base URL (e.g. `http://127.0.0.1:8025`); used by the `mailpit` provider sender in `mailer/mailpit-sender.ts`; falls back to `http://127.0.0.1:${MAILPIT_WEB_PORT ?? 8025}` |
| `MAILPIT_SMTP_PORT` | Deno mailer | Mailpit SMTP port used as fallback when no SMTP config (default 1025) |

### Settings-driven configuration (`TURBOPANEL_SYSTEM_EMAIL__*`)

Email behavior is configured via the hierarchical settings system under the `TURBOPANEL_SYSTEM_EMAIL` prefix. Full keys use a double-underscore separator:

```
TURBOPANEL_SYSTEM_EMAIL__<SHORT_KEY>
```

Examples: `TURBOPANEL_SYSTEM_EMAIL__PROVIDER`, `TURBOPANEL_SYSTEM_EMAIL__FROM`, `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE`.

**Env-wins semantics**: when a `TURBOPANEL_SYSTEM_EMAIL__*` env var is present and non-empty, it takes precedence over any DB value and the default. DB values are only used when no overriding env var is set. The admin UI reflects this (env-overridden secrets are hidden; DB secrets are masked).

**DB storage (self-hosted):** email settings are persisted as a single `setting` row with `key = 'SYSTEM_EMAIL'` and `value` as a JSON object (e.g. `{ "PROVIDER": "smtp", "FROM": "noreply@turbopanel.local" }`). Short keys match `EMAIL_SETTING_SHORT_KEYS` in `src/lib/settings/email-settings.ts`. When env vars (`TURBOPANEL_SYSTEM_EMAIL__*`) override all keys, the `SYSTEM_EMAIL` row may remain absent — env always wins and the resolver never reads per-key `setting` rows for email.

Short keys and new rate/queue keys (added to `src/lib/settings/email-settings.ts`):

| Short key | Default | Env key | Notes |
|---|----|----|----|
| `PROVIDER` | `smtp` | `TURBOPANEL_SYSTEM_EMAIL__PROVIDER` | `smtp`, `mailgun`, or `mailpit` (dev only — Mailpit HTTP API sender) |
| `FROM` | `noreply@turbopanel.local` | `TURBOPANEL_SYSTEM_EMAIL__FROM` | |
| `MAILGUN_API_KEY` | — | `TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY` | secret |
| `MAILGUN_DOMAIN` | — | `TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN` | |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | `TURBOPANEL_SYSTEM_EMAIL__SMTP_*` | |
| `RATE_LIMIT_PER_MINUTE` | `60` | `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE` | used by the Deno mailer |
| `RATE_LIMIT_BURST` | same as rate | — | max bucket size; see mailer throttling |
| `QUEUE_PREFETCH` | `1` | — | RabbitMQ `channel.prefetch` for the mailer consumer |

The **`mailer/`** consumer resolves settings via `resolveEmailSettings(db, Deno.env.toObject())` with a 30s TTL cache and re-resolves on each consumed message. Without restart, the mailer hot-applies **provider** (swaps the active sender), **rate/burst** (swaps the token bucket), and **prefetch** (re-applies `channel.prefetch`). **FROM**, SMTP/Mailgun credentials, and transport config are re-resolved inside `MailerSmtpSender` / `MailerMailgunSender` / `MailerMailpitSender` on each send.

### Deno mailer throttling and prefetch

The mailer (`mailer/main.ts`) drives a token-bucket `RateLimiter` from the settings:

- `RATE_LIMIT_PER_MINUTE` controls refill rate (tokens per minute).
- `RATE_LIMIT_BURST` controls bucket capacity (defaults to the rate when unset or non-positive). Capacity is the burst value itself — it may be lower than the refill rate.
- `QUEUE_PREFETCH` is applied via `channel.prefetch(...)` at startup and again when the resolved value changes (default 1).

On each consumed message the mailer re-resolves (cached) and, if rate or burst changed, swaps the limiter while preserving as many in-flight tokens as the new capacity allows.

### OTP email surface

Client authentication supports one-time passcodes (OTPs) for sign-in, email verification, and password reset flows. OTPs are generated and verified by `src/client/authn/email-otp.ts` and surfaced via `src/client/authn/otp-http.ts` (mounted under the client auth router):

- `POST /api/client/v1/auth/send-otp` — create + enqueue an `email-otp` job
- `POST /api/client/v1/auth/verify-otp` — verify an OTP (does not consume by default in some flows)
- `POST /api/client/v1/auth/sign-in/otp` — verify OTP and establish a session (sign-in)
- `POST /api/client/v1/auth/verify-email/otp` — verify email ownership OTP
- `POST /api/client/v1/auth/reset-password/request-otp` — create a `forget-password` OTP and enqueue
- `POST /api/client/v1/auth/reset-password/otp` — verify OTP and set a new password

These endpoints enqueue `EmailJob` payloads of type `email-otp` (with `otpType`: `sign-in` | `email-verification` | `forget-password`). On Deno, the mailer delivers them via the configured provider; on Workers, delivery is direct via Mailgun (or noop when provider is SMTP).

## OpenAPI & Scalar

Hand-authored API docs are split by surface and served from the client and daemon routers (Workers and Deno):

| Endpoint | Surface | Auth scheme |
|---|---|---|
| `GET /api/client/v1/openapi.json` | Client | `cookieAuth` (session cookie) |
| `GET /api/client/v1/reference` | Client | Scalar embed with cookie auth |
| `GET /api/daemon/v1/openapi.json` | Daemon | `bearerAuth` (daemon JWT) |
| `GET /api/daemon/v1/reference` | Daemon | Scalar embed with Bearer auth |

`servers[0].url` in each spec is the request origin (`new URL(c.req.url).origin`). Client spec documents health, client/auth/install, and resource routes. Daemon spec documents readiness, platform CA, JWKS (`GET /api/daemon/v1/jwks.json`; `DaemonJwksResponse` in `src/daemon/openapi/auth.ts`), the co-located daemon checkout version endpoint (`GET /api/daemon/v1/version`), and the `/ws/daemon/v1` WebSocket upgrade — daemon JWT credentials are sent in the HTTP `Authorization` header before upgrade.

The marketing site (`../website`) loads client + daemon specs on `/docs/api` as **separate Scalar documents** (cookie auth on Client, Bearer on Daemon — never both schemes in one shared auth config). The instance also exposes Scalar directly for local/dev use.

```mermaid
sequenceDiagram
    participant Browser
    participant Instance as instance (Workers/Deno)
    participant Website as website (Next.js)

    Browser->>Website: GET /docs/api
    Website-->>Browser: ApiReferenceReact page
    Browser->>Website: GET /api/config
    Website-->>Browser: { openApiUrl: ".../api/client/v1/openapi.json" }
    Browser->>Instance: GET /api/client/v1/openapi.json
    Instance-->>Browser: OpenAPI 3.1 JSON (client surface)
    Browser->>Instance: GET /api/client/v1/reference
    Instance-->>Browser: Scalar embed (cookieAuth)
    Browser->>Instance: GET /api/daemon/v1/openapi.json
    Instance-->>Browser: OpenAPI 3.1 JSON (daemon surface)
    Browser->>Instance: GET /api/daemon/v1/reference
    Instance-->>Browser: Scalar embed (bearerAuth JWT)
```

## Layout

- `src/app.ts` — shared Hono factory (`/api/health` + client/daemon routers)
- `src/deno.ts` — Deno entry; registers install routes, developer surface, daemon WS
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main); registers `developer/routes-core` once per isolate
- `src/surfaces.ts` — versioned API/WS prefix constants
- `src/openapi.ts` / `src/scalar-html.ts` — hand-authored OpenAPI 3.1 specs + Scalar embed HTML
- `src/client/routes.ts` — client REST router; imports `src/client/authn/*` and `src/client/authz/*`
- `src/client/authn/` — session, credentials, PAM install gate, license CRUD, HTTP auth handlers
- `src/client/authz/` — four-value permission catalog, `can`/`listVisible`, grant management
- `src/daemon/api-routes.ts` / `src/daemon/deno-ws.ts` / `src/daemon/workers-ws.ts` — daemon REST + WS (cell-backed)
- `src/daemon/cell/contracts.ts` — `DaemonCell` interface, `DaemonCellRegistry`, DTOs
- `src/daemon/cell/protocol.ts` — `DaemonMessage`, envelope codecs, `DAEMON_INBOUND_ALLOWED`, `DAEMON_STALE_MS`
- `src/daemon/cell/do.ts` — `DaemonCellObject` (SQLite-backed Durable Object, Workers)
- `src/daemon/cell/do-registry.ts` — `createDurableObjectDaemonCellRegistry`
- `src/daemon/cell/redis/` — `RedisDaemonCell`, `RedisCellClient`, `createRedisDaemonCellRegistry` (Deno only)
- `src/daemon/cell/stateless-challenge.ts` — stateless HMAC-signed challenge tokens (`DaemonChallengeStore`)
- `src/daemon/cell/location.ts` — `resolveCellLocationHint`, `resolveCellGeneration`
- `src/daemon/cell/postgres-projection.ts` — write-through helpers for canonical Postgres fields
- `src/daemon/cell/snapshot-merge.ts` — `mergeSnapshotPresence`
- `src/daemon/authn/license.ts` — daemon hello license verification (`verifyDaemonLicense`)
- `src/daemon/authn/daemon-jwt.ts` — daemon JWT issue/verify (EdDSA/Ed25519, 15-minute lifetime)
- `src/daemon/authn/daemon-jwt-keyring.ts` — deterministic Ed25519 keyring derived from `TURBOPANEL_SECRET(S)`; `deriveDaemonJwtKeyring`, `buildJwksDocument`
- `src/daemon/authn/daemon-state.ts` — `ServerDaemonState` / `ServerDaemonKey` types and parsers for `server.daemon` jsonb
- `src/daemon/authn/server-identity-db.ts` — DB helpers for `server.daemon` (`getServerDaemonStateByServerId`, `attachDaemonStateToServer`, `touchDaemonKeyLastUsed`, `revokeDaemonKey`, `clearServerDaemonState`)
- `src/daemon/authn/server-key.ts` — `buildAuthPayload`, `computePublicKeyFingerprint`, `verifyDaemonSignature`
- `src/daemon/authz/` — daemon-side authorization placeholder
- `src/lib/db/schema.ts` — Drizzle table definitions (`server`, etc.; see `src/lib/db/AGENTS.md`); connection factories stay in `src/db.ts`
- `src/lib/install/routes.ts` — self-hosted install wizard (`/api/install/v1/*`; Deno-only registration)
- `src/lib/update/manifest.ts` — Workers-safe trunk manifest resolver (`fetch`-only; returns `null` on any failure)
- `src/lib/email/` — shared queue types/templates; `smtp/` (Deno/AMQP) and `mailgun/` (Workers) backends
- `src/developer/` — developer surface (Deno-only routes + Workers-safe `routes-core.ts`)
- `src/admin/routes.ts` — admin surface (`/api/admin/v1`); **now mounted** on both runtimes; gated to `superadmin` or `admin` via `createAdminAccessMiddleware`; dev-only OpenAPI/Scalar; `GET/PUT /instance/public-urls` persists `TURBOPANEL_PUBLIC_URLS` in the `setting` table.
- `src/resource-routes.ts` — workspace/environment/project/service/hosting CRUD
- `src/server-paths.ts` / `src/server-registry.ts` — Unix socket path + daemon server row resolution
