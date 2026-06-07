# Database (early development)

**Do not run migrations.** TurboPanel is in very early development and the co-located dev server already has live data. Treat every database change as production-adjacent until we say otherwise.

## Workflow: database first → introspect → `schema.ts`

During early dev we **design in the database**, then pull the model back into code. Do **not** use `drizzle-kit push` or `migrate` for this loop.

| Step | Where | What |
|---|---|---|
| 1. Change schema | Live dev Postgres (Drizzle Studio) | Add/alter tables, columns, indexes |
| 2. Introspect | Host shell (`drizzle-kit introspect`) | Read DB → generated TS |
| 3. Adopt | `schema.ts` | Replace contents with introspected model (clean up style) |
| 4. Discard | `drizzle/` output | Delete generated SQL/snapshots — we are not keeping migrations yet |

**Source of truth in code:** `schema.ts` — kept in sync with the dev database via introspect, not hand-written ahead of the DB.

### 1. Edit the database (Drizzle Studio)

Use the developer console **Database** section (`/developer/database`):

1. **Test Postgres connection** — should show connected (`tcp` on co-located dev).
2. **Start API & open studio** — opens `https://local.drizzle.studio?host=<browser-host>&port=8444` (Caddy proxies the studio API on `:8444`).
3. In Studio, create or change tables/columns. Changes apply **directly** to the dev database.

Studio is for **schema exploration and DDL in dev only**. Do not use it on production.

### 2. Introspect (pull DB → `schema.ts`)

Run on the **instance host** from the `turbopanel` repo root:

```bash
cd /opt/turbopanel/platform/turbopanel
./introspect.sh
```

`introspect.sh` (repo root):

1. Builds `DATABASE_URL` from `turbopanel-instance` systemd env (dev TCP `127.0.0.1:5432`), or uses `DATABASE_URL` if already set
2. Runs `drizzle-kit introspect`
3. Copies `drizzle/schema.ts` → **`schema.ts`** (this file)
4. Deletes ephemeral `drizzle/` SQL/snapshots
5. Runs `deno check src/db/schema.ts`

Override connection: `DATABASE_URL=postgresql://… ./introspect.sh`

### 3. Review `schema.ts`

The script copies drizzle-kit output verbatim (minus unused `sql` import). Before commit:

1. Normalize style if needed: single quotes, explicit column names, trim verbose `generatedAlwaysAsIdentity` options when defaults suffice.
2. Remove exports for tables you intentionally dropped in Studio.
3. If relations matter later, inspect what drizzle-kit generated in `drizzle/relations.ts` during the run (the script deletes it after adopt) and add a `relations.ts` sibling when app code needs it.

Optional sanity check:

```bash
docker exec turbopanel-postgres psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only if application code changed — introspect alone does not require a restart.

## Current policy (what not to run)

- **No migration workflow** — do not run `drizzle-kit migrate`, do not curate SQL under `drizzle/`, do not commit `drizzle/meta/`.
- **No `drizzle-kit push`** — schema changes go through Studio (or explicit approved DDL), then introspect back; push bypasses that loop and can fight live data.
- **No production DDL** from agents without explicit approval.

Destructive Studio changes (drop column/table, type narrowing) can lose dev rows. Before introspecting after a destructive change, confirm the operator intended it.

## Layout

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle table definitions — **synced from dev DB via introspect** |
| `../db.ts` | Connection factories (`createDenoDb`, `createWorkersDb`) |
| `../../drizzle.config.ts` | drizzle-kit config (introspect + studio only) |
| `../../introspect.sh` | Standard pull script (introspect → adopt → cleanup → check) |
| `../../drizzle/` | Ephemeral introspect output — **not** source of truth; `introspect.sh` deletes after adopt |

## Connection (self-hosted dev)

Co-located **dev** uses **TCP** `127.0.0.1:5432` (`postgres_expose_port=true`, `TURBOPANEL_PG_HOST=127.0.0.1`) so `drizzle-kit` and `node-postgres` work with a normal URL. **Production** uses Unix socket only (`TURBOPANEL_PG_SOCKET`). See repo root `AGENTS.md` for `TURBOPANEL_PG_*` env vars. Do not embed credentials or host-specific URLs here.

## Developer console tooling

- **Test connection** — `GET /api/developer/v1/database/status` runs `SELECT version()` via the same client as the app.
- **Drizzle Studio** — `POST /api/developer/v1/database/studio` spawns `drizzle-kit studio` on `127.0.0.1:4983`; Caddy proxies on **`:8444`**. Open `https://local.drizzle.studio?host=<browser-host>&port=8444`.
