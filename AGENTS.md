# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and **Deno**.

## Speed doctrine (turbo)

TurboPanel is named for speed; keep it fast on every path.

- **Cache runtimes & deps.** Deno/Node/Caddy live under `/opt/turbopanel/runtimes/<tool>/current`; install only when the pinned version is missing. Don't re-download or re-`pnpm install` when nothing changed. Caddy follows the same `runtimes/caddy/<version>/caddy` + `current` layout (no `versions/` subdir); `scripts/download-caddy.mjs` and the `caddy` Ansible role are aligned.
- **Idempotent fast-paths.** Bootstrap/install steps must short-circuit when already satisfied (the Ansible roles do; mirror that in scripts).
- **Avoid redundant work.** No polling loops or periodic git/`systemctl` forks unless essential (the version watcher and auto-update poll were removed for this reason).
- **Parallelize** independent I/O (e.g. `Promise.all` for per-daemon fan-out, as in the admin routes).
- **Push, don't poll** for cross-process signals where practical (WS messages over fallback timers).

## Platform model: Ansible owns installs

The **daemon is the constant** installed on every TurboPanel-managed host and is the only party that runs Ansible to install/update everything else (runtimes, users, the instance, UI, Caddy). The instance does not install itself. In co-located dev the daemon runs the `instance-dev-install` playbook (see `../daemon/AGENTS.md`) when `TURBOPANEL_DEV_INSTANCE=1`. Nothing auto-updates — updates are operator-driven (admin **Upgrade System** button or **Sync Dev Build**).

## Users, group & socket permissions

- **`turbopanel`** (UID/GID **9999**): the **daemon user and git identity**; has passwordless sudo; owns the install tree and **all git operations** (`git pull`, Upgrade System fetch/reset). Not necessarily the human developer.
- **Human developer** (whoever runs `./console`): added to the `turbopanel` group by the `dev-permissions` role and can edit source files via group ACL write. After any `git pull` or `pnpm install` (which run as `turbopanel`), the dev user can immediately edit the resulting files because the default ACL propagates `g:turbopanel:rwx` to new files.
- **`turbopaneli`** (UID **9998**): runs the instance, Caddy, and the dev UI. Primary group is **`turbopaneli`** (GID **9998**); supplementary group **`turbopanel`** (GID 9999) grants socket and checkout access. **No sudo**. It **reads** platform checkouts via group membership; it must not own source files (that blocks reclaiming ownership to `turbopanel`).
- Co-located dev checkouts (`platform/daemon`, `platform/instance`, `platform/ui`) are **`2770 turbopanel:turbopanel`** with default ACL **`g:turbopanel:rwx`**. Per-service runtime state lives in **gitignored** checkout dirs: **`instance/.local`** (instance + Caddy), **`ui/.local`** + **`ui/.expo`** (Expo), plus matching **`.config`** trees. The **daemon** (`turbopanel`, UID 9999) uses **`/opt/turbopanel`** as `HOME`. The ownership normalizer skips checkout `.cache`/`.config`/`.local`/`.expo` so turbopaneli-owned runtime files are not reclaimed to `turbopanel`, and re-applies default ACLs on the source tree.
- Git SSH uses `/opt/turbopanel/.ssh/github_ed25519` at mode **`0600`** only (SSH rejects `0640`); the ACL must not be applied to `.ssh/`. Upgrade runs `sudo -u turbopanel git`; never run git as `instance`.
- Manual pulls: `sudo -u turbopanel git -C … pull` (or pull as the `turbopanel` login user directly). After any mistaken `turbopaneli`-user git, run `/usr/local/bin/turbopanel-normalize-dev-checkout <path>`. **Upgrade System** runs `turbopanel-normalize-dev-checkout <path> --prepare-reset` before `git reset` (clears turbopaneli-owned `.config`/`.local`/`.cache`/`.expo` that block reset), then normalizes source ownership and `--ensure-runtime-dirs` after reset.
- `/run/turbopanel` is **`2770 turbopanel:turbopanel`** (group-writable + setgid) so the in-group `turbopaneli` user can bind the socket; new sockets stay in the `turbopanel` group. The instance hardens its socket to **`0660`** so the daemon (also group `turbopanel`) can connect.

## Documentation discipline

**Keep this file current.** When you learn something durable about how TurboPanel works — architecture, env vars, gotchas, cross-repo contracts, operational steps — add or update a note here in the same PR/session as the code change. Future agents read `AGENTS.md` first.

- Prefer extending an existing section over appending orphan bullets.
- Record **why** when the reason is non-obvious (e.g. a missing Debian package that breaks Ansible).
- If a fact belongs in another repo (`daemon`, `ui`), put the canonical detail there and add a short cross-reference here when the instance is involved.
- Do not record secrets, tokens, or machine-specific credentials.
- Remove or correct notes that prove wrong.

`README.md` is for humans getting started; `AGENTS.md` is for agents maintaining the system.

## Setup

- **Deno** — <https://docs.deno.com/runtime/getting_started/installation/>
- **pnpm** — <https://pnpm.io/installation>
- **Node.js** and **openssl** — required for cert generation (`scripts/*.mjs`); Node.js also used for Caddy download
- Run `./console` from the `turbopanel-dev` checkout. The console installs Deno, clones the daemon, and drives the full dev stack via `scripts/bootstrap-orchestration.ts` + `scripts/install-daemon-systemd.sh` (shared orchestration under `/opt/turbopanel/runtimes/` — not `orchestration/runtime/venv`).
- `pnpm install` — installs Hono and Wrangler into `node_modules/` for Workers bundling
- Local Wrangler secrets live in `.dev.vars` (`TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS`; gitignored — Tilt `sync-env.sh` writes from `dev/.env`)
- `pnpm dev` (wrangler) still runs the **Cloudflare Workers** path for full-stack testing — unchanged. **`wrangler.jsonc` `dev.ip` is `0.0.0.0`** so Docker Caddy (`host.docker.internal`) can reach the dev server; default localhost-only bind causes Caddy **502**s.
- **`pnpm deploy`** — applies pending migrations (`TURBOPANEL_DATABASE_URL` or `DATABASE_URL` required for tooling) then deploys to Cloudflare Workers (`CLOUDFLARE_ENV` required, e.g. `live` or `testing`). Works from any environment with internet access to the database — self-hosted dev, CI, or production. Requires **Node** only (`pnpm migrate` runs `drizzle-kit migrate`; no Deno prerequisite). Equivalent to `pnpm migrate && wrangler deploy --env $CLOUDFLARE_ENV --minify`.
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts`
- The Ansible `instance-certs` / `caddy` / `node-runtime` roles supersede the standalone `pnpm cert:generate` / `pnpm caddy:install` scripts for managed hosts (the scripts remain for manual use).

### Systemd (all dev services run as their users)

Installed and managed by the daemon via the `instance-launch` Ansible role:

| Unit | User | Notes |
|---|---|---|
| `turbopanel-instance.service` | `instance:turbopanel` | Deno instance on the Unix socket |
| `turbopanel-caddy.service` | `instance:turbopanel` | TLS + reverse proxy on `:8443` (`GOMAXPROCS=1`, `CPUQuota=100%`) |
| `turbopanel-ui.service` | `instance:turbopanel` | Expo web dev server (`:8081`, dev only) |
| `turbopanel-daemon.service` | `turbopanel:turbopanel` | runs Ansible; has sudo |

- `systemd/turbopanel-instance.service` was removed — the canonical unit is templated by the `instance-launch` role in `../daemon`.
- Logs: `journalctl -u turbopanel-instance -u turbopanel-caddy -u turbopanel-ui -f`
- Co-located daemon: `../daemon/scripts/install-daemon-systemd.sh`

## Unix domain sockets

In Deno mode (development and production), the Hono instance listens on a **Unix domain socket** instead of a TCP port. Caddy terminates TLS and proxies `/api/*` and `/ws/*` to that socket.

### Directory layout

All TurboPanel runtime sockets live under **`/run/turbopanel/`** (on Linux, `/var/run` symlinks to `/run`). The directory is **`2770 turbopanel:turbopanel`** (setgid) so the `instance` user (in group `turbopanel`) can bind:

| Socket file | Service |
|---|---|
| `/run/turbopanel/instance.sock` | Hono instance (bound by `instance`, mode `0660`, group `turbopanel`) |
| `/run/turbopanel/postgres/.s.PGSQL.5432` | PostgreSQL 18 (Docker bind-mount) |
| `/run/turbopanel/<name>.sock` | Reserved for future services |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TURBOPANEL_SOCKET` | — | Full socket path override |
| `TURBOPANEL_SOCKET_DIR` | `/run/turbopanel` | Directory when using the default filename |
| `TURBOPANEL_SOCKET_DIAL` | `run/turbopanel/instance.sock` | Caddy `unix//` dial path (no leading slash) |
| `TURBOPANEL_UI_MODE` | `static` | `dev` proxies to Expo; `static` serves exported UI |
| `TURBOPANEL_UI_ROOT` | `../ui/dist` | Directory of `expo export --platform web` output |
| `TURBOPANEL_UI_SERVICE` | `turbopanel-ui` | Name of the Expo systemd unit on managed hosts (injected for orchestration; no instance API surface today) |
| `CADDY_PORT` | `8443` | HTTPS listen port |
| `CADDY_TLS_CERT` | `./certs/self-signed.crt` | Server leaf certificate (signed by platform CA) |
| `CADDY_TLS_KEY` | `./certs/self-signed.key` | Server leaf private key |
| `TURBOPANEL_TLS_EXTRA_SANS` | — | Comma-separated DNS names for the server cert (e.g. `turbopanel.lan`) |
| `TURBOPANEL_PUBLIC_URLS` | — | Comma-separated list of URLs/hosts this control plane is reachable at (e.g. `https://panel.example.com,https://huey.lan:8443`). Persisted in the `setting` table by the admin API; read by `generate-self-signed-cert.mjs` to derive cert SANs. Also consulted by `resolvePublicBaseUrl` as the preferred install-command host. |

Path resolution lives in `src/server-paths.ts`.

## Database (Drizzle + Postgres.js)

The instance uses **Drizzle ORM** over **postgres.js** with `prepare: false` (required for Hyperdrive and transaction-pooling). Connection factories live in `src/db.ts`; schema in `src/lib/db/schema.ts`; drizzle-kit config in `drizzle.config.ts`. **Read `src/lib/db/AGENTS.md` before touching schema or the database.** Schema changes are versioned in `migrations/`; `pnpm migrate` applies pending SQL during Workers deploy. Applied versions are recorded in `public.migration`.

| Runtime | Factory | When connected |
|---|---|---|
| Cloudflare Workers | `createWorkersDb(env.HYPERDRIVE)` | `HYPERDRIVE` binding present in `wrangler.jsonc` |
| Deno (self-hosted) | `createDenoDb()` | `TURBOPANEL_DATABASE_URL` set by `instance-launch` |

Route handlers read the per-request client via `getDb(c)` (set by `createApp({ db })`). **Deno boot requires `TURBOPANEL_DATABASE_URL`:** `createDenoDb()` throws before `createApp()` when the variable is missing or blank, so the process exits instead of serving without a database.

| Variable | Purpose |
|---|---|
| `TURBOPANEL_DATABASE_URL` | Full postgres connection URL. **Deno mode:** required at boot — `createDenoDb()` throws immediately when missing or blank (self-hosted instance will not start). Passed directly to postgres.js (supports Unix socket URLs: `postgresql://user:pass@/db?host=/var/run/turbopanel/postgres`). **Workers runtime:** uses the `HYPERDRIVE` binding, not this env var. When the URL uses `?host=` for a Unix socket, ensure Deno has read access to that directory (`/run/turbopanel` covers the default Docker bind-mount path). |
| `DATABASE_URL` | **Tooling only** (drizzle-kit, `pnpm migrate`, `./introspect.sh` / `./sync.sh` overrides). Accepted as a fallback when `TURBOPANEL_DATABASE_URL` is unset — common in CI and Cloudflare dashboard deploy workflows. Not read by the Deno instance or Workers runtime at request time. |

### Workers Hyperdrive

`wrangler.jsonc` declares a `HYPERDRIVE` binding stub (replace the placeholder id before deploy). Types: `worker-configuration.d.ts` (`HYPERDRIVE?: Hyperdrive`). Regenerate with `pnpm cf-typegen` after changing bindings.

**Local dev (`wrangler dev`):** do not commit `localConnectionString` in `wrangler.jsonc`. Tilt `sync-env.sh` writes `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` to `instance/.env` (derived from `dev/.env` `POSTGRES_*`, or override in `dev/.env`). Wrangler loads `.env` into `process.env` before applying Hyperdrive bindings — the Worker connects directly to local Postgres (no Hyperdrive pooling/caching in this mode). **`TURBOPANEL_DATABASE_URL`** (or **`DATABASE_URL`** for tooling) in the same file is for migrations/Drizzle/sync and may use different credentials than the Hyperdrive runtime user in production.

The Workers DB client uses `prepare: false` on postgres.js (see **Database** above) because Hyperdrive sits in front of a connection pool and does not preserve per-session prepared-statement state.

**Unsupported PostgreSQL features** (do not rely on these on the Workers/Hyperdrive path):

- SQL-level prepared statements: `PREPARE`, `DISCARD`, `DEALLOCATE`, `EXECUTE`
- [Advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- `LISTEN` / `NOTIFY`
- Any other modification to per-session state unless Cloudflare documents it as supported

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

The daemon's `runtime-sockets` role (and `scripts/ensure-socket-dir.mjs` for manual runs) ensures `/run/turbopanel` exists as `2770 turbopanel:turbopanel`, using passwordless `sudo` when needed. After bind, the instance hardens the socket file to `0660` (owner+group only) so the daemon can connect.

The instance Deno process runs with scoped permissions (see the `instance-launch` unit template): `--allow-env --allow-sys=networkInterfaces --allow-read=/run/turbopanel,<daemon dir>,<instance dir> --allow-write=/run/turbopanel --allow-run=git,systemctl,tar` (`tar` is needed for the dev-sync tarball). TCP dev Postgres adds `--allow-net=127.0.0.1:5432`.

### Production

The daemon's orchestration bootstrap runs the `socket-dirs-setup` Ansible playbook, which installs `/etc/tmpfiles.d/turbopanel.conf` and applies it with `systemd-tmpfiles --create`. The directory is recreated on boot automatically.

## Caddy (dev + production)

Caddy terminates TLS and routes traffic from a single HTTPS entrypoint:

- `/api/*` and `/ws/*` → Deno instance (`unix:///run/turbopanel/instance.sock`)
- everything else → Expo dev server (**dev**) or static export (**production**)

`reverse_proxy` to the Unix socket sets `X-Real-IP {remote_host}` on `/api/*` and `/ws/*`. The instance uses that header to deduplicate daemon WebSocket reconnects (without it, every reconnect looked like a new fleet member behind the proxy).

In **dev** mode, the Expo upstream proxy must forward `Host {http.request.host}` (not `127.0.0.1:8081`). Expo's CORS middleware compares `Origin` to `Host`; LAN hostnames like `huey.lan:8443` are rejected when `Host` is overwritten to the loopback upstream.

### Development

Caddy/cert installs are handled by the daemon's `caddy` and `instance-certs` Ansible roles; `turbopanel-caddy.service` runs Caddy as `instance`.

- Entrypoint: `https://<host>:8443` (Caddy, defined in `Caddyfile`) — binds all interfaces; use `localhost` or the machine's LAN IP.
- Self-hosted TLS uses a **platform CA** (`certs/ca.crt` + `certs/ca.key`) that signs a **server leaf cert** (`certs/self-signed.crt` + `.key`) presented by Caddy (`auto_https off`, no Let's Encrypt). **`auto_https off` is mandatory and must never be removed.** Caddy must never auto-provision certs via ACME or on-demand TLS. All cert issuance goes through `scripts/generate-self-signed-cert.mjs` (self-hosted, platform CA) or an explicitly-configured publicly-trusted cert. The `instance-certs-apply.yml` playbook is the runtime cert-regen path triggered by the admin public-URL apply action. The CA is long-lived and can issue additional certificates later; daemons fetch it from `GET /api/daemon/v1/instance/ca`. Trust `certs/ca.crt` in browsers/OS to avoid warnings.
- Override the resolved binary with `TURBOPANEL_CADDY` (and `TURBOPANEL_DENO` for Deno).

### Daemon TLS trust model (3 paths)

The daemon validates the instance server cert on **every** connect — both chain trust **and** hostname (SAN). There is **no** insecure/skip-verification mode at runtime (the old `TURBOPANEL_TLS_INSECURE` daemon env was dead and was removed; `run.sh --insecure-tls` only affects the bootstrap `curl -k` downloads). Three valid configurations:

| Path | CA trust | SAN requirement |
|---|---|---|
| **Self-signed (self-hosted)** | Daemon trusts the downloaded platform CA (`TURBOPANEL_INSTANCE_CA`, fetched from `GET /api/daemon/v1/instance/ca`) | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname. |
| **Let's Encrypt** | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`) | The real cert already covers the public hostname. |
| **Cloudflare tunnel / proxy** | Cloudflare's edge cert is publicly-valid → **system trust** | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. |

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does not replace them), so configuring the platform CA does not break validation of publicly-trusted certs.

### Production (static UI)

When `TURBOPANEL_UI_MODE=static`, Caddy serves the exported web build from `ui/dist`, `isDeveloperSurfaceEnabled()` is disabled (see `src/dev-mode.ts`), and `turbopanel-ui.service` is stopped/disabled by the `instance-launch` role.

Build the static export locally or switch via the dev console **Switch to production build** (runs `ui-build` → `instance-build` → `instance-launch`). For a compiled instance binary, `deno task compile` in this repo produces `dist/turbopanel-instance` with all `--allow-*` flags baked in at compile time (mirrors the `turbopanel-instance.service` `ExecStart` permissions).

Manual export + Caddy:

```bash
cd ../ui && pnpm export
cd ../turbopanel
TURBOPANEL_UI_ROOT=../ui/dist caddy run --config Caddyfile --adapter caddyfile
```

Caddy serves files from `TURBOPANEL_UI_ROOT` (default `../ui/dist`) and falls back to `/index.html` for client-side routes (SPA), matching the Cloudflare Workers asset routing in `ui/wrangler.jsonc`.

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

Server nodes are tracked by a **Daemon Cell** abstraction keyed by `serverId`. There is no in-process daemon state — all connection presence, snapshots, outbox, request records, challenges, and event buffers live in the cell backend.

| Runtime | Backend | Storage |
|---|---|---|
| Deno (self-hosted) | `RedisDaemonCell` (`src/daemon/cell/redis/`) | Redis Streams + HASH + SET at `tp:cell:{serverId}:*`; Unix socket `/run/turbopanel/redis.sock` |
| Cloudflare Workers | `DaemonCellObject` (`src/daemon/cell/do.ts`) | SQLite-backed Durable Object per server, named by `serverId` (or `serverId:g{n}` for relocated generations) |

Postgres remains canonical for business data (`server`). The cell is the low-latency hot projection and coordination layer.

**Monitoring storage:** the cell is the live source of truth for machine and service state. Dedicated tables/keys — `monitor_instance`, `monitor_resource`, `monitor_metric_minute`, `monitor_event`, `monitor_alert`, `monitor_deadline` — hold current resource state (latest only), minute-bucket metrics (72h rolling window), transition event history (bounded), alert dedupe/cooldown state, and scheduled offline/cooldown deadlines. `DaemonCellSnapshot` remains connection-oriented (presence, liveness timestamps) — it does not hold the full resource graph.

**Monitoring message types:** `monitor.sync` (full baseline on connect), `monitor.heartbeat` (60s delta), `monitor.transition` (focused single-resource event), `monitor.ack` (cell → daemon, with `acceptedSequence` and optional `resyncNeeded`). Defined in `src/daemon/cell/protocol.ts` and `src/daemon/cell/monitor-contracts.ts`.

**Offline deadline:** the cell schedules an offline deadline ~150s after the last monitor heartbeat. Workers: single DO alarm processes the nearest deadline and reschedules. Redis: deadline sorted set processed by `maintain()` in the registry loop.

**Sparse Postgres projection:** ordinary heartbeats do **not** write Postgres. `server.daemon.projection` is updated only on: online/offline transitions, meaningful service/project transitions, daemon identity changes, and slow summary refreshes (capped at 15 minutes). `server.lastSeenAt` is updated only on liveness transitions.

**Cheap fleet index:** `listOnlineServerIds()` reads the Redis online set (Deno) or the sparse `server.daemon.projection.connected` field (Workers) — it does not fan out across all cells.

**WS upgrade flow:** JWT verified in the main isolate/process → cell `attachDaemonSocket` acquires the single-writer lease → outbox pump loop (`readOutboxBatch` → `ws.send` → `ackOutbox`) runs until close → `detachDaemonSocket` releases the lease.

**Co-located daemon** (`__direct__`): stored in cell meta (`remoteAddress = '__direct__'`) so `tryAssignColocatedDaemonToInstalledOrganization` and tunnel routing still work.

**Challenge stores:** enrollment and auth challenges use `createRedisChallengeStore` (Deno) or `createDurableObjectChallengeStore` (Workers) — single-use, hard TTL, no in-process Maps.

**`DAEMON_INBOUND_ALLOWED`** is defined in `src/daemon/cell/protocol.ts` (not `hub.ts`).

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/daemon/v1/heartbeat` | daemon JWT | degraded fallback ingestion only; routes monitor payloads into the cell but **never writes Postgres** on every call |
| `POST /api/daemon/v1/commands/lease` | daemon JWT | Poll for pending commands (stub — returns `{ commands: [] }`) |

- No `version` push / auto-update: the daemon never self-updates.

### Dev sync (push a daemon build without git)

`src/developer/dev-sync.ts` tars the local `../daemon` checkout, base64-encodes it, and streams `dev-sync-begin` → `dev-sync-chunk*` → `dev-sync-end` over the daemon WS; the daemon unpacks, `deno cache`s, replies `dev-sync-result`, and restarts. Developer routes: `POST /api/developer/v1/daemon/:id/sync-dev` and `…/daemon/sync-dev` (all). Dev console: **Sync Dev Build** in the fleet section.

### Instance Cloudflare tunnel

`POST /api/developer/v1/instance/tunnel-token` (`src/developer/tunnel-routes.ts`) sends a `tunnel-token` WS message to the co-located daemon, which writes `cloudflared/tunnels/instance.token` and (re)starts cloudflared. External remote daemons then reach this instance via the tunnel → Caddy → socket. Dev console: **Save Tunnel Token** in the fleet section (empty token tears it down).

Correlated request/ack helpers (`awaitDaemonAck` / `recordDaemonAck`) back both dev-sync and tunnel-token.

### Public URL apply

**Public URL apply**: `POST /api/admin/v1/instance/public-urls/apply` (Deno only) sends a `public-urls-update` WS message to the co-located daemon with the current URL list. The daemon writes `TURBOPANEL_PUBLIC_URLS` to the instance `.env`, re-runs the `instance-certs` Ansible role (regenerating the leaf cert with updated SANs, CA preserved), and reloads `turbopanel-caddy`. Replies with `public-urls-update-result { ok, error? }`. On Workers, the endpoint returns 422 (cert apply not applicable). Timeout: 60 s.

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
    Daemon->>Daemon: write .env, run instance-certs, reload caddy
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
- **Auth challenge + session token**: enrolled daemon requests `POST /api/daemon/v1/auth/challenge` with `{ serverId, keyId }`, signs `buildAuthPayload()` (`turbopanel-daemon-auth-v1` canonical format), then calls `POST /api/daemon/v1/auth/session` to receive a **15-minute stateless JWT**.
- **JWT enforcement**: protected daemon REST routes use `requireDaemonJwt` middleware (`Authorization: Bearer <token>`), except `GET /readiness`, `GET /instance/ca`, `GET /openapi.json`, `GET /reference`, `POST /auth/challenge`, `POST /enroll`, and `POST /auth/session`. JWT verification checks signature, expiry, and claims only — no session row lookup.
- **Canonical payload helper status**: `buildCanonicalPayload` is deprecated and aliases `buildAuthPayload` for compatibility (legacy `fingerprint` inputs are mapped to auth `keyId`).
- Remote WSS connections require a valid daemon JWT at upgrade time; unauthenticated server row creation from `hostname`/`machineId` alone is disallowed.
- Co-located socket daemons use the same auth model; there is no unauthenticated bypass.
- `DAEMON_INBOUND_ALLOWED` in `src/daemon/cell/protocol.ts` is a static set of accepted post-auth message types — not an authz system.
- Daemon identity is stored on the `server` row as typed jsonb `server.daemon` (`key` only). Hot-path timestamps live in `server.daemon_key_last_used_at` and `server.last_seen_at`. No `serverkey` or `daemonsession` tables.
- Re-enrollment or recovery with a valid license replaces `server.daemon` entirely; old daemon keys are not kept for MVP.
- JWT payload: `sub` (serverId), `kid` (`server.daemon.key.id`), `jti` (random uuid, logging only), `iss`, `aud`, `typ`, `iat`, `exp`. No `sid`.
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

On the **Deno runtime**, initial setup is gated by host PAM — **`root`** or any user in the **`sudo` / `wheel` / `admin`** groups. Host auth **never** receives a session or cookie. The instance process runs as **`turbopaneli`**; it runs **`pamtester login "$username" authenticate`** via **`sudo -n`** and a shell pipe (see `src/client/authn/credentials.ts`). **`pamtester`** must be installed on managed hosts (the daemon `daemon-prereqs` role). Sudoers: **`turbopaneli`** gets `NOPASSWD: /usr/bin/pamtester login * authenticate` in `instance-launch` `upgrade-sudoers.yml`. The instance systemd unit must grant **`--allow-run=/bin/sh,sudo,/usr/bin/sudo`**.

**Dev mode bypass (`TURBOPANEL_DEV_HOST_AUTH=group-only`):** When this env var is set, `verifyInstallHostCredentials` skips `verifyPamLogin` entirely. The password field must still be non-empty (the UI requires it), but it is not verified against PAM. Group membership (`sudo`/`wheel`/`admin`) is still checked via `id -nG`. This var is injected automatically by `dev/scripts/instance-serve.sh` in Tilt dev — it is never set on managed production hosts. `pamtester` is only required on managed hosts (installed by the daemon `daemon-prereqs` role).

**Install flow:** `POST /api/install/v1/bootstrap` verifies host PAM and returns `{ ok: true }` only (no cookies). The UI keeps host username/password in the form and reveals superadmin fields client-side. `POST /api/install/v1/` re-verifies host PAM, creates org (**Default Organization**) + team (**Default Team**) + **superadmin** user (`role: superadmin`, email + credential `account`), assigns the co-located daemon, and returns a signed session cookie for the superadmin only. Host accounts cannot sign in via `/auth/sign-in`. This path is **never active on Workers**.

Superadmin-only routes (`createRootOnlyMiddleware`, `resolveRootSession`) authorize by **`user.role === 'superadmin'`**, not PAM root. `user.role` ∈ `superadmin | admin | user` is **instance authority only** and is distinct from resource access profiles. **`superadmin` and `admin`** both bypass resource authorization checks — `can()` and `listVisible()` short-circuit in SQL without requiring any `grant` rows. Future superadmin-only platform operations (developer reset-dev, etc.) remain restricted to `superadmin` via middleware, not `admin`.

#### Session secret configuration

Both runtimes read the same root secret env vars; `deriveSecretsConfig()` HKDF-derives purpose-specific keys (e.g. `session-signing`) from the root material.

| Variable | Behaviour when missing |
|---|---|
| `TURBOPANEL_SECRET` | Single 48-char root key (`src/generate-secret.ts`); normalized to `v1` when `TURBOPANEL_SECRETS` is unset |
| `TURBOPANEL_SECRETS` | Versioned list `2:secret,1:secret`; highest version is current signing key |

| Runtime | Source |
|---|---|
| Deno | `TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS` env vars (`instance-launch` injects them on managed hosts) |
| Workers | Same names as Wrangler bindings / `.dev.vars` (Tilt `sync-env.sh` writes them from `dev/.env`) |

**Root secret format:** 48 characters from `[A-Za-z0-9_]`, always at least one `_` between positions 2–47 (never in position 1 or 48). Implementation: `scripts/generate-secret.mjs` (re-exported from `src/generate-secret.ts`). Generate with `pnpm generate:secret` in `instance/`. HKDF uses the UTF-8 bytes of the string as key material (`deriveKey` in `src/client/authn/secrets.ts`). Same helper (`generatePassword`) is the canonical generator for random passwords.

At least one of `TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS` must be set in production. Workers always fail fast when both are missing. Deno co-located dev (`TURBOPANEL_UI_MODE` ≠ `static`) may use an ephemeral random key as a warning-only fallback.

Add a `TURBOPANEL_SECRET` to `dev/.env` before running `pnpm dev` (Tilt syncs it to `instance/.dev.vars` — see `dev/.env.example`).

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
| `POST` | `/api/client/v1/invitations/{id}/accept` | Accept a pending invitation; atomically claims the row, materializes `invitation.grants` into `grant` rows (default: `organization:manage` grant on the org), updates session `organizationId` |
| `GET` | `/api/client/v1/permissions` | Permission catalog — four fixed keys (`organization:own`, `organization:manage`, `team:own`, `team:manage`); any authenticated user |
| `GET` | `/api/client/v1/access?resourceId=<uuid>` | List access grants for a resource; requires `organization:own` on the resource (via `getAccessManagementPermission`); returns `{ access: AccessRecord[] }` with `subjectKind`, `resourceId`, `effect`, and `permissionKey` |
| `GET` | `/api/client/v1/access/check?resourceId=<uuid>&permissionKey=…` | Check a single permission for the signed-in user; `permissionKey` must be one of `organization:own`, `organization:manage`, `team:own`, `team:manage`; returns `{ allowed: boolean }` |
| `GET` | `/api/client/v1/access/resource-id?kind=<kind>&itemId=<uuid>` | Resolve `resourceId` for an entity in the session org; returns `{ resourceId, kind, itemId }` |
| `POST` | `/api/client/v1/access` | Create an access grant; body accepts `{ subjectKind, subjectId, resourceId, effect, permissionKey }` where `permissionKey` is required and must be from the four-value catalog |
| `DELETE` | `/api/client/v1/access/{id}` | Revoke a `grant` row; requires `organization:own` on the grant's target resource |
| `GET` | `/api/client/v1/workspaces` | List workspaces visible via `listVisible` (org-level `organization:own` / `organization:manage` grants); full CRUD table in `src/lib/db/AGENTS.md` |
| `GET` | `/api/client/v1/licenses` | List licenses (`organization:own`) |
| `POST` | `/api/client/v1/licenses` | Create a license (`organization:own`) |
| `DELETE` | `/api/client/v1/licenses/{id}` | Revoke a license (`organization:own`) |

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

The `src/lib/email/` module defines a queue abstraction (`EmailQueue`, `EmailJob`, `getEmailQueue`) shared by both runtimes:

- **Deno** — `src/lib/email/smtp/deno-amqp-queue.ts` publishes jobs to RabbitMQ (`TURBOPANEL_AMQP_URL`); falls back to `createNoopQueue` when the broker is unreachable. On managed hosts, `TURBOPANEL_AMQP_URL` is injected by the `instance-launch` role from `/opt/turbopanel/platform/config/rabbitmq/.rabbitmq_pass` (no `guest:guest` default).
- **Workers** — `src/lib/email/mailgun/workers-queue.ts` sends directly via Mailgun when `TURBOPANEL_MAILGUN_API_KEY` and `TURBOPANEL_MAILGUN_DOMAIN` are set; otherwise noop.

The **`mailer/`** consumer runs as **`turbopanel-mailer.service`** on managed hosts (installed by the `instance-launch` role). In Tilt dev it is the standalone `mailer` resource (Deno mode only): RabbitMQ consumer → SMTP sender with a token-bucket rate limiter (`TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE`, default 60). SMTP config comes from env (`SMTP_*`) with DB `setting` table fallback when **`TURBOPANEL_DATABASE_URL`** is set; Mailpit is the default SMTP target in dev (`MAILPIT_SMTP_PORT`). Co-located dev installs Mailpit via the daemon **`mailpit`** Ansible role (`turbopanelmailpit` container; web UI `127.0.0.1:8025`, SMTP `127.0.0.1:1025`); `instance-launch` injects `SMTP_HOST` / `SMTP_PORT` / `MAILPIT_SMTP_PORT` into the mailer unit.

| Variable | Runtime | Purpose |
|---|---|---|
| `TURBOPANEL_AMQP_URL` | Deno | RabbitMQ connection URL (managed installs: from `/opt/turbopanel/platform/config/rabbitmq/.rabbitmq_pass`; Tilt dev default `amqp://guest:guest@localhost:19828`) |
| `TURBOPANEL_DATABASE_URL` | Deno mailer | Postgres for DB-backed SMTP settings (`setting` table); same URL as the instance |
| `TURBOPANEL_REDIS_SOCKET` | Deno | Unix socket path used by the Daemon Cell Redis backend (`src/daemon/cell/redis/client.ts`); default `/run/turbopanel/redis.sock` |
| `TURBOPANEL_SYSTEM_EMAIL_FROM` | Both | Sender address (default `noreply@turbopanel.local`) |
| `TURBOPANEL_BASE_URL` | Deno | Public base URL for verification links (falls back to request origin) |
| `TURBOPANEL_MAILGUN_API_KEY` | Workers | Mailgun API key |
| `TURBOPANEL_MAILGUN_DOMAIN` | Workers | Mailgun sending domain |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Deno mailer | SMTP config (env override; DB fallback via `setting` table) |
| `SMTP_FROM` | Deno mailer | Sender address override (env; DB fallback) |
| `TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE` | Deno mailer | Token-bucket rate limit (default 60) |
| `MAILPIT_SMTP_PORT` | Deno mailer | Mailpit SMTP port used as fallback when no SMTP config (default 1025) |

## OpenAPI & Scalar

Hand-authored API docs are split by surface and served from the client and daemon routers (Workers and Deno):

| Endpoint | Surface | Auth scheme |
|---|---|---|
| `GET /api/client/v1/openapi.json` | Client | `cookieAuth` (session cookie) |
| `GET /api/client/v1/reference` | Client | Scalar embed with cookie auth |
| `GET /api/daemon/v1/openapi.json` | Daemon | `bearerAuth` (daemon JWT) |
| `GET /api/daemon/v1/reference` | Daemon | Scalar embed with Bearer auth |

`servers[0].url` in each spec is the request origin (`new URL(c.req.url).origin`). Client spec documents health, client/auth/install, and resource routes. Daemon spec documents readiness, platform CA, the co-located daemon checkout version endpoint (`GET /api/daemon/v1/version`), and the `/ws/daemon/v1` WebSocket upgrade — daemon JWT credentials are sent in the HTTP `Authorization` header before upgrade.

The marketing site (`../website`) loads the client spec via its `/api/config` proxy for `/docs/api`; the instance also exposes Scalar directly for local/dev use.

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
- `src/daemon/cell/protocol.ts` — `DaemonMessage`, envelope codecs, `DAEMON_INBOUND_ALLOWED`, `DAEMON_STALE_MS`, `DAEMON_PING_MS`
- `src/daemon/cell/do.ts` — `DaemonCellObject` (SQLite-backed Durable Object, Workers)
- `src/daemon/cell/do-registry.ts` — `createDurableObjectDaemonCellRegistry`
- `src/daemon/cell/redis/` — `RedisDaemonCell`, `RedisCellClient`, `createRedisDaemonCellRegistry` (Deno only)
- `src/daemon/cell/challenge-store.ts` — `DaemonChallengeStore` interface + Redis/DO/in-memory variants
- `src/daemon/cell/location.ts` — `resolveCellLocationHint`, `resolveCellGeneration`
- `src/daemon/cell/postgres-projection.ts` — write-through helpers for canonical Postgres fields
- `src/daemon/cell/snapshot-merge.ts` — `mergeSnapshotPresence`
- `src/daemon/authn/license.ts` — daemon hello license verification (`verifyDaemonLicense`)
- `src/daemon/authn/daemon-jwt.ts` — daemon JWT issue/verify (HMAC-SHA256, 15-minute lifetime)
- `src/daemon/authn/daemon-state.ts` — `ServerDaemonState` / `ServerDaemonKey` types and parsers for `server.daemon` jsonb
- `src/daemon/authn/server-identity-db.ts` — DB helpers for `server.daemon` (`getServerDaemonStateByServerId`, `attachDaemonStateToServer`, `touchDaemonKeyLastUsed`, `revokeDaemonKey`, `clearServerDaemonState`)
- `src/daemon/authn/server-key.ts` — `buildCanonicalPayload`, `computePublicKeyFingerprint`, `verifyDaemonSignature`
- `src/daemon/authz/` — daemon-side authorization placeholder
- `src/lib/db/schema.ts` — Drizzle table definitions (`server`, etc.; see `src/lib/db/AGENTS.md`); connection factories stay in `src/db.ts`
- `src/lib/install/routes.ts` — self-hosted install wizard (`/api/install/v1/*`; Deno-only registration)
- `src/lib/email/` — shared queue types/templates; `smtp/` (Deno/AMQP) and `mailgun/` (Workers) backends
- `src/developer/` — developer surface (Deno-only routes + Workers-safe `routes-core.ts`)
- `src/admin/routes.ts` — admin surface (`/api/admin/v1`); **now mounted** on both runtimes; gated to `superadmin` or `admin` via `createAdminAccessMiddleware`; dev-only OpenAPI/Scalar; `GET/PUT /instance/public-urls` persists `TURBOPANEL_PUBLIC_URLS` in the `setting` table.
- `src/resource-routes.ts` — workspace/environment/project/service/hosting CRUD
- `src/server-paths.ts` / `src/server-registry.ts` — Unix socket path + daemon server row resolution
