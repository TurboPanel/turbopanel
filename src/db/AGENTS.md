# Database (early development)

**Do not run migrations.** TurboPanel is in very early development and the co-located dev server already has live data. Treat every database change as production-adjacent until we say otherwise.

## Two sync directions (no migration files)

We keep `schema.ts` and the dev database aligned using **drizzle-kit introspect** and **drizzle-kit push** only. Neither writes versioned migrations under `drizzle/`.

| Direction | You changed | Command | drizzle-kit |
|---|---|---|---|
| **Pull** (DB → code) | Live Postgres (Studio / SQL) | `./introspect.sh` | `introspect` |
| **Push** (code → DB) | `schema.ts` | `./sync.sh` | `push` |

Pick one source of truth per change — do not edit both sides and blindly run both scripts.

### Pull: database → `schema.ts` (`./introspect.sh`)

Use when you designed in **Drizzle Studio** or applied DDL directly.

1. Change tables in Studio (`/developer/database` → **Start API & open studio**).
2. Run `./introspect.sh` from the `turbopanel` repo root.
3. Review `schema.ts` (style, dropped tables).

`introspect.sh`: builds `DATABASE_URL` from `turbopanel-instance` env → introspect → copy to `schema.ts` → delete ephemeral `drizzle/` output → `deno check`.

### Push: `schema.ts` → database (`./sync.sh`)

Use when you edited **`schema.ts` first** and need the live dev DB to catch up.

1. Edit `src/db/schema.ts`.
2. Run `./sync.sh` from the `turbopanel` repo root.
3. Confirm drizzle-kit prompts (`--strict` by default). Use `./sync.sh --force` only when you accept possible **data loss** on dev.

`sync.sh`: `deno check` → `drizzle-kit push` (no SQL files committed). Flags: `--verbose`, `--force`.

Override connection for either script: `DATABASE_URL=postgresql://… ./introspect.sh` or `./sync.sh`.

### Drizzle Studio (dev UI)

- **Test connection** — `GET /api/developer/v1/database/status`
- **Studio** — `POST /api/developer/v1/database/studio`; Caddy proxies **HTTPS-only** on **`:8444`**. `local.drizzle.studio` (HTTPS) blocks mixed-content HTTP to private hosts, then retries HTTPS — trust the platform CA (same as `:8443`). Open `https://local.drizzle.studio?host=<browser-host>&port=8444`.
- Studio applies DDL **directly** to the DB — follow with `./introspect.sh` to pull into code.

## Current policy (what not to run)

- **No migration workflow** — do not run `drizzle-kit migrate`, do not commit `drizzle/*.sql` or `drizzle/meta/`.
- **No ad-hoc push** — use `./sync.sh` only (after editing `schema.ts`), not raw `drizzle-kit push` in one-off commands.
- **No production DDL** from agents without explicit approval.

Destructive changes (drop column/table, type narrowing) can lose dev rows. `sync.sh` prompts via `--strict`; `--force` skips those guardrails.

## `servers` table

Each physical server node gets a row in `servers` (`id` uuidv7). On daemon connect the instance resolves `serverId` (reuse by persisted id, `metadata.machineId`, or `metadata.hostname`; unique indexes prevent duplicates), tracks the websocket in `daemon-hub`, and returns `serverId` in `hello`. The daemon persists it at `/etc/turbopanel/daemon/server.id` (writable by the `turbopanel` user).

## Layout

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle table definitions — sync with dev DB via `./introspect.sh` or `./sync.sh` |
| `../db.ts` | Connection factories (`createDenoDb`, `createWorkersDb`) |
| `../../drizzle.config.ts` | drizzle-kit config (introspect, push, studio) |
| `../../introspect.sh` | Pull DB → `schema.ts` |
| `../../sync.sh` | Push `schema.ts` → DB (no migration files) |
| `../../scripts/db-connect.sh` | Shared `DATABASE_URL` + toolchain paths for both scripts |
| `../../drizzle/` | Ephemeral introspect output only — `introspect.sh` deletes after adopt |

## Connection (self-hosted dev)

Self-hosted instance, drizzle-kit (`drizzle.config.ts`), and `./sync.sh` / `./introspect.sh` all connect via **Unix socket** (`TURBOPANEL_PG_SOCKET`). Postgres in Docker always publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure (`postgres_expose_port`) is optional and unused by the instance. See repo root `AGENTS.md` for `TURBOPANEL_PG_*` env vars. Do not embed credentials here.

## Sanity check

```bash
docker exec turbopanel-postgres psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone does not require a restart.
