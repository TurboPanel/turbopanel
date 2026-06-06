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

## Deno-mode dev proxy (Caddy + Expo)

In Deno mode, Tilt also runs the Expo web UI and a Caddy HTTPS proxy that mirrors the Cloudflare (wrangler) routing locally:

- Entrypoint: `https://<host>:8443` (Caddy, defined in `Caddyfile`) — binds all interfaces; use `localhost` or the machine's LAN IP. The self-signed cert includes detected LAN addresses.
- `/api/*` and `/ws` → Deno control plane (`http://localhost:8787`)
- everything else → Expo web dev server (`http://localhost:8081`, `../ui`)
- Caddy uses a self-signed cert (`auto_https off`, no Let's Encrypt). Trust `certs/dev.crt` in your browser/OS trust store to avoid warnings.
- `pnpm caddy:install` — download the pinned Caddy into `~/runtimes/caddy/` (symlinked like node/deno); `pnpm dev:cert` — generate `certs/dev.crt` + `certs/dev.key`. Tilt's `caddy-setup` resource runs both automatically.
- Override the resolved binary with `TURBOPANEL_CADDY` (and `TURBOPANEL_DENO` for Deno).

## Layout

- `src/app.ts` — shared Hono app
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main)
- `src/deno.ts` — Deno entry (`deno.json` tasks)
