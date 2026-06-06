# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and **Deno**.

## Setup

- **Deno** — <https://docs.deno.com/runtime/getting_started/installation/>
- **pnpm** — <https://pnpm.io/installation>
- **Tilt** — <https://docs.tilt.dev/install.html>
- **Node.js** — for the Tilt wrapper scripts (`scripts/*.mjs`)
- `pnpm install` — installs Hono and Wrangler into `node_modules/` for Workers bundling
- Copy or create `.dev.vars` at the repo root for local Wrangler secrets (see the commented stub; file is gitignored)
- `pnpm dev` — launches Tilt; defaults to Deno mode; use the "Switch to Workers" button in Tilt UI to swap runtimes
- `pnpm dev:deno` — Tilt in Deno mode directly
- `pnpm dev:workers` — Tilt in Workers (Wrangler) mode directly
- `DEV_MODE=deno` or `DEV_MODE=workers` in a root `.env` file is read by the wrapper on startup and watched for live mode-switching
- `pnpm deploy:workers` — deploy to Cloudflare
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts`

## Unix domain sockets

In Deno mode (development and production), the Hono instance listens on a **Unix domain socket** instead of a TCP port. Caddy terminates TLS and proxies `/api/*` and `/ws` to that socket.

### Directory layout

All TurboPanel runtime sockets live under **`/run/turbopanel/`** (on Linux, `/var/run` symlinks to `/run`):

| Socket file | Service |
|---|---|
| `/run/turbopanel/turbopanel.sock` | Hono instance (mode `0660`, owner `turbopanel:turbopanel`) |
| `/run/turbopanel/<name>.sock` | Reserved for future services |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TURBOPANEL_SOCKET` | — | Full socket path override |
| `TURBOPANEL_SOCKET_DIR` | `/run/turbopanel` | Directory when using the default filename |
| `TURBOPANEL_SOCKET_DIAL` | `run/turbopanel/turbopanel.sock` | Caddy `unix//` dial path (no leading slash) |
| `TURBOPANEL_UI_MODE` | `static` | `dev` proxies to Expo; `static` serves exported UI |
| `TURBOPANEL_UI_ROOT` | `../ui/dist` | Directory of `expo export --platform web` output |
| `CADDY_PORT` | `8443` | HTTPS listen port |
| `CADDY_TLS_CERT` | `./certs/self-signed.crt` | Server leaf certificate (signed by platform CA) |
| `CADDY_TLS_KEY` | `./certs/self-signed.key` | Server leaf private key |
| `TURBOPANEL_TLS_EXTRA_SANS` | — | Comma-separated DNS names for the server cert (e.g. `turbopanel.lan`) |

Path resolution lives in `src/server-paths.ts`.

### Caddy dial format

Caddy uses `unix//<path>` where `<path>` has **no leading slash**:

```caddyfile
reverse_proxy unix//run/turbopanel/turbopanel.sock
```

Tilt passes `TURBOPANEL_SOCKET_DIAL` into the `Caddyfile` placeholders.

### Development (Tilt)

Tilt runs a `socket-setup` resource (`scripts/ensure-socket-dir.mjs`) before Deno and Caddy start. The script ensures `/run/turbopanel` exists with owner `turbopanel:turbopanel` and mode `0750`, using passwordless `sudo` when needed. After bind, the instance sets the socket file itself to mode `0660` (owner+group only).

Deno is started with scoped permissions: `--allow-env --allow-read=/run/turbopanel --allow-write=/run/turbopanel`.

### Production

The daemon's orchestration bootstrap runs the `socket-dirs-setup` Ansible playbook, which installs `/etc/tmpfiles.d/turbopanel.conf` and applies it with `systemd-tmpfiles --create`. The directory is recreated on boot automatically.

## Caddy (dev + production)

Caddy terminates TLS and routes traffic from a single HTTPS entrypoint:

- `/api/*` and `/ws` → Deno instance (`unix:///run/turbopanel/turbopanel.sock`)
- everything else → Expo dev server (**dev**) or static export (**production**)

### Development (Tilt)

Tilt sets `TURBOPANEL_UI_MODE=dev` and proxies non-API traffic to the Expo web dev server at `http://localhost:8081`.

- Entrypoint: `https://<host>:8443` (Caddy, defined in `Caddyfile`) — binds all interfaces; use `localhost` or the machine's LAN IP.
- Self-hosted TLS uses a **platform CA** (`certs/ca.crt` + `certs/ca.key`) that signs a **server leaf cert** (`certs/self-signed.crt` + `.key`) presented by Caddy (`auto_https off`, no Let's Encrypt). The CA is long-lived and can issue additional certificates later; agents fetch it from `GET /api/instance/ca`. Trust `certs/ca.crt` in browsers/OS to avoid warnings.
- `pnpm caddy:install` — download the pinned Caddy into `~/runtimes/caddy/` (symlinked like node/deno); `pnpm cert:generate` — (re)generate the platform CA and server cert. Tilt's `caddy-setup` resource runs both automatically.
- Override the resolved binary with `TURBOPANEL_CADDY` (and `TURBOPANEL_DENO` for Deno).

### Production (static UI)

Export the Expo web app, then run Caddy with the default `TURBOPANEL_UI_MODE=static`:

```bash
cd ../ui && pnpm export
cd ../turbopanel
TURBOPANEL_UI_ROOT=../ui/dist caddy run --config Caddyfile --adapter caddyfile
```

Caddy serves files from `TURBOPANEL_UI_ROOT` (default `../ui/dist`) and falls back to `/index.html` for client-side routes (SPA), matching the Cloudflare Workers asset routing in `ui/wrangler.jsonc`.

Set `CADDY_TLS_CERT` / `CADDY_TLS_KEY` only when overriding the default server leaf certificate paths.

## Layout

- `src/app.ts` — shared Hono app
- `src/server-paths.ts` — Unix socket path resolution
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main)
- `src/deno.ts` — Deno entry (`deno.json` tasks)
