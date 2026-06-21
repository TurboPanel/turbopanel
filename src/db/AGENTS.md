# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`, run `pnpm drizzle-kit generate` to create SQL files. Apply pending migrations with `TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command. **`pnpm migrate` applies versioned SQL via `drizzle-kit migrate` and then runs resource-registry repair** (`repairSchemaFromMigrations` + `repairResourceRegistry` in `scripts/seed-catalog.ts` via Node — no Deno prerequisite). Applied migration versions are recorded in **`public.migration`** (configured in `drizzle.config.ts`).

The co-located dev server has live data — treat every database change as production-adjacent.

## Schema sync directions

> **Fresh database:** apply migrations with `pnpm migrate` before starting the instance. There is no automatic push fallback on boot.

| Direction | You changed | Command | drizzle-kit |
|---|---|---|---|
| **Pull** (DB → code) | Live Postgres (Studio / SQL) | `./introspect.sh` | `introspect` |
| **Push** (code → DB, Deno dev only) | `schema.ts` | `./sync.sh` | `push` |
| **Generate migration** | `schema.ts` | `pnpm drizzle-kit generate` | `generate` |
| **Apply migration** (Workers deploy + manual) | pending SQL in `migrations/` | `TURBOPANEL_DATABASE_URL=… pnpm migrate` | `migrate` + resource registry repair |

Pick one source of truth per change — do not edit both sides and blindly run both scripts.

### Pull: database → `schema.ts` (`./introspect.sh`)

Use when you designed in **Drizzle Studio** or applied DDL directly.

1. Change tables in Studio (`/developer/database` → **Start API & open studio**).
2. Run `./introspect.sh` from the `turbopanel` repo root.
3. Review `schema.ts` (style, dropped tables).

`introspect.sh`: loads `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` → introspect → copy to `schema.ts` → delete ephemeral `drizzle/` output → `deno check`.

### Push: `schema.ts` → database (`./sync.sh`)

Use when you edited **`schema.ts` first** and need the live dev DB to catch up without committing migration files (Deno dev convenience only).

1. Edit `src/db/schema.ts`.
2. Run `./sync.sh` from the `turbopanel` repo root.
3. Confirm drizzle-kit prompts (`--strict` by default). Use `./sync.sh --force` only when you accept possible **data loss** on dev.

`sync.sh`: `deno check` → `drizzle-kit push` (no SQL files committed). Flags: `--verbose`, `--force`.

Override connection for either script: `TURBOPANEL_DATABASE_URL=postgresql://… ./introspect.sh` or `./sync.sh`.

### Generate + apply migrations (Workers path)

Use when schema changes should ship as versioned SQL (required for Workers deploy).

1. Edit `src/db/schema.ts`.
2. Run `pnpm drizzle-kit generate` — writes SQL under `migrations/`.
3. Commit the new migration files.
4. Apply: `TURBOPANEL_DATABASE_URL=… pnpm migrate` (local or CI). Workers deploy runs `pnpm migrate` automatically — schema migrations and resource-registry repair run in one step (Node only).

Applied versions are tracked in **`public.migration`** (`drizzle.config.ts` sets `migrations: { table: 'migration', schema: 'public' }`).

### Drizzle Studio (dev UI)

- **Test connection** — `GET /api/developer/v1/database/status`
- **Reset dev instance** — `POST /api/developer/v1/system/reset-dev` (superadmin session only): `DROP SCHEMA public CASCADE`, `drizzle-kit migrate`, resource-registry repair, restart instance. UI: Database section → **Reset Dev Instance**.
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
| **Organizations** | `organization`, `member`, `team`, `teammate`, `invitation`, `license` |
| **Resource tree** | `realm`, `environment`, `project`, `service`, `hosting` |
| **Authorization** | `resource`, `access` |
| **Config** | `setting` |
| **Runtime** | `server` |

> Access profiles and permissions are **static code constants** defined in `../authz/catalog.ts` (`ACCESS_PROFILES`, `PERMISSIONS`) — not DB rows. There are no `role`, `permission`, or `permit` tables.

Drizzle relations are defined for future Better Auth adapter use. `IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup.

**Organizations:** `member` and `invitation` are **pure relationship tables** — `member.role` and `invitation.role` were removed because authorization is now derived exclusively from `access` rows, not membership columns. **`invitation.grants`** (JSONB) stores the intended access grants (`InvitationGrantSpec[]` in `src/authn/invitation-grants.ts`); they are materialized into `access` rows on accept. When `grants` is null, accept applies a default org-scoped member access-profile grant.

**Uniqueness:** `member(organization_id, user_id)`, `teammate(team_id, user_id)`, and partial unique indexes on `access` for access-profile-key and permission-key targeted grants prevent duplicate membership or grant rows on concurrent invite acceptance/retries.

**Server resources:** `server` rows with an `organization_id` must have a matching `resource` row (`kind = 'server'`) for `listVisible()` to include them. Registration happens in `server-registry.ts` (create/bind), `assignColocatedDaemonToOrganization()` (install), and developer `PATCH /servers/:id` org assignment.

**Install (Deno):** A fresh DB has no org or superadmin. `src/authn/install-state.ts` `isInstanceInstalled()` is false until `completeInstanceInstall` creates org + team + superadmin user with a named org. **`organization.slug`** stays **NULL** (reserved for a future feature). Org extras (e.g. logo URL) belong in **`organization.metadata`** — there is no `logo` column. Install sets **`email`** and **`role`** (on `user`) only — `display_name`, `username`, and `display_username` stay **NULL** until the user chooses them. `completeInstanceInstall` registers the org `resource` row and inserts an owner `access` grant for the superadmin user (via `registerResource` + direct `access` insert with `accessProfileKey: 'owner'`).

### Client API (authz integration)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/client/v1/invitations/{id}/accept` | Accept a pending invitation; creates `member`/`teammate` rows, materializes `invitation.grants` into `access` rows, updates session `organizationId` |
| `GET` | `/api/client/v1/access-profiles` | Access profile catalog — static, no DB query (any authenticated user) |
| `GET` | `/api/client/v1/permissions` | Permission catalog — static, no DB query (any authenticated user) |
| `GET` | `/api/client/v1/access?resourceId=<uuid>` | List access grants; rows carry `accessProfileKey` or `permissionKey` string fields |
| `POST` | `/api/client/v1/access` | Create an access grant; body: `{ subjectKind, subjectId, resourceId, effect, accessProfileKey?, permissionKey? }` — exactly one key required |
| `DELETE` | `/api/client/v1/access/{id}` | Revoke an access grant |

#### Resource tree CRUD

List and get enforce visibility via `listVisible` / `assertCanOr403` in SQL — never client-side. Create requires `<parent-kind>:rw` on the parent resource scope. Update and delete require `<kind>:rw` on the entity's own resource scope. All create/delete operations run entity insert/delete + `registerResource` / `unregisterResource` in a single transaction.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/client/v1/realms` | `realm:ro` or `realm:rw` (via `listVisible`) |
| `GET` | `/api/client/v1/realms/{id}` | `realm:ro` |
| `POST` | `/api/client/v1/realms` | `organization:rw` on org resource |
| `PATCH` | `/api/client/v1/realms/{id}` | `realm:rw` |
| `DELETE` | `/api/client/v1/realms/{id}` | `realm:rw` |
| `GET` | `/api/client/v1/environments` | `environment:ro` or `environment:rw` (optional `?realmId=`) |
| `GET` | `/api/client/v1/environments/{id}` | `environment:ro` |
| `POST` | `/api/client/v1/environments` | `realm:rw` on parent realm |
| `PATCH` | `/api/client/v1/environments/{id}` | `environment:rw` |
| `DELETE` | `/api/client/v1/environments/{id}` | `environment:rw` |
| `GET` | `/api/client/v1/projects` | `project:ro` or `project:rw` (optional `?environmentId=`) |
| `GET` | `/api/client/v1/projects/{id}` | `project:ro` |
| `POST` | `/api/client/v1/projects` | `environment:rw` on parent environment |
| `PATCH` | `/api/client/v1/projects/{id}` | `project:rw` |
| `DELETE` | `/api/client/v1/projects/{id}` | `project:rw` |
| `GET` | `/api/client/v1/services` | `service:ro` or `service:rw` (optional `?projectId=`) |
| `GET` | `/api/client/v1/services/{id}` | `service:ro` |
| `POST` | `/api/client/v1/services` | `project:rw` on parent project |
| `PATCH` | `/api/client/v1/services/{id}` | `service:rw` |
| `DELETE` | `/api/client/v1/services/{id}` | `service:rw` |
| `GET` | `/api/client/v1/hostings` | `hosting:ro` or `hosting:rw` (optional `?projectId=`) |
| `GET` | `/api/client/v1/hostings/{id}` | `hosting:ro` |
| `POST` | `/api/client/v1/hostings` | `project:rw` on parent project |
| `PATCH` | `/api/client/v1/hostings/{id}` | `hosting:rw` |
| `DELETE` | `/api/client/v1/hostings/{id}` | `hosting:rw` |

Implemented in `src/resource-routes.ts`, registered from `registerClientRoutes`.

`GET /api/client/v1/servers` uses `listVisible()` for server visibility (not raw org membership). License endpoints (`GET`/`POST` `/licenses`, `DELETE` `/licenses/{id}`) require `organization:billing` when the org `resource` row exists; legacy installs without a registered org resource fall back to session org membership with a warning log.

### Catalog seeding

Access profiles and permissions are **static code constants** in `src/authz/catalog.ts` — there is nothing to seed. `syncAuthzCatalog` has been removed. `pnpm migrate` applies versioned SQL migrations and repairs the `resource` registry (`repairSchemaFromMigrations` + `repairResourceRegistry` in `scripts/seed-catalog.ts`). `pnpm seed` re-runs the same repair without applying migrations. Never edit access profiles or permissions in Studio — they do not exist as DB rows.

### `license` table

Organization-scoped API tokens for server registration. Each row belongs to an `organization` (`organization_id`, cascade delete). `display_name` is optional. `hashed_token` stores a PBKDF2-SHA256 hash in the same `$pbkdf2-sha256$…` format as `account.password`. Soft-delete via `revoked_at` — revoked licenses remain in the table for audit; application code should treat non-null `revoked_at` as inactive.

### `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon connect the instance resolves `serverId` (reuse by persisted id, `metadata.machineId`, or `metadata.hostname`), tracks the websocket in `daemon-hub`, and returns `serverId` in `hello`. The daemon persists it at `/opt/turbopanel/platform/daemon/state/server.id` (writable by the `turbopanel` user). `display_name`, `organization_id`, and soft-delete via `deleted_at` match the old trunk shape; daemon registration stores `machineId` / `hostname` in `metadata` (see `server-metadata.ts`). `license_id` (nullable FK → `license.id`) records which license token the server registered with.

## Layout

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle table definitions — sync with dev DB via `./introspect.sh` or `./sync.sh` |
| `../db.ts` | Connection factories (`createDenoDb`, `createToolingDb`, `createWorkersDb`) |
| `../../drizzle.config.ts` | drizzle-kit config (`TURBOPANEL_DATABASE_URL`; introspect, push, generate, migrate, studio) |
| `../../introspect.sh` | Pull DB → `schema.ts` |
| `../../sync.sh` | Push `schema.ts` → DB (Deno dev only; no migration files) |
| `../../scripts/db-connect.sh` | Resolves `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` for drizzle-kit scripts |
| `../../migrations/` | Versioned SQL migration files (committed); applied by `pnpm migrate`; tracked in `public.migration` |
| `../../scripts/seed-catalog.ts` | Node entrypoint (`node --experimental-strip-types`) for `repairSchemaFromMigrations` + `repairResourceRegistry` — run by `pnpm migrate` and `pnpm seed`; no longer calls `syncAuthzCatalog` |
| `../../drizzle/` | Ephemeral introspect scratch dir — `introspect.sh` deletes after adopt; never committed |

### Authz engine

Runtime authorization lives in `../authz/` (pure TypeScript, safe for both Deno and Workers — no Deno-only imports). Access profiles and permissions are static code constants in `catalog.ts`; `sync.ts` has been removed. The modules below evaluate access at request time against `resource` / `access`.

| File | Purpose |
|---|---|
| `../authz/catalog.ts` | Static `ACCESS_PROFILES`, `PERMISSIONS`, `isAccessProfileKey`, `isPermissionKey`, `accessProfilesGrantingPermission`, `getAccessProfileCatalog`, `getPermissionCatalog` — no DB access |
| `../authz/resource-registry.ts` | `registerResource` / `unregisterResource` / `getResourceByItem` / `getResourceId` — lifecycle of `resource` rows keyed by (`kind`, `item_id`) |
| `../authz/evaluator.ts` | `getSubjects`, `getResourceAncestry`, `can`, `assertCan`, `listVisible`, `ForbiddenError` — expands access profiles from code constants; superadmin bypass in SQL |
| `../authz/http.ts` | `assertCanOr403` Hono helper (503 / 401 / 403 short-circuit, `null` to continue) |

`can()` resolves a permission in a **single recursive-CTE query** (`subjectset` → `ancestry` → `hits`, ordered closest-first with deny winning ties) — one round-trip, no per-ancestor queries. Access profile expansion (`accessProfilesGrantingPermission`) happens in code before the query. A superadmin bypass (`EXISTS … WHERE role = 'superadmin'`) is OR'd into the final result so no explicit grants are needed for superadmins. `listVisible()` applies the same leaf-first, deny-beats-allow resolution for `<kind>:ro` and `<kind>:rw` in SQL — **never rely on client-side filtering** for visibility.

**Follow-up (deferred):** Resource ancestry is currently computed from the generic `resource` shadow table. A future pass should compute it directly from real domain tables (`organization → realm → environment → project → service/hosting`, `organization → server`) and drop the `resource` table entirely.

## Connection (self-hosted dev)

Self-hosted instance boot and all database tooling require **`TURBOPANEL_DATABASE_URL`**. Unix socket connections use the libpq-style `?host=` query param (e.g. `postgresql://user:pass@/turbopanel?host=/var/run/turbopanel/postgres`). Postgres in Docker always publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure (`postgres_expose_port`) is optional and unused by the instance. See repo root `AGENTS.md` for env var details. Do not embed credentials here.

## Sanity check

```bash
docker exec turbopaneldb psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone does not require a restart.
