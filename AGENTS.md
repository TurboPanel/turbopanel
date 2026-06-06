# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and **Deno**.

## Setup

- **Deno** — <https://docs.deno.com/runtime/getting_started/installation/>
- **pnpm** — <https://pnpm.io/installation>
- **Tilt** — <https://docs.tilt.dev/install.html>
- **Node.js** — for the Tilt wrapper scripts (`scripts/*.mjs`)
- `pnpm install` — installs Hono and Wrangler into `node_modules/` for Workers bundling
- Copy or create `.dev.vars` at the repo root for local Wrangler secrets (see the commented stub; file is gitignored)
- `pnpm dev` or `deno task tilt` — launches Tilt; defaults to Deno mode; use the "Switch to Workers" button in Tilt UI to swap runtimes
- `pnpm dev:deno` / `deno task tilt:deno` — Tilt in Deno mode directly
- `pnpm dev:workers` / `deno task tilt:workers` — Tilt in Workers (Wrangler) mode directly
- `DEV_MODE=deno` or `DEV_MODE=workers` in a root `.env` file is read by the wrapper on startup and watched for live mode-switching
- `pnpm deploy:workers` or `deno task workers:deploy` — deploy to Cloudflare
- `pnpm cf-typegen` or `deno task workers:typegen` — regenerate `worker-configuration.d.ts`

## Layout

- `src/app.ts` — shared Hono app
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main)
- `src/deno.ts` — Deno entry (`deno.json` tasks)
