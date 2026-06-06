# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and **Deno**.

## Setup

- **Deno** — <https://docs.deno.com/runtime/getting_started/installation/>
- **Wrangler** — <https://developers.cloudflare.com/workers/wrangler/install-and-update/>
- **Tilt** — <https://docs.tilt.dev/install.html>
- **Node.js** — only for the Tilt wrapper scripts (`scripts/*.mjs`) and one-time Hono install for Wrangler (`deno task deps`)
- Copy or create `.dev.vars` at the repo root for local Wrangler secrets (see the commented stub; file is gitignored)
- `deno task deps` — installs Hono into `node_modules/` for Wrangler bundling (uses npm once; no `package.json` or pnpm)
- `deno task tilt` — launches Tilt; defaults to Deno mode; use the "Switch to Workers" button in Tilt UI to swap runtimes
- `deno task tilt:deno` — Tilt in Deno mode directly
- `deno task tilt:workers` — Tilt in Workers (Wrangler) mode directly
- `DEV_MODE=deno` or `DEV_MODE=workers` in a root `.env` file is read by the wrapper on startup and watched for live mode-switching
- `deno task workers:deploy` — deploy to Cloudflare
- `deno task workers:typegen` — regenerate `worker-configuration.d.ts`

## Layout

- `src/app.ts` — shared Hono app
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main)
- `src/deno.ts` — Deno entry (`deno.json` tasks)
