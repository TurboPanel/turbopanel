# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and **Deno**.

## Setup

- **Tilt** — <https://docs.tilt.dev/install.html>
- `pnpm install` — installs Wrangler and Hono; `pnpm-workspace.yaml` pre-approves `esbuild`, `sharp`, and `workerd` build scripts
- Copy or create `.dev.vars` at the repo root for local Wrangler secrets (see the commented stub; file is gitignored)
- `pnpm dev` — launches Tilt; defaults to Deno mode; use the "Switch to Workers" button in Tilt UI to swap runtimes
- `pnpm dev:deno` — Tilt in Deno mode directly
- `pnpm dev:workers` — Tilt in Workers (Wrangler) mode directly
- `DEV_MODE=deno` or `DEV_MODE=workers` in a root `.env` file is read by the wrapper on startup and watched for live mode-switching
- `pnpm deploy:workers` — deploy to Cloudflare
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts`

## Layout

- `src/app.ts` — shared Hono app
- `src/workers.ts` — Workers entry (`wrangler.jsonc` main)
- `src/deno.ts` — Deno entry (`deno.json` tasks)
