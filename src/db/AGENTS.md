# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`, run `pnpm drizzle-kit generate` to create SQL files. Apply pending migrations with `TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command. **`drizzle-kit migrate` records applied versions in `public.migration`** (configured in `drizzle.config.ts`).

The co-located dev server has live data — treat every database change as production-adjacent.

## Schema sync directions

| Direction | You changed | Command | drizzle-kit |
|---|---|---|---|
| **Pull** (DB → code) | Live Postgres (Studio / SQL) | `./introspect.sh` | `introspect` |
| **Push** (code → DB, Deno dev only) | `schema.ts` | `./sync.sh` | `push` |
| **Generate migration** | `schema.ts` | `pnpm drizzle-kit generate` | `generate` |
| **Apply migration** (Workers deploy + manual) | pending SQL in `migrations/` | `TURBOPANEL_DATABASE_URL=… pnpm migrate` | `migrate` |

Pick one source of truth per change — do not edit both sides and blindly run both scripts.

### Pull: database → `schema.ts` (`./introspect.sh`)

Use when you designed in **Drizzle Studio** or applied DDL directly.

1. Change tables in Studio (`/developer/database` → **Start API & open studio**).
2. Run `./introspect.sh` from the `turbopanel` repo root.
3. Review `schema.ts` (style, dropped tables).

`introspect.sh`: loads `TURBOPANEL_DATABASE_URL` from `turbopanel-instance` (or `DATABASE_URL` override) → introspect → copy to `schema.ts` → delete ephemeral `drizzle/` output → `deno check`.

### Push: `schema.ts` → database (`./sync.sh`)

Use when you edited **`schema.ts` first** and need the live dev DB to catch up without committing migration files (Deno dev convenience only).

1. Edit `src/db/schema.ts`.
2. Run `./sync.sh` from the `turbopanel` repo root.
3. Confirm drizzle-kit prompts (`--strict` by default). Use `./sync.sh --force` only when you accept possible **data loss** on dev.

`sync.sh`: `deno check` → `drizzle-kit push` (no SQL files committed). Flags: `--verbose`, `--force`.

Override connection for either script: `DATABASE_URL=postgresql://… ./introspect.sh` or `./sync.sh`.

### Generate + apply migrations (Workers path)

Use when schema changes should ship as versioned SQL (required for Workers deploy).

1. Edit `src/db/schema.ts`.
2. Run `pnpm drizzle-kit generate` — writes SQL under `migrations/`.
3. Commit the new migration files.
4. Apply: `TURBOPANEL_DATABASE_URL=… pnpm migrate` (local or CI). Workers deploy runs `pnpm migrate` automatically.

Applied versions are tracked in **`public.migration`** (`drizzle.config.ts` sets `migrations: { table: 'migration', schema: 'public' }`).

### Drizzle Studio (dev UI)

- **Test connection** — `GET /api/developer/v1/database/status`
- **Reset dev instance** — `POST /api/developer/v1/system/reset-dev` (superadmin session only): `DROP SCHEMA public CASCADE`, `drizzle-kit push --force`, restart instance. UI: Database section → **Reset Dev Instance**.
- **Studio** — `POST /api/developer/v1/database/studio` starts `drizzle-kit studio` on **127.0.0.1:4983** (HTTP API). Open **`https://local.drizzle.studio?host=localhost&port=4983`** (hosted UI). Safari/Brave may block localhost — see [Drizzle docs](https://orm.drizzle.team/docs/drizzle-kit-studio#safari-and-brave-support).
- Studio applies DDL **directly** to the DB — follow with `./introspect.sh` to pull into code.

## Current policy (what not to run)

- Use `pnpm drizzle-kit generate` + `pnpm migrate` for Workers-bound schema changes; `./sync.sh` (`push`) remains for Deno dev convenience only.
- **No ad-hoc push** — use `./sync.sh` only (after editing `schema.ts`), not raw `drizzle-kit push` in one-off commands.
- **No production DDL** from agents without explicit approval.

Destructive changes (drop column/table, type narrowing) can lose dev rows. `sync.sh` prompts via `--strict`; `--force` skips those guardrails.

## Schema (ported from old trunk `apps/api`)

`schema.ts` mirrors the old monorepo database layout (Better Auth–compatible tables, no auth runtime yet). Grouped by concern:

| Group | Tables |
|---|---|
| **Identity** | `user`, `account`, `apikey`, `session`, `verification`, `passkey`, `2fa` |
| **Organizations** | `organization`, `member`, `team`, `teammate`, `invitation` |
| **Config** | `setting` |
| **Runtime** | `server` |

Drizzle relations are defined for future Better Auth adapter use. `IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup.

**Install (Deno):** A fresh DB has no org or superadmin. `src/auth/install-state.ts` `isInstanceInstalled()` is false until `completeInstanceInstall` creates org + team + superadmin user with a named org. **`organization.slug`** stays **NULL** (reserved for a future feature). Org extras (e.g. logo URL) belong in **`organization.metadata`** — there is no `logo` column. Install sets **`email`** and **`role`** only — `display_name`, `username`, and `display_username` stay **NULL** until the user chooses them.

### `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon connect the instance resolves `serverId` (reuse by persisted id, `metadata.machineId`, or `metadata.hostname`), tracks the websocket in `daemon-hub`, and returns `serverId` in `hello`. The daemon persists it at `/etc/turbopanel/daemon/server.id` (writable by the `turbopanel` user). `display_name`, `organization_id`, and soft-delete via `deleted_at` match the old trunk shape; daemon registration stores `machineId` / `hostname` in `metadata` (see `server-metadata.ts`).

## Layout

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle table definitions — sync with dev DB via `./introspect.sh` or `./sync.sh` |
| `../db.ts` | Connection factories (`createDenoDb`, `createWorkersDb`) |
| `../../drizzle.config.ts` | drizzle-kit config (`TURBOPANEL_DATABASE_URL` / `DATABASE_URL`; introspect, push, generate, migrate, studio) |
| `../../introspect.sh` | Pull DB → `schema.ts` |
| `../../sync.sh` | Push `schema.ts` → DB (Deno dev only; no migration files) |
| `../../scripts/db-connect.sh` | Resolves `TURBOPANEL_DATABASE_URL` → `DATABASE_URL` for drizzle-kit scripts |
| `../../migrations/` | Versioned SQL migration files (committed); applied by `pnpm migrate`; tracked in `public.migration` |
| `../../drizzle/` | Ephemeral introspect scratch dir — `introspect.sh` deletes after adopt; never committed |

## Connection (self-hosted dev)

Self-hosted instance, drizzle-kit (`drizzle.config.ts`), and `./sync.sh` / `./introspect.sh` all connect via **`TURBOPANEL_DATABASE_URL`** (falls back to `DATABASE_URL` for tooling). Unix socket connections use the libpq-style `?host=` query param (e.g. `postgresql://user:pass@/turbopanel?host=/var/run/turbopanel/postgres`). Postgres in Docker always publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure (`postgres_expose_port`) is optional and unused by the instance. See repo root `AGENTS.md` for env var details. Do not embed credentials here.

## Sanity check

```bash
docker exec turbopanel-db psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone does not require a restart.

### Empty database bootstrap (Deno dev)

On startup, `src/deno.ts` calls `ensureDbSchemaReady()` when Postgres is configured. If the `user` table is missing (fresh Postgres volume, failed reset, etc.), the instance runs `drizzle-kit push --force` from `schema.ts` before accepting traffic. `./sync.sh` reads `TURBOPANEL_DATABASE_URL` (or `DATABASE_URL` override).
