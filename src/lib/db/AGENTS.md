# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`, run `pnpm drizzle-kit generate` to create SQL files. Apply pending migrations with `TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command. Applied migration versions are recorded in **`public.migration`** (configured in `drizzle.config.mjs`).

The co-located dev server has live data — treat every database change as production-adjacent.

## Schema sync directions

> **Fresh database:** co-located dev converge runs `./scripts/bootstrap-dev-db.sh` via Ansible (`pnpm migrate`). Manual bootstrap: `./scripts/bootstrap-dev-db.sh` from the instance repo root.

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

`introspect.sh`: loads `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` → introspect → copy to `schema.ts` → delete ephemeral `drizzle/` output → `deno check`.

### Push: `schema.ts` → database (`./sync.sh`)

Use when you edited **`schema.ts` first** and need the live dev DB to catch up without committing migration files (Deno dev convenience only).

1. Edit `src/lib/db/schema.ts`.
2. Run `./sync.sh` from the `turbopanel` repo root.
3. Confirm drizzle-kit prompts (`--strict` by default). Use `./sync.sh --force` only when you accept possible **data loss** on dev.

`sync.sh`: `deno check` → `drizzle-kit push` (no SQL files committed). Flags: `--verbose`, `--force`.

Override connection for either script: `TURBOPANEL_DATABASE_URL=postgresql://… ./introspect.sh` or `./sync.sh`.

### Generate + apply migrations (Workers path)

Use when schema changes should ship as versioned SQL (required for Workers deploy).

1. Edit `src/lib/db/schema.ts`.
2. Run `pnpm drizzle-kit generate` — writes SQL under `migrations/`.
3. Commit the new migration files.
4. Apply: `TURBOPANEL_DATABASE_URL=… pnpm migrate` (local or CI). Workers deploy runs `pnpm migrate` automatically.

Applied versions are tracked in **`public.migration`** (`drizzle.config.ts` sets `migrations: { table: 'migration', schema: 'public' }`).

### Drizzle Studio (dev UI)

- **Test connection** — `GET /api/developer/v1/database/status`
- **Reset dev instance** — `POST /api/developer/v1/system/reset-dev` (superadmin session only): `DROP SCHEMA public CASCADE`, `drizzle-kit migrate`, restart instance. UI: Database section → **Reset Dev Instance**.
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
| **Resource tree** | `workspace`, `environment`, `project`, `service`, `hosting` |
| **Authorization** | `grant` |
| **Config** | `setting` |
| **Runtime** | `server` |

> The physical Postgres table is **`workspace`** (`environment.workspace_id` → `workspace.id`). The Drizzle export is `workspace`.

> Permissions are **static code constants** defined in `../../client/authz/catalog.ts` (`PERMISSIONS`, `ENTITY_TYPES`, `SUBJECT_TYPES`) — not DB rows. There are no `role`, `permission`, or `permit` tables. The Drizzle table export is **`grant`** (not `accessGrant`).

Drizzle relations are defined for future Better Auth adapter use. `IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup.

**Organizations:** `member` and `invitation` are **pure relationship tables** — `member.role` and `invitation.role` were removed because authorization is now derived exclusively from `grant` rows, not membership columns. **`invitation.grants`** (JSONB) stores the intended access grants (`InvitationGrantSpec[]` in `src/client/authn/invitation-grants.ts`); they are materialized into `grant` rows on accept. When `grants` is null, accept applies a default `organization:manage` grant on the org.

**Uniqueness:** `member(organization_id, user_id)` and `teammate(team_id, user_id)` prevent duplicate membership rows on concurrent invite acceptance/retries.

**Install (Deno):** A fresh DB has no org or superadmin. `src/client/authn/install-state.ts` `isInstanceInstalled()` is false until `completeInstanceInstall` creates org + team + superadmin user with a named org. **`organization.slug`** stays **NULL** (reserved for a future feature). Org extras (e.g. logo URL) belong in **`organization.metadata`** — there is no `logo` column. Install sets **`email`** and **`role`** (on `user`) only — `display_name`, `username`, and `display_username` stay **NULL** until the user chooses them.

### Client API (authz integration)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/client/v1/invitations/{id}/accept` | Accept a pending invitation; creates `member`/`teammate` rows, materializes `invitation.grants` into `grant` rows, updates session `organizationId` |
| `GET` | `/api/client/v1/permissions` | Permission catalog — static, no DB query (any authenticated user) |
| `GET` | `/api/client/v1/access?resourceId=<uuid>` | List access grants for a resource; returns `{ access: AccessRecord[] }` with `subjectKind`, `subjectId`, `resourceId`, `effect`, and `permissionKey` |
| `GET` | `/api/client/v1/access/check?resourceId=<uuid>&permissionKey=…` | Check a single permission for the signed-in user; returns `{ allowed: boolean }` |
| `GET` | `/api/client/v1/access/resource-id?kind=<kind>&itemId=<uuid>` | Resolve `resourceId` for an entity in the session org; returns `{ resourceId, kind, itemId }` |
| `POST` | `/api/client/v1/access` | Create an access grant; body: `{ subjectKind, subjectId, resourceId, effect, permissionKey }` |
| `DELETE` | `/api/client/v1/access/{id}` | Revoke an access grant |

#### Resource tree CRUD

List and get enforce visibility via `listVisible` / org-level grant checks in SQL — never client-side. Create, update, and delete require `organization:own` or `organization:manage` on the entity's org (via `can()`). All create/delete operations run entity insert/delete in a single transaction.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/client/v1/workspaces` | org owner/manager or platform admin (via `listVisible`) |
| `GET` | `/api/client/v1/workspaces/{id}` | org owner/manager or platform admin |
| `POST` | `/api/client/v1/workspaces` | org owner/manager on org |
| `PATCH` | `/api/client/v1/workspaces/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/workspaces/{id}` | org owner/manager |
| `GET` | `/api/client/v1/environments` | org owner/manager (optional `?workspaceId=`) |
| `GET` | `/api/client/v1/environments/{id}` | org owner/manager |
| `POST` | `/api/client/v1/environments` | org owner/manager on parent workspace |
| `PATCH` | `/api/client/v1/environments/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/environments/{id}` | org owner/manager |
| `GET` | `/api/client/v1/projects` | org owner/manager (optional `?environmentId=`) |
| `GET` | `/api/client/v1/projects/{id}` | org owner/manager |
| `POST` | `/api/client/v1/projects` | org owner/manager on parent environment |
| `PATCH` | `/api/client/v1/projects/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/projects/{id}` | org owner/manager |
| `GET` | `/api/client/v1/services` | org owner/manager (optional `?projectId=`) |
| `GET` | `/api/client/v1/services/{id}` | org owner/manager |
| `POST` | `/api/client/v1/services` | org owner/manager on parent project |
| `PATCH` | `/api/client/v1/services/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/services/{id}` | org owner/manager |
| `GET` | `/api/client/v1/hostings` | org owner/manager (optional `?projectId=`) |
| `GET` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `POST` | `/api/client/v1/hostings` | org owner/manager on parent project |
| `PATCH` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/hostings/{id}` | org owner/manager |

Implemented in `src/resource-routes.ts`, registered from `registerClientRoutes`.

`GET /api/client/v1/servers` uses `listVisible()` for server visibility (not raw org membership). License endpoints (`GET`/`POST` `/licenses`, `DELETE` `/licenses/{id}`) require org ownership (`organization:own`).

### Catalog

Permissions are **static code constants** in `../../client/authz/catalog.ts` — there is nothing to seed. Four permissions exist: `organization:own`, `organization:manage`, `team:own`, and `team:manage`. Never edit permissions in Studio — they do not exist as DB rows. **`ENTITY_TYPES`** and **`SUBJECT_TYPES`** are also exported from `catalog.ts` for route/body validation (`isEntityType`, `isSubjectType`).

### `license` table

Organization-scoped API tokens for server registration. Each row belongs to an `organization` (`organization_id`, cascade delete). `display_name` is optional. `hashed_token` stores a PBKDF2-SHA256 hash in the same `$pbkdf2-sha256$…` format as `account.password`. Soft-delete via `revoked_at` — revoked licenses remain in the table for audit; application code should treat non-null `revoked_at` as inactive.

### `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon connect the instance resolves `serverId` (reuse by persisted id, `metadata.machineId`, or `metadata.hostname`), tracks the websocket in `daemon-hub`, and returns `serverId` in `hello`. The daemon persists it at `/opt/turbopanel/platform/daemon/state/server.id` (writable by the `turbopanel` user). `display_name`, `organization_id`, and soft-delete via `deleted_at` match the old trunk shape; daemon registration stores `machineId` / `hostname` in `metadata` (see `server-metadata.ts`). `license_id` (nullable FK → `license.id`) records which license token the server registered with.

## Layout

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle table definitions — sync with dev DB via `./introspect.sh` or `./sync.sh` |
| `../../db.ts` | Connection factories (`createDenoDb`, `createToolingDb`, `createWorkersDb`) |
| `../../drizzle.config.mjs` | drizzle-kit config (`TURBOPANEL_DATABASE_URL`; introspect, push, generate, migrate, studio) |
| `../../scripts/bootstrap-dev-db.sh` | Dev DB bootstrap: `pnpm migrate` |
| `../../introspect.sh` | Pull DB → `schema.ts` |
| `../../sync.sh` | Push `schema.ts` → DB (Deno dev only; no migration files) |
| `../../scripts/db-connect.sh` | Resolves `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` for drizzle-kit scripts |
| `../../migrations/` | Versioned SQL migration files (committed); applied by `pnpm migrate`; tracked in `public.migration` |
| `../../drizzle/` | Ephemeral introspect scratch dir — `introspect.sh` deletes after adopt; never committed |

### Authz engine

Runtime authorization lives in `../../client/authz/` (pure TypeScript, safe for both Deno and Workers — no Deno-only imports). Permissions are static code constants in `catalog.ts`. The modules below evaluate access at request time against `grant`.

| File | Purpose |
|---|---|
| `../../client/authz/catalog.ts` | Static `PERMISSIONS`, `ENTITY_TYPES`, `SUBJECT_TYPES`, `isPermissionKey`, `isEntityType`, `isSubjectType`, `getPermissionCatalog` — no DB access |
| `../../client/authz/service.ts` | `isPlatformAdmin`, `isSuperAdmin`, `canManageOrganization`, `canOwnOrganization`, `canManageTeam`, `canOwnTeam`, `canInviteToOrganization`, `canInviteToTeam`, `assertNotLastOrgOwner` — higher-level org/team management checks built on `can()` |
| `../../client/authz/evaluator.ts` | `getSubjects`, `can`, `assertCan`, `listVisible`, `ForbiddenError` — org-level grant checks via domain-FK ancestry; superadmin and admin bypass in SQL |
| `../../client/authz/http.ts` | `assertCanOr403` Hono helper (503 / 401 / 403 short-circuit, `null` to continue) |

`can()` resolves org-level access in a **single CTE query** (`subjectset` → `ancestry` → org grant `hits`) — one round-trip. Users with `organization:own` or `organization:manage` on an org may access any entity in that org. A platform-admin bypass (`EXISTS … WHERE role IN ('superadmin', 'admin')`) is OR'd into the final result. Superadmin-only platform operations (e.g. developer reset-dev) remain gated separately by `user.role === 'superadmin'`. `listVisible()` returns all leaf ids in the org when the user has org-level access — **never rely on client-side filtering** for visibility.

**Install (Deno):** `completeInstanceInstall` inserts exactly one `organization:own` grant on the org and one `team:own` grant on the default team for the superadmin user.

**Completed:** Resource ancestry is computed directly from real domain tables (`organization → workspace → environment → project → service/hosting`, `organization → server`); the generic `resource` shadow table has been dropped.

## Connection (self-hosted dev)

Self-hosted instance boot and all database tooling require **`TURBOPANEL_DATABASE_URL`**. Unix socket connections use the libpq-style `?host=` query param (e.g. `postgresql://user:pass@/turbopanel?host=/var/run/turbopanel/postgres`). Postgres in Docker always publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure (`postgres_expose_port`) is optional and unused by the instance. See repo root `AGENTS.md` for env var details. Do not embed credentials here.

## Sanity check

```bash
docker exec turbopaneldb psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone does not require a restart.
