# Database (early development)

**Do not run migrations.** TurboPanel is in very early development and the co-located dev server already has live data. Treat every database change as production-adjacent until we say otherwise.

## Current policy

- **No migration workflow** — do not generate migration files, do not run `drizzle-kit migrate`, and do not add SQL under `drizzle/`. We are not using versioned migrations yet.
- **No automatic schema apply** — do not run `drizzle-kit push`, `drizzle-kit pull`, or hand-written DDL against the dev database unless the change is well understood, explicitly requested, and the impact on existing rows has been considered.
- **Code-first schema only** — edit `schema.ts` to express the intended model, but assume the live database may lag until a deliberate sync is approved.

## When schema and database diverge

For now we will use **database sync** (manual, operator-driven alignment of schema ↔ database) only when we intentionally want the running software and the database to match — not as a routine part of every PR or agent session.

Before any sync:

1. Confirm what data already exists on the target (dev server Postgres).
2. Understand whether the change is additive, destructive, or reshaping existing columns/tables.
3. Get explicit operator approval for touching that environment.

If unsure, **stop and ask** rather than applying anything.

## Layout

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle table definitions (source of truth in code) |
| `../db.ts` | Connection factories (`createDenoDb`, `createWorkersDb`) |
| `../../drizzle.config.ts` | drizzle-kit config (tooling only — not license to push/migrate) |

## Connection (self-hosted dev)

Postgres runs in Docker on the instance host; the instance connects via Unix socket. See the repo root `AGENTS.md` for `TURBOPANEL_PG_*` env vars. Do not embed credentials or host-specific URLs here.

## Developer console tooling

- **Test connection** — `GET /api/developer/v1/database/status` runs `SELECT version()` via the same client as the app.
- **Drizzle Studio** — `POST /api/developer/v1/database/studio` spawns `drizzle-kit studio` on demand; Caddy proxies `/drizzle-studio/` in dev mode. Read-only browsing only — still no `push` / `migrate` from Studio or agents unless explicitly approved.
