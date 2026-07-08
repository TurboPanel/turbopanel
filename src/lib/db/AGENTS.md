# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`, run `pnpm drizzle-kit generate --name <summary>` to create SQL files (always pass `--name` — see below). Apply pending migrations with `TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command. Applied migration versions are recorded in **`public.migration`** (configured in `drizzle.config.mjs`).

The co-located dev server has live data — treat every database change as production-adjacent.

## Schema sync directions

> **Fresh database:** co-located dev converge runs `./scripts/bootstrap-dev-db.sh` via Ansible (`pnpm migrate`). Manual bootstrap: `./scripts/bootstrap-dev-db.sh` from the instance repo root.

| Direction | You changed | Command | drizzle-kit |
|---|---|---|---|
| **Pull** (DB → code) | Live Postgres (Studio / SQL) | `./introspect.sh` | `introspect` |
| **Push** (code → DB, Deno dev only) | `schema.ts` | `./sync.sh` | `push` |
| **Generate migration** | `schema.ts` | `pnpm drizzle-kit generate --name <summary>` | `generate` |
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
2. Run `pnpm drizzle-kit generate --name <short_snake_case_summary>` — writes SQL under `migrations/` (e.g. `0002_add_command_table.sql`). **Always pass `--name`**; bare `generate` picks random names like `tan_silver_centurion` that are useless in review.
3. Commit the new migration files (developer only — after reviewing SQL).
4. Apply: `TURBOPANEL_DATABASE_URL=… pnpm migrate` (local or CI; **developer only**). Workers deploy runs `pnpm migrate` automatically.

Applied versions are tracked in **`public.migration`** (`drizzle.config.ts` sets `migrations: { table: 'migration', schema: 'public' }`).

### Drizzle Studio (dev UI)

- **Test connection** — `GET /api/developer/v1/database/status`
- **Reset dev instance** — `POST /api/developer/v1/system/reset-dev` (superadmin session only): `DROP SCHEMA public CASCADE`, `drizzle-kit migrate`, restart instance. UI: Database section → **Reset Dev Instance**.
- **Studio** — `POST /api/developer/v1/database/studio` starts `drizzle-kit studio` on **127.0.0.1:4983** (HTTP API). Open **`https://local.drizzle.studio?host=localhost&port=4983`** (hosted UI). Safari/Brave may block localhost — see [Drizzle docs](https://orm.drizzle.team/docs/drizzle-kit-studio#safari-and-brave-support).
- Studio applies DDL **directly** to the DB — follow with `./introspect.sh` to pull into code.

## Current policy (what not to run)

- Use `pnpm drizzle-kit generate --name …` + `pnpm migrate` for Workers-bound schema changes; `./sync.sh` (`push`) remains for Deno dev convenience only.
- **No ad-hoc push** — use `./sync.sh` only (after editing `schema.ts`), not raw `drizzle-kit push` in one-off commands.
- **No production DDL** from agents without explicit approval.

### Agent policy: generate yes, apply/commit no

Agents **may** edit `schema.ts` and run **`pnpm drizzle-kit generate --name …`** when a task needs versioned SQL — but **must not apply migrations or commit them**. Apply and commit stay with the developer so they can review the SQL before it hits git or the local dev database.

**Generate with a meaningful `--name`.** Drizzle assigns random tags when `--name` is omitted (e.g. `0001_tan_silver_centurion`). Always pass a short snake_case summary of the change:

```bash
pnpm drizzle-kit generate --name add_command_table
pnpm drizzle-kit generate --name drop_member_role_columns
pnpm drizzle-kit generate --name server_license_fk_restrict
```

Pick a name that answers “what is this migration doing?” — table/column added or dropped, constraint changed, index added. One logical change per migration when possible.

Do **not** run (or offer to run):

- `pnpm migrate` / `drizzle-kit migrate`
- `./sync.sh` / `drizzle-kit push`
- `./introspect.sh` / `drizzle-kit introspect`
- `./scripts/bootstrap-dev-db.sh`
- Raw DDL against Postgres (Studio, `psql`, etc.)
- Bare `pnpm drizzle-kit generate` without `--name`

After generating, tell the developer to **review** the new SQL under `migrations/`, then **apply locally** (`TURBOPANEL_DATABASE_URL=… pnpm migrate`) and **commit** when satisfied. Do **not** commit files under `migrations/` unless the developer explicitly asks.

Destructive changes (drop column/table, type narrowing) can lose dev rows. `sync.sh` prompts via `--strict`; `--force` skips those guardrails.

## Schema (ported from old trunk `apps/api`)

`schema.ts` mirrors the old monorepo database layout (Better Auth–compatible tables, no auth runtime yet). Grouped by concern:

| Group | Tables |
|---|---|
| **Identity** | `user`, `account`, `session`, `verification`, `passkey`, `2fa` |
| **Organizations** | `organization`, `member`, `team`, `teammate`, `invitation` (no `organization_id`; `team_id NOT NULL`), `license` |
| **Resource tree** | `workspace`, `project`, `environment`, `service`, `hosting`, `network`, `managed`, `variable` |
| **Authorization** | `grant` |
| **Config** | `setting` (`value` is `jsonb`) |
| **Runtime** | `server`, `command` |

> The physical Postgres table is **`workspace`** (`project.workspace_id` → `workspace.id`). The Drizzle export is `workspace`.

### Resource hierarchy

Canonical order (org scope is derived via joins — not stored on child rows):

```
organization → workspace → project → environment → service → hosting
organization → workspace → project → managed (1:1)
organization → workspace → project → environment → variable (1:N, env-scoped)
organization → workspace → variable (1:N)
organization → project → variable (1:N)
organization → workspace → project → environment → service → variable (1:N)
organization → server → network
organization → server → variable (1:N, server-scoped; excluded from inheritance chain)
```

| Entity | Parent FK | Notes |
|---|---|---|
| `workspace` | `organization_id` | Root of the resource tree |
| `project` | `workspace_id` | Docker-compose equivalent; env-specific vars live on environments. **`metadata`**: `type` (`"managed"` \| `"template"` \| null), `managed_id`. **`options.compose`**: base Docker Compose JSON. |
| `environment` | `project_id` | Staging/production/etc. within a project. **`metadata`**: environment-specific metadata (extensible JSONB). **`options.compose`**: per-environment Docker Compose overlay JSON merged onto the project base. |
| `service` | `environment_id` | Deployable unit within an environment |
| `hosting` | `service_id NOT NULL` | Org is always derived via the service chain |
| `network` | `server_id NOT NULL` | Linked to a server; org derived via server. Cascade delete. |
| `managed` | `project_id NOT NULL` (unique) | Linking table; project is source of truth for timestamps; `ON DELETE CASCADE`. **`metadata`**: kebab-case catalog `code`, etc. |
| `variable` | exactly one of `organization_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `server_id` (all nullable FKs; CHECK enforces one parent) | Config vars/secrets at any resource scope; `is_secret` flag; secret `value` is a sealed envelope; partial unique indexes on `(key, <parent_fk>)` per scope; `ON DELETE CASCADE`. Key must match `^[A-Za-z_][A-Za-z0-9_]*$`. **Inheritance order** (runtime resolution, excludes server-scoped): `service` → `environment` → `project` → `workspace` → `organization` (lower scope wins). **Server-scoped** variables are fetched separately and do not participate in the inheritance chain. |

Authorization ancestry and `listVisible()` resolve organization through this chain in SQL (`evaluator.ts`, `create-access-grant.ts`). **`variable`** and **`managed`** are in `RESOURCE_KINDS`, `GRANT_ENTITY_TYPES`, and `ENTITY_TYPES` (`catalog.ts`); `resolveEntityById()` and `can()` resolve their org via parent joins (same paths as `create-access-grant.ts`). **`GET /access/check`** accepts any resolvable entity UUID (including `variable` and `managed`). **`GET /access/resource-id`** accepts only `organization` and `team` kinds (grant-management UI). Access grants still target org/team entities only.

> Permissions are **static code constants** defined in `../../client/authz/catalog.ts` (`PERMISSIONS`, `ENTITY_TYPES`, `SUBJECT_TYPES`) — not DB rows. There are no `role`, `permission`, or `permit` tables. The Drizzle table export is **`grant`** (not `accessGrant`).

Drizzle relations are defined for future Better Auth adapter use. `IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup. `setting.value` is `jsonb`. The `SYSTEM_EMAIL` key stores all email settings as a single JSON object (self-hosted mode only; env vars take precedence and leave this table empty).

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
| `GET` | `/api/client/v1/environments` | org owner/manager (optional `?projectId=`); returns `metadata` and `options` |
| `GET` | `/api/client/v1/environments/{id}` | org owner/manager; returns `metadata` and `options` |
| `POST` | `/api/client/v1/environments` | org owner/manager on parent project; optional `options` (plain object, e.g. `options.compose` overlay) |
| `PATCH` | `/api/client/v1/environments/{id}` | org owner/manager; optional `options` patch |
| `DELETE` | `/api/client/v1/environments/{id}` | org owner/manager |
| `GET` | `/api/client/v1/variables` | org owner/manager (optional `?environmentId=`) |
| `GET` | `/api/client/v1/variables/{id}` | org owner/manager |
| `POST` | `/api/client/v1/variables` | org owner/manager on parent environment; `isSecret=true` seals value via `encryptSecret`; sealed values are never returned |
| `PATCH` | `/api/client/v1/variables/{id}` | org owner/manager; re-seals on secret value update |
| `DELETE` | `/api/client/v1/variables/{id}` | org owner/manager |
| `GET` | `/api/client/v1/projects` | org owner/manager (optional `?workspaceId=`); returns `metadata` and `options` |
| `GET` | `/api/client/v1/projects/{id}` | org owner/manager; returns `metadata` and `options` |
| `POST` | `/api/client/v1/projects` | org owner/manager on parent workspace; optional `type` (`blank` \| `template` \| `managed`, default blank) and `code` (required for template/managed — from code-bundled catalog); managed creation writes a `managed` row, sets `project.metadata.managed_id`, scaffolds environments/variables, and seals default secret variables via `encryptSecret` |
| `GET` | `/api/client/v1/project-catalog` | org owner/manager (session required); UI-safe catalog summaries (`code`, `kind`, `displayName`, `description`) — no compose or secret defaults |
| `PATCH` | `/api/client/v1/projects/{id}` | org owner/manager; returns `metadata` (read-only via PATCH) and accepts patchable `options` (e.g. `options.compose`) |
| `DELETE` | `/api/client/v1/projects/{id}` | org owner/manager |
| `GET` | `/api/client/v1/services` | org owner/manager (optional `?environmentId=`) |
| `GET` | `/api/client/v1/services/{id}` | org owner/manager |
| `POST` | `/api/client/v1/services` | org owner/manager on parent environment |
| `PATCH` | `/api/client/v1/services/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/services/{id}` | org owner/manager |
| `GET` | `/api/client/v1/hostings` | org owner/manager (optional `?serviceId=`) |
| `GET` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `POST` | `/api/client/v1/hostings` | org owner/manager; `serviceId` required |
| `PATCH` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `GET` | `/api/client/v1/networks` | org manager (`organization:manage`; requires `?serverId=`) |
| `POST` | `/api/client/v1/networks` | org manager; body `{ serverId }` |
| `DELETE` | `/api/client/v1/networks/{id}` | org manager |

Implemented in `src/client/*/routes.ts`, registered from `registerClientRoutes`.

`GET /api/client/v1/servers` uses `listVisible()` for server visibility (not raw org membership). License endpoints (`GET`/`POST` `/licenses`, `DELETE` `/licenses/{id}`) require org ownership (`organization:own`).

### Catalog

Permissions are **static code constants** in `../../client/authz/catalog.ts` — there is nothing to seed. Four permissions exist: `organization:own`, `organization:manage`, `team:own`, and `team:manage`. Never edit permissions in Studio — they do not exist as DB rows. **`ENTITY_TYPES`** and **`SUBJECT_TYPES`** are also exported from `catalog.ts` for route/body validation (`isEntityType`, `isSubjectType`).

### `license` table

Organization-scoped API tokens for server registration. Each row belongs to an `organization` (`organization_id`, cascade delete). `display_name` is optional. `token` stores a PBKDF2-SHA256 hash in the same `$pbkdf2-sha256$…` format as `account.password`. Soft-delete via `revoked_at` — revoked licenses remain in the table for audit; application code should treat non-null `revoked_at` as inactive.

### `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon connect the instance resolves `serverId` (reuse by persisted id, `metadata.machineId`, or `metadata.hostname`), tracks presence in the **Daemon Cell**, and returns `serverId` in enrollment responses. The daemon persists it at `/opt/turbopanel/platform/daemon/state/server.id` (writable by the `turbopanel` user). Server rows are hard-deleted — there is no soft-delete column. `display_name` and `organization_id` match the old trunk shape; daemon registration stores `machineId` / `hostname` in `metadata` (see `server-metadata.ts`). `license_id` (nullable FK → `license.id`, `ON DELETE RESTRICT`) records which license token the server registered with. `organization_id` FK uses `ON DELETE RESTRICT` — Postgres blocks deleting an organization or license that still has referencing server rows. Deleting a server cascades to its `network` rows (`network.server_id` → `server.id`, `ON DELETE CASCADE`).

**Cell metadata fields** (stored in `server.metadata` and/or `server.options` JSONB — no migration required):

| Field | Column | Purpose |
|---|---|---|
| `cellLocationHint` | `options` (preferred) or `metadata` | Cloudflare Durable Object `locationHint` chosen at enrollment time. |

`options` takes precedence over `metadata` when both define a value (see `src/daemon/cell/location.ts`).

**Daemon identity (`server.daemon` jsonb):** the `server` row stores the one active daemon Ed25519 identity and sparse presence summary as structured jsonb. Shape: `{ key, projection?, status? }`. No separate `serverkey` table exists for MVP.

```json
{
  "key": {
    "id": "uuid",
    "algorithm": "Ed25519",
    "publicJwk": {},
    "fingerprint": "sha256-public-jwk-fingerprint",
    "createdAt": "iso timestamp",
    "revokedAt": "iso timestamp or null"
  },
  "projection": {
    "hostname": "host.example",
    "machineId": "machine-id",
    "remoteAddress": "203.0.113.1",
    "keyId": "uuid",
    "agent": { "commit": "abc", "buildId": "build-1", "builtAt": "iso", "channel": "trunk" }
  },
  "status": {
    "connected": true,
    "daemonStatus": "online",
    "lastSeenAt": "iso timestamp",
    "connectedAt": "iso timestamp",
    "disconnectedAt": null,
    "statusChangedAt": "iso timestamp"
  }
}
```

| Field | Purpose |
|---|---|
| `key.id` | Logical key identifier returned to the daemon as `keyId` on enrollment |
| `key.publicJwk` | Raw Ed25519 public JWK `{ crv, kty, x }` |
| `key.fingerprint` | SHA-256 hex over the canonical public JWK — duplicate-checked at enrollment (no DB unique constraint for MVP) |
| `key.revokedAt` | Non-null blocks new JWT issuance; existing JWTs remain valid until their 15-minute expiry |

**`server.daemon.projection` (sparse identity summary):** `hostname`, `machineId`, `remoteAddress`, `keyId`, optional `agent` (`commit`/`buildId`/`builtAt`/`channel`). Updated on identity changes and agent build identity changes (via `control-plane-monitor.ts` outside the DO hot path on Workers). No monitor health counts or resource graph are stored.

**`server.daemon.status` (liveness projection):** `connected`, `daemonStatus` (`online` \| `offline` \| `unknown`), `lastSeenAt`, `connectedAt`, `disconnectedAt`, `statusChangedAt`. Updated on online/offline transitions and debounced heartbeats (60 s). There are no dedicated Postgres columns for these fields — reads use jsonb path queries (e.g. `daemon->'status'->>'connected'`).

**Status read model:** `server.daemon.status` is the Postgres-projected liveness read model. UI and API status reads go through `src/daemon/cell/server-status.ts` (formerly `fleet-presence.ts`). Do not read `server.daemon.status` directly from routes — use `resolveFleetPresence` / `loadServerStatusRecords`. The `/servers/status` and `/servers/:id/status` endpoints serve this jsonb read model; reads are Postgres-only and do not call the DO/Redis cell; both runtimes share the same response shape. There are **no** dedicated status columns — jsonb path queries only. See the instance `AGENTS.md` Daemon Cell section for cost/parity rules.

**Status read model:** `server.daemon.status` is the Postgres-projected liveness read model. UI and API status reads go through `src/daemon/cell/server-status.ts` (formerly `fleet-presence.ts`). Do not read `server.daemon.status` directly from routes — use `resolveFleetPresence` / `loadServerStatusRecords`. The `/servers/status` and `/servers/:id/status` endpoints serve this jsonb read model; reads are Postgres-only and do not call the DO/Redis cell; both runtimes share the same response shape. There are **no** dedicated status columns — jsonb path queries only. See the instance `AGENTS.md` Daemon Cell section for cost/parity rules.

**Key use tracking:** `server.daemon.key.lastUsedAt` is updated on JWT session issuance via `touchDaemonKeyLastUsed()` (Postgres only — no cell wake). `lastInboundAt` remains cell-only (Redis/DO snapshot), coalesced on connect and inbound WS activity.

The `key` field is always preserved on write (read-modify-write via `parseServerDaemonState` + merge).

Re-enrollment with a valid license token replaces `server.daemon` atomically. No historical key rows are kept for MVP. To revoke daemon auth, set `server.daemon.key.revokedAt` (via `revokeDaemonKey` helper).

### `command` table

Canonical command/job history — source of truth for UI status and history. Do not read command history from the Daemon Cell — the cell holds only hot pending-request correlation state. The `command` table is the canonical record.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (uuidv7) | Primary key |
| `server_id` | uuid NOT NULL | FK → `server.id`, `ON DELETE CASCADE` (org derived from server) |
| `actor_entity_type` | text NOT NULL | Open set — e.g. `'user'`; no FK, polymorphic |
| `actor_entity_id` | uuid NOT NULL | ID of the acting entity; no FK |
| `metadata` | jsonb NOT NULL | Lifecycle blob — see fields below |
| `payload` | jsonb NOT NULL | Typed command input (small, bounded) |
| `result` | jsonb nullable | Typed command output (small, bounded) |

| Metadata key | Type | Notes |
|---|---|---|
| `name` | string | Command type (e.g. `daemon.ping`, `server.hostname.set`) |
| `status` | string | See status values |
| `error` | string \| null | Terminal error message |
| `attempts` | number | Dispatch retry count (default 0) |
| `createdAt` / `updatedAt` | ISO-UTC string | Row lifecycle; ISO-UTC sorts lexicographically so the jsonb expression index on `createdAt` orders chronologically |
| `queuedAt` | ISO-UTC \| null | Set when status → `queued` |
| `dispatchStartedAt` | ISO-UTC \| null | Set when status → `dispatching` |
| `sentAt` | ISO-UTC \| null | Set when status → `sent` |
| `ackedAt` | ISO-UTC \| null | Set when status → `acked` |
| `startedAt` | ISO-UTC \| null | Set when status → `running` |
| `finishedAt` | ISO-UTC \| null | Set when status → terminal |
| `expiresAt` | ISO-UTC \| null | Optional command TTL |

**JSONB usage:** `payload` stores typed command input; `result` stores typed command output. **Never store logs, streaming output, or large blobs in these columns.**

**Status values:**

| Status | Meaning |
|---|---|
| `queued` | Accepted by API; waiting for queue consumer |
| `dispatching` | Consumer picked up the job |
| `sent` | Enqueued to daemon cell outbox |
| `acked` | Daemon acknowledged receipt |
| `running` | Daemon executing |
| `succeeded` | Completed successfully (terminal) |
| `failed` | Completed with error (terminal) |
| `timed_out` | Expired without completion (terminal) |
| `cancelled` | Cancelled before completion (terminal) |

**Indexes:**
- `idx_command_server_id_created_at` — btree on `(server_id, (metadata->>'createdAt') DESC)` — backs `listServerCommands` ordering
- `idx_command_status` — btree on `((metadata->>'status'))` — supports status-filtered queries

Only FK is `server_id → server.id` (`ON DELETE CASCADE`). Organization is derived from the server — no `organization_id` column on `command`.

**Lifecycle timestamps:** All lifecycle timestamps and status live in the `metadata` jsonb blob. `transitionCommand` merges patches atomically via `metadata || patch::jsonb`. `serializeCommandRecord` in `command-records.ts` flattens the blob into the stable `CommandRecord` type for callers.

Server delete cascades to command rows (`ON DELETE CASCADE` on `server_id`).

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

**Completed:** Resource ancestry is computed directly from real domain tables (`organization → workspace → project → environment → service/hosting`, `organization → server`); the generic `resource` shadow table has been dropped. The `grant.allow` column (formerly `allowed`) stores whether a grant permits (`true`) or denies (`false`) the listed permission.

## Connection (self-hosted dev)

Self-hosted instance boot and all database tooling require **`TURBOPANEL_DATABASE_URL`**. Unix socket connections use the libpq-style `?host=` query param (e.g. `postgresql://user:pass@/turbopanel?host=/var/run/turbopanel/postgres`). Postgres in Docker always publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure (`postgres_expose_port`) is optional and unused by the instance. See repo root `AGENTS.md` for env var details. Do not embed credentials here.

## Sanity check

```bash
docker exec turbopaneldb psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone does not require a restart.
