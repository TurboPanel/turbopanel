# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`, run `pnpm drizzle-kit generate --name <summary>` to create SQL files (always pass `--name` — see below). Apply pending migrations with `TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command. Applied migration versions are recorded in **`public.migration`** (configured in `drizzle.config.mjs`).

**Current baseline: a single `0000_init.sql`.** TurboPanel has not shipped yet, so there is no live-upgrade constraint — schema changes are squashed back into that one init migration (delete and regenerate `migrations/0000_init.sql` + `migrations/meta/` rather than stacking `0001_*`, `0002_*`, … files) until the product ships and versioned incremental migrations become required for existing installs.

The co-located dev server has live data — treat every database change as production-adjacent.

**Server metrics is never stored in Postgres.** Host metrics live in Analytics Engine (Workers) or ClickHouse (Deno) only — see instance `AGENTS.md` (Server metrics). Do not add metrics tables or columns here; there are no per-minute Postgres projection writes for metrics.

## Schema sync directions

> **Fresh database:** versioned `pnpm migrate` is the only bootstrap path. Co-located
> dev converge runs `./scripts/bootstrap-dev-db.sh` via Ansible (`pnpm migrate`).
> Manual bootstrap: `./scripts/bootstrap-dev-db.sh` from the instance repo root.
> An unmigrated database is an operational failure (missing relations propagate);
> it must not be treated as install mode / `needsInstall`.

| Direction | You changed | Command | drizzle-kit |
|---|---|---|---|
| **Pull** (DB → code) | Live Postgres (Studio / SQL) | `dev/scripts/introspect.sh` | `introspect` |
| **Push** (code → DB, Deno dev only) | `schema.ts` | `dev/scripts/sync.sh` | `push` |
| **Generate migration** | `schema.ts` | `pnpm drizzle-kit generate --name <summary>` | `generate` |
| **Apply migration** (Workers deploy + manual) | pending SQL in `migrations/` | `TURBOPANEL_DATABASE_URL=… pnpm migrate` | `migrate` |

Pick one source of truth per change — do not edit both sides and blindly run both scripts.

### Pull: database → `schema.ts` (`dev/scripts/introspect.sh`)

Use when you designed in **Drizzle Studio** or applied DDL directly.

1. Change tables in Studio (`/developer/database` → **Start API & open studio**).
2. From the dev checkout, run `./scripts/introspect.sh` (resolves the instance repo via `TURBOPANEL_INSTANCE_REPO` / `$HOME/instance`).
3. Review `schema.ts` (style, dropped tables).

`dev/scripts/introspect.sh`: loads `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` → introspect → copy to `schema.ts` → delete ephemeral `drizzle/` output → `deno check`.

### Push: `schema.ts` → database (`dev/scripts/sync.sh`)

Use when you edited **`schema.ts` first** and need the live dev DB to catch up without committing migration files (Deno dev convenience only).

1. Edit `src/lib/db/schema.ts`.
2. From the dev checkout, run `./scripts/sync.sh`.
3. Confirm drizzle-kit prompts (`--strict` by default). Use `./scripts/sync.sh --force` only when you accept possible **data loss** on dev.

`dev/scripts/sync.sh`: `deno check` → `drizzle-kit push` (no SQL files committed). Flags: `--verbose`, `--force`.

Override connection for either script: `TURBOPANEL_DATABASE_URL=postgresql://… ./scripts/introspect.sh` or `./scripts/sync.sh` (from dev).

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
- Studio applies DDL **directly** to the DB — follow with `dev/scripts/introspect.sh` to pull into code.

## Current policy (what not to run)

- Use `pnpm drizzle-kit generate --name …` + `pnpm migrate` for Workers-bound schema changes; `dev/scripts/sync.sh` (`push`) remains for Deno dev convenience only.
- **No ad-hoc push** — use `dev/scripts/sync.sh` only (after editing `schema.ts`), not raw `drizzle-kit push` in one-off commands.
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
- `dev/scripts/sync.sh` / `drizzle-kit push`
- `dev/scripts/introspect.sh` / `drizzle-kit introspect`
- `./scripts/bootstrap-dev-db.sh`
- Raw DDL against Postgres (Studio, `psql`, etc.)
- Bare `pnpm drizzle-kit generate` without `--name`

After generating, tell the developer to **review** the new SQL under `migrations/`, then **apply locally** (`TURBOPANEL_DATABASE_URL=… pnpm migrate`) and **commit** when satisfied. Do **not** commit files under `migrations/` unless the developer explicitly asks.

Destructive changes (drop column/table, type narrowing) can lose dev rows. `dev/scripts/sync.sh` prompts via `--strict`; `--force` skips those guardrails.

## Schema (ported from old trunk `apps/api`)

`schema.ts` mirrors the old monorepo database layout (Better Auth–compatible tables, no auth runtime yet). Grouped by concern:

| Group | Tables |
|---|---|
| **Identity** | `user`, `account`, `session`, `verification`, `passkey`, `2fa` |
| **Organizations** | `organization`, `member`, `team`, `teammate`, `invitation` (no `organization_id`; `team_id NOT NULL`), `license`, `tls` |
| **Networking** | `datacenter`, `network` (no VPN kind), `ip` (incl. `scope='vpn'`), `vpn` (owns `cidr`), `peer` |
| **Resource tree** | `workspace`, `project`, `environment`, `service`, `hosting`, `container`, `managed`, `variable`, `principal`, `assignment` |
| **Authorization** | `grant` |
| **Config** | `setting` (`value` is `jsonb`) |
| **Runtime** | `server`, `command` |

> The physical Postgres table is **`workspace`** (`project.workspace_id` → `workspace.id`). The Drizzle export is `workspace`.

### Resource hierarchy

**Legacy resource tree** (workspace → project → … → hosting/container): organization scope is derived via parent FK joins — not stored on those child rows (except `workspace`, which roots the tree with `organization_id`).

**Org-owned networking tables** (`datacenter`, `network`, `ip`, `vpn`) persist **`organization_id` directly** on each row. Authz and domain logic for those entities should use that column (alongside optional `datacenter_id` / `server_id` / `network_id` / `vpn_id` links), not only join-derived ancestry from the compose tree. VPN overlay addresses are first-class `ip` rows (`scope = 'vpn'`, `vpn_id` set) — there is no redundant `network.kind = 'vpn'` layer.

Canonical order:

```
organization → workspace → project → environment → service → hosting
organization → workspace → project → environment → service → assignment ← principal (M:N)
organization → workspace → project → environment → service → container (1:N)
organization → workspace → project → environment → managed (1:1)
organization → workspace → project → environment → variable (1:N, env-scoped)
organization → workspace → variable (1:N)
organization → project → variable (1:N)
organization → workspace → project → environment → service → variable (1:N)
organization → workspace → project → environment → service → hosting → variable (1:N)
organization → datacenter → server
organization → datacenter → network
organization → server → network
organization → ip
organization → vpn → ip (overlay, scope='vpn')
organization → vpn → peer → endpoint_ip_id / tunnel_ip_id
organization → server → container
organization → server → variable (1:N, server-scoped; excluded from inheritance chain)
```

| Entity | Parent FK | Notes |
|---|---|---|
| `workspace` | `organization_id` | Root of the resource tree |
| `project` | `workspace_id` | Docker Compose / catalog project. **`metadata`**: `type` (`"docker-compose"` \| `"managed"` \| `"template"`), optional `code` (managed engine catalog code). **`options.compose`**: base **ComposeDocument** (versioned JSON with presentation for YAML comments/order) — see `src/lib/compose/`. **`options.containerNaming`**: `uuid` (default) \| `custom` — controls deploy container_name allocation. Project compose does **not** own server placement (sanitized on save). |
| `environment` | `project_id`; optional `server_id` → `server.id` (`ON DELETE RESTRICT`, `idx_environment_server_id`) | Staging/production/etc. within a project. **`server_id`** is the **single** whole-server placement pin (not compose / not `metadata.serverId`). **`options.compose`**: per-environment ComposeDocument overlay merged onto the project base at deploy — placement is stripped on save. |
| `service` | `environment_id` | Deployable unit within an environment. **`compose_service_name`** (`varchar(255) NOT NULL`) is the Compose service key — **derived only**, written by reconcile (`reconcileServicesFromCompose`), managed container allocation, and daemon-report container reconcile (`ensureServicesForReportedContainers`); never accepted from a client request/body. Unique (non-partial) `uniq_service_environment_compose_name` on `(environment_id, compose_service_name)`. `display_name` is separate and not unique. **`metadata`**: reserved for future non-indexed facts. **`options`**: reserved (future per-service placement). |
| `hosting` | `service_id NOT NULL` | Public routing for a service (Traefik + hosting Caddy). Optional **`tls_id`** → `tls.id` (`ON DELETE SET NULL`) pins an org certificate; null = basic self-signed (Caddy `tls internal`) at deploy — library certs must be pinned explicitly. Optional **`ip_id`** → `ip.id` (`ON DELETE SET NULL`) pins a managed ingress address. **`options`**: `{ hostnames[], pathPrefix?, targetPort? }`. **`metadata`**: deploy status fields. Org derived via service chain. |
| `tls` | `organization_id NOT NULL` | Org TLS certificate library (`upload` / `lets_encrypt` / `self_signed`). **`certificate_pem`**: public chain (nullable while LE pending). **`private_key_pem`**: sealed `enc` only — never returned on client GET. Dedicated columns: **`status`** (`text NOT NULL DEFAULT 'ready'`), **`not_after`** (`timestamptz(3)`), **`fingerprint_sha256`** (`text`); indexes `idx_tls_not_after` and partial unique `uniq_tls_organization_fingerprint_sha256` on `(organization_id, fingerprint_sha256) WHERE fingerprint_sha256 IS NOT NULL`. Residual **`metadata`**: `{ dnsNames, hasWildcard, notBefore, subject, issuer, acme? }` — client GET still assembles a full metadata DTO including status/notAfter/fingerprint. **`options`**: `{ prefer?, autoRenew?, requestedHostnames? }`. `ON DELETE CASCADE` from org; hosting pins clear on cert delete. |
| `container` | `service_id NOT NULL` + `server_id NOT NULL` | Pins a deployed Docker container to a service and records which server hosts it. Dedicated columns: **`container_id`** (nullable — null between pre-allocation and the daemon's post-`compose up` report), **`container_name`**, **`status`** (`text NOT NULL DEFAULT 'pending'`), **`role`** (`text NOT NULL DEFAULT 'app'`, CHECK `container_role_check` / `role IN ('app', 'ingress')` — `'app'` for workload replicas; `'ingress'` for the service's dedicated Traefik row), **`compose_service_name`**, **`ordinal`** (`integer NOT NULL DEFAULT 1`, CHECK `container_ordinal_positive_check` / `ordinal >= 1` — 1-based instance index within the service; managed engines always carry an ordinal). Indexes: `idx_container_status`, partial unique `uniq_container_server_container_id` on `(server_id, container_id) WHERE container_id IS NOT NULL`, and unique `uniq_container_service_role_ordinal` on `(service_id, role, ordinal)` (idempotent per-`(service, role, ordinal)` allocation — placement changes re-home `server_id` on the same row). **`role='ingress'`** rows always use `ordinal = 1` and are named `<service.id>-ingress` via `ingressContainerNameFromService`; a service may hold N app replicas plus exactly one ingress row. **Pre-allocation:** deploy-prepare upserts pending rows (`container_id` null) on `uniq_container_service_role_ordinal` for uuid-named (or explicitly named) services before compose up; uuid mode sets `container_name` from the **service** id (`<service.id>` / `<service.id>-<ordinal>`), not the container row id; explicit `service.options.container.name` wins in every project naming mode (with `-<ordinal>` when `instances > 1`) and is the same name written into compose + platform vars. Stale pending rows outside the current allocation set are pruned during prepare (all servers for the service set). **Managed engines** pre-allocate one ordinal-1 `role='app'` `container` row pinned to `managed.server_id` (with an explicit `service` row for the engine's compose service name) via `ensureManagedContainerAllocation` during `buildManagedApplyPayload`; when exposure is enabled they also pre-allocate a second `role='ingress'` ordinal-1 row **on that same engine `service.id`** via `ensureManagedIngressContainerAllocation` (`composeServiceName` = `<engine>-ingress`, `containerName` = `<service.id>-ingress`) — no separate ingress `service` row is created; the hard-delete path on `DELETE …/managed` clears pending null-id rows so a never-applied managed project stays deletable. Pre-existing `<engine>-ingress` `service` rows / `<ingressServiceId>-1` containers from older applies are left alone (no migration). **Reconcile** (`reconcileEnvironmentContainers`): identity-based upsert — match by `container_name` first, else compose service (+ strip trailing `-<digits>` for multi-instance clones) and `(service, role, ordinal)` (not just `(service, ordinal)`); update matched rows; insert only unmatched reported containers (custom naming), stamping `role` from the report (`role` field or `-ingress` compose-name fallback); `ensureServicesForReportedContainers` skips any reported container resolved as `role='ingress'` (no `<engine>-ingress` service row is minted); keep unmatched pending null-id **app** rows only when their ordinal is still within the service's current `options.instances` (stale ordinals are deleted) — **ingress** pending rows are always expected (not bounded by `options.instances`); **empty authoritative report** (stop/destroy) resets to `status='exited'` / `container_id=null` instead of deleting so identity survives stop→start. **`metadata`** remains for future non-indexed facts. Both FKs `ON DELETE RESTRICT` (deleting a service or server with existing containers is blocked, mirroring `hosting`/`network`). |
| `principal` | optional `project_id` (project principals) + optional `managed_id` (managed-engine users) + assignments | Behind-the-scenes account identity for hosting/database-user flows, **project principals** (`GET/POST/DELETE /api/client/v1/projects/:projectId/principals`), and **managed-engine users** (`managed_id` FK → `managed`, `ON DELETE CASCADE`). **`kind`** CHECK `('system', 'database')` — `database` covers every managed engine user; **`provider`** CHECK `('pam', 'postgres', 'mysql', 'redis', 'clickhouse')`; **`username`** `varchar(255)` CHECK `^[A-Za-z_][A-Za-z0-9_-]*$` — the Linux username stays operator-chosen (not derived from the UUID). **`password`** is nullable + write-only; stored as a sealed `enc` envelope at rest (show-once plaintext only at create/rotate). **`metadata`** holds `uid`/`gid`/`home` — UID/GID come **only** from the instance-wide **`principal_uid_seq`** (starts at **10001**, `nextval`; `organization.options.nextPrincipalUid` is removed). **`metadata.home`** is `/srv/users/<principal_id>` (canonical value from `naming.ts`; metadata is a display mirror — deploy always re-derives home). **`options.shell`** (default `/usr/sbin/nologin`) is persisted and applied by the daemon via `useradd -s` / `usermod -s`. Daemon `ensureSystemPrincipals` runs during deploy when `principalMaterial[]` is present. **Traditional-web:** a sole assignment to a traditional-web service pins `traditionalWebSites[].principal` so the site tree (and Apache php-fpm workers) run as that Linux user. **No global unique on `username`**. |
| `assignment` | `principal_id NOT NULL` + `service_id NOT NULL` | Join edge for the principal↔service many-to-many. `principal_id` FK `ON DELETE CASCADE` (deleting a principal removes its edges); `service_id` FK `ON DELETE RESTRICT` (a service still referenced by principals cannot be deleted, mirroring `container`). Unique `(principal_id, service_id)`; btree indexes on each FK. Traditional-web ownership requires **at most one** principal per service (deploy-prepare rejects ambiguous pins). |
| `network` | `organization_id NOT NULL`; per-kind scope FKs | Org-owned network registry (not VPN overlays). **`kind`** CHECK `('datacenter', 'server', 'docker')` — **`vpn` is not a network kind**. Tightened **`network_single_scope_check`**: `datacenter` requires `datacenter_id` (no `server_id`); `server` requires `server_id` (no `datacenter_id`); `docker` requires neither. API returns **400** `network_scope_required` when the required FK is missing and **400** `network_single_scope_conflict` when both FKs are set (or when docker carries either). Nullable **`cidr`**. **`kind: docker`** rows register long-lived host Docker networks for compose `networks.*.external` — API requires **`options.dockerNetworkName`** (create/patch → **400** `docker_network_name_required` when missing/invalid). Project-internal compose networks are **not** stored here. `server_id` and `datacenter_id` FKs `ON DELETE RESTRICT` — deleting a datacenter is blocked while scoped networks remain (API returns **409** `datacenter_has_networks`). |
| `datacenter` | `organization_id NOT NULL` | Physical site grouping servers on a shared private network; optional on `server`. **`options`** may mirror org timezone enforcement (`defaultServerTimezone`, `enforceServerTimezone`) for a future resolver. `ON DELETE CASCADE` from org; `server.datacenter_id` and `ip.datacenter_id` SET NULL on datacenter delete; datacenter-scoped `network` rows RESTRICT delete. |
| `ip` | `organization_id NOT NULL`; optional `datacenter_id`, `network_id`, `server_id`, `vpn_id` | Canonical managed addresses. **`address`** is native Postgres **`inet`** (see `net-types.ts`). **`version` is not stored** — API responses derive it via `parseIpVersion(address)` and reject client-supplied `version`. **`scope`** CHECK `('public', 'datacenter', 'loopback', 'vpn')` with **`ip_vpn_scope_check`**: `scope='vpn'` requires `vpn_id`; non-VPN scopes omit `vpn_id`. **`allocation`** CHECK `('dedicated', 'shared')`. Uniqueness is split: partial **`uniq_ip_org_address`** on `(organization_id, address) WHERE vpn_id IS NULL`, and **`uniq_ip_vpn_address`** on `(vpn_id, address) WHERE vpn_id IS NOT NULL` (same RFC1918 address may exist on different VPNs). **`ip.datacenter_id` is free-pool-only** (`ip_datacenter_free_pool_check`: when set, `server_id` / `vpn_id` / `network_id` must be null). API enforces `serverId`/`datacenterId` mutual exclusion. **A server's private datacenter address is `ip WHERE server_id = … AND scope = 'datacenter'`** — there is no `server.datacenter_private_ip` column. Overlay tunnel addresses are auto-allocated as `ip(scope='vpn', allocation='dedicated', vpn_id=…)` on peer create (and released on peer delete when unreferenced). `server_id` FK RESTRICT; `vpn_id` FK CASCADE. |
| `vpn` | `organization_id NOT NULL`; **`cidr` NOT NULL** | Org WireGuard mesh. Owns its overlay subnet directly as **`cidr`** (no linked `network` row). **`POST /vpns`** requires **`cidr`**; **`PATCH /vpns/:id`** may update `cidr` and returns **409** `vpn_cidr_in_use` when another VPN in the org already uses that CIDR. |
| `peer` | `vpn_id NOT NULL`, `server_id NOT NULL`; optional `endpoint_ip_id`, `tunnel_ip_id` | One server in a VPN mesh. **`endpoint_ip_id`** → public `ip` used as the WireGuard endpoint; **`tunnel_ip_id`** → overlay `ip(scope='vpn')` for this peer (must belong to the same VPN). **`role`** CHECK `('gateway', 'member')` (default `member`) — gateway advertises its datacenter CIDR; member is host-route only. **WireGuard private keys are never stored in Postgres** — only `public_key` is persisted. **`preshared_key`** is a write-only sealed `enc`, never returned on GET. Unique `(vpn_id, server_id)`, `(vpn_id, public_key)`, and partial **`uniq_peer_vpn_tunnel_ip`** on `(vpn_id, tunnel_ip_id) WHERE tunnel_ip_id IS NOT NULL`. |
| `managed` | `environment_id` NOT NULL (unique); optional `server_id` | Environment-scoped managed DB/cache: `display_name`; dedicated **`engine`** / **`status`** columns (index `idx_managed_engine`); **`status`** CHECK `NULL OR IN ('provisioning','applying','ready','stopped','failed')`. Optional **`server_id`** FK → `server` `ON DELETE RESTRICT` pins the managed service host (mirrors `environment.server_id` at create). Residual **`metadata`**: `rootPrincipalId` / `host` / `port` / optional `error`. **`options`**: `{ settings, databases[] }` from the engine spec. Root/user creds via **`principal.managed_id`** sealed as `enc`. Apply-prepare pre-allocates a single `service` row for the engine plus an ordinal-1 `role='app'` `container` (named `<service.id>-1`) pinned to this `server_id`, and when exposure is enabled a **second `container` row on that same `service.id`** (`role='ingress'`, `ordinal=1`, named `<service.id>-ingress`, `composeServiceName` = `<engine>-ingress`) — no separate ingress `service` / `composeServiceName` row is ever created. Pre-existing `<engine>-ingress` `service` rows and their `<ingressServiceId>-1` `container` rows already in a database are left alone — no migration/cleanup sweep; only new `managed.apply` calls produce the new shape. Hard-delete (`stopped`/`failed`/`provisioning`/no server) and create-compensation (enqueue failure / incomplete provisioning cleanup) also clear pending null-id container rows for the environment (covering both engine `app` and `ingress` rows on the engine service). Client API lives in `src/client/managed/` (`GET/POST/PATCH/DELETE …/environments/{id}/managed`, apply/lifecycle/users/databases/status/logs, plus `GET …/organizations/{id}/managed`). Engine specs: `src/lib/managed/`. |
| `variable` | exactly one of `organization_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `hosting_id`, `server_id` (all nullable FKs; CHECK enforces one parent) | Config vars/secrets at any resource scope; `is_secret` flag; **`is_literal`**, **`for_build`**, **`for_runtime`** (default runtime-only) control deploy injection; secret `value` is a sealed envelope; partial unique indexes on `(key, <parent_fk>)` per scope; `ON DELETE CASCADE`. Key must match `^[A-Za-z_][A-Za-z0-9_]*$`. **Inheritance** (runtime resolution; lower scope wins): service resolution uses `service` → `environment` → `project` → `workspace` → `organization`; hosting resolution uses `hosting` → `service` → `environment` → `project` → `workspace` → `organization`. **Deploy compose injection** additionally merges hosting-scoped vars for that service via `mergeHostingVariablesForService` (sorted hosting ids; later wins on key conflicts) so hostname overrides reach containers even though Docker applies env at the service level. **Server-scoped** variables are fetched separately and do not participate in either inheritance chain. |
| `storage` | `organization_id NOT NULL` + exactly one of `project_id`, `environment_id`, `service_id` (CHECK) | Platform storage registry (`docker_volume`, `bind_mount`, `file`, `directory`); `server_id` required for materialization; daemon writes under `<stateDir>/storage/<orgId>/<storageId>/`; included in deploy payload as `storageMaterial[]` with instance-supplied **`volumeName`**. **Naming:** new `docker_volume` rows stamp **`metadata.dockerVolumeName`** to the storage UUID (operator create + compose auto-register); compose-declared volumes also store **`metadata.composeVolumeKey`** (idempotency key with `environment_id`; partial unique `uniq_storage_environment_compose_volume_key`). Compose auto-register reuses untagged legacy/manual `docker_volume` rows that match by `name`, stamping `composeVolumeKey` without overwriting a pinned `dockerVolumeName`. Unstamped legacy rows keep the daemon-era `tp-<org8>-<name>` name via `legacyNamespacedDockerVolumeName` / `resolveDockerVolumeName` — never used for new rows. A principal-owned `bind_mount` with no explicit `source_path` derives `/srv/users/<principal_id>/volumes/<storage_id>` at deploy-prepare — no new `storage.kind` value. The storage API exposes read-only **`resolvedSourcePath`** (explicit `sourcePath`, else the derived principal volume path, else null) — never persisted. |

### Resource naming contract

Generated names and principal paths live in **`src/lib/naming.ts`** — the single source of truth for container names (`containerNameFromService` / `managedContainerName` / `ingressContainerNameFromService` — all keyed off the **service** UUID, not the container row), Docker volume names (`dockerVolumeNameFromStorageId` / `resolveDockerVolumeName` / legacy-only `legacyNamespacedDockerVolumeName`), principal home/SSH/volume paths under `/srv/users`, the reserved-only DNS shape (`serviceDnsName`), and the reserved `TURBOPANEL_*` deploy variable keys (`RESERVED_DEPLOY_VARIABLE_KEYS`). Option parsers (`project-options.ts` `containerNaming`, `service-options.ts` `instances`, `principal-options.ts` `shell`) feed those helpers; deploy-prepare owns allocation, multi-instance expansion, compose-volume registration, and compose emission via `apply-service-options.ts`.

Native Postgres **`inet`** and **`cidr`** columns are defined in `net-types.ts` via Drizzle `customType` — no regex CHECK constraints belong on those types.

**Project cascade delete** (`deleteProjectCascade` in `project-delete.ts`): after all containers under the project are non-active (`exited`/`dead`/`removing`), `DELETE /projects/:id` deletes in order `container` → `hosting` → `service` → `environment` → `project` (variables/`managed` cascade via FK). Active containers return **409** `project_has_running_services` — stop stacks first via `environment.stop`. Restrictive FKs stay in place as a safety net.

Authorization ancestry and `listVisible()` resolve organization through this chain in SQL (`evaluator.ts`, `create-access-grant.ts`). **`variable`** and **`managed`** are in `RESOURCE_KINDS`, `GRANT_ENTITY_TYPES`, and `ENTITY_TYPES` (`catalog.ts`); `resolveEntityById()` and `can()` resolve their org via parent joins (same paths as `create-access-grant.ts`) — **`managed`** ancestry resolves via `environment → project → workspace`. **`principal`** is in `RESOURCE_KINDS` and `ENTITY_TYPES` but **not** `GRANT_ENTITY_TYPES` — org is derived via `assignment → service → environment → project → workspace` (returns null when unassigned); `assignment` itself is not a grantable authz entity. **`GET /access/check`** accepts any resolvable entity UUID (including `variable` and `managed`). **`GET /access/resource-id`** accepts only `organization` and `team` kinds (grant-management UI). Access grants still target org/team entities only.

> Permissions are **static code constants** defined in `../../client/authz/catalog.ts` (`PERMISSIONS`, `ENTITY_TYPES`, `SUBJECT_TYPES`) — not DB rows. There are no `role`, `permission`, or `permit` tables. The Drizzle table export is **`grant`** (not `accessGrant`).

Drizzle relations are defined for future Better Auth adapter use. `IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup. `setting.value` is `jsonb`. The `SYSTEM_EMAIL` key stores all email settings as a single JSON object (self-hosted mode only; env vars take precedence and leave this table empty).

**Organizations:** `member` and `invitation` are **pure relationship tables** — `member.role` and `invitation.role` were removed because authorization is now derived exclusively from `grant` rows, not membership columns. **`invitation.grants`** (JSONB) stores the intended access grants (`InvitationGrantSpec[]` in `src/client/authn/invitation-grants.ts`); they are materialized into `grant` rows on accept. When `grants` is null, accept applies a default `organization:manage` grant on the org. **`organization.options.maxServers`** caps enrolled servers + unconsumed registration keys (`null`/omitted = unlimited). Self-hosted operators set it via `GET`/`PUT /organizations/:id/server-capacity`; `POST /licenses` returns **409** `server_capacity_exceeded` when the org is at capacity. Workers/Stripe billing will write the same field later.

**Uniqueness:** `member(organization_id, user_id)` and `teammate(team_id, user_id)` prevent duplicate membership rows on concurrent invite acceptance/retries.

**Install (Deno):** A fresh DB has no org or superadmin. `src/client/authn/install-state.ts` `isInstanceInstalled()` is false until `completeInstanceInstall` creates org + team + **Default Workspace** + superadmin user with a named org. **`organization.slug`** stays **NULL** (reserved for a future feature). Org extras (e.g. logo URL) belong in **`organization.metadata`** — there is no `logo` column. Install sets **`email`** and **`role`** (on `user`) only — `display_name`, `username`, and `display_username` stay **NULL** until the user chooses them.

**Install sentinel invariant:** `completeInstanceInstall` is race-safe. The very first write inside its transaction is a **unique install sentinel** — a `setting` row with `key = INSTANCE_INSTALL_SENTINEL_KEY` (`'INSTANCE_INSTALL_SENTINEL'`), inserted with `ON CONFLICT (key) DO NOTHING ... RETURNING`. Concurrent install transactions block on the `setting_key_unique` constraint until the first commits, then observe the conflict (no returned row) and abort with `INSTANCE_ALREADY_CONFIGURED_ERROR`. After acquiring the sentinel the transaction re-checks `isInstanceInstalled(tx)` (guards pre-sentinel installs where org+superadmin already exist) and then performs every root setup insert (org, team, superadmin user + credential account, membership, grants, workspace, colocated license) in the same transaction. This reuses the existing `setting` table (no schema migration) — only one superadmin/organization bootstrap can ever be created, even under concurrent requests across isolates.

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
| `GET` | `/api/client/v1/organizations/{id}/default-timezone` | org manager |
| `PUT` | `/api/client/v1/organizations/{id}/default-timezone` | org manager |
| `GET` | `/api/client/v1/organizations/{id}/server-capacity` | org manager |
| `PUT` | `/api/client/v1/organizations/{id}/server-capacity` | org owner (`maxServers`; null = unlimited) |
| `GET` | `/api/client/v1/workspaces` | org owner/manager or platform admin (via `listVisible`) |
| `GET` | `/api/client/v1/workspaces/{id}` | org owner/manager or platform admin |
| `POST` | `/api/client/v1/workspaces` | org owner/manager on org |
| `PATCH` | `/api/client/v1/workspaces/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/workspaces/{id}` | org owner/manager |
| `GET` | `/api/client/v1/environments` | org owner/manager (optional `?projectId=`); returns `metadata` and `options` |
| `GET` | `/api/client/v1/environments/{id}` | org owner/manager; returns `metadata` and `options` |
| `POST` | `/api/client/v1/environments` | org owner/manager on parent project; optional `options` (plain object, e.g. `options.compose` overlay; placement stripped) and optional `serverId` |
| `PATCH` | `/api/client/v1/environments/{id}` | org owner/manager; optional `options` patch (placement stripped) and optional `serverId` (`null` clears the pin) |
| `DELETE` | `/api/client/v1/environments/{id}` | org owner/manager |
| `GET` | `/api/client/v1/variables` | org owner/manager (optional `?environmentId=`) |
| `GET` | `/api/client/v1/variables/{id}` | org owner/manager |
| `POST` | `/api/client/v1/variables` | org owner/manager on parent environment; `isSecret=true` seals value via `encryptSecret`; sealed values are never returned |
| `PATCH` | `/api/client/v1/variables/{id}` | org owner/manager; re-seals on secret value update (lazy re-seal-on-write under the current data-encryption key version) |
| `DELETE` | `/api/client/v1/variables/{id}` | org owner/manager |
| `GET` | `/api/client/v1/projects` | org owner/manager (optional `?workspaceId=`); returns `metadata` and `options` |
| `GET` | `/api/client/v1/projects/{id}` | org owner/manager; returns `metadata` and `options` |
| `POST` | `/api/client/v1/projects` | org owner/manager on parent workspace; optional `type` (`docker-compose` \| `template` \| `managed`, default `docker-compose`), `code` (required for template/managed), and optional `serverId` (pins every scaffolded environment in the same transaction); managed engines scaffold a `Production` environment (no `managed` row until `POST …/managed`) |
| `POST` | `/api/client/v1/environments/{id}/deploy` | org manager; target from persisted `environment.server_id` only (`409 server_placement_required` when unset; body `serverId` is ignored); merges project+env compose to runtime YAML (placement stripped from both), creates `environment.deploy` command; poll status via `GET /servers/:serverId/commands/:commandId` (Postgres only — no DO reads) |
| `GET` | `/api/client/v1/environments/{id}/deploy-preview` | org manager; same `prepareDeployCompose` path as deploy (idempotent container allocation + volume registration) but skips daemon sealing; returns `{ ok, composeYaml, projectName, containers[], volumes[], warnings[] }` with secret values redacted; prepare gates surface as non-fatal `warnings` so the preview always renders |
| `GET` | `/api/client/v1/environments/{id}/managed` | org manage; `{ managed, connection, settings, server, rootUsername }` (never passwords; connection null while provisioning) |
| `POST` | `/api/client/v1/environments/{id}/managed` | org manage; create managed row + root principal + enqueue `managed.apply`; show-once `rootPassword`; idempotent thereafter; `409 server_placement_required` / `server_offline` / `managed_busy` |
| `PATCH` | `/api/client/v1/environments/{id}/managed` | org manage; persist settings only (no apply); `400 managed_settings_invalid` |
| `POST` | `/api/client/v1/environments/{id}/managed/apply` | org manage; enqueue `managed.apply` |
| `POST` | `/api/client/v1/environments/{id}/managed/lifecycle` | org manage; enqueue `managed.lifecycle` |
| `DELETE` | `/api/client/v1/environments/{id}/managed` | org manage; hard-delete when stopped/failed/provisioning or no `server_id`; else enqueue `managed.destroy` (`deleted: false`) |
| `POST` | `/api/client/v1/environments/{id}/managed/root-password` | org manage; rotate root password (show-once) + apply |
| `GET/POST/DELETE` | `/api/client/v1/environments/{id}/managed/users[/{principalId}]` | org manage; list/create/delete engine users (passwords show-once on create) |
| `GET/POST/DELETE` | `/api/client/v1/environments/{id}/managed/databases[/{name}]` | org manage; database name list/create/drop + apply |
| `GET` | `/api/client/v1/environments/{id}/managed/status` | org manage; Postgres-only status + containers (no cell/DO) |
| `GET` | `/api/client/v1/environments/{id}/managed/logs` | org manage; cell `managed-logs-request` round-trip |
| `GET` | `/api/client/v1/organizations/{id}/managed` | org manage; one joined list of managed services (Postgres only) |
| `GET` | `/api/client/v1/project-catalog` | org owner/manager (session required); UI-safe catalog summaries (`code`, `kind`, `displayName`, `description`) — no compose or secret defaults |
| `PATCH` | `/api/client/v1/projects/{id}` | org owner/manager; returns `metadata` (read-only via PATCH) and accepts patchable `options` (e.g. `options.compose`) plus optional `workspaceId` to move the project to another same-org workspace (authz on target workspace) |
| `DELETE` | `/api/client/v1/projects/{id}` | org owner/manager |
| `GET` | `/api/client/v1/services` | org owner/manager (optional `?environmentId=`) |
| `GET` | `/api/client/v1/services/{id}` | org owner/manager |
| `POST` | `/api/client/v1/services` | org owner/manager on parent environment |
| `PATCH` | `/api/client/v1/services/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/services/{id}` | org owner/manager |
| `GET` | `/api/client/v1/hostings` | org owner/manager (optional `?serviceId=`) |
| `GET` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `POST` | `/api/client/v1/hostings` | org owner/manager; `serviceId` required; optional `tlsId`, `ipId`, `options.bind` |
| `PATCH` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/hostings/{id}` | org owner/manager |
| `GET` | `/api/client/v1/networks` | org owner/manager (optional `?datacenterId=`, `?serverId=`, `?kind=`) |
| `GET` | `/api/client/v1/networks/{id}` | org owner/manager |
| `POST` | `/api/client/v1/networks` | org owner/manager; body requires `kind` (`datacenter` \| `server` \| `docker` — not `vpn`); `datacenter` requires `datacenterId`, `server` requires `serverId`, `docker` requires neither; `kind: docker` requires `options.dockerNetworkName` |
| `PATCH` | `/api/client/v1/networks/{id}` | org owner/manager; `datacenterId`/`serverId` immutable; docker options patches must keep a valid `dockerNetworkName` |
| `DELETE` | `/api/client/v1/networks/{id}` | org owner/manager |
| `GET` | `/api/client/v1/datacenters` | org owner/manager |
| `GET` | `/api/client/v1/datacenters/{id}` | org owner/manager |
| `POST` | `/api/client/v1/datacenters` | org owner/manager on org |
| `PATCH` | `/api/client/v1/datacenters/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/datacenters/{id}` | org owner/manager; **409** `datacenter_has_networks` when scoped networks remain |
| `GET` | `/api/client/v1/ips` | org owner/manager (optional filters) |
| `GET` | `/api/client/v1/ips/{id}` | org owner/manager |
| `POST` | `/api/client/v1/ips` | org owner/manager |
| `PATCH` | `/api/client/v1/ips/{id}` | org owner/manager; `address` / `allocation` / `scope` immutable (`version` is derived-only and rejected if supplied); optional `vpnId` / `datacenterId` / `serverId` / `networkId` patches (server/datacenter mutually exclusive) |
| `DELETE` | `/api/client/v1/ips/{id}` | org owner/manager; **409** when hosting pins the IP |
| `GET` | `/api/client/v1/vpns` | org owner/manager |
| `GET` | `/api/client/v1/vpns/{id}` | org owner/manager |
| `POST` | `/api/client/v1/vpns` | org owner/manager; body requires **`cidr`** (stored on `vpn`) |
| `PATCH` | `/api/client/v1/vpns/{id}` | org owner/manager |
| `DELETE` | `/api/client/v1/vpns/{id}` | org owner/manager |
| `GET` | `/api/client/v1/vpns/{id}/peers` | org owner/manager; never returns `presharedKey` |
| `POST` | `/api/client/v1/vpns/{id}/peers` | org owner/manager; **`tunnelIpId` optional** (auto-allocates lowest free host in `vpn.cidr` when omitted); optional **`tunnelAddress`** override (mutually exclusive with `tunnelIpId`); **`tunnelIpId: null`** opts out of allocation; **409** `vpn_address_pool_exhausted` / `vpn_address_conflict` |
| `PATCH` | `/api/client/v1/vpns/{id}/peers/{peerId}` | org owner/manager; swapping `tunnelIpId` leaves the previous overlay `ip` row in the pool (visible/deletable on the IPs surface) |
| `DELETE` | `/api/client/v1/vpns/{id}/peers/{peerId}` | org owner/manager; releases the peer's overlay `ip` when unreferenced |
| `POST` | `/api/client/v1/vpns/{id}/apply` | org manager; fans out `server.wireguard.apply` per peer (poll commands on each server) |
| `PATCH` | `/api/client/v1/servers/{id}` | org manager; optional `displayName`, `datacenterId` |

Implemented in `src/client/*/routes.ts`, registered from `registerClientRoutes`.

**Principals** are not exposed as public client CRUD. Hosting/database-user flows create `principal` / `assignment` rows via `src/client/principals/store.ts`; passwords are sealed as `enc` at rest and re-sealed to `denc` only at delivery.

`GET /api/client/v1/servers` uses `listVisible()` for server visibility (not raw org membership). License endpoints (`GET`/`POST` `/licenses`, `DELETE` `/licenses/{id}`) require org ownership (`organization:own`).

### Catalog

Permissions are **static code constants** in `../../client/authz/catalog.ts` — there is nothing to seed. Four permissions exist: `organization:own`, `organization:manage`, `team:own`, and `team:manage`. Never edit permissions in Studio — they do not exist as DB rows. **`ENTITY_TYPES`** and **`SUBJECT_TYPES`** are also exported from `catalog.ts` for route/body validation (`isEntityType`, `isSubjectType`).

### `license` table

Organization-scoped API tokens for server registration. Each row belongs to an `organization` (`organization_id`, cascade delete). `display_name` is optional. `token` stores an Argon2id PHC hash in the same `$argon2id$…` format as `account.password`. Soft-delete via `revoked_at` — revoked licenses remain in the table for audit; application code should treat non-null `revoked_at` as inactive.

**One-shot latch:** `license.server_id` (nullable FK → `server.id`, `ON DELETE SET NULL`) is set on first successful enroll. Partial unique index `uniq_license_server_id` on `license(server_id) WHERE server_id IS NOT NULL` enforces one license per server. Unconsumed seats have `server_id IS NULL`. Revoked rows may keep `server_id` until the server is deleted (SET NULL).

**Colocated control-plane license:** install and Deno boot recovery mint a license with `display_name = 'this server'` (`COLOCATED_SERVER_DISPLAY_NAME`). `POST /api/client/v1/licenses` rejects that reserved display name so user-minted registration keys cannot collide. Uniqueness of active colocated seats is application-level (disk rotate revokes then mints one) — there is no display-name unique index.

**Disk recovery (`ensureColocatedLicenseCredentialsOnDisk`):** plaintext tokens are written once to `/var/lib/turbopanel/license.id` + `license.token` (via `TURBOPANEL_DAEMON_STATE_DIR` / `TURBOPANEL_STATE_DIR`) and are unrecoverable from the DB hash. When those files are missing on an installed instance, recovery **revokes** every active `this server` license for the default org (`rotateColocatedLicenseCredentials` → `invalidateLicense`), then mints exactly one fresh license and rewrites disk credentials — never appends a second active orphan.

### `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon connect the instance resolves `serverId` (reuse by persisted id, `machine_key`, or `hostname` columns), tracks presence in the **Daemon Cell**, and returns `serverId` in enrollment responses. The daemon persists it at `/var/lib/turbopanel/daemon/state/server.id` (production: owned by **`tp:tp`**; co-located dev: dev-user-owned under the same FHS path). See the canonical [Production UID/GID allocation](../../../AGENTS.md#production-uidgid-allocation) table in the repo root `AGENTS.md`. Server rows are hard-deleted — there is no soft-delete column. `display_name` and `organization_id` match the old trunk shape; daemon registration stores `machine_key` / `hostname` on dedicated columns (not in `metadata` — see `server-metadata.ts`). Which registration key enrolled the server is on `license.server_id` (not a column on `server`). `organization_id` FK uses `ON DELETE RESTRICT` — Postgres blocks deleting an organization that still has referencing server rows. `network.server_id` → `server.id` is `ON DELETE RESTRICT` — server deletion is blocked while network rows exist. Deleting a server clears `license.server_id` via `ON DELETE SET NULL`; the app soft-revokes the bound license after delete.

**`machine_key`** (`text`, nullable) is a deterministic HMAC-SHA256 digest of the host machine-id (`src/lib/machine-key.ts` → `deriveMachineKey`) — never the raw machine-id, and not a sealed secret (it is non-reversible and safe to index/equality-match). It is echoed into signed enroll/auth payloads and used for reconnect/reuse matching alongside `hostname`.

Canonical column order: `id`, `created_at`, `updated_at`, `organization_id`, `datacenter_id`, `display_name`, `hostname`, `machine_key`, `connected`, `status_changed_at`, `daemon`, `metadata`, `options` (`daemon` before the trailing `metadata`/`options` pair). Indexes: `idx_server_organization_id`, `idx_server_datacenter_id`, `idx_server_machine_key`, `idx_server_hostname`, and partial `idx_server_connected` on `(id) WHERE connected`. There is no `daemon_status` column or CHECK constraint — liveness is a single boolean plus a transition timestamp (see "Fleet status columns" below). `organization_id` FK uses `ON DELETE RESTRICT`. `datacenter_id` FK uses `ON DELETE SET NULL` — deleting a datacenter unpins servers rather than blocking delete. `network.server_id` → `server.id` is `ON DELETE RESTRICT` — server deletion is blocked while network rows reference it (same for `ip.server_id` and `peer.server_id`). Deleting a server clears `license.server_id` via `ON DELETE SET NULL`; the app soft-revokes the bound license after delete.

**Cell metadata fields** (stored in `server.metadata` and/or `server.options` JSONB):

| Field | Column | Purpose |
|---|---|---|
| `cellLocationHint` | `options` (preferred) or `metadata` | Cloudflare Durable Object `locationHint` chosen at enrollment time. |

`options` takes precedence over `metadata` when both define a value (see `src/daemon/cell/location.ts`). Residual `metadata` also holds `os`, `cpu`, `geo`, `addresses`, `timeSync`, and cell generation fields — not hostname/machineKey.

**Daemon identity (`server.daemon` jsonb):** sparse `{ key, projection? }` only. Fleet liveness lives on dedicated columns (below). No separate `serverkey` table exists for MVP.

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
    "machineKey": "hmac-derived-machine-key",
    "remoteAddress": "203.0.113.1",
    "keyId": "uuid",
    "agent": { "commit": "abc", "buildId": "build-1", "builtAt": "iso", "channel": "trunk" }
  }
}
```

| Field | Purpose |
|---|---|
| `key.id` | Logical key identifier returned to the daemon as `keyId` on enrollment |
| `key.publicJwk` | Raw Ed25519 public JWK `{ crv, kty, x }` |
| `key.fingerprint` | SHA-256 hex over the canonical public JWK — duplicate-checked at enrollment (no DB unique constraint for MVP) |
| `key.revokedAt` | Non-null blocks new JWT issuance; existing JWTs remain valid until their 15-minute expiry |

**`server.daemon.projection` (sparse identity summary):** optional `hostname` / `machineKey` (also mirrored onto dedicated columns), `remoteAddress`, `keyId`, optional `agent` (`commit`/`buildId`/`builtAt`/`channel`), optional `update`. Updated on identity changes and agent build identity changes (via `control-plane-monitor.ts` outside the DO hot path on Workers). No monitor health counts or resource graph are stored. Projection is not path-queried for reconnect dedup — use `hostname` / `machine_key` columns.

**Fleet status columns (liveness projection):** just two columns — `connected` (`boolean NOT NULL DEFAULT false`) and `status_changed_at` (last `connected` flip, set on every online **and** offline transition). There is no `daemon_status`, `last_seen_at`, `connected_at`, or `disconnected_at` column; the old tri-state `online|offline|unknown` and the separate timestamp columns were collapsed into this pair. `connectedAt` is **derived**, not stored: `src/daemon/cell/server-status.ts` returns `statusChangedAt` as `connectedAt` only while `connected` is true (otherwise `null`), and treats `!connected` as offline-since-`statusChangedAt`. Written by `postgres-projection.ts` only on connect/disconnect transitions and on meaningful heartbeats (agent build-identity change, or new `timeSync`/`addresses` facts) — never on a bare elapsed-time debounce (there is no periodic "touch `last_seen_at` every N seconds" write path anymore). Identity columns `hostname` / `machine_key` are written on enroll/hello/identity projection.

**Status read model:** the two status columns above are the Postgres-projected liveness read model. UI and API status reads go through `src/daemon/cell/server-status.ts` (`resolveFleetPresence`) for coarse presence, plus `src/client/servers/update-status.ts` (`loadServerStatusRecords` / `buildServerStatusRecord`) for the `ServerStatusRecord` DTO shape (`serverId`, `connected`, `daemonStatus`, `connectedAt`, `statusChangedAt`, `hostname`, `remoteAddress`, `geo`, `colocatedWithInstance`). Do not read status columns directly from routes. The tri-state `daemonStatus` (`online` \| `offline` \| `unknown`) still exists as an **API-layer derived value** — `src/daemon/authn/daemon-state.ts` (`mapServerDaemonStatusFromColumns`) computes it from `connected` + `statusChangedAt` at read time (`unknown` only when `statusChangedAt` is null, i.e. the server has never transitioned) — it is never stored as a column or CHECK constraint. The `/servers/status` and `/servers/:id/status` endpoints serve this read model; reads are Postgres-only and do not call the DO/Redis cell by default; both runtimes share the same response shape. A separate, independent **status event history** in Analytics Engine/ClickHouse (`src/daemon/metrics/AGENTS.md`) exists for historical uptime/downtime charts — it is history-only and never authoritative for current liveness. See `src/daemon/cell/AGENTS.md` for cost/parity rules.

**Key use tracking:** `server.daemon.key.lastUsedAt` is updated on JWT session issuance via `touchDaemonKeyLastUsed()` (Postgres only — no cell wake). `lastInboundAt` remains cell-only (Redis/DO snapshot), coalesced on connect and inbound WS activity.

The `key` field is always preserved on write (read-modify-write via `parseServerDaemonState` + merge). Status is never written into `server.daemon` jsonb.

Re-enrollment with a valid license token replaces `server.daemon` atomically (and resets status columns). No historical key rows are kept for MVP. To revoke daemon auth, set `server.daemon.key.revokedAt` (via `revokeDaemonKey` helper).

### `command` table

Canonical command/job history — source of truth for UI status and history. Do not read command history from the Daemon Cell — the cell holds only hot pending-request correlation state. The `command` table is the canonical record.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (uuidv7) | Primary key |
| `created_at` | timestamptz(3) NOT NULL `now()` | Real column; index/order source |
| `updated_at` | timestamptz(3) NOT NULL `now()` | Bumped by `transitionCommand` |
| `server_id` | uuid NOT NULL | FK → `server.id`, `ON DELETE CASCADE` (org derived from server) |
| `actor_type` | text NOT NULL | Open set — e.g. `'user'`; no FK |
| `actor_id` | uuid NOT NULL | ID of the acting entity; no FK |
| `name` | text NOT NULL | Command type (e.g. `daemon.ping`) |
| `status` | text NOT NULL `'queued'` | See status values |
| `attempts` | integer NOT NULL `0` | Dispatch retry count |
| `payload` | jsonb NOT NULL | Typed command input (small, bounded) |
| `result` | jsonb nullable | Typed command output (small, bounded) |
| `metadata` | jsonb NOT NULL | Remaining lifecycle blob — see fields below |

| Metadata key | Type | Notes |
|---|---|---|
| `error` | string \| null | Terminal error message |
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
- `idx_command_server_id_created_at` — btree on `(server_id, created_at DESC)` — backs `listServerCommands` ordering
- `idx_command_status` — btree on `status` — supports status-filtered queries

Only FK is `server_id → server.id` (`ON DELETE CASCADE`). Organization is derived from the server — no `organization_id` column on `command`.

**Lifecycle timestamps:** `status`, `created_at`, `updated_at` (and `attempts`, `name`, `result`) are **real columns**. Granular lifecycle timestamps (`queuedAt`…`finishedAt`, `expiresAt`) and `error` remain in `metadata`. `transitionCommand` writes the `status`/`updated_at`/`attempts`/`result` columns and merges the rest into `metadata`. `serializeCommandRecord` in `command-records.ts` flattens both column and metadata fields into the stable `CommandRecord` type for callers.

Server delete cascades to command rows (`ON DELETE CASCADE` on `server_id`).

## Layout

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle table definitions — sync with dev DB via `dev/scripts/introspect.sh` or `dev/scripts/sync.sh` |
| `../../db.ts` | Connection factories (`createDenoDb`, `createToolingDb`, `createWorkersDb`) |
| `../../drizzle.config.mjs` | drizzle-kit config (`TURBOPANEL_DATABASE_URL`; introspect, push, generate, migrate, studio) |
| `../../scripts/bootstrap-dev-db.sh` | Dev DB bootstrap: `pnpm migrate` |
| `~/dev/scripts/introspect.sh` | Pull DB → `schema.ts` (lives in dev repo) |
| `~/dev/scripts/sync.sh` | Push `schema.ts` → DB (Deno dev only; no migration files) |
| `../../scripts/db-connect.sh` | Resolves `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` for drizzle-kit scripts |
| `../../migrations/` | Versioned SQL migration files (committed); applied by `pnpm migrate`; tracked in `public.migration` |
| `../../drizzle/` | Ephemeral introspect scratch dir — `dev/scripts/introspect.sh` deletes after adopt; never committed |

### Authz engine

Runtime authorization lives in `../../client/authz/` (pure TypeScript, safe for both Deno and Workers — no Deno-only imports). Permissions are static code constants in `catalog.ts`. The modules below evaluate access at request time against `grant`.

| File | Purpose |
|---|---|
| `../../client/authz/catalog.ts` | Static `PERMISSIONS`, `ENTITY_TYPES`, `SUBJECT_TYPES`, `isPermissionKey`, `isEntityType`, `isSubjectType`, `getPermissionCatalog` — no DB access |
| `../../client/authz/service.ts` | `isPlatformAdmin`, `isSuperAdmin`, `canManageOrganization`, `canOwnOrganization`, `canManageTeam`, `canOwnTeam`, `canInviteToOrganization`, `canInviteToTeam`, `assertNotLastOrgOwner` — higher-level org/team management checks built on `can()` |
| `../../client/authz/evaluator.ts` | `getSubjects`, `can`, `assertCan`, `listVisible`, `ForbiddenError` — org-level grant checks via domain-FK ancestry; superadmin and admin bypass in SQL |
| `../../client/authz/http.ts` | `assertCanOr403` Hono helper (503 / 401 / 403 short-circuit, `null` to continue) |

`can()` resolves org-level access in a **single CTE query** (`subjectset` → `ancestry` → org grant `hits`) — one round-trip. **Organization permission evaluation respects the requested permission:** an `organization:own` check requires an `organization:own` grant (owner only — a manager grant is NOT sufficient), while an `organization:manage` check accepts either an `organization:own` or `organization:manage` grant (owner or manager). A platform-admin bypass (`EXISTS … WHERE role IN ('superadmin', 'admin')`) is OR'd into the final result. Superadmin-only platform operations (e.g. developer reset-dev) remain gated separately by `user.role === 'superadmin'`. `listVisible()` returns all leaf ids in the org when the user has org-level access (owner or manager) — **never rely on client-side filtering** for visibility.

**Owner-only vs broad org access:** owner-only routes (access-grant management, license lifecycle) use the exact owner-only guard `assertOrgOwnerOr403` (`../../client/authz/http.ts`) which checks `organization:own`. Broad "owner or manager" resource read/create/update/delete routes use `assertCanManageOr403` / `assertCanReadOr403` / `assertCanCreateOr403` (`../../client/shared.ts`), which check `organization:manage`. Never use `organization:own` as a broad org-access check — it is exact owner-only.

**Install (Deno):** `completeInstanceInstall` inserts exactly one `organization:own` grant on the org, one `team:own` grant on the default team, and a **Default Workspace** for the superadmin user. Workers sign-up (`createOrganizationForUser`) creates the same Default Workspace when provisioning an org.

**Completed:** Resource ancestry is computed directly from real domain tables (`organization → workspace → project → environment → service/hosting`, `organization → server`); the generic `resource` shadow table has been dropped. The `grant.allow` column (formerly `allowed`) stores whether a grant permits (`true`) or denies (`false`) the listed permission.

## Connection (self-hosted dev)

Self-hosted instance boot and all database tooling require **`TURBOPANEL_DATABASE_URL`**. Unix socket connections use the libpq-style `?host=` query param (e.g. `postgresql://user:pass@/turbopanel?host=/var/run/turbopanel/postgres`). Postgres in Docker always publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure (`postgres_expose_port`) is optional and unused by the instance. See repo root `AGENTS.md` for env var details. Do not embed credentials here.

## Sanity check

```bash
docker exec turbopanel-database psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone does not require a restart.
