# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`,
run `pnpm drizzle-kit generate --name <summary>` to create SQL files (always
pass `--name` — see below). Apply pending migrations with
`TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command.
Applied migration versions are recorded in **`public.migration`** (configured in
`drizzle.config.mjs`).

**`0000_init.sql` is the squashed baseline for a fresh database, and nothing
else.** Do not edit it to carry a schema change: a provisioned instance has
already recorded `0000_init` in `public.migration` and will never replay it, so
an edit there reaches new installs only and leaves every upgraded instance
querying relations that were never created. Schema changes land as **additive
forward migrations** — `pnpm drizzle-kit generate --name <summary>` writes the
next `NNNN_*.sql` plus its `migrations/meta/NNNN_snapshot.json` and appends the
journal entry; commit all three and leave `0000_init.sql` untouched.

The baseline has been regenerated while pre-MVP (no installed instances, no
data) — first for the `gitapp` table and `installation.app_id`, which
replaced the singleton GitHub App / GitLab OAuth `setting` rows. **This
rename/audit cutover is a second deliberate, explicitly-authorized exception**
to the additive-forward-migration policy, justified by pre-MVP status (no
customers, no production data, no deployed servers). It authorizes **exactly
one** baseline regeneration in the next phase (`Schema cutover and squashed
baseline`), not a general license to re-baseline. Each such regeneration is a
deliberate pre-MVP exception, **not** a precedent: the policy above is what
holds going forward. Additive forward migrations,
`0000_init.sql` is the squashed baseline and nothing else, and applying a
regenerated baseline requires wiping the database because `public.migration`
replay follows the migration journal timestamps/order
(`migrations/meta/_journal.json`). Once a real instance exists, regenerating
stops being an option at all.

Physical boolean columns use an `is_` prefix (`is_connected`,
`is_read_eligible`, `is_for_build`, `is_for_runtime`,
`is_emit_engine_defaults`, `is_read_only`). Public API JSON still uses
`connected`, `readEligible`, `forBuild`, `forRuntime`, `emitEngineDefaults`,
and `readOnly`.

The co-located dev server has live data — treat every database change as
production-adjacent.

**Server metrics is never stored in Postgres.** Host metrics live in Analytics
Engine (Workers) or ClickHouse (Deno) only — see instance `AGENTS.md` (Server
metrics). Do not add metrics tables or columns here; there are no per-minute
Postgres projection writes for metrics.

## Schema sync directions

> **Fresh database:** versioned `pnpm migrate` is the only bootstrap path.
> Co-located dev converge runs `./scripts/bootstrap-dev-db.sh` via Ansible
> (`pnpm migrate`). Manual bootstrap: `./scripts/bootstrap-dev-db.sh` from the
> instance repo root. An unmigrated database is an operational failure (missing
> relations propagate); it must not be treated as install mode / `needsInstall`.

| Direction                                     | You changed                  | Command                                      | drizzle-kit  |
| --------------------------------------------- | ---------------------------- | -------------------------------------------- | ------------ |
| **Pull** (DB → code)                          | Live Postgres (Studio / SQL) | `dev/scripts/introspect.sh`                  | `introspect` |
| **Push** (code → DB, Deno dev only)           | `schema.ts`                  | `dev/scripts/sync.sh`                        | `push`       |
| **Generate migration**                        | `schema.ts`                  | `pnpm drizzle-kit generate --name <summary>` | `generate`   |
| **Apply migration** (Workers deploy + manual) | pending SQL in `migrations/` | `TURBOPANEL_DATABASE_URL=… pnpm migrate`     | `migrate`    |

Pick one source of truth per change — do not edit both sides and blindly run
both scripts.

### Pull: database → `schema.ts` (`dev/scripts/introspect.sh`)

Use when you designed in **Drizzle Studio** or applied DDL directly.

1. Change tables in Studio (`/developer/database` → **Start API & open
   studio**).
2. From the dev checkout, run `./scripts/introspect.sh` (resolves the instance
   repo via `TURBOPANEL_INSTANCE_REPO` / `$HOME/turbopanel`).
3. Review `schema.ts` (style, dropped tables).

`dev/scripts/introspect.sh`: loads `TURBOPANEL_DATABASE_URL` from env or
`turbopanel-instance` → introspect → copy to `schema.ts` → delete ephemeral
`drizzle/` output → `deno check`.

### Push: `schema.ts` → database (`dev/scripts/sync.sh`)

Use when you edited **`schema.ts` first** and need the live dev DB to catch up
without committing migration files (Deno dev convenience only).

1. Edit `src/lib/db/schema.ts`.
2. From the dev checkout, run `./scripts/sync.sh`.
3. Confirm drizzle-kit prompts (`--strict` by default). Use
   `./scripts/sync.sh --force` only when you accept possible **data loss** on
   dev.

`dev/scripts/sync.sh`: `deno check` → `drizzle-kit push` (no SQL files
committed). Flags: `--verbose`, `--force`.

Override connection for either script:
`TURBOPANEL_DATABASE_URL=postgresql://… ./scripts/introspect.sh` or
`./scripts/sync.sh` (from dev).

### Generate + apply migrations (Workers path)

Use when schema changes should ship as versioned SQL (required for Workers
deploy).

1. Edit `src/lib/db/schema.ts`.
2. Run `pnpm drizzle-kit generate --name <short_snake_case_summary>` — writes
   SQL under `migrations/` (e.g. `0002_add_command_table.sql`). **Always pass
   `--name`**; bare `generate` picks random names like `tan_silver_centurion`
   that are useless in review.
3. Commit the new migration files (developer only — after reviewing SQL).
4. Apply: `TURBOPANEL_DATABASE_URL=… pnpm migrate` (local or CI; **developer
   only**). Workers deploy runs `pnpm migrate` automatically.

Applied versions are tracked in **`public.migration`** (`drizzle.config.ts` sets
`migrations: { table: 'migration', schema: 'public' }`).

### Drizzle Studio (dev UI)

- **Test connection** — `GET /api/developer/v1/database/status`
- **Reset dev instance** — `POST /api/developer/v1/system/reset-dev` (superadmin
  session only): `DROP SCHEMA public CASCADE`, `drizzle-kit migrate`, restart
  instance. UI: Database section → **Reset Dev Instance**.
- **Studio** — `POST /api/developer/v1/database/studio` starts
  `drizzle-kit studio` on **loopback only** (**127.0.0.1:4983** / `::1`;
  `TURBOPANEL_DRIZZLE_STUDIO_HOST` must be `localhost`, `127.0.0.1`, or `::1` —
  non-loopback values are rejected without spawning). Open
  **`https://local.drizzle.studio?host=localhost&port=4983`** (hosted UI).
  Safari/Brave may block localhost — see
  [Drizzle docs](https://orm.drizzle.team/docs/drizzle-kit-studio#safari-and-brave-support).
- Studio applies DDL **directly** to the DB — follow with
  `dev/scripts/introspect.sh` to pull into code.

## Current policy (what not to run)

- Use `pnpm drizzle-kit generate --name …` + `pnpm migrate` for Workers-bound
  schema changes; `dev/scripts/sync.sh` (`push`) remains for Deno dev
  convenience only.
- **No ad-hoc push** — use `dev/scripts/sync.sh` only (after editing
  `schema.ts`), not raw `drizzle-kit push` in one-off commands.
- **No production DDL** from agents without explicit approval.

### Agent policy: generate yes, apply/commit no

Agents **may** edit `schema.ts` and run **`pnpm drizzle-kit generate --name …`**
when a task needs versioned SQL — but **must not apply migrations or commit
them**. Apply and commit stay with the developer so they can review the SQL
before it hits git or the local dev database.

**Generate with a meaningful `--name`.** Drizzle assigns random tags when
`--name` is omitted (e.g. `0001_tan_silver_centurion`). Always pass a short
snake_case summary of the change:

```bash
pnpm drizzle-kit generate --name add_command_table
pnpm drizzle-kit generate --name drop_member_role_columns
pnpm drizzle-kit generate --name server_license_fk_restrict
```

Pick a name that answers “what is this migration doing?” — table/column added or
dropped, constraint changed, index added. One logical change per migration when
possible.

Do **not** run (or offer to run):

- `pnpm migrate` / `drizzle-kit migrate`
- `dev/scripts/sync.sh` / `drizzle-kit push`
- `dev/scripts/introspect.sh` / `drizzle-kit introspect`
- `./scripts/bootstrap-dev-db.sh`
- Raw DDL against Postgres (Studio, `psql`, etc.)
- Bare `pnpm drizzle-kit generate` without `--name`

After generating, tell the developer to **review** the new SQL under
`migrations/`, then **apply locally** (`TURBOPANEL_DATABASE_URL=… pnpm migrate`)
and **commit** when satisfied. Do **not** commit files under `migrations/`
unless the developer explicitly asks.

Destructive changes (drop column/table, type narrowing) can lose dev rows.
`dev/scripts/sync.sh` prompts via `--strict`; `--force` skips those guardrails.

## Schema (ported from old trunk `apps/api`)

`schema.ts` mirrors the old monorepo database layout (Better Auth–compatible
tables, no auth runtime yet). Grouped by concern — see **Step 4** in the
schema cutover ledger below (post-cutover names).

**Column order:** tables that carry `metadata` / `options` declare them
immediately after timestamps — `id` → `created_at` → `updated_at` → `metadata` →
`options` → remaining columns. If a table has one of those JSONB columns, it
must have both, and both are always nullable.


## Schema cutover ledger (phase 1)

This ledger is the **single source** the next phase (`Schema cutover and
squashed baseline`) executes against. Identifiers below are **current**
(`schema.ts` as of this writing) so phase 2 can apply them mechanically —
no re-derivation. Phase 2 may implement **only** what this ledger
authorizes: the locked table renames, the listed FK/constraint/index
renames, the listed column renames/drops, and the two name-format CHECK
drops. No `schema.ts` edits, no `drizzle-kit generate`, and no
route/record-helper changes belong to **this** phase.

`schema.ts` currently exports **51** `pgTable` definitions in declaration
order (not 60 — that figure was a planning estimate; the declaration list
below is complete). Physical names follow the single-lowercase-word rule
guarded by `table-naming.test.ts`.

### Step 1 — Inventory (current `schema.ts`)

Declaration order. Physical name, Drizzle export, full column list, and
every named CHECK / unique / index / FK constraint.

1. **`invitation`** (Drizzle export `invitation`)
   - Columns: `id`, `created_at`, `user_id`, `team_id`, `expires_at`, `email`, `status`, `grants`
   - Constraints: `idx_invitation_email` (index), `idx_invitation_user_id` (index), `idx_invitation_team_id` (index), `invitation_user_id_user_id_fk` (fk), `invitation_team_id_team_id_fk` (fk)

2. **`organization`** (Drizzle export `organization`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `name`, `slug`
   - Constraints: `organization_slug_unique` (unique)

3. **`tls`** (Drizzle export `tls`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`, `source`, `certificate_pem`, `private_key_pem`, `status`, `not_after`, `fingerprint_sha256`, `ca_state`, `ca_generation`
   - Constraints: `idx_tls_organization_id` (index), `idx_tls_not_after` (index), `idx_tls_organization_ca_generation` (index), `uniq_tls_organization_fingerprint_sha256` (uniqueIndex), `uniq_tls_organization_active_ca` (uniqueIndex), `tls_source_check` (check), `tls_name_format_check` (check), `tls_ca_state_check` (check), `tls_ca_lifecycle_source_check` (check), `tls_ca_generation_source_check` (check), `tls_ca_generation_required_check` (check), `tls_organization_id_organization_id_fk` (fk)

4. **`rotation`** (Drizzle export `rotation`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `from_ca_generation`, `to_ca_generation`, `state`, `started_at`, `completed_at`, `results`
   - Constraints: `idx_rotation_organization_id` (index), `uniq_rotation_inflight_organization` (uniqueIndex), `rotation_state_check` (check), `rotation_organization_id_organization_id_fk` (fk)

5. **`passkey`** (Drizzle export `passkey`)
   - Columns: `id`, `created_at`, `user_id`, `aaguid`, `name`, `public_key`, `credential_id`, `counter`, `device_type`, `is_backed_up`, `transports`
   - Constraints: `idx_passkey_credential_id` (index), `idx_passkey_user_id` (index), `passkey_user_id_user_id_fk` (fk)

6. **`datacenter`** (Drizzle export `datacenter`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`, `description`
   - Constraints: `idx_datacenter_organization_id` (index), `datacenter_name_format_check` (check), `datacenter_organization_id_organization_id_fk` (fk)

7. **`server`** (Drizzle export `server`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`, `hostname`, `machine_key`, `os_id`, `os_family`, `os_version`, `os_codename`, `os_pretty_name`, `os_architecture`, `timezone`, `is_time_sync_enabled`, `ntp_servers`, `ntp_last_synced_at`, `is_connected`, `status_changed_at`, `daemon`
   - Constraints: `idx_server_organization_id` (index), `idx_server_machine_key` (index), `idx_server_hostname` (index), `idx_server_connected` (index), `server_organization_id_organization_id_fk` (fk)

8. **`license`** (Drizzle export `license`)
   - Columns: `id`, `created_at`, `updated_at`, `organization_id`, `server_id`, `name`, `token`, `revoked_at`
   - Constraints: `idx_license_organization_id` (index), `uniq_license_server_id` (uniqueIndex), `license_organization_id_organization_id_fk` (fk), `license_server_id_server_id_fk` (fk)

9. **`command`** (Drizzle export `command`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `server_id`, `actor_type`, `actor_id`, `name`, `status`, `attempts`, `context`, `result_summary`, `error_code`, `error_message`, `queued_at`, `dispatch_started_at`, `sent_at`, `acked_at`, `started_at`, `finished_at`, `expires_at`
   - Constraints: `idx_command_server_id_created_at` (index), `idx_command_status` (index), `idx_command_deploy_environment_created` (index), `command_server_id_server_id_fk` (fk)

10. **`dispatch`** (Drizzle export `dispatch`)
   - Columns: `command_id`, `created_at`, `payload`, `expires_at`
   - Constraints: `idx_dispatch_expires_at` (index), `dispatch_command_id_command_id_fk` (fk)

11. **`network`** (Drizzle export `network`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `datacenter_id`, `server_id`, `environment_id`, `kind`, `cidr`, `name`
   - Constraints: `idx_network_server_id` (index), `idx_network_organization_id` (index), `idx_network_datacenter_id` (index), `idx_network_environment_id` (index), `uniq_network_datacenter_cidr` (uniqueIndex), `network_kind_check` (check), `network_single_scope_check` (check), `network_name_format_check` (check), `network_organization_id_organization_id_fk` (fk), `network_datacenter_id_datacenter_id_fk` (fk), `network_server_id_server_id_fk` (fk)

12. **`fabric`** (Drizzle export `fabric`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `cidr`, `name`
   - Constraints: `idx_fabric_organization_id` (index), `uniq_fabric_organization_id` (uniqueIndex), `fabric_name_format_check` (check), `fabric_organization_id_organization_id_fk` (fk)

13. **`ip`** (Drizzle export `ip`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `datacenter_id`, `network_id`, `server_id`, `address`, `allocation`, `scope`, `description`
   - Constraints: `idx_ip_organization_id` (index), `idx_ip_datacenter_id` (index), `idx_ip_network_id` (index), `idx_ip_server_id` (index), `idx_ip_scope_server_datacenter` (index), `uniq_ip_org_address` (uniqueIndex), `ip_allocation_check` (check), `ip_scope_check` (check), `ip_datacenter_scope_check` (check), `ip_datacenter_anchor_check` (check), `ip_datacenter_member_network_check` (check), `ip_organization_id_organization_id_fk` (fk), `ip_datacenter_id_datacenter_id_fk` (fk), `ip_network_id_network_id_fk` (fk), `ip_server_id_server_id_fk` (fk)

14. **`relay`** (Drizzle export `relay`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `fabric_id`, `server_id`, `address`, `role`, `keepalive`, `endpoint_address`, `public_key`, `prefix`, `advertised_cidrs`, `preshared_key`
   - Constraints: `idx_relay_fabric_id` (index), `idx_relay_server_id` (index), `relay_fabric_server_unique` (unique), `uniq_relay_fabric_address` (unique), `uniq_relay_fabric_public_key` (unique), `relay_role_check` (check), `relay_keepalive_check` (check), `relay_member_advertised_cidrs_empty_check` (check), `relay_fabric_id_fabric_id_fk` (fk), `relay_server_id_server_id_fk` (fk)

15. **`segment`** (Drizzle export `segment`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `network_id`, `server_id`, `cidr`
   - Constraints: `idx_segment_network_id` (index), `idx_segment_server_id` (index), `segment_network_server_unique` (unique), `segment_network_id_network_id_fk` (fk), `segment_server_id_server_id_fk` (fk)

16. **`workspace`** (Drizzle export `workspace`)
   - Columns: `id`, `created_at`, `updated_at`, `organization_id`, `name`, `description`, `kind`
   - Constraints: `idx_workspace_organization_id` (index), `uniq_workspace_organization_turbopanel` (uniqueIndex), `workspace_name_format_check` (check), `workspace_kind_check` (check), `workspace_organization_id_organization_id_fk` (fk)

17. **`project`** (Drizzle export `project`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `workspace_id`, `repository_id`, `name`, `description`
   - Constraints: `idx_project_workspace_id` (index), `idx_project_repository_id` (index), `uniq_project_workspace_system_component` (uniqueIndex), `project_name_format_check` (check), `project_workspace_id_workspace_id_fk` (fk), `project_repository_id_repository_id_fk` (fk, `ON DELETE RESTRICT`)
   - `repository_id` is the one Git repository this project **is** (null =
     not repository-backed). Every `x-turbopanel.source.sourceId` in the
     project's compose has to name it — see `src/lib/compose/AGENTS.md` →
     "One repository per project".

18. **`environment`** (Drizzle export `environment`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `project_id`, `server_id`, `generation`, `name`, `description`
   - Constraints: `idx_environment_project_id` (index), `idx_environment_server_id` (index), `environment_name_format_check` (check), `environment_project_id_project_id_fk` (fk), `environment_server_id_server_id_fk` (fk)

19. **`managed`** (Drizzle export `managed`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `server_id`, `name`, `engine`, `status`
   - Constraints: `idx_managed_environment_id` (index), `idx_managed_server_id` (index), `idx_managed_engine` (index), `managed_environment_id_unique` (uniqueIndex), `managed_name_format_check` (check), `managed_status_check` (check), `managed_environment_id_environment_id_fk` (fk), `managed_server_id_server_id_fk` (fk)

20. **`node`** (Drizzle export `node`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `managed_id`, `server_id`, `role`, `replica_class`, `is_read_eligible`, `ordinal`, `replication_transport`, `private_port`, `status`
   - Constraints: `idx_node_managed_id` (index), `idx_node_server_id` (index), `uniq_node_primary` (uniqueIndex), `uniq_node_server_private_port` (uniqueIndex), `uniq_node_managed_ordinal` (unique), `uniq_node_managed_server` (unique), `node_role_check` (check), `node_replica_class_check` (check), `node_ordinal_positive_check` (check), `node_transport_check` (check), `node_status_check` (check), `node_managed_id_managed_id_fk` (fk), `node_server_id_server_id_fk` (fk)

21. **`leaf`** (Drizzle export `leaf`)
   - Columns: `id`, `organization_id`, `server_id`, `kind`, `managed_id`, `node_id`, `ca_id`, `ca_generation`, `not_after`, `issued_at`
   - Constraints: `idx_leaf_not_after` (index), `idx_leaf_organization_id` (index), `uniq_leaf_ingress_server` (uniqueIndex), `uniq_leaf_engine_node` (uniqueIndex), `leaf_kind_check` (check), `leaf_kind_keys_check` (check), `leaf_organization_id_organization_id_fk` (fk), `leaf_server_id_server_id_fk` (fk), `leaf_managed_id_managed_id_fk` (fk), `leaf_node_id_node_id_fk` (fk), `leaf_ca_id_tls_id_fk` (fk)

22. **`recovery`** (Drizzle export `recovery`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `managed_id`, `kind`, `source_primary_member_id`, `target_member_id`, `state`, `started_at`, `completed_at`
   - Constraints: `idx_recovery_managed_id` (index), `uniq_recovery_inflight_managed` (uniqueIndex), `recovery_kind_check` (check), `recovery_state_check` (check), `recovery_managed_id_managed_id_fk` (fk)

23. **`variable`** (Drizzle export `variable`)
   - Columns: `id`, `created_at`, `updated_at`, `organization_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `hosting_id`, `server_id`, `binding_id`, `key`, `value`, `is_secret`, `is_literal`, `is_for_build`, `is_for_runtime`, `description`
   - Constraints: `idx_variable_organization_id` (index), `idx_variable_workspace_id` (index), `idx_variable_project_id` (index), `idx_variable_environment_id` (index), `idx_variable_service_id` (index), `idx_variable_hosting_id` (index), `idx_variable_server_id` (index), `idx_variable_binding_id` (index), `uniq_var_org` (uniqueIndex), `uniq_var_workspace` (uniqueIndex), `uniq_var_project` (uniqueIndex), `uniq_var_environment` (uniqueIndex), `uniq_var_service` (uniqueIndex), `uniq_var_hosting` (uniqueIndex), `uniq_var_server` (uniqueIndex), `variable_exactly_one_parent_check` (check), `variable_key_format_check` (check), `variable_organization_id_organization_id_fk` (fk), `variable_workspace_id_workspace_id_fk` (fk), `variable_project_id_project_id_fk` (fk), `variable_environment_id_environment_id_fk` (fk), `variable_service_id_service_id_fk` (fk), `variable_hosting_id_hosting_id_fk` (fk), `variable_server_id_server_id_fk` (fk), `variable_binding_id_binding_id_fk` (fk)

24. **`service`** (Drizzle export `service`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `name`, `description`, `compose_service_name`
   - Constraints: `idx_service_environment_id` (index), `uniq_service_environment_compose_name` (uniqueIndex), `service_name_format_check` (check), `service_environment_id_environment_id_fk` (fk)

25. **`deployment`** (Drizzle export `deployment`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `server_id`, `desired_generation`, `applied_generation`, `desired_hash`, `status`, `last_command_id`, `finished_at`, `duration_ms`, `outcome`
   - Constraints: `idx_deployment_environment_id` (index), `idx_deployment_server_id` (index), `uniq_deployment_environment_server` (unique), `deployment_status_check` (check), `deployment_generation_check` (check), `deployment_outcome_check` (check), `deployment_environment_id_environment_id_fk` (fk), `deployment_server_id_server_id_fk` (fk)

26. **`task`** (Drizzle export `task`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `service_id`, `server_id`, `address`, `slot`, `generation`, `desired_state`
   - Constraints: `idx_task_environment_generation` (index), `idx_task_server_id` (index), `uniq_task_service_slot` (unique), `task_slot_nonnegative_check` (check), `task_desired_state_check` (check), `task_environment_id_environment_id_fk` (fk), `task_service_id_service_id_fk` (fk), `task_server_id_server_id_fk` (fk)

27. **`label`** (Drizzle export `label`)
   - Columns: `id`, `created_at`, `updated_at`, `server_id`, `key`, `value`
   - Constraints: `idx_label_server_id` (index), `uniq_label_server_key` (unique), `label_key_format_check` (check), `label_server_id_server_id_fk` (fk)

28. **`hosting`** (Drizzle export `hosting`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `service_id`, `tls_id`, `ip_id`, `name`, `description`
   - Constraints: `idx_hosting_service_id` (index), `idx_hosting_tls_id` (index), `idx_hosting_ip_id` (index), `hosting_name_format_check` (check), `hosting_service_id_service_id_fk` (fk), `hosting_tls_id_tls_id_fk` (fk), `hosting_ip_id_ip_id_fk` (fk)

29. **`container`** (Drizzle export `container`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `service_id`, `server_id`, `container_id`, `container_name`, `status`, `role`, `compose_service_name`, `ordinal`
   - Constraints: `idx_container_service_id` (index), `idx_container_server_id` (index), `idx_container_status` (index), `uniq_container_server_container_id` (uniqueIndex), `uniq_container_service_role_ordinal` (uniqueIndex), `container_ordinal_positive_check` (check), `container_role_check` (check), `container_service_id_service_id_fk` (fk), `container_server_id_server_id_fk` (fk)

30. **`principal`** (Drizzle export `principal`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `kind`, `provider`, `username`, `password`, `project_id`, `managed_id`
   - Constraints: `idx_principal_project_id` (index), `idx_principal_managed_id` (index), `principal_kind_check` (check), `principal_provider_check` (check), `principal_username_format_check` (check), `principal_project_id_project_id_fk` (fk), `principal_managed_id_managed_id_fk` (fk)

31. **`entitlement`** (Drizzle export `entitlement`)
   - Columns: `id`, `created_at`, `updated_at`, `principal_id`, `runtime`, `series`, `granted_by`
   - Constraints: `idx_entitlement_principal_id` (index), `entitlement_unique` (unique), `entitlement_runtime_check` (check), `entitlement_series_check` (check), `entitlement_granted_by_check` (check), `entitlement_principal_id_principal_id_fk` (fk)

32. **`ssh`** (Drizzle export `sshKey`)
   - Columns: `id`, `created_at`, `updated_at`, `principal_id`, `name`, `key_type`, `public_key`, `fingerprint`, `comment`, `user_id`, `bits`
   - Constraints: `idx_ssh_principal_id` (index), `idx_ssh_fingerprint` (index), `ssh_fingerprint_unique` (unique), `ssh_type_check` (check), `ssh_fingerprint_check` (check), `ssh_public_key_check` (check), `ssh_name_check` (check), `ssh_principal_id_principal_id_fk` (fk), `ssh_user_id_user_id_fk` (fk)

33. **`tenancy`** (Drizzle export `tenancy`)
   - Columns: `id`, `created_at`, `updated_at`, `principal_id`, `service_id`
   - Constraints: `idx_steward_principal_id` (index), `idx_steward_service_id` (index), `steward_principal_service_unique` (unique), `steward_principal_id_principal_id_fk` (fk), `steward_service_id_service_id_fk` (fk)

34. **`binding`** (Drizzle export `binding`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `principal_id`, `service_id`, `database_name`, `key_prefix`, `is_emit_engine_defaults`
   - Constraints: `idx_binding_principal_id` (index), `idx_binding_service_id` (index), `uniq_binding_service_engine_defaults` (uniqueIndex), `uniq_binding_service_prefix` (unique), `binding_key_prefix_format_check` (check), `binding_database_name_format_check` (check), `binding_principal_id_principal_id_fk` (fk), `binding_service_id_service_id_fk` (fk)

35. **`secret`** (Drizzle export `secret`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `principal_id`, `provider`, `name`, `secret_envelope`, `expires_at`
   - Constraints: `idx_credential_organization_id` (index), `idx_credential_principal_id` (index), `credential_provider_check` (check), `credential_organization_id_organization_id_fk` (fk), `credential_principal_id_principal_id_fk` (fk)

36. **`storage`** (Drizzle export `storage`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `kind`, `name`, `access_mode`, `retention`, `generation`, `principal_id`, `content_envelope`
   - Constraints: `idx_storage_organization_id` (index), `idx_storage_workspace_id` (index), `idx_storage_project_id` (index), `idx_storage_environment_id` (index), `idx_storage_service_id` (index), `uniq_storage_environment_compose_volume_key` (uniqueIndex), `storage_kind_check` (check), `storage_access_mode_check` (check), `storage_retention_check` (check), `storage_at_most_one_parent_check` (check), `storage_organization_id_organization_id_fk` (fk), `storage_workspace_id_workspace_id_fk` (fk), `storage_project_id_project_id_fk` (fk), `storage_environment_id_environment_id_fk` (fk), `storage_service_id_service_id_fk` (fk), `storage_principal_id_principal_id_fk` (fk)

37. **`copy`** (Drizzle export `storageCopy`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `storage_id`, `server_id`, `credential_id`, `provider`, `role`, `state`, `path`, `endpoint`, `generation`
   - Constraints: `idx_location_storage_id` (index), `idx_location_server_id` (index), `idx_location_credential_id` (index), `uniq_location_storage_primary` (uniqueIndex), `uniq_location_storage_server_provider` (uniqueIndex), `location_provider_check` (check), `location_role_check` (check), `location_state_check` (check), `location_storage_id_storage_id_fk` (fk), `location_server_id_server_id_fk` (fk), `location_credential_id_credential_id_fk` (fk)

38. **`mount`** (Drizzle export `mount`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `storage_id`, `service_id`, `destination_path`, `subpath`, `is_read_only`
   - Constraints: `idx_mount_storage_id` (index), `idx_mount_service_id` (index), `uniq_mount_service_destination` (unique), `mount_storage_id_storage_id_fk` (fk), `mount_service_id_service_id_fk` (fk)

39. **`gitapp`** (Drizzle export `forge`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `provider`, `name`, `base_url`, `api_url`, `external_app_id`, `app_slug`, `client_id`, `redirect_uri`, `webhook_origin`, `is_public`, `custom_git_user`, `custom_git_port`, `synced_at`, `envelopes`, `webhook_ref`, `webhook_token_hash`
   - Constraints: `idx_gitapp_organization_id` (index), `idx_gitapp_provider` (index), `uniq_gitapp_webhook_ref` (unique), `uniq_gitapp_provider_base_external` (unique), `uniq_gitapp_webhook_token_hash` (unique), `gitapp_provider_check` (check), `gitapp_organization_id_organization_id_fk` (fk)

40. **`installation`** (Drizzle export `gitConnection`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `app_id`, `provider`, `external_installation_id`, `account_login`, `account_type`, `suspended_at`, `oauth_envelope`
   - Constraints: `idx_installation_organization_id` (index), `idx_installation_app_id` (index), `uniq_installation_organization_app_external` (unique), `installation_provider_check` (check), `installation_organization_id_organization_id_fk` (fk), `installation_app_id_gitapp_id_fk` (fk)

41. **`source`** (Drizzle export `repository`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `installation_id`, `service_id`, `environment_id`, `credential_id`, `provider`, `repository_url`, `repository_external_id`, `default_branch`, `subdirectory`, `auto_deploy`
   - Constraints: `idx_source_organization_id` (index), `idx_source_installation_id` (index), `idx_source_service_id` (index), `idx_source_environment_id` (index), `idx_source_credential_id` (index), `uniq_source_organization_installation_repository` (unique), `source_provider_check` (check), `source_auto_deploy_check` (check), `source_at_most_one_parent_check` (check), `source_organization_id_organization_id_fk` (fk), `source_installation_id_installation_id_fk` (fk), `source_service_id_service_id_fk` (fk), `source_environment_id_environment_id_fk` (fk), `source_credential_id_credential_id_fk` (fk)

42. **`delivery`** (Drizzle export `webhookDelivery`)
   - Columns: `id`, `created_at`, `provider`, `external_delivery_id`, `event`
   - Constraints: `idx_delivery_created_at` (index), `uniq_delivery_provider_external` (unique), `delivery_provider_check` (check)

43. **`grant`** (Drizzle export `grant`)
   - Columns: `id`, `created_at`, `actor_type`, `actor_id`, `entity_type`, `entity_id`, `permission`
   - Constraints: `idx_grant_entity` (index), `idx_grant_actor` (index), `grant_unique` (unique)

44. **`session`** (Drizzle export `session`)
   - Columns: `id`, `created_at`, `updated_at`, `user_id`, `expires_at`, `token`, `ip_address`, `user_agent`
   - Constraints: `idx_session_user_id` (index), `session_token_unique` (unique), `session_user_id_user_id_fk` (fk)

45. **`setting`** (Drizzle export `setting`)
   - Columns: `id`, `created_at`, `updated_at`, `key`, `value`
   - Constraints: `setting_key_unique` (unique)

46. **`account`** (Drizzle export `account`)
   - Columns: `id`, `created_at`, `updated_at`, `user_id`, `provider_id`, `provider_user_id`, `access_token`, `refresh_token`, `id_token`, `access_token_expires_at`, `refresh_token_expires_at`, `scope`, `password`
   - Constraints: `idx_account_user_id` (index), `account_user_id_user_id_fk` (fk)

47. **`teammate`** (Drizzle export `teammate`)
   - Columns: `id`, `created_at`, `team_id`, `user_id`
   - Constraints: `idx_teammate_team_id` (index), `idx_teammate_user_id` (index), `teammate_team_user_unique` (unique), `teammate_team_id_team_id_fk` (fk), `teammate_user_id_user_id_fk` (fk)

48. **`team`** (Drizzle export `team`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`
   - Constraints: `idx_team_organization_id` (index), `team_name_format_check` (check), `team_organization_id_organization_id_fk` (fk)

49. **`user`** (Drizzle export `user`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `name`, `email`, `is_email_verified`, `is_2fa_enabled`, `is_disabled`, `role`
   - Constraints: `user_email_unique` (unique), `user_name_format_check` (check)

50. **`2fa`** (Drizzle export `twoFactor`)
   - Columns: `id`, `created_at`, `user_id`, `secret`, `is_verified`, `backup_codes`
   - Constraints: `idx_2fa_user_id` (index), `2fa_user_id_user_id_fk` (fk)

51. **`verification`** (Drizzle export `verification`)
   - Columns: `id`, `created_at`, `updated_at`, `expires_at`, `identifier`, `value`
   - Constraints: `verification_identifier_unique` (unique)

#### Step 1 usage cross-reference

Complete per-column read/write evidence for every inventoried column.
Scope is first-party TypeScript under `turbopanel/src/` excluding
`schema.ts` itself. A **read** is a table-qualified `export.column`
select / `eq` / `.returning({ column })`, a whole-row
`select().from(table)` / `getTableColumns(table)`, or a tagged-SQL
`physical.column` fragment. A **write** is `.insert(table).values({`
column `})`, `.update(table).set({` column `})`, or a Postgres
default (`uuidv7()`, `defaultNow()`) applied on those inserts.
Coarse identifier matches (`expiresAt` on a different table) do
**not** count. `no` / `no` is an explicit no-reader/no-writer
finding, not an omitted row.

A column is a **drop candidate** only when a table-qualified
read **and** write are both absent **and** Step 3 authorizes the
drop. Unused pairing / Better Auth / reserved columns stay **Keep**.

**1. `invitation`** (export `invitation`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/access/routes.ts` |
| `created_at` | yes | no | Whole-row accept select; no first-party insert. |
| `user_id` | yes | no | Present on the accept select; no first-party insert. |
| `team_id` | yes | no | Present on the accept select; no first-party insert. |
| `expires_at` | yes | yes | `client/access/routes.ts` |
| `email` | yes | no | Read on accept (`client/access/routes.ts`). **No first-party `insert(invitation)`**. |
| `status` | yes | yes | `client/access/routes.ts` |
| `grants` | yes | no | Read on accept; no first-party insert. |

**2. `organization`** (export `organization`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `client/org-context.ts` (+1) |
| `updated_at` | no | yes | Touched by org PATCH (`client/organizations/routes.ts`); no qualified select. |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `name` | yes | yes | `client/authn/install-state.ts` (+3) |
| `slug` | yes | no | Selected in `developer/routes-core.ts`; install never populates it. |

**3. `tls`** (export `tls`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/tls/organization-ca.ts` (+1) |
| `updated_at` | yes | yes | `client/tls/organization-ca.ts` (+1) |
| `metadata` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `options` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `name` | yes | yes | `client/tls/organization-ca.ts` (+1) |
| `source` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+3) |
| `certificate_pem` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `private_key_pem` | yes | yes | `admin/reencrypt-secrets.ts` (+2) |
| `status` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `not_after` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `fingerprint_sha256` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `ca_state` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+2) |
| `ca_generation` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+2) |

**4. `rotation`** (export `rotation`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/tls/changeover-lease.ts` |
| `created_at` | yes | yes | `client/tls/changeover-lease.ts` |
| `updated_at` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `metadata` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `options` | yes | no | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `organization_id` | yes | yes | `client/tls/changeover-lease.ts` |
| `from_ca_generation` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `to_ca_generation` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `state` | yes | yes | `client/tls/changeover-lease.ts` |
| `started_at` | yes | yes | `client/tls/changeover-lease.ts` |
| `completed_at` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `results` | yes | yes | `client/tls/changeover-fanout.ts` |

**5. `passkey`** (export `passkey`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `created_at` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `user_id` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `aaguid` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `name` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `public_key` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `credential_id` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `counter` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `device_type` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `is_backed_up` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `transports` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |

**6. `datacenter`** (export `datacenter`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/datacenters/routes.ts` |
| `updated_at` | yes | yes | `client/datacenters/routes.ts` |
| `metadata` | yes | yes | `client/datacenters/routes.ts` (+1) |
| `options` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `name` | yes | yes | `client/datacenters/routes.ts` (+1) |
| `description` | yes | yes | `client/datacenters/routes.ts` |

**7. `server`** (export `server`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `developer/routes-core.ts` (+3) |
| `updated_at` | no | yes | Touched by hello/status writes; list/detail select other columns. |
| `metadata` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `organization_id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `name` | yes | yes | `client/authn/install-state.ts` (+3) |
| `hostname` | yes | yes | `client/authn/install-state.ts` (+3) |
| `machine_key` | yes | yes | `client/authn/install-state.ts` (+3) |
| `os_id` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_family` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_version` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_codename` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_pretty_name` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_architecture` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `timezone` | yes | yes | `client/openapi/servers.ts` (+3) |
| `is_time_sync_enabled` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `ntp_servers` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `ntp_last_synced_at` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `is_connected` | yes | yes | `client/managed/ha-recovery.ts` (+3) |
| `status_changed_at` | yes | yes | `client/servers/update-status.ts` (+3) |
| `daemon` | yes | yes | `daemon/authn/daemon-state.ts` (+3) |

**8. `license`** (export `license`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `client/authn/license.ts` |
| `updated_at` | no | yes | Touched on bind/revoke; list selects other columns. |
| `organization_id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `server_id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `name` | yes | yes | `client/authn/install-state.ts` (+2) |
| `token` | yes | yes | `client/authn/install-state.ts` (+1) |
| `revoked_at` | yes | yes | `client/authn/install-state.ts` (+3) |

**9. `command`** (export `command`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/environments/deployment-history-routes.ts` (+3) |
| `created_at` | yes | yes | `lib/db/command-records.ts` (+2) |
| `updated_at` | yes | yes | `lib/db/command-records.ts` |
| `metadata` | yes | yes | `lib/db/command-records.ts` |
| `options` | no | no | Pairing column; unused today (`command-records.ts` never selects/sets it). |
| `server_id` | yes | yes | `daemon/execution-log-ingest.ts` (+3) |
| `actor_type` | yes | yes | `lib/db/command-records.ts` (+1) |
| `actor_id` | yes | yes | `lib/db/command-records.ts` (+1) |
| `name` | yes | yes | `lib/db/command-records.ts` (+2) |
| `status` | yes | yes | `daemon/execution-log-ingest.ts` (+3) |
| `attempts` | yes | yes | `lib/db/command-records.ts` |
| `context` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `result_summary` | yes | yes | `lib/db/command-records.ts` (+1) |
| `error_code` | yes | yes | `lib/db/command-records.ts` (+1) |
| `error_message` | yes | yes | `lib/db/command-records.ts` (+1) |
| `queued_at` | yes | yes | `lib/db/command-records.ts` (+2) |
| `dispatch_started_at` | yes | yes | `lib/db/command-records.ts` |
| `sent_at` | yes | yes | `lib/db/command-records.ts` |
| `acked_at` | yes | yes | `lib/db/command-records.ts` |
| `started_at` | yes | yes | `lib/db/command-records.ts` (+1) |
| `finished_at` | yes | yes | `lib/db/command-records.ts` (+2) |
| `expires_at` | yes | yes | `lib/db/command-records.ts` |

**10. `dispatch`** (export `dispatch`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `command_id` | yes | yes | `lib/db/command-records.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` when dispatch row is inserted (`command-records.ts`). |
| `payload` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `expires_at` | yes | yes | Written by `retainCommandDispatch`; sweep reads `expires_at` in `command-records.ts`. |

**11. `network`** (export `network`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/networks/routes.ts` |
| `updated_at` | yes | yes | `client/networks/routes.ts` |
| `metadata` | yes | yes | `client/environments/validate-docker-external-networks.ts` (+1) |
| `options` | yes | yes | `client/environments/validate-docker-external-networks.ts` (+2) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `datacenter_id` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `server_id` | yes | yes | `client/environments/validate-docker-external-networks.ts` (+2) |
| `environment_id` | yes | yes | `client/managed/ingress-attachments.ts` (+1) |
| `kind` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `cidr` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `name` | yes | yes | `client/networks/routes.ts` (+1) |

**12. `fabric`** (export `fabric`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/fabric-records.ts` (+3) |
| `created_at` | yes | yes | `lib/net/private-endpoint.ts` |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert; no qualified select. |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | yes | yes | `lib/db/fabric-records.ts` (+2) |
| `organization_id` | yes | yes | `lib/commands/consumer.ts` (+2) |
| `cidr` | yes | yes | `lib/db/fabric-records.ts` |
| `name` | no | no | Nullable label; `insert(fabric)` in `fabric-records.ts` omits it. |

**13. `ip`** (export `ip`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/ips/routes.ts` (+2) |
| `updated_at` | yes | yes | `client/ips/routes.ts` |
| `metadata` | yes | yes | `client/ips/routes.ts` |
| `options` | yes | yes | `client/ips/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `datacenter_id` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `network_id` | yes | yes | `client/datacenters/routes.ts` (+2) |
| `server_id` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `address` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `allocation` | yes | yes | `client/ips/routes.ts` |
| `scope` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `description` | yes | yes | `client/ips/routes.ts` |

**14. `relay`** (export `relay`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/fabric-records.ts` (+2) |
| `created_at` | no | yes | Postgres `defaultNow()` on insert (`fabric-records.ts`). |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert/update. |
| `metadata` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+3) |
| `options` | yes | yes | `lib/db/fabric-records.ts` (+1) |
| `fabric_id` | yes | yes | `lib/db/fabric-records.ts` (+1) |
| `server_id` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+3) |
| `address` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+2) |
| `role` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+2) |
| `keepalive` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `endpoint_address` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `public_key` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `prefix` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `advertised_cidrs` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+2) |
| `preshared_key` | yes | yes | `lib/db/fabric-records.ts` |

**15. `segment`** (export `segment`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/fabric-records.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` on insert (`fabric-records.ts`). |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `metadata` | no | no | Pairing column; unused today (keep with `options`). |
| `options` | yes | yes | `lib/db/fabric-records.ts` |
| `network_id` | yes | yes | `client/managed/ingress-attachments.ts` (+1) |
| `server_id` | yes | yes | `client/managed/ingress-attachments.ts` (+1) |
| `cidr` | yes | yes | `lib/db/fabric-records.ts` |

**16. `workspace`** (export `workspace`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `client/workspaces/routes.ts` |
| `updated_at` | yes | yes | `client/workspaces/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `name` | yes | yes | `client/display-name-uniqueness.ts` (+3) |
| `description` | yes | yes | `client/workspaces/routes.ts` |
| `kind` | yes | yes | `client/authz/workspace-kind-ancestry.ts` (+3) |

**17. `project`** (export `project`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/projects/routes.ts` |
| `updated_at` | yes | yes | `client/projects/routes.ts` |
| `metadata` | yes | yes | `client/managed/context.ts` (+3) |
| `options` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `workspace_id` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `repository_id` | yes | yes | `lib/db/repository-records.ts` (+1) |
| `name` | yes | yes | `client/display-name-uniqueness.ts` (+2) |
| `description` | yes | yes | `client/projects/routes.ts` |

**18. `environment`** (export `environment`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/environments/routes.ts` |
| `updated_at` | yes | yes | `client/environments/routes.ts` |
| `metadata` | yes | yes | `client/environments/routes.ts` (+1) |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `project_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `server_id` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `generation` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `name` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `description` | yes | yes | `client/environments/routes.ts` (+1) |

**19. `managed`** (export `managed`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/managed/routes.ts` |
| `updated_at` | yes | yes | `client/managed/routes.ts` |
| `metadata` | yes | yes | `client/managed/routes.ts` (+3) |
| `options` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `environment_id` | yes | yes | `client/bindings/routes-helpers.ts` (+3) |
| `server_id` | yes | yes | `client/managed/routes.ts` (+1) |
| `name` | yes | yes | `client/managed/routes.ts` |
| `engine` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `status` | yes | yes | `client/managed/apply-prepare.ts` (+3) |

**20. `node`** (export `node`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/managed/ha-recovery.ts` (+3) |
| `created_at` | yes | yes | `client/managed/members.ts` |
| `updated_at` | yes | yes | `client/managed/members.ts` |
| `metadata` | yes | yes | `client/managed/members.ts` (+1) |
| `options` | yes | yes | `client/managed/members.ts` |
| `managed_id` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `server_id` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `role` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `replica_class` | yes | yes | `client/managed/ha-desired.ts` (+1) |
| `is_read_eligible` | yes | yes | `client/bindings/resolve-endpoint.ts` (+2) |
| `ordinal` | yes | yes | `client/bindings/resolve-endpoint.ts` (+2) |
| `replication_transport` | yes | yes | `client/managed/members.ts` |
| `private_port` | yes | yes | `client/managed/ingress-desired.ts` (+1) |
| `status` | yes | yes | `client/managed/members.ts` |

**21. `leaf`** (export `leaf`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `organization_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `server_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+1) |
| `kind` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+1) |
| `managed_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `node_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+1) |
| `ca_id` | no | yes | Written by leaf upsert (`client/tls/leaf-tracking.ts`); renewal sweep keys other columns. |
| `ca_generation` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `not_after` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `issued_at` | no | yes | Written on leaf upsert; not selected on the renewal path. |

**22. `recovery`** (export `recovery`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/managed/ha-recovery.ts` (+1) |
| `created_at` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `metadata` | yes | yes | `client/managed/ha-recovery.ts` |
| `options` | yes | no | `client/authn/install-state.ts` (insert/select on this table). |
| `managed_id` | yes | yes | `client/managed/ha-recovery.ts` (+1) |
| `kind` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `source_primary_member_id` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `target_member_id` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `state` | yes | yes | `lib/db/recovery-records.ts` |
| `started_at` | yes | yes | `lib/db/recovery-records.ts` |
| `completed_at` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |

**23. `variable`** (export `variable`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/variables/routes.ts` |
| `updated_at` | yes | yes | `client/variables/routes.ts` |
| `organization_id` | yes | yes | `client/variables/routes.ts` |
| `workspace_id` | yes | yes | `client/variables/routes.ts` |
| `project_id` | yes | yes | `client/variables/routes.ts` |
| `environment_id` | yes | yes | `client/projects/empty-setup.ts` (+1) |
| `service_id` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `hosting_id` | yes | yes | `client/bindings/routes-helpers.ts` (+1) |
| `server_id` | yes | yes | `client/variables/resolve-inherited.ts` (+1) |
| `binding_id` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `key` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `value` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `is_secret` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `is_literal` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `is_for_build` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `is_for_runtime` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `description` | yes | yes | `client/variables/routes.ts` |

**24. `service`** (export `service`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/services/routes.ts` |
| `updated_at` | yes | yes | `client/services/routes.ts` |
| `metadata` | yes | yes | `client/services/routes.ts` |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `environment_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `name` | yes | yes | `client/bindings/impact.ts` (+1) |
| `description` | yes | yes | `client/services/routes.ts` |
| `compose_service_name` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |

**25. `deployment`** (export `deployment`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/deployment-records.ts` |
| `created_at` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `metadata` | yes | yes | `lib/db/deployment-records.ts` |
| `options` | yes | yes | `client/environments/deploy-routes.ts` (+1) |
| `environment_id` | yes | yes | `client/environments/site-releases.ts` (+3) |
| `server_id` | yes | yes | `daemon/rehydrate-secrets.ts` (+2) |
| `desired_generation` | yes | yes | `lib/db/deployment-history.ts` |
| `applied_generation` | yes | yes | `lib/db/deployment-history.ts` |
| `desired_hash` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `status` | yes | yes | `lib/commands/consumer.ts` (+2) |
| `last_command_id` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `finished_at` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `duration_ms` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `outcome` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |

**26. `task`** (export `task`)

Cron-style scheduled command on a service. Constraints: `uniq_task_service_name`
on `(service_id, name)`; `idx_task_service_id`; `task_concurrency_policy_check`
`IN ('allow','forbid','replace')`; `task_service_id_service_id_fk` CASCADE. No
execution columns (`last_run_at` / result) and no run-history table.

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/task-records.ts` |
| `created_at` | yes | yes | `lib/db/task-records.ts` |
| `updated_at` | yes | yes | `lib/db/task-records.ts` |
| `metadata` | yes | yes | `client/tasks/routes.ts` |
| `options` | yes | yes | `client/tasks/routes.ts` |
| `service_id` | yes | yes | `lib/db/task-records.ts` |
| `name` | yes | yes | `lib/db/task-records.ts` |
| `schedule` | yes | yes | `client/tasks/routes.ts` |
| `command` | yes | yes | `client/tasks/routes.ts` |
| `timezone` | yes | yes | `client/tasks/routes.ts` |
| `is_enabled` | yes | yes | `client/tasks/routes.ts` |
| `concurrency_policy` | yes | yes | `client/tasks/routes.ts` |
| `timeout_seconds` | yes | yes | `client/tasks/routes.ts` |

**27. `label`** (export `label`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/password.ts` (insert/select on this table). |
| `created_at` | yes | yes | `client/authn/password.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `client/authn/password.ts` (insert/select on this table). |
| `server_id` | yes | yes | `lib/db/label-records.ts` |
| `key` | yes | yes | `lib/db/label-records.ts` (+1) |
| `value` | yes | yes | `lib/schedule/plan-deploy.ts` |

**28. `hosting`** (export `hosting`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/hostings/routes.ts` |
| `updated_at` | yes | yes | `client/hostings/routes.ts` |
| `metadata` | yes | yes | `client/hostings/routes.ts` |
| `options` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `service_id` | yes | yes | `client/bindings/routes-helpers.ts` (+3) |
| `tls_id` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `ip_id` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `name` | yes | yes | `client/hostings/routes.ts` |
| `description` | yes | yes | `client/hostings/routes.ts` |

**29. `container`** (export `container`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/containers/routes.ts` (+1) |
| `updated_at` | yes | yes | `client/containers/routes.ts` (+1) |
| `metadata` | yes | yes | `client/containers/routes.ts` (+1) |
| `options` | yes | yes | `client/containers/routes.ts` (+1) |
| `service_id` | yes | yes | `client/containers/routes.ts` (+3) |
| `server_id` | yes | yes | `client/containers/routes.ts` (+3) |
| `container_id` | yes | yes | `client/containers/routes.ts` (+3) |
| `container_name` | yes | yes | `client/containers/routes.ts` (+3) |
| `status` | yes | yes | `client/containers/routes.ts` (+3) |
| `role` | yes | yes | `client/containers/routes.ts` (+3) |
| `compose_service_name` | yes | yes | `client/containers/routes.ts` (+3) |
| `ordinal` | yes | yes | `client/containers/routes.ts` (+3) |

**30. `principal`** (export `principal`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/managed/routes.ts` (+2) |
| `updated_at` | yes | yes | `client/managed/routes.ts` (+2) |
| `metadata` | yes | yes | `client/bindings/routes.ts` (+3) |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `kind` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `provider` | yes | yes | `client/managed/routes.ts` (+3) |
| `username` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `password` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `project_id` | yes | yes | `client/principals/reconcile.ts` (+3) |
| `managed_id` | yes | yes | `client/bindings/impact.ts` (+3) |

**31. `entitlement`** (export `entitlement`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | yes | PK default on insert (`principals/store.ts`); list selects runtime/series/granted_by. |
| `created_at` | no | yes | Postgres `defaultNow()` on insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `principal_id` | yes | yes | `client/principals/store.ts` |
| `runtime` | yes | yes | `client/principals/store.ts` |
| `series` | yes | yes | `client/principals/store.ts` |
| `granted_by` | yes | yes | `client/principals/store.ts` |

**32. `ssh`** (export `sshKey`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/principals/ssh-keys.ts` |
| `created_at` | yes | yes | `client/principals/ssh-keys.ts` |
| `updated_at` | no | yes | Postgres `defaultNow()`; `ssh-keys.ts` selects other columns. |
| `principal_id` | yes | yes | `client/principals/ssh-keys.ts` |
| `name` | yes | yes | `client/principals/ssh-keys.ts` |
| `key_type` | yes | yes | `client/principals/ssh-keys.ts` |
| `public_key` | yes | yes | `client/principals/ssh-keys.ts` |
| `fingerprint` | yes | yes | `client/principals/ssh-keys.ts` |
| `comment` | yes | yes | `client/principals/ssh-keys.ts` |
| `user_id` | no | yes | Written as provenance on insert (`ssh-keys.ts`); not selected on list. |
| `bits` | yes | yes | `client/principals/ssh-keys.ts` |

**33. `tenancy`** (export `tenancy`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | yes | PK default; join queries use `principal_id` / `service_id`. |
| `created_at` | no | yes | Postgres `defaultNow()` on insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `principal_id` | yes | yes | `client/principals/tenancies.ts` (+1) |
| `service_id` | yes | yes | `client/principals/tenancies.ts` (+1) |

**34. `binding`** (export `binding`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `created_at` | yes | yes | `client/bindings/routes.ts` |
| `updated_at` | yes | yes | `client/bindings/routes.ts` |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | no | no | Pairing column; unused today. |
| `principal_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `service_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `database_name` | yes | yes | `client/bindings/impact.ts` (+2) |
| `key_prefix` | yes | yes | `client/bindings/impact.ts` (+3) |
| `is_emit_engine_defaults` | yes | yes | `client/bindings/materialize.ts` (+2) |

**35. `credential`** (export `credential`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+2) |
| `created_at` | no | yes | Postgres `defaultNow()` on insert (`client/repositories/routes.ts`). |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `metadata` | no | yes | Written on deploy-key create (`publicKey` / fingerprint jsonb). |
| `options` | no | no | Pairing column; unused today. |
| `organization_id` | yes | yes | `client/repositories/routes.ts` |
| `principal_id` | no | no | Optional FK present in schema; no first-party insert/select of `credential.principalId`. |
| `provider` | yes | yes | `client/repositories/routes-helpers.ts` (+1) |
| `name` | no | yes | Written on deploy-key create (`client/repositories/routes.ts` insert); not later selected qualified. |
| `secret_envelope` | yes | yes | `admin/reencrypt-secrets.ts` (+1) |
| `expires_at` | no | no | No table-qualified `credential.expiresAt` anywhere in `src/` (other tables' `expires_at` are unrelated). |

**36. `storage`** (export `storage`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/storage/routes.ts` |
| `updated_at` | yes | yes | `client/storage/routes.ts` |
| `metadata` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `options` | yes | yes | `client/storage/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `workspace_id` | yes | yes | `client/storage/routes.ts` (+1) |
| `project_id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `environment_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `service_id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `kind` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `name` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `access_mode` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `retention` | yes | yes | `client/storage/routes.ts` (+1) |
| `generation` | yes | yes | `client/storage/routes.ts` |
| `principal_id` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `content_envelope` | yes | yes | `admin/reencrypt-secrets.ts` (+1) |

**37. `location`** (export `location`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `created_at` | yes | yes | `client/storage/routes.ts` |
| `updated_at` | yes | yes | `client/storage/routes.ts` |
| `metadata` | yes | yes | `client/storage/routes.ts` |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `storage_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `server_id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `credential_id` | yes | yes | `client/storage/routes.ts` |
| `provider` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `role` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `state` | yes | yes | `client/storage/routes.ts` |
| `path` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `endpoint` | yes | yes | `client/storage/routes.ts` |
| `generation` | yes | yes | `client/storage/routes.ts` |

**38. `mount`** (export `mount`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/storage/routes.ts` |
| `created_at` | yes | yes | `client/storage/routes.ts` |
| `updated_at` | yes | yes | `client/storage/routes.ts` |
| `metadata` | yes | yes | `client/storage/routes.ts` |
| `options` | yes | yes | `client/storage/routes.ts` |
| `storage_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `service_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `destination_path` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `subpath` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `is_read_only` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |

**39. `gitapp`** (export `forge`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/forges/handlers.ts` (+2) |
| `created_at` | yes | yes | `lib/git/forge-records.ts` |
| `updated_at` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `metadata` | yes | no | `client/forges/handlers.ts` (insert/select on this table). |
| `options` | yes | no | `client/forges/handlers.ts` (insert/select on this table). |
| `organization_id` | yes | yes | `client/forges/handlers.ts` (+1) |
| `provider` | yes | yes | `client/repositories/routes.ts` (+1) |
| `name` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `base_url` | yes | yes | `client/repositories/routes.ts` |
| `api_url` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `external_app_id` | yes | yes | `lib/git/forge-records.ts` |
| `app_slug` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `client_id` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `redirect_uri` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `webhook_origin` | yes | yes | `client/repositories/routes.ts` |
| `is_public` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `custom_git_user` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `custom_git_port` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `synced_at` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `envelopes` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `webhook_ref` | yes | yes | `client/repositories/routes.ts` (+1) |
| `webhook_token_hash` | yes | yes | `lib/git/forge-records.ts` |

**40. `installation`** (export `gitConnection`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/repositories/routes.ts` |
| `updated_at` | yes | yes | `client/repositories/routes.ts` |
| `metadata` | yes | yes | `client/repositories/routes.ts` |
| `options` | yes | yes | `client/repositories/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `app_id` | yes | yes | `client/repositories/routes.ts` (+2) |
| `provider` | yes | yes | `client/repositories/routes.ts` (+3) |
| `external_installation_id` | yes | yes | `client/repositories/routes.ts` (+2) |
| `account_login` | yes | yes | `client/repositories/routes.ts` |
| `account_type` | yes | yes | `client/repositories/routes.ts` |
| `suspended_at` | yes | yes | `client/repositories/routes.ts` (+3) |
| `oauth_envelope` | yes | yes | `lib/git/gitlab-oauth-token.ts` |

**41. `repository`** (export `repository`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/repositories/routes.ts` (+1) |
| `updated_at` | yes | yes | `client/repositories/routes.ts` |
| `metadata` | yes | yes | `client/repositories/routes.ts` |
| `options` | yes | yes | `client/repositories/routes.ts` (+1) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `installation_id` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `service_id` | yes | yes | `client/repositories/routes.ts` (+1) |
| `environment_id` | yes | yes | `client/repositories/routes.ts` (+1) |
| `credential_id` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `provider` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `repository_url` | yes | yes | `client/environments/deploy-sources.ts` (+1) |
| `repository_external_id` | yes | yes | `client/repositories/routes.ts` (+2) |
| `default_branch` | yes | yes | `client/environments/deploy-sources.ts` (+3) |
| `subdirectory` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `auto_deploy` | yes | yes | `client/repositories/routes.ts` (+1) |

**42. `delivery`** (export `webhookDelivery`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/webhook-delivery-records.ts` |
| `created_at` | yes | yes | Default on insert; sweep cursor in `webhook-delivery-records.ts`. |
| `provider` | yes | yes | `lib/db/webhook-delivery-records.ts` |
| `external_delivery_id` | yes | yes | `lib/db/webhook-delivery-records.ts` |
| `event` | no | yes | Written on claim insert; not selected after. |

**43. `grant`** (export `grant`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/access/routes.ts` (+3) |
| `created_at` | yes | yes | `client/access/routes.ts` |
| `actor_type` | yes | yes | `client/access/routes.ts` (+3) |
| `actor_id` | yes | yes | `client/access/routes.ts` (+3) |
| `entity_type` | yes | yes | `client/access/routes.ts` (+3) |
| `entity_id` | yes | yes | `client/access/routes.ts` (+3) |
| `permission` | yes | yes | `client/access/routes.ts` (+3) |

**44. `session`** (export `session`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/session-store.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` on session insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on session insert. |
| `user_id` | yes | yes | `client/access/routes.ts` (+3) |
| `expires_at` | yes | yes | `client/authn/session-store.ts` |
| `token` | yes | yes | `client/authn/session-store.ts` |
| `ip_address` | no | yes | Written by `createSession` (`session-store.ts`); login lookup does not select it. |
| `user_agent` | no | yes | Written by `createSession`; login lookup does not select it. |

**45. `setting`** (export `setting`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` |
| `created_at` | yes | yes | `admin/openapi/index.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `admin/openapi/index.ts` (insert/select on this table). |
| `key` | yes | yes | `admin/public-urls.ts` (+3) |
| `value` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |

**46. `account`** (export `account`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/otp-http.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` on account insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on account insert. |
| `user_id` | yes | yes | `client/authn/credentials.ts` (+2) |
| `provider_id` | yes | yes | `client/authn/credentials.ts` (+1) |
| `provider_user_id` | no | yes | Written on credential-account insert (`install-state.ts`, `http.ts`); not later selected. |
| `access_token` | no | no | OAuth leftover; credential accounts only write `password` / `provider_id`. |
| `refresh_token` | no | no | OAuth leftover; unused. |
| `id_token` | no | no | OAuth leftover; unused. |
| `access_token_expires_at` | no | no | OAuth leftover; unused. |
| `refresh_token_expires_at` | no | no | OAuth leftover; unused. |
| `scope` | no | no | OAuth leftover; unused. |
| `password` | yes | yes | `client/authn/credentials.ts` |

**47. `teammate`** (export `teammate`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/org-context.ts` |
| `created_at` | no | yes | `client/access/routes.ts` (insert/select on this table). |
| `team_id` | yes | yes | `client/access/routes.ts` (+3) |
| `user_id` | yes | yes | `client/access/routes.ts` (+3) |

**48. `team`** (export `team`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/access/routes.ts` (+3) |
| `created_at` | yes | yes | `client/teams/routes.ts` |
| `updated_at` | yes | yes | `client/teams/routes.ts` |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | no | no | Pairing column; unused today. |
| `organization_id` | yes | yes | `client/access/routes.ts` (+3) |
| `name` | yes | yes | `client/teams/routes.ts` |

**49. `user`** (export `user`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/credentials.ts` (+3) |
| `created_at` | no | yes | Postgres `defaultNow()` on user insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on user insert/update. |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | no | no | Pairing column; unused today. |
| `name` | no | no | Sign-in is email-only; inserts omit `user.name`. |
| `email` | yes | yes | `client/authn/credentials.ts` (+3) |
| `is_email_verified` | yes | yes | `client/authn/credentials.ts` (+2) |
| `is_2fa_enabled` | no | no | No first-party reader/writer; 2FA table also unused. |
| `is_disabled` | yes | yes | `client/authn/credentials.ts` (+2) |
| `role` | yes | yes | `client/authn/install-state.ts` (+3) |

**50. `2fa`** (export `twoFactor`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `created_at` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `user_id` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `secret` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `is_verified` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `backup_codes` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |

**51. `verification`** (export `verification`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/email-otp.ts` (+1) |
| `created_at` | yes | yes | `client/authn/email-otp.ts` |
| `updated_at` | no | yes | Postgres `defaultNow()` on OTP/email-verification upsert. |
| `expires_at` | yes | yes | `client/authn/email-otp.ts` (+1) |
| `identifier` | yes | yes | `client/authn/email-otp.ts` (+1) |
| `value` | yes | yes | `client/authn/email-otp.ts` (+1) |

Authz raw-SQL touch points (flag only; **do not edit in this phase**):
`src/client/authz/evaluator.ts`, `src/client/authz/create-access-grant.ts`,
`src/client/authz/workspace-kind-ancestry.ts`. After cutover, every
hand-written `sql` tagged-template fragment that names `copy`, `tag`, or `subnet` must
double-quote those identifiers (`"copy"`, `"tag"`, `"subnet"`) because
they are SQL-adjacent words.

There is no Storage-classification or Subsystem-docs table **in this
file** — those live in the repo-root `AGENTS.md`. Stray old table names
in **this** file are corrected in Step 4 below.

### Step 2 — Locked table renames

Mechanical substitution: in every listed FK/constraint/index name, replace
the old physical-table token with the new one, and apply the listed column
renames (which also rewrite FK constraint names that embed the old column).

| Old table (export) | New table (export) | FK/constraint/index names to rename (old → new) | FK columns to rename |
| --- | --- | --- | --- |
| `gitapp` (`forge`) | `forge` (`forge`) | `idx_gitapp_organization_id` → `idx_forge_organization_id`; `idx_gitapp_provider` → `idx_forge_provider`; `gitapp_organization_id_organization_id_fk` → `forge_organization_id_organization_id_fk`; `gitapp_provider_check` → `forge_provider_check`; `uniq_gitapp_webhook_ref` → `uniq_forge_webhook_ref`; `uniq_gitapp_provider_base_external` → `uniq_forge_provider_base_external`; `uniq_gitapp_webhook_token_hash` → `uniq_forge_webhook_token_hash` | `gitapp.credentials` → `forge.envelopes` |
| `installation` (`gitConnection`) | `connection` (`gitConnection`) | `idx_installation_organization_id` → `idx_connection_organization_id`; `idx_installation_app_id` → `idx_connection_forge_id`; `installation_organization_id_organization_id_fk` → `connection_organization_id_organization_id_fk`; `installation_app_id_gitapp_id_fk` → `connection_forge_id_forge_id_fk`; `installation_provider_check` → `connection_provider_check`; `uniq_installation_organization_app_external` → `uniq_connection_organization_forge_external` | `installation.app_id` → `connection.forge_id` |
| `source` (`source`) | `repository` (`repository`) | `idx_source_organization_id` → `idx_repository_organization_id`; `idx_source_installation_id` → `idx_repository_connection_id`; `idx_source_service_id` → `idx_repository_service_id`; `idx_source_environment_id` → `idx_repository_environment_id`; `idx_source_credential_id` → `idx_repository_secret_id`; `source_organization_id_organization_id_fk` → `repository_organization_id_organization_id_fk`; `source_installation_id_installation_id_fk` → `repository_connection_id_connection_id_fk`; `source_service_id_service_id_fk` → `repository_service_id_service_id_fk`; `source_environment_id_environment_id_fk` → `repository_environment_id_environment_id_fk`; `source_credential_id_credential_id_fk` → `repository_secret_id_secret_id_fk`; `uniq_source_organization_installation_repository` → `uniq_repository_organization_connection_repository`; `source_provider_check` → `repository_provider_check`; `source_auto_deploy_check` → `repository_auto_deploy_check`; `source_at_most_one_parent_check` → `repository_at_most_one_parent_check` | `source.installation_id` → `repository.connection_id`; `source.credential_id` → `repository.secret_id` |
| `steward` (`steward`) | `tenancy` (`tenancy`) | `idx_steward_principal_id` → `idx_tenancy_principal_id`; `idx_steward_service_id` → `idx_tenancy_service_id`; `steward_principal_id_principal_id_fk` → `tenancy_principal_id_principal_id_fk`; `steward_service_id_service_id_fk` → `tenancy_service_id_service_id_fk`; `steward_principal_service_unique` → `tenancy_principal_service_unique` | none |
| `location` (`location`) | `copy` (export `storageCopy`) | `idx_location_storage_id` → `idx_copy_storage_id`; `idx_location_server_id` → `idx_copy_server_id`; `idx_location_credential_id` → `idx_copy_secret_id`; `location_storage_id_storage_id_fk` → `copy_storage_id_storage_id_fk`; `location_server_id_server_id_fk` → `copy_server_id_server_id_fk`; `location_credential_id_credential_id_fk` → `copy_secret_id_secret_id_fk`; `uniq_location_storage_primary` → `uniq_copy_storage_primary`; `uniq_location_storage_server_provider` → `uniq_copy_storage_server_provider`; `location_provider_check` → `copy_provider_check`; `location_role_check` → `copy_role_check`; `location_state_check` → `copy_state_check` | `location.credential_id` → `copy.secret_id` (`copy.storage_id` / `copy.server_id` unchanged) |
| `credential` (`credential`) | `secret` (`secret`) | `idx_credential_organization_id` → `idx_secret_organization_id`; `idx_credential_principal_id` → `idx_secret_principal_id`; `credential_organization_id_organization_id_fk` → `secret_organization_id_organization_id_fk`; `credential_principal_id_principal_id_fk` → `secret_principal_id_principal_id_fk`; `credential_provider_check` → `secret_provider_check` | none (referencing columns renamed on their own tables above) |
| `node` (`node`) | `replica` (`replica`) | `idx_node_managed_id` → `idx_replica_managed_id`; `idx_node_server_id` → `idx_replica_server_id`; `node_managed_id_managed_id_fk` → `replica_managed_id_managed_id_fk`; `node_server_id_server_id_fk` → `replica_server_id_server_id_fk`; `uniq_node_primary` → `uniq_replica_primary`; `uniq_node_server_private_port` → `uniq_replica_server_private_port`; `uniq_node_managed_ordinal` → `uniq_replica_managed_ordinal`; `uniq_node_managed_server` → `uniq_replica_managed_server`; `node_role_check` → `replica_role_check`; `node_replica_class_check` → `replica_replica_class_check`; `node_ordinal_positive_check` → `replica_ordinal_positive_check`; `node_transport_check` → `replica_transport_check`; `node_status_check` → `replica_status_check` | `leaf.node_id` → `leaf.replica_id` (and its FK `leaf_node_id_node_id_fk` → `leaf_replica_id_replica_id_fk` / unique `uniq_leaf_engine_node` → `uniq_leaf_engine_replica`) |
| `segment` (`segment`) | `subnet` (`subnet`) | `idx_segment_network_id` → `idx_subnet_network_id`; `idx_segment_server_id` → `idx_subnet_server_id`; `segment_network_id_network_id_fk` → `subnet_network_id_network_id_fk`; `segment_server_id_server_id_fk` → `subnet_server_id_server_id_fk`; `segment_network_server_unique` → `subnet_network_server_unique` | none (`subnet.network_id` / `subnet.server_id` unchanged) |
| `rotation` (`rotation`) | `changeover` (`changeover`) | `idx_rotation_organization_id` → `idx_changeover_organization_id`; `rotation_organization_id_organization_id_fk` → `changeover_organization_id_organization_id_fk`; `uniq_rotation_inflight_organization` → `uniq_changeover_inflight_organization`; `rotation_state_check` → `changeover_state_check` | none |
| `task` (`task`, replica-slot meaning) | `slot` (`slot`) | `uniq_task_service_slot` → `uniq_slot_service_slot`; `idx_task_environment_generation` → `idx_slot_environment_generation`; `idx_task_server_id` → `idx_slot_server_id`; `task_environment_id_environment_id_fk` → `slot_environment_id_environment_id_fk`; `task_service_id_service_id_fk` → `slot_service_id_service_id_fk`; `task_server_id_server_id_fk` → `slot_server_id_server_id_fk`; `task_slot_nonnegative_check` → `slot_slot_nonnegative_check`; `task_desired_state_check` → `slot_desired_state_check` | none — table keeps its own columns (`environment_id`, `service_id`, `server_id`, `address`, `slot`, `generation`, `desired_state`) |

**Forthcoming (not created in phase 2's rename pass; owned by later phases):**
a **new-meaning** `task` (cron). The replica-slot table
is `slot`; the cron table reclaims the physical name `task` after that
rename (helpers `src/lib/db/task-records.ts`; client CRUD
`src/client/tasks/routes.ts`). `tag` / `marker` exist (helpers `src/lib/db/tag-records.ts`). `copy`,
`tag`, and `subnet` are SQL-adjacent words — double-quote
them in every hand-written `sql` tagged-template fragment (known touch points listed in
Step 1).

### Step 3 — Column adjudication

Phase 2 implements **exactly** the DDL delta below (plus the Step 2
table/FK/index/column renames). Every other inventoried column and
named constraint is **Keep**. The complete catalog that follows is
the mechanical checklist — one keep/rename/drop line per schema item
so cutover does not re-open `schema.ts` to guess.

#### DDL delta (the only mutations besides Step 2 renames)

| Current identifier | Decision | Reason |
| --- | --- | --- |
| `hosting.name` (`hosting_name_format_check`) | **Drop the CHECK**, keep the column | Validation is app-side (`display-name-format.ts`) per the documented names-are-labels rule. |
| `datacenter.name` (`datacenter_name_format_check`) | **Drop the CHECK**, keep the column | Same reason. |
| `gitapp.credentials` | **Rename** to `forge.envelopes` | Stops the name clash with the new `secret` table; contents unchanged (`privateKeyEnvelope?`, `clientSecretEnvelope?`, `webhookSecretEnvelope?`). |
| `installation.provider` (becomes `connection.provider`) | **Keep** | Hot denormalized filter column: `src/client/repositories/routes.ts`, `webhook-trigger.ts`, `github-app-token.ts`, `gitlab-oauth-token.ts` select/filter it directly rather than always joining `forge.provider`. |
| `service.compose_service_name` / `container.compose_service_name` | **Keep both** | Independently authoritative — `service` is the compose key of the logical service; `container` is the reported/allocated Docker identity. Shared name is not a true duplicate; phase 2 must not conflate them. |
| `storage.generation` | **Keep** | Step 1 found an API reader (`STORAGE_SELECT` in `src/client/storage/routes.ts` + `serialize.ts`). Materialization tracking still uses `location.generation` (→ `copy.generation`); the storage-level column is the identity generation the API already echoes. |
| `principal.metadata.home` | **Keep** (no DDL) | jsonb field inside `metadata`, not a column. Intentionally mirrors the derived `/srv/users/<username>` path for display. Phase 3+ code auditors only. |
| `command.options` | **Keep** | `metadata`/`options` pairing is a hard schema rule. Unused today; dropping would break the invariant for no gain. |
| `service.metadata` / `service.options` | **Keep** | Same pairing convention; reserved for future non-indexed facts / per-service placement. |
| `mount.metadata` / `mount.options` | **Keep** | Same pairing convention. |
| `segment.metadata` / `segment.options` (→ `subnet`) | **Keep** | Same pairing convention. |
| `location.provider` CHECK (`block`/`nfs`/`cifs`/`s3`/`s3_compatible`/`sftp`/`ftp`/`webdav` plus live `docker`/`path`) | **Keep** all values | `docker`/`path` are exercised today; the remainder mirror `credential.provider`'s CHECK and are pre-provisioned for the storage-provider roadmap in the `location`/`storage` doc comments — not dead, just unimplemented. |
| `credential.provider` CHECK (→ `secret.provider`) | **Keep** all values | Same forward-provisioning reason; `git_deploy_key` is already live. |
| `organization.slug` | **Keep** column + `organization_slug_unique` | Documented always-NULL / reserved for a future feature. Writes never populate it; the unique is defensive. |
| `credential.expires_at` (would have become `secret.expires_at`) | **Drop** | Step 1 grep found no reader — no credential-rotation or expiry-sweep path references `credential.expiresAt` / `credential.expires_at`. |

#### Complete keep / rename / drop catalog

One line per column and per named constraint. Table renames themselves
are in Step 2; this catalog records what happens to each item **on**
those tables.

**1. `invitation`** (export `invitation` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `invitation.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `invitation.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `invitation.user_id` | column | **Keep** | Live column. Present on the accept select; no first-party insert. |
| `invitation.team_id` | column | **Keep** | Live column. Present on the accept select; no first-party insert. |
| `invitation.expires_at` | column | **Keep** | Live column. `client/access/routes.ts` |
| `invitation.email` | column | **Keep** | Live column. Read on accept (`client/access/routes.ts`). **No first-party `insert(invitation)`**. |
| `invitation.status` | column | **Keep** | Live column. `client/access/routes.ts` |
| `invitation.grants` | column | **Keep** | Live column. Read on accept; no first-party insert. |
| `idx_invitation_email` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_invitation_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_invitation_team_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `invitation_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `invitation_team_id_team_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**2. `organization`** (export `organization` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `organization.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `organization.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `organization.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `organization.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `organization.options` | column | **Keep** | Live jsonb; `client/bindings/materialize.ts` (+3) |
| `organization.name` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `organization.slug` | column | **Keep** | Always-NULL reserved slug + `organization_slug_unique`; developer status echoes it. |
| `organization_slug_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**3. `tls`** (export `tls` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `tls.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `tls.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `tls.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `tls.metadata` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+3) |
| `tls.options` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+3) |
| `tls.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `tls.name` | column | **Keep** | Live column. `client/tls/organization-ca.ts` (+1) |
| `tls.source` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+3) |
| `tls.certificate_pem` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `tls.private_key_pem` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+2) |
| `tls.status` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+3) |
| `tls.not_after` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `tls.fingerprint_sha256` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `tls.ca_state` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+2) |
| `tls.ca_generation` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+2) |
| `idx_tls_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_tls_not_after` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_tls_organization_ca_generation` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_tls_organization_fingerprint_sha256` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_tls_organization_active_ca` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_source_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_state_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_lifecycle_source_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_generation_source_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_generation_required_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**4. `rotation`** → `changeover` (export `changeover`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `rotation.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `rotation.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `rotation.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `rotation.metadata` | column | **Keep** | Live jsonb; table insert/select |
| `rotation.options` | column | **Keep** | Live jsonb; table insert/select |
| `rotation.organization_id` | column | **Keep** | Live column. `client/tls/changeover-lease.ts` |
| `rotation.from_ca_generation` | column | **Keep** | Live column. table insert/select |
| `rotation.to_ca_generation` | column | **Keep** | Live column. table insert/select |
| `rotation.state` | column | **Keep** | Live column. `client/tls/changeover-lease.ts` |
| `rotation.started_at` | column | **Keep** | Live column. `client/tls/changeover-lease.ts` |
| `rotation.completed_at` | column | **Keep** | Live column. table insert/select |
| `rotation.results` | column | **Keep** | Live column. `client/tls/changeover-fanout.ts` |
| `idx_rotation_organization_id` | index | **Rename** → `idx_changeover_organization_id` | Step 2 mechanical token substitution. |
| `uniq_rotation_inflight_organization` | uniqueIndex | **Rename** → `uniq_changeover_inflight_organization` | Step 2 mechanical token substitution. |
| `rotation_state_check` | check | **Rename** → `changeover_state_check` | Step 2 mechanical token substitution. |
| `rotation_organization_id_organization_id_fk` | fk | **Rename** → `changeover_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |

**5. `passkey`** (export `passkey` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `passkey.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `passkey.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `passkey.user_id` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.aaguid` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.name` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.public_key` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.credential_id` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.counter` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.device_type` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.is_backed_up` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.transports` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `idx_passkey_credential_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_passkey_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `passkey_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**6. `datacenter`** (export `datacenter` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `datacenter.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `datacenter.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `datacenter.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `datacenter.metadata` | column | **Keep** | Live jsonb; `client/datacenters/routes.ts` (+1) |
| `datacenter.options` | column | **Keep** | Live jsonb; `client/datacenters/routes.ts` (+3) |
| `datacenter.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `datacenter.name` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+1) |
| `datacenter.description` | column | **Keep** | Live column. `client/datacenters/routes.ts` |
| `idx_datacenter_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `datacenter_name_format_check` | check | **Drop** | Name-format CHECK contradicts app-side `display-name-format.ts`; column stays. |
| `datacenter_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**7. `server`** (export `server` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `server.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `server.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `server.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `server.metadata` | column | **Keep** | Live jsonb; `client/datacenters/routes.ts` (+3) |
| `server.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `server.organization_id` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.name` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.hostname` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.machine_key` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.os_id` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_family` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_version` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_codename` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_pretty_name` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_architecture` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.timezone` | column | **Keep** | Live column. `client/openapi/servers.ts` (+3) |
| `server.is_time_sync_enabled` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.ntp_servers` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.ntp_last_synced_at` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.is_connected` | column | **Keep** | Live column. `client/managed/ha-recovery.ts` (+3) |
| `server.status_changed_at` | column | **Keep** | Live column. `client/servers/update-status.ts` (+3) |
| `server.daemon` | column | **Keep** | Live column. `daemon/authn/daemon-state.ts` (+3) |
| `idx_server_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_server_machine_key` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_server_hostname` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_server_connected` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `server_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**8. `license`** (export `license` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `license.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `license.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `license.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `license.organization_id` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `license.server_id` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `license.name` | column | **Keep** | Live column. `client/authn/install-state.ts` (+2) |
| `license.token` | column | **Keep** | Live column. `client/authn/install-state.ts` (+1) |
| `license.revoked_at` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `idx_license_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_license_server_id` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `license_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `license_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**9. `command`** (export `command` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `command.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `command.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `command.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `command.metadata` | column | **Keep** | Live jsonb; `lib/db/command-records.ts` |
| `command.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `command.server_id` | column | **Keep** | Live column. `daemon/execution-log-ingest.ts` (+3) |
| `command.actor_type` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.actor_id` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.name` | column | **Keep** | Live column. `lib/db/command-records.ts` (+2) |
| `command.status` | column | **Keep** | Live column. `daemon/execution-log-ingest.ts` (+3) |
| `command.attempts` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.context` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+3) |
| `command.result_summary` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.error_code` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.error_message` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.queued_at` | column | **Keep** | Live column. `lib/db/command-records.ts` (+2) |
| `command.dispatch_started_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.sent_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.acked_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.started_at` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.finished_at` | column | **Keep** | Live column. `lib/db/command-records.ts` (+2) |
| `command.expires_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `idx_command_server_id_created_at` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_command_status` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_command_deploy_environment_created` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `command_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**10. `dispatch`** (export `dispatch` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `dispatch.command_id` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `dispatch.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `dispatch.payload` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `dispatch.expires_at` | column | **Keep** | Live column. Written by `retainCommandDispatch`; sweep reads `expires_at` in `command-records.ts`. |
| `idx_dispatch_expires_at` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `dispatch_command_id_command_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**11. `network`** (export `network` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `network.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `network.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `network.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `network.metadata` | column | **Keep** | Live jsonb; `client/environments/validate-docker-external-networks.ts` (+1) |
| `network.options` | column | **Keep** | Live jsonb; `client/environments/validate-docker-external-networks.ts` (+2) |
| `network.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `network.datacenter_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `network.server_id` | column | **Keep** | Live column. `client/environments/validate-docker-external-networks.ts` (+2) |
| `network.environment_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `network.kind` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `network.cidr` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `network.name` | column | **Keep** | Live column. `client/networks/routes.ts` (+1) |
| `idx_network_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_network_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_network_datacenter_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_network_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_network_datacenter_cidr` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_single_scope_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_datacenter_id_datacenter_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**12. `fabric`** (export `fabric` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `fabric.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `fabric.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `fabric.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `fabric.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `fabric.options` | column | **Keep** | Live jsonb; `lib/db/fabric-records.ts` (+2) |
| `fabric.organization_id` | column | **Keep** | Live column. `lib/commands/consumer.ts` (+2) |
| `fabric.cidr` | column | **Keep** | Live column. `lib/db/fabric-records.ts` |
| `fabric.name` | column | **Keep** | Nullable display label; not populated by enable-fabric. |
| `idx_fabric_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_fabric_organization_id` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `fabric_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `fabric_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**13. `ip`** (export `ip` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `ip.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `ip.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ip.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ip.metadata` | column | **Keep** | Live jsonb; `client/ips/routes.ts` |
| `ip.options` | column | **Keep** | Live jsonb; `client/ips/routes.ts` |
| `ip.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `ip.datacenter_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `ip.network_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+2) |
| `ip.server_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `ip.address` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `ip.allocation` | column | **Keep** | Live column. `client/ips/routes.ts` |
| `ip.scope` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `ip.description` | column | **Keep** | Live column. `client/ips/routes.ts` |
| `idx_ip_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_datacenter_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_network_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_scope_server_datacenter` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_ip_org_address` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_allocation_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_scope_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_scope_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_anchor_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_member_network_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_id_datacenter_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_network_id_network_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**14. `relay`** (export `relay` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `relay.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `relay.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `relay.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `relay.metadata` | column | **Keep** | Live jsonb; `client/organizations/fabric-routes-helpers.ts` (+3) |
| `relay.options` | column | **Keep** | Live jsonb; `lib/db/fabric-records.ts` (+1) |
| `relay.fabric_id` | column | **Keep** | Live column. `lib/db/fabric-records.ts` (+1) |
| `relay.server_id` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+3) |
| `relay.address` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+2) |
| `relay.role` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+2) |
| `relay.keepalive` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.endpoint_address` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.public_key` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.prefix` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.advertised_cidrs` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+2) |
| `relay.preshared_key` | column | **Keep** | Live column. `lib/db/fabric-records.ts` |
| `idx_relay_fabric_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_relay_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_fabric_server_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_relay_fabric_address` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_relay_fabric_public_key` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_role_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_keepalive_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_member_advertised_cidrs_empty_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_fabric_id_fabric_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**15. `segment`** → `subnet` (export `subnet`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `segment.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `segment.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `segment.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `segment.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `segment.options` | column | **Keep** | Live jsonb; `lib/db/fabric-records.ts` |
| `segment.network_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `segment.server_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `segment.cidr` | column | **Keep** | Live column. `lib/db/fabric-records.ts` |
| `idx_segment_network_id` | index | **Rename** → `idx_subnet_network_id` | Step 2 mechanical token substitution. |
| `idx_segment_server_id` | index | **Rename** → `idx_subnet_server_id` | Step 2 mechanical token substitution. |
| `segment_network_server_unique` | unique | **Rename** → `subnet_network_server_unique` | Step 2 mechanical token substitution. |
| `segment_network_id_network_id_fk` | fk | **Rename** → `subnet_network_id_network_id_fk` | Step 2 mechanical token substitution. |
| `segment_server_id_server_id_fk` | fk | **Rename** → `subnet_server_id_server_id_fk` | Step 2 mechanical token substitution. |

**16. `workspace`** (export `workspace` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `workspace.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `workspace.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `workspace.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `workspace.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `workspace.name` | column | **Keep** | Live column. `client/display-name-uniqueness.ts` (+3) |
| `workspace.description` | column | **Keep** | Live column. `client/workspaces/routes.ts` |
| `workspace.kind` | column | **Keep** | Live column. `client/authz/workspace-kind-ancestry.ts` (+3) |
| `idx_workspace_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_workspace_organization_turbopanel` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `workspace_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `workspace_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `workspace_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**17. `project`** (export `project` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `project.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `project.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `project.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `project.metadata` | column | **Keep** | Live jsonb; `client/managed/context.ts` (+3) |
| `project.options` | column | **Keep** | Live jsonb; `client/bindings/resolve-endpoint.ts` (+3) |
| `project.workspace_id` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `project.name` | column | **Keep** | Live column. `client/display-name-uniqueness.ts` (+2) |
| `project.description` | column | **Keep** | Live column. `client/projects/routes.ts` |
| `idx_project_workspace_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_project_workspace_system_component` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `project_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `project_workspace_id_workspace_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**18. `environment`** (export `environment` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `environment.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `environment.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `environment.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `environment.metadata` | column | **Keep** | Live jsonb; `client/environments/routes.ts` (+1) |
| `environment.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `environment.project_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `environment.server_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `environment.generation` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `environment.name` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `environment.description` | column | **Keep** | Live column. `client/environments/routes.ts` (+1) |
| `idx_environment_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_environment_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `environment_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `environment_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `environment_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**19. `managed`** (export `managed` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `managed.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `managed.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `managed.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `managed.metadata` | column | **Keep** | Live jsonb; `client/managed/routes.ts` (+3) |
| `managed.options` | column | **Keep** | Live jsonb; `client/bindings/materialize.ts` (+3) |
| `managed.environment_id` | column | **Keep** | Live column. `client/bindings/routes-helpers.ts` (+3) |
| `managed.server_id` | column | **Keep** | Live column. `client/managed/routes.ts` (+1) |
| `managed.name` | column | **Keep** | Live column. `client/managed/routes.ts` |
| `managed.engine` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `managed.status` | column | **Keep** | Live column. `client/managed/apply-prepare.ts` (+3) |
| `idx_managed_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_managed_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_managed_engine` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_environment_id_unique` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_status_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**20. `node`** → `replica` (export `replica`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `node.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `node.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `node.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `node.metadata` | column | **Keep** | Live jsonb; `client/managed/members.ts` (+1) |
| `node.options` | column | **Keep** | Live jsonb; `client/managed/members.ts` |
| `node.managed_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `node.server_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `node.role` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `node.replica_class` | column | **Keep** | Live column. `client/managed/ha-desired.ts` (+1) |
| `node.is_read_eligible` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+2) |
| `node.ordinal` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+2) |
| `node.replication_transport` | column | **Keep** | Live column. `client/managed/members.ts` |
| `node.private_port` | column | **Keep** | Live column. `client/managed/ingress-desired.ts` (+1) |
| `node.status` | column | **Keep** | Live column. `client/managed/members.ts` |
| `idx_node_managed_id` | index | **Rename** → `idx_replica_managed_id` | Step 2 mechanical token substitution. |
| `idx_node_server_id` | index | **Rename** → `idx_replica_server_id` | Step 2 mechanical token substitution. |
| `uniq_node_primary` | uniqueIndex | **Rename** → `uniq_replica_primary` | Step 2 mechanical token substitution. |
| `uniq_node_server_private_port` | uniqueIndex | **Rename** → `uniq_replica_server_private_port` | Step 2 mechanical token substitution. |
| `uniq_node_managed_ordinal` | unique | **Rename** → `uniq_replica_managed_ordinal` | Step 2 mechanical token substitution. |
| `uniq_node_managed_server` | unique | **Rename** → `uniq_replica_managed_server` | Step 2 mechanical token substitution. |
| `node_role_check` | check | **Rename** → `replica_role_check` | Step 2 mechanical token substitution. |
| `node_replica_class_check` | check | **Rename** → `replica_replica_class_check` | Step 2 mechanical token substitution. |
| `node_ordinal_positive_check` | check | **Rename** → `replica_ordinal_positive_check` | Step 2 mechanical token substitution. |
| `node_transport_check` | check | **Rename** → `replica_transport_check` | Step 2 mechanical token substitution. |
| `node_status_check` | check | **Rename** → `replica_status_check` | Step 2 mechanical token substitution. |
| `node_managed_id_managed_id_fk` | fk | **Rename** → `replica_managed_id_managed_id_fk` | Step 2 mechanical token substitution. |
| `node_server_id_server_id_fk` | fk | **Rename** → `replica_server_id_server_id_fk` | Step 2 mechanical token substitution. |

**21. `leaf`** (export `leaf` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `leaf.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `leaf.organization_id` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.server_id` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+1) |
| `leaf.kind` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+1) |
| `leaf.managed_id` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.node_id` | column | **Rename** → `leaf.replica_id` | Step 2 FK/column rename. |
| `leaf.ca_id` | column | **Keep** | Live column. Written by leaf upsert (`client/tls/leaf-tracking.ts`); renewal sweep keys other columns. |
| `leaf.ca_generation` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.not_after` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.issued_at` | column | **Keep** | Live column. Written on leaf upsert; not selected on the renewal path. |
| `idx_leaf_not_after` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_leaf_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_leaf_ingress_server` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_leaf_engine_node` | uniqueIndex | **Rename** → `uniq_leaf_engine_replica` | Step 2 mechanical token substitution. |
| `leaf_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_kind_keys_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_managed_id_managed_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_node_id_node_id_fk` | fk | **Rename** → `leaf_replica_id_replica_id_fk` | Step 2 mechanical token substitution. |
| `leaf_ca_id_tls_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**22. `recovery`** (export `recovery` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `recovery.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `recovery.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `recovery.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `recovery.metadata` | column | **Keep** | Live jsonb; `client/managed/ha-recovery.ts` |
| `recovery.options` | column | **Keep** | Live jsonb; table insert/select |
| `recovery.managed_id` | column | **Keep** | Live column. `client/managed/ha-recovery.ts` (+1) |
| `recovery.kind` | column | **Keep** | Live column. table insert/select |
| `recovery.source_primary_member_id` | column | **Keep** | Live column. table insert/select |
| `recovery.target_member_id` | column | **Keep** | Live column. table insert/select |
| `recovery.state` | column | **Keep** | Live column. `lib/db/recovery-records.ts` |
| `recovery.started_at` | column | **Keep** | Live column. `lib/db/recovery-records.ts` |
| `recovery.completed_at` | column | **Keep** | Live column. table insert/select |
| `idx_recovery_managed_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_recovery_inflight_managed` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `recovery_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `recovery_state_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `recovery_managed_id_managed_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**23. `variable`** (export `variable` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `variable.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `variable.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `variable.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `variable.organization_id` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `variable.workspace_id` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `variable.project_id` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `variable.environment_id` | column | **Keep** | Live column. `client/projects/empty-setup.ts` (+1) |
| `variable.service_id` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.hosting_id` | column | **Keep** | Live column. `client/bindings/routes-helpers.ts` (+1) |
| `variable.server_id` | column | **Keep** | Live column. `client/variables/resolve-inherited.ts` (+1) |
| `variable.binding_id` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `variable.key` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `variable.value` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `variable.is_secret` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `variable.is_literal` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.is_for_build` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.is_for_runtime` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.description` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `idx_variable_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_workspace_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_hosting_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_binding_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_org` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_workspace` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_project` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_environment` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_service` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_hosting` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_server` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_exactly_one_parent_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_key_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_workspace_id_workspace_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_hosting_id_hosting_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_binding_id_binding_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**24. `service`** (export `service` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `service.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `service.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `service.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `service.metadata` | column | **Keep** | Live jsonb; `client/services/routes.ts` |
| `service.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `service.environment_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `service.name` | column | **Keep** | Live column. `client/bindings/impact.ts` (+1) |
| `service.description` | column | **Keep** | Live column. `client/services/routes.ts` |
| `service.compose_service_name` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `idx_service_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_service_environment_compose_name` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `service_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `service_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**25. `deployment`** (export `deployment` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `deployment.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `deployment.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `deployment.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `deployment.metadata` | column | **Keep** | Live jsonb; `lib/db/deployment-records.ts` |
| `deployment.options` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+1) |
| `deployment.environment_id` | column | **Keep** | Live column. `client/environments/site-releases.ts` (+3) |
| `deployment.server_id` | column | **Keep** | Live column. `daemon/rehydrate-secrets.ts` (+2) |
| `deployment.desired_generation` | column | **Keep** | Live column. `lib/db/deployment-history.ts` |
| `deployment.applied_generation` | column | **Keep** | Live column. `lib/db/deployment-history.ts` |
| `deployment.desired_hash` | column | **Keep** | Live column. table insert/select |
| `deployment.status` | column | **Keep** | Live column. `lib/commands/consumer.ts` (+2) |
| `deployment.last_command_id` | column | **Keep** | Live column. table insert/select |
| `deployment.finished_at` | column | **Keep** | Live column. table insert/select |
| `deployment.duration_ms` | column | **Keep** | Live column. table insert/select |
| `deployment.outcome` | column | **Keep** | Live column. table insert/select |
| `idx_deployment_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_deployment_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_deployment_environment_server` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_status_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_generation_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_outcome_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**26. `task`** → `slot` (export `slot`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `task.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `task.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `task.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `task.metadata` | column | **Keep** | Live jsonb; table insert/select |
| `task.options` | column | **Keep** | Live jsonb; table insert/select |
| `task.environment_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `task.service_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `task.server_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `task.address` | column | **Keep** | Live column. `lib/schedule/slot-addresses.ts` |
| `task.slot` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `task.generation` | column | **Keep** | Live column. `lib/db/slot-records.ts` |
| `task.desired_state` | column | **Keep** | Live column. table insert/select |
| `idx_task_environment_generation` | index | **Rename** → `idx_slot_environment_generation` | Step 2 mechanical token substitution. |
| `idx_task_server_id` | index | **Rename** → `idx_slot_server_id` | Step 2 mechanical token substitution. |
| `uniq_task_service_slot` | unique | **Rename** → `uniq_slot_service_slot` | Step 2 mechanical token substitution. |
| `task_slot_nonnegative_check` | check | **Rename** → `slot_slot_nonnegative_check` | Step 2 mechanical token substitution. |
| `task_desired_state_check` | check | **Rename** → `slot_desired_state_check` | Step 2 mechanical token substitution. |
| `task_environment_id_environment_id_fk` | fk | **Rename** → `slot_environment_id_environment_id_fk` | Step 2 mechanical token substitution. |
| `task_service_id_service_id_fk` | fk | **Rename** → `slot_service_id_service_id_fk` | Step 2 mechanical token substitution. |
| `task_server_id_server_id_fk` | fk | **Rename** → `slot_server_id_server_id_fk` | Step 2 mechanical token substitution. |

**27. `label`** (export `label` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `label.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `label.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `label.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `label.server_id` | column | **Keep** | Live column. `lib/db/label-records.ts` |
| `label.key` | column | **Keep** | Live column. `lib/db/label-records.ts` (+1) |
| `label.value` | column | **Keep** | Live column. `lib/schedule/plan-deploy.ts` |
| `idx_label_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_label_server_key` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `label_key_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `label_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**28. `hosting`** (export `hosting` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `hosting.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `hosting.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `hosting.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `hosting.metadata` | column | **Keep** | Live jsonb; `client/hostings/routes.ts` |
| `hosting.options` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+3) |
| `hosting.service_id` | column | **Keep** | Live column. `client/bindings/routes-helpers.ts` (+3) |
| `hosting.tls_id` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `hosting.ip_id` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `hosting.name` | column | **Keep** | Live column. `client/hostings/routes.ts` |
| `hosting.description` | column | **Keep** | Live column. `client/hostings/routes.ts` |
| `idx_hosting_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_hosting_tls_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_hosting_ip_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `hosting_name_format_check` | check | **Drop** | Name-format CHECK contradicts app-side `display-name-format.ts`; column stays. |
| `hosting_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `hosting_tls_id_tls_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `hosting_ip_id_ip_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**29. `container`** (export `container` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `container.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `container.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `container.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `container.metadata` | column | **Keep** | Live jsonb; `client/containers/routes.ts` (+1) |
| `container.options` | column | **Keep** | Live jsonb; `client/containers/routes.ts` (+1) |
| `container.service_id` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.server_id` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.container_id` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.container_name` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.status` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.role` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.compose_service_name` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.ordinal` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `idx_container_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_container_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_container_status` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_container_server_container_id` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_container_service_role_ordinal` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_ordinal_positive_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_role_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**30. `principal`** (export `principal` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `principal.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `principal.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `principal.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `principal.metadata` | column | **Keep** | Live jsonb; `client/bindings/routes.ts` (+3) |
| `principal.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `principal.kind` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `principal.provider` | column | **Keep** | Live column. `client/managed/routes.ts` (+3) |
| `principal.username` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `principal.password` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `principal.project_id` | column | **Keep** | Live column. `client/principals/reconcile.ts` (+3) |
| `principal.managed_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `idx_principal_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_principal_managed_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_provider_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_username_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_managed_id_managed_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**31. `entitlement`** (export `entitlement` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `entitlement.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `entitlement.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `entitlement.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `entitlement.principal_id` | column | **Keep** | Live column. `client/principals/store.ts` |
| `entitlement.runtime` | column | **Keep** | Live column. `client/principals/store.ts` |
| `entitlement.series` | column | **Keep** | Live column. `client/principals/store.ts` |
| `entitlement.granted_by` | column | **Keep** | Live column. `client/principals/store.ts` |
| `idx_entitlement_principal_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_runtime_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_series_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_granted_by_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**32. `ssh`** (export `sshKey` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `ssh.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `ssh.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ssh.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ssh.principal_id` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.name` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.key_type` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.public_key` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.fingerprint` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.comment` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.user_id` | column | **Keep** | Live column. Written as provenance on insert (`ssh-keys.ts`); not selected on list. |
| `ssh.bits` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `idx_ssh_principal_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ssh_fingerprint` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_fingerprint_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_type_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_fingerprint_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_public_key_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_name_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**33. `steward`** → `tenancy` (export `tenancy`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `steward.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `steward.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `steward.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `steward.principal_id` | column | **Keep** | Live column. `client/principals/tenancies.ts` (+1) |
| `steward.service_id` | column | **Keep** | Live column. `client/principals/tenancies.ts` (+1) |
| `idx_steward_principal_id` | index | **Rename** → `idx_tenancy_principal_id` | Step 2 mechanical token substitution. |
| `idx_steward_service_id` | index | **Rename** → `idx_tenancy_service_id` | Step 2 mechanical token substitution. |
| `steward_principal_service_unique` | unique | **Rename** → `tenancy_principal_service_unique` | Step 2 mechanical token substitution. |
| `steward_principal_id_principal_id_fk` | fk | **Rename** → `tenancy_principal_id_principal_id_fk` | Step 2 mechanical token substitution. |
| `steward_service_id_service_id_fk` | fk | **Rename** → `tenancy_service_id_service_id_fk` | Step 2 mechanical token substitution. |

**34. `binding`** (export `binding` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `binding.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `binding.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `binding.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `binding.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `binding.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `binding.principal_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `binding.service_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `binding.database_name` | column | **Keep** | Live column. `client/bindings/impact.ts` (+2) |
| `binding.key_prefix` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `binding.is_emit_engine_defaults` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `idx_binding_principal_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_binding_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_binding_service_engine_defaults` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_binding_service_prefix` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_key_prefix_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_database_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**35. `credential`** → `secret` (export `secret`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `credential.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `credential.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `credential.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `credential.metadata` | column | **Keep** | Live jsonb; Written on deploy-key create (`publicKey` / fingerprint jsonb). |
| `credential.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `credential.organization_id` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `credential.principal_id` | column | **Keep** | Optional FK reserved for principal-owned secrets; unused today. |
| `credential.provider` | column | **Keep** | Live column. `client/repositories/routes-helpers.ts` (+1) |
| `credential.name` | column | **Keep** | Live column. Written on deploy-key create (`client/repositories/routes.ts` insert); not later selected qualified. |
| `credential.secret_envelope` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+1) |
| `credential.expires_at` | column | **Drop** | No table-qualified reader or writer; would have become `secret.expires_at`. |
| `idx_credential_organization_id` | index | **Rename** → `idx_secret_organization_id` | Step 2 mechanical token substitution. |
| `idx_credential_principal_id` | index | **Rename** → `idx_secret_principal_id` | Step 2 mechanical token substitution. |
| `credential_provider_check` | check | **Rename** → `secret_provider_check` | Step 2 mechanical token substitution. |
| `credential_organization_id_organization_id_fk` | fk | **Rename** → `secret_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |
| `credential_principal_id_principal_id_fk` | fk | **Rename** → `secret_principal_id_principal_id_fk` | Step 2 mechanical token substitution. |

**36. `storage`** (export `storage` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `storage.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `storage.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `storage.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `storage.metadata` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `storage.options` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `storage.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `storage.workspace_id` | column | **Keep** | Live column. `client/storage/routes.ts` (+1) |
| `storage.project_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `storage.environment_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `storage.service_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `storage.kind` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `storage.name` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `storage.access_mode` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `storage.retention` | column | **Keep** | Live column. `client/storage/routes.ts` (+1) |
| `storage.generation` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `storage.principal_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `storage.content_envelope` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+1) |
| `idx_storage_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_workspace_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_storage_environment_compose_volume_key` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_access_mode_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_retention_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_at_most_one_parent_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_workspace_id_workspace_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**37. `location`** → `copy` (export `storageCopy`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `location.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `location.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `location.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `location.metadata` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `location.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+1) |
| `location.storage_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `location.server_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `location.credential_id` | column | **Rename** → `copy.secret_id` | Step 2 FK/column rename. |
| `location.provider` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `location.role` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `location.state` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `location.path` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `location.endpoint` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `location.generation` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `idx_location_storage_id` | index | **Rename** → `idx_copy_storage_id` | Step 2 mechanical token substitution. |
| `idx_location_server_id` | index | **Rename** → `idx_copy_server_id` | Step 2 mechanical token substitution. |
| `idx_location_credential_id` | index | **Rename** → `idx_copy_secret_id` | Step 2 mechanical token substitution. |
| `uniq_location_storage_primary` | uniqueIndex | **Rename** → `uniq_copy_storage_primary` | Step 2 mechanical token substitution. |
| `uniq_location_storage_server_provider` | uniqueIndex | **Rename** → `uniq_copy_storage_server_provider` | Step 2 mechanical token substitution. |
| `location_provider_check` | check | **Rename** → `copy_provider_check` | Step 2 mechanical token substitution. |
| `location_role_check` | check | **Rename** → `copy_role_check` | Step 2 mechanical token substitution. |
| `location_state_check` | check | **Rename** → `copy_state_check` | Step 2 mechanical token substitution. |
| `location_storage_id_storage_id_fk` | fk | **Rename** → `copy_storage_id_storage_id_fk` | Step 2 mechanical token substitution. |
| `location_server_id_server_id_fk` | fk | **Rename** → `copy_server_id_server_id_fk` | Step 2 mechanical token substitution. |
| `location_credential_id_credential_id_fk` | fk | **Rename** → `copy_secret_id_secret_id_fk` | Step 2 mechanical token substitution. |

**38. `mount`** (export `mount` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `mount.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `mount.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `mount.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `mount.metadata` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `mount.options` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `mount.storage_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `mount.service_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `mount.destination_path` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `mount.subpath` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `mount.is_read_only` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `idx_mount_storage_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_mount_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_mount_service_destination` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `mount_storage_id_storage_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `mount_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**39. `gitapp`** → `forge` (export `forge`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `gitapp.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `gitapp.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `gitapp.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `gitapp.metadata` | column | **Keep** | Live jsonb; table insert/select |
| `gitapp.options` | column | **Keep** | Live jsonb; table insert/select |
| `gitapp.organization_id` | column | **Keep** | Live column. `client/forges/handlers.ts` (+1) |
| `gitapp.provider` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `gitapp.name` | column | **Keep** | Live column. table insert/select |
| `gitapp.base_url` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `gitapp.api_url` | column | **Keep** | Live column. table insert/select |
| `gitapp.external_app_id` | column | **Keep** | Live column. `lib/git/forge-records.ts` |
| `gitapp.app_slug` | column | **Keep** | Live column. table insert/select |
| `gitapp.client_id` | column | **Keep** | Live column. table insert/select |
| `gitapp.redirect_uri` | column | **Keep** | Live column. table insert/select |
| `gitapp.webhook_origin` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `gitapp.is_public` | column | **Keep** | Live column. table insert/select |
| `gitapp.custom_git_user` | column | **Keep** | Live column. table insert/select |
| `gitapp.custom_git_port` | column | **Keep** | Live column. table insert/select |
| `gitapp.synced_at` | column | **Keep** | Live column. table insert/select |
| `gitapp.credentials` | column | **Rename** → `forge.envelopes` | Step 2 FK/column rename. |
| `forge.webhook_ref` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `gitapp.webhook_token_hash` | column | **Keep** | Live column. `lib/git/forge-records.ts` |
| `idx_gitapp_organization_id` | index | **Rename** → `idx_forge_organization_id` | Step 2 mechanical token substitution. |
| `idx_gitapp_provider` | index | **Rename** → `idx_forge_provider` | Step 2 mechanical token substitution. |
| `uniq_gitapp_webhook_ref` | unique | **Rename** → `uniq_forge_webhook_ref` | Step 2 mechanical token substitution. |
| `uniq_gitapp_provider_base_external` | unique | **Rename** → `uniq_forge_provider_base_external` | Step 2 mechanical token substitution. |
| `uniq_gitapp_webhook_token_hash` | unique | **Rename** → `uniq_forge_webhook_token_hash` | Step 2 mechanical token substitution. |
| `gitapp_provider_check` | check | **Rename** → `forge_provider_check` | Step 2 mechanical token substitution. |
| `gitapp_organization_id_organization_id_fk` | fk | **Rename** → `forge_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |

**40. `installation`** → `connection` (export `gitConnection`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `installation.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `installation.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `installation.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `installation.metadata` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` |
| `installation.options` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` |
| `installation.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `installation.app_id` | column | **Rename** → `connection.forge_id` | Step 2 FK/column rename. |
| `installation.provider` | column | **Keep** | Live column. `client/repositories/routes.ts` (+3) |
| `installation.external_installation_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+2) |
| `installation.account_login` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `installation.account_type` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `installation.suspended_at` | column | **Keep** | Live column. `client/repositories/routes.ts` (+3) |
| `installation.oauth_envelope` | column | **Keep** | Live column. `lib/git/gitlab-oauth-token.ts` |
| `idx_installation_organization_id` | index | **Rename** → `idx_connection_organization_id` | Step 2 mechanical token substitution. |
| `idx_installation_app_id` | index | **Rename** → `idx_connection_forge_id` | Step 2 mechanical token substitution. |
| `uniq_installation_organization_app_external` | unique | **Rename** → `uniq_connection_organization_forge_external` | Step 2 mechanical token substitution. |
| `installation_provider_check` | check | **Rename** → `connection_provider_check` | Step 2 mechanical token substitution. |
| `installation_organization_id_organization_id_fk` | fk | **Rename** → `connection_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |
| `installation_app_id_gitapp_id_fk` | fk | **Rename** → `connection_forge_id_forge_id_fk` | Step 2 mechanical token substitution. |

**41. `source`** → `repository` (export `repository`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `source.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `source.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `source.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `source.metadata` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` |
| `source.options` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` (+1) |
| `source.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `source.installation_id` | column | **Rename** → `repository.connection_id` | Step 2 FK/column rename. |
| `source.service_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `source.environment_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `source.credential_id` | column | **Rename** → `repository.secret_id` | Step 2 FK/column rename. |
| `source.provider` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+2) |
| `source.repository_url` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+1) |
| `source.repository_external_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+2) |
| `source.default_branch` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+3) |
| `source.subdirectory` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+2) |
| `source.auto_deploy` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `idx_source_organization_id` | index | **Rename** → `idx_repository_organization_id` | Step 2 mechanical token substitution. |
| `idx_source_installation_id` | index | **Rename** → `idx_repository_connection_id` | Step 2 mechanical token substitution. |
| `idx_source_service_id` | index | **Rename** → `idx_repository_service_id` | Step 2 mechanical token substitution. |
| `idx_source_environment_id` | index | **Rename** → `idx_repository_environment_id` | Step 2 mechanical token substitution. |
| `idx_source_credential_id` | index | **Rename** → `idx_repository_secret_id` | Step 2 mechanical token substitution. |
| `uniq_source_organization_installation_repository` | unique | **Rename** → `uniq_repository_organization_connection_repository` | Step 2 mechanical token substitution. |
| `source_provider_check` | check | **Rename** → `repository_provider_check` | Step 2 mechanical token substitution. |
| `source_auto_deploy_check` | check | **Rename** → `repository_auto_deploy_check` | Step 2 mechanical token substitution. |
| `source_at_most_one_parent_check` | check | **Rename** → `repository_at_most_one_parent_check` | Step 2 mechanical token substitution. |
| `source_organization_id_organization_id_fk` | fk | **Rename** → `repository_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |
| `source_installation_id_installation_id_fk` | fk | **Rename** → `repository_connection_id_connection_id_fk` | Step 2 mechanical token substitution. |
| `source_service_id_service_id_fk` | fk | **Rename** → `repository_service_id_service_id_fk` | Step 2 mechanical token substitution. |
| `source_environment_id_environment_id_fk` | fk | **Rename** → `repository_environment_id_environment_id_fk` | Step 2 mechanical token substitution. |
| `source_credential_id_credential_id_fk` | fk | **Rename** → `repository_secret_id_secret_id_fk` | Step 2 mechanical token substitution. |

**42. `delivery`** (export `webhookDelivery` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `delivery.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `delivery.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `delivery.provider` | column | **Keep** | Live column. `lib/db/webhook-delivery-records.ts` |
| `delivery.external_delivery_id` | column | **Keep** | Live column. `lib/db/webhook-delivery-records.ts` |
| `delivery.event` | column | **Keep** | Live column. Written on claim insert; not selected after. |
| `idx_delivery_created_at` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_delivery_provider_external` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `delivery_provider_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**43. `grant`** (export `grant` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `grant.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `grant.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `grant.actor_type` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.actor_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.entity_type` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.entity_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.permission` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `idx_grant_entity` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_grant_actor` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `grant_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**44. `session`** (export `session` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `session.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `session.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `session.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `session.user_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `session.expires_at` | column | **Keep** | Live column. `client/authn/session-store.ts` |
| `session.token` | column | **Keep** | Live column. `client/authn/session-store.ts` |
| `session.ip_address` | column | **Keep** | Live column. Written by `createSession` (`session-store.ts`); login lookup does not select it. |
| `session.user_agent` | column | **Keep** | Live column. Written by `createSession`; login lookup does not select it. |
| `idx_session_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `session_token_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `session_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**45. `setting`** (export `setting` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `setting.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `setting.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `setting.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `setting.key` | column | **Keep** | Live column. `admin/public-urls.ts` (+3) |
| `setting.value` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `setting_key_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**46. `account`** (export `account` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `account.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `account.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `account.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `account.user_id` | column | **Keep** | Live column. `client/authn/credentials.ts` (+2) |
| `account.provider_id` | column | **Keep** | Live column. `client/authn/credentials.ts` (+1) |
| `account.provider_user_id` | column | **Keep** | Live column. Written on credential-account insert (`install-state.ts`, `http.ts`); not later selected. |
| `account.access_token` | column | **Keep** | Better Auth OAuth leftover; credential accounts unused. |
| `account.refresh_token` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.id_token` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.access_token_expires_at` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.refresh_token_expires_at` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.scope` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.password` | column | **Keep** | Live column. `client/authn/credentials.ts` |
| `idx_account_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `account_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**47. `teammate`** (export `teammate` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `teammate.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `teammate.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `teammate.team_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `teammate.user_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `idx_teammate_team_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_teammate_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `teammate_team_user_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `teammate_team_id_team_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `teammate_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**48. `team`** (export `team` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `team.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `team.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `team.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `team.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `team.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `team.organization_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `team.name` | column | **Keep** | Live column. `client/teams/routes.ts` |
| `idx_team_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `team_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `team_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**49. `user`** (export `user` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `user.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `user.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `user.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `user.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `user.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `user.name` | column | **Keep** | Email-only identity; column kept for Better Auth compat. |
| `user.email` | column | **Keep** | Live column. `client/authn/credentials.ts` (+3) |
| `user.is_email_verified` | column | **Keep** | Live column. `client/authn/credentials.ts` (+2) |
| `user.is_2fa_enabled` | column | **Keep** | Reserved until 2FA ships; `2fa` table also unused. |
| `user.is_disabled` | column | **Keep** | Live column. `client/authn/credentials.ts` (+2) |
| `user.role` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `user_email_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `user_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**50. `2fa`** (export `twoFactor` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `2fa.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `2fa.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `2fa.user_id` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `2fa.secret` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `2fa.is_verified` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `2fa.backup_codes` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `idx_2fa_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `2fa_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**51. `verification`** (export `verification` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `verification.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `verification.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `verification.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `verification.expires_at` | column | **Keep** | Live column. `client/authn/email-otp.ts` (+1) |
| `verification.identifier` | column | **Keep** | Live column. `client/authn/email-otp.ts` (+1) |
| `verification.value` | column | **Keep** | Live column. `client/authn/email-otp.ts` (+1) |
| `verification_identifier_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

### Step 4 — Post-cutover groupings (living docs below use new names)

| Group             | Tables                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**      | `user`, `account`, `session`, `verification`, `passkey`, `2fa`                                                                                                                      |
| **Organizations** | `organization`, `team`, `teammate` (org membership SoT), `invitation` (no `organization_id`; `team_id NOT NULL`), `license`, `tls`, `changeover`, `leaf` |
| **Networking**    | `datacenter`, `network` (kinds `datacenter` / `docker` / `compose`), `ip` (scopes `public` / `datacenter`), `fabric` (0–1 per org; TurboFabric on when present), `relay`, `subnet` |
| **Resource tree** | `workspace`, `project`, `environment`, `service`, `hosting`, `container`, `managed`, `replica`, `recovery`, `variable`, `principal`, `tenancy`, `binding`                                          |
| **Storage**       | `storage`, `copy` (export `storageCopy`), `mount`, `secret`                                                                                                                          |
| **Git**           | `forge`, `connection`, `repository`, `delivery`                                                                                                                                     |
| **Authorization** | `grant`                                                                                                                                                                             |
| **Config**        | `setting` (`value` is `jsonb`)                                                                                                                                                      |
| **Runtime**       | `server`, `command`, `dispatch`, `deployment`, `slot`, `task`, `label`                                                                                                                |
| **Tagging**       | `tag`, `marker`                                                                                                                                                                     |

### Physical table naming rule

Every physical `CREATE TABLE` name is **one standalone lower-case word** —
letter-first alphanumeric token, **no underscores**. Guarded by
`src/lib/db/table-naming.test.ts`, which scans every migration SQL file under
`migrations/`.

| Physical name | Drizzle export | Role |
| ------------- | -------------- | ---- |
| `invitation` | `invitation` | Pending org/team invite (`grants` jsonb materialized on accept). Unchanged. |
| `organization` | `organization` | Tenant org. Unchanged. **`slug`** stays NULL/reserved. |
| `tls` | `tls` | Org TLS library + Organization CA row. Unchanged. |
| `changeover` | `changeover` | Organization CA rotation journal (fan-out progress; partial unique in-flight per org). Was `rotation`. |
| `passkey` | `passkey` | Better Auth–compat WebAuthn table. Unchanged; unused by first-party code. |
| `datacenter` | `datacenter` | Routing domain of mutually routable site subnets. Unchanged. **`datacenter_name_format_check` dropped.** |
| `server` | `server` | Enrolled host. Unchanged. |
| `license` | `license` | One-shot registration key. Unchanged. |
| `command` | `command` | Typed command row (lifecycle columns, no payload). Unchanged. |
| `dispatch` | `dispatch` | One-shot daemon execution payload for a `command` (deleted on success, ~24h retention on failure). Unchanged. |
| `network` | `network` | Org network registry (`datacenter` / `docker` / `compose`). Unchanged. |
| `fabric` | `fabric` | Org TurboFabric mesh (0–1 per org; on when present). Unchanged. |
| `ip` | `ip` | Canonical managed addresses (`public` / `datacenter`). Unchanged. |
| `relay` | `relay` | One server in the org TurboFabric mesh — `tp0` address, role, container prefix, advertised CIDRs, PSK. Unchanged. |
| `subnet` | `subnet` | Server-local Docker bridge for a `kind='compose'` spanning network. Was `segment`. SQL-adjacent — double-quote in raw `sql` tagged templates. |
| `workspace` | `workspace` | Resource-tree root (`project.workspace_id` → `workspace.id`). Unchanged. |
| `project` | `project` | Docker Compose / catalog / managed project. Unchanged. |
| `environment` | `environment` | Staging/production/etc. within a project; optional `server_id` pin. Unchanged. |
| `managed` | `managed` | Environment-scoped managed engine cluster. Unchanged. |
| `replica` | `replica` | One server’s participation in a managed cluster (primary / replica). Was `node`. |
| `leaf` | `leaf` | Organization-CA-signed managed leaf tracking (`ingress` / `engine`; upsert on re-issue). Engine unique is `uniq_leaf_engine_replica` on `replica_id`. Unchanged physical name. |
| `recovery` | `recovery` | Managed HA journal (automatic failover / switchover / disaster recovery). Unchanged. |
| `variable` | `variable` | Scoped config/secret. Unchanged. |
| `service` | `service` | Deployable unit within an environment. Unchanged. |
| `deployment` | `deployment` | Current apply state per `(environment, server)`. Unchanged. |
| `slot` | `slot` | Scheduled replica instance of a logical service (0-based `slot` column). Was `task` (replica-slot meaning). |
| `label` | `label` | Server Docker-engine labels. Unchanged. |
| `hosting` | `hosting` | Public routing for a service. Unchanged. **`hosting_name_format_check` dropped.** |
| `container` | `container` | Deployed Docker container pin. Unchanged. |
| `principal` | `principal` | Linux/system or managed-engine user. Unchanged. |
| `entitlement` | `entitlement` | Runtime series a principal may execute (one row = one unix group). Unchanged. |
| `ssh` | `sshKey` | Public key that may authenticate as a principal. Unchanged. |
| `tenancy` | `tenancy` | Linux/system principal that runs as / owns a service. Was `steward`. |
| `binding` | `binding` | Managed-DB principal → compose service inject. Unchanged. |
| `secret` | `secret` | Sealed provider secrets (NFS/S3/rclone + Git deploy keys). Was `credential`. **`expires_at` dropped.** |
| `storage` | `storage` | Logical dataset identity (volume / directory / file / object). Unchanged. |
| `copy` | `storageCopy` | One physical copy of a storage identity. Was `location`. SQL-adjacent — double-quote in raw `sql` tagged templates. |
| `mount` | `mount` | Service attachment of a storage identity. Unchanged. |
| `forge` | `forge` | Registered GitHub App / GitLab OAuth application (`organization_id` NULL = instance-wide). Was `gitapp`. **`envelopes`** was `credentials`. |
| `connection` | `gitConnection` | Git provider App installation granted to one org. Was `installation` (export `gitConnection`). **`forge_id`** FK → `forge`. **`provider`** kept as a denormalized filter column. **`external_installation_id`** is the provider-side id. No token columns — installation access tokens are minted on demand in `src/lib/git/github-app-token.ts`. |
| `repository` | `repository` | Git repository binding. Was `source`. **`connection_id`** SET NULL; optional `service_id` / `environment_id` CASCADE (at most one); optional `secret_id` SET NULL. Compose still references a row via `services.<name>.x-turbopanel.source.sourceId`. CRUD: `src/client/repositories/routes.ts` (path unchanged until a later phase). |
| `delivery` | `webhookDelivery` | Inbound provider-webhook delivery ledger — replay protection only. Org-agnostic on purpose: the delivery id arrives before the payload is matched to a connection. `provider` CHECK `github`; unique `(provider, external_delivery_id)`; `created_at` is the received time and the sweep cursor. Holds no payload and no secret. Claimed by `claimWebhookDelivery`, pruned after `WEBHOOK_DELIVERY_RETENTION_MS` (`src/lib/db/webhook-delivery-records.ts`). |
| `grant` | `grant` | Authz grant row. Unchanged. |
| `session` | `session` | Opaque DB-backed user session. Unchanged. |
| `setting` | `setting` | Instance settings (`value` is `jsonb`). Unchanged. |
| `account` | `account` | Credential / (reserved) OAuth account. Unchanged. |
| `teammate` | `teammate` | User ↔ team; org membership is derived through `team.organization_id`. Unchanged. |
| `team` | `team` | Org team. Unchanged. |
| `user` | `user` | Instance user (email identity). Unchanged. |
| `2fa` | `twoFactor` | Better Auth–compat two-factor table; digit-leading name exception. Unchanged; unused by first-party code. |
| `verification` | `verification` | Email / OTP verification tokens. Unchanged. |
| `tag` | `tag` | Org-owned tag definition. App-enforced trim + case-insensitive uniqueness backed by `uniq_tag_organization_name`. SQL-adjacent — double-quote in raw `sql` tagged templates. |
| `marker` | `marker` | Join edge: one tag on exactly one parent (`marker_exactly_one_parent_check`); seven partial uniques (`uniq_marker_server` … `uniq_marker_storage`). Org derived through `tag.organization_id`. No `metadata`/`options` pair (follows `tenancy` / `label`). |
| `task` | `task` | Cron-style scheduled command on a service. `uniq_task_service_name`; `task_concurrency_policy_check` (`allow` \| `forbid` \| `replace`). No execution columns (`last_run_at` / result) and no run-history table. |

**Better Auth:** do not reintroduce a physical `member` or `membership` table.
Org membership is `teammate` → `team.organization_id`. Platform authority stays
on `user.role` (`superadmin` / `admin` / `user`), separate from org grants.

**Retired names:** `vpn` / `peer` / `tlsleaf` / `tlsrotation` /
`principal_entitlement` / `principal_ssh_key` / `gitapp` / `installation` /
`source` / `steward` / `location` / `credential` / `node` / `segment` /
`rotation` are retired physical table names, guarded by `table-naming.test.ts`
(same reject list as `member` / `bridge` / `managed_member`). Do not
reintroduce them. The `table-naming.test.ts` edit that adds `gitapp` /
`installation` / `source` / `steward` / `location` / `credential` / `node` /
`segment` / `rotation` to the reject list is **phase 2's job** — this ledger
only records the decision. Do **not** retire `task`: the replica-slot table is
`slot`; `task` is the cron scheduled-command table.

**Naming exceptions** (external compatibility only — listed in the guard test
and here):

| Name  | Why                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------- |
| `2fa` | Better Auth two-factor model; digit-leading name. Keep the exception documented when the table remains. |

### Resource hierarchy

**Legacy resource tree** (workspace → project → … → hosting/container):
organization scope is derived via parent FK joins — not stored on those child
rows (except `workspace`, which roots the tree with `organization_id`).

**Ownership vs placement:** ownership fields live only at the nearest canonical
parent and are otherwise derived by ancestry join. Do not denormalize
`organization_id`, `workspace.kind`, or similar ownership facts onto `project` /
`environment` / `service` / `container`. Fields that express a _different_ fact
may legitimately repeat a reference at multiple levels — e.g.
`environment.server_id` (desired placement) vs `container.server_id` (observed
placement) — and are not ownership duplication. **`storage`**, **`network`**,
**`ip`**, and **`datacenter`** carrying direct `organization_id` are an
intentional exception (org-owned registries) and must not be used as precedent
for adding `organization_id` / `is_system` (or any ownership column) to the
workspace → project → environment → service → container tree.

**Org-owned networking tables** (`datacenter`, `network`, `ip`) persist
**`organization_id` directly** on each row. Authz and domain logic for those
entities should use that column (alongside optional `datacenter_id` /
`server_id` / `network_id` links), not only join-derived ancestry from the
compose tree. Overlay `tp0` addresses live on **`relay.address`**, not in the
`ip` registry — the trade-off (fabric addresses no longer appear on the org
Addresses page) was deliberate, taken to drop `ip.vpn_id` / `ip.fabric_id` and
three constraints per mesh member.

Canonical order:

```text
organization → workspace → project → environment → service → hosting
organization → workspace → project → environment → service → tenancy ← principal (M:N; Linux/system run-as)
organization → workspace → project → environment → service → binding ← principal (managed DB user)
organization → workspace → project → environment → service → container (1:N)
organization → workspace → project → environment → managed (1:1)
organization → managed → replica (1:N, primary + replicas)
organization → workspace → project → environment → variable (1:N, env-scoped)
organization → workspace → variable (1:N)
organization → project → variable (1:N)
organization → workspace → project → environment → service → variable (1:N)
organization → workspace → project → environment → service → hosting → variable (1:N)
organization → datacenter → network (one or more site subnets, kind='datacenter', CIDR required, IPv4 and/or IPv6)
organization → datacenter → ip (membership pins + free-pool rows)
organization → network (docker, optional server pin)
organization → ip (public + datacenter scopes)
organization → server (no home datacenter_id; memberships via ip pins)
organization → fabric                      (0 or 1; TurboFabric on when present)
organization → fabric → relay              (tp0 address + container prefix, per server)
organization → network (kind='compose')    (logical spanning network; spans hosts via TurboFabric)
organization → network → subnet            (that network on one server + local /24)
environment → service → slot → address     (per-replica address inside that subnet)
organization → storage                         (logical dataset; optional workspace/project/environment/service scope)
organization → storage → copy                  (physical copy; optional server + secret)
organization → storage → mount → service       (container destination)
organization → secret                          (sealed provider secrets; schema only — no public CRUD)
forge                                          (registered GitHub App / GitLab OAuth application; `organization_id` NULL = instance-wide, set = org-owned)
forge → connection                             (every connection names the forge it was granted through)
organization → connection                      (Git provider App install, physical table `connection`; no token columns)
organization → repository                      (Git repository binding; optional single service *or* environment scope)
organization → workspace → project → environment → service → repository
organization → connection → repository         (clone auth for github-provider repositories)
organization → tag                             (org-owned tag definition)
organization → tag → marker → server | workspace | project | environment | service | datacenter | storage
environment → service → task                   (scheduled command; cron text stored verbatim)
organization → server → container
organization → server → variable (1:N, server-scoped; excluded from inheritance chain)
```

| Entity        | Parent FK                                                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`   | `organization_id`                                                                                                                                                       | Root of the resource tree. **`kind`** (`'user'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `project`     | `workspace_id`                                                                                                                                                          | Docker Compose / catalog project. **`name` uniqueness** is app-enforced per organization via workspace join (trim + case-insensitive; **409** `project_name_in_use`) — no DB unique index. **`metadata`**: `type` (`"docker-compose"` \| `"managed"` \| `"template"` \| `"system"` — `"system"` is platform-owned on TurboPanel-workspace projects and **never accepted by `POST /projects` or `…/configure`**), optional `code` (managed engine catalog code), optional **`component`** (a `SystemComponentKey` — `"hosting-ingress"`, `"managed-ingress"`, `"managed-ha"`, or `"turbopanel"` — for platform-managed system projects — partial unique `uniq_project_workspace_system_component` on `(workspace_id, (metadata->>'component')) WHERE (metadata->>'component') IS NOT NULL`). Self-host `database` / `queue` / `analytics` are `service.composeServiceName` values under the `turbopanel` project, not project `component` keys. **`options.compose`**: base **ComposeDocument** (versioned JSON with presentation for YAML comments/order) — see `src/lib/compose/`. **`options.containerNaming`**: `uuid` (default) \| `custom` — controls deploy container_name allocation. Project compose does **not** own server placement (sanitized on save).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `environment` | `project_id`; optional `server_id` → `server.id` (`ON DELETE RESTRICT`, `idx_environment_server_id`)                                                                    | Staging/production/etc. within a project. **`server_id`** is the **single** whole-server placement pin (not compose / not `metadata.serverId`). **`generation`** (`integer NOT NULL DEFAULT 0`) is the monotonic desired generation, bumped once per deploy and fanned into `deployment.desired_generation`. System environments are keyed by their parent **`project.metadata.component`** (`hosting-ingress` / `turbopanel`) plus `server_id` — never stamp or unique on `environment.metadata.component` (reserved/stripped on public create/patch). **`options.compose`**: per-environment ComposeDocument overlay merged onto the project base at deploy — placement is stripped on save.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `deployment`  | `environment_id` NOT NULL (`ON DELETE CASCADE`) + `server_id` NOT NULL (`ON DELETE RESTRICT`, mirroring `container.server_id`)                                          | One row per participating `(environment, server)` — unique `uniq_deployment_environment_server`. **`desired_generation`** / nullable **`applied_generation`**; **`desired_hash`** (sha256 of that server's compiled runtime `compose.yaml`); **`status`** CHECK `pending` \| `applying` \| `applied` \| `failed` \| `draining`; **`last_command_id`** has **no FK** (mirrors `command.actor_id`). `metadata` carries the last failure message / planner warnings. **`options.secretPlan`** is the last-applied Compose standalone secret file plan (paths/names, no plaintext) used by daemon boot rehydrate. **`options.siteReleases`** (`{ serviceId, username }[]`) records the per-service release trees (`<principalHome>/sites/<serviceId>`) that deploy published on that server — the durable half of what `environment.stop` reclaims, because a Git-backed service removed from the compose is no longer derivable from the merged document (`client/environments/site-releases.ts`). **`finished_at`** / **`duration_ms`** / **`outcome`** (CHECK NULL \| `applied` \| `failed` \| `timed_out`) summarize only the **last** apply attempt — `outcome` keeps `failed` and `timed_out` apart where `status` collapses both to `failed`. This table is **current state, not history**: it is upserted per `(environment_id, server_id)` and overwritten on every redeploy, so per-attempt deploy history is read from the append-only `command` table instead (`name = 'environment.deploy'` filtered on `context->>'environmentId'`, index `idx_command_deploy_environment_created`); `last_command_id` is the back-reference from current state into that history. Helpers: `src/lib/db/deployment-records.ts`, `src/lib/db/deployment-history.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `slot`        | `environment_id` CASCADE + `service_id` CASCADE + `server_id` RESTRICT                                                                                                  | Logical-service ↔ scheduled-instance split: **never** mint a `service` row per replica. Physical table **`slot`** (was `task`). **`slot`** column is 0-based (unlike 1-based `container.ordinal` / `replica.ordinal`); unique `uniq_slot_service_slot` on `(service_id, slot)`. **`desired_state`** CHECK `running` \| `stopped` \| `removed`. Nullable **`address inet`** is the per-replica spanning-network address, deterministic from `(service, slot)` inside that server's `subnet.cidr`, persisted so the sticky re-plan keeps it stable; source for compose `ipv4_address` + `extra_hosts`. A slot row is derived scheduling state, so `service_id` CASCADE does not block service delete. Helpers: today `src/lib/db/slot-records.ts` (phase 2 renames with the table).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `service`     | `environment_id`                                                                                                                                                        | Deployable unit within an environment. **`compose_service_name`** (`varchar(255) NOT NULL`) is the Compose service key — **derived only**, written by reconcile (`reconcileServicesFromCompose`), managed container allocation, and daemon-report container reconcile (`ensureServicesForReportedContainers`); never accepted from a client request/body. Unique (non-partial) `uniq_service_environment_compose_name` on `(environment_id, compose_service_name)`. **`name`** is the user-facing label (column renamed from `display_name`; nullable, not unique; client JSON field is `name`). **`metadata`**: reserved for future non-indexed facts. **`options`**: reserved (future per-service placement / hooks / resources — not container names).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `hosting`     | `service_id NOT NULL`                                                                                                                                                   | Public routing for a service (Traefik + hosting Caddy). Optional **`tls_id`** → `tls.id` (`ON DELETE SET NULL`) pins an org certificate; null = basic self-signed (Caddy `tls internal`) at deploy — library certs must be pinned explicitly. Optional **`ip_id`** → `ip.id` (`ON DELETE SET NULL`) pins a managed ingress address. **`options`**: `{ hostnames[], pathPrefix?, targetPort? }`. **`metadata`**: deploy status fields. Org derived via service chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tls`         | `organization_id NOT NULL`                                                                                                                                              | Org TLS certificate library (`upload` / `lets_encrypt` / `self_signed` / `organization_ca`). **`certificate_pem`**: public chain (nullable while LE pending). **`private_key_pem`**: sealed `tpsecret` only — never returned on client GET. Dedicated columns: **`status`** (`text NOT NULL DEFAULT 'ready'`), **`not_after`** (`timestamptz(3)`), **`fingerprint_sha256`** (`text`); indexes `idx_tls_not_after`, partial unique `uniq_tls_organization_fingerprint_sha256` on `(organization_id, fingerprint_sha256) WHERE fingerprint_sha256 IS NOT NULL`, and partial unique `uniq_tls_organization_active_ca` on `(organization_id) WHERE source = 'organization_ca' AND ca_state = 'active'` (at most one active org CA). Lifecycle columns: **`ca_state`** (`active` \| `retired` \| `revoked`, null on non-CA rows) and **`ca_generation`** (monotonic per org; required unless revoked). Rotate **retires** the prior active row so `GET /tls/ca` can return the overlap **trustBundlePem**. Residual **`metadata`**: `{ dnsNames, hasWildcard, notBefore, subject, issuer, acme? }` — client GET still assembles a full metadata DTO including status/notAfter/fingerprint. **`options`**: `{ prefer?, autoRenew?, requestedHostnames? }`. `ON DELETE CASCADE` from org; hosting pins clear on cert delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `changeover`  | `organization_id NOT NULL` CASCADE                                                                                                                                      | Organization CA rotation journal (physical table **`changeover`**, was `rotation`). **`state`** CHECK `in_progress` \| `awaiting_retire` \| `completed` \| `failed`; **`from_ca_generation`** / **`to_ca_generation`**; **`results`** jsonb (per-server `ingress`/`apply` fan-out). Partial unique `uniq_changeover_inflight_organization` on `organization_id` WHERE `state = 'in_progress'`. Helpers: `src/client/tls/changeover-lease.ts` (path unchanged this phase). |
| `leaf`        | `organization_id` CASCADE + `server_id` CASCADE + optional `managed_id`/`replica_id` CASCADE + `ca_id` CASCADE                                                             | Organization-CA-signed managed leaf tracking (no PEM). **`kind`** CHECK `ingress` \| `engine`; ingress has null `replica_id`/`managed_id` (partial unique `uniq_leaf_ingress_server` on `server_id`); engine requires both (partial unique `uniq_leaf_engine_replica` on `replica_id`). **`not_after`** + **`ca_generation`** feed the renewal sweep (`idx_leaf_not_after`). Helpers: `src/client/tls/leaf-tracking.ts` / `leaf-renewal-sweep.ts`. |
| `container`   | `service_id NOT NULL` + `server_id NOT NULL`                                                                                                                            | Pins a deployed Docker container to a service and records which server hosts it. Dedicated columns: **`container_id`** (nullable — null between pre-allocation and the daemon's post-`compose up` report), **`container_name`**, **`status`** (`text NOT NULL DEFAULT 'pending'`), **`role`** (`text NOT NULL DEFAULT 'service'`, CHECK `container_role_check` / `role IN ('service', 'ingress', 'turbopanel')` — `'service'` for ordinary workload/engine replicas; `'ingress'` for the per-service/hosting Traefik row **or** the shared ProxySQL `managed-ingress` row (both `<serviceId>-in`); `'turbopanel'` for the `turbopanel-system` stack plus the `-ha` Orchestrator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `label`       | `server_id` NOT NULL (`ON DELETE CASCADE`)                                                                                                                              | Server label source for `placement.constraints` (`node.labels.*`). Org-scoped through `server` — **no** `organization_id` (same as `container`). Unique `uniq_label_server_key` on `(server_id, key)`; **`key`** CHECK Docker engine-label charset `^[A-Za-z0-9][A-Za-z0-9._-]*$` length 1–255; **`value`** `text` default `''` (app-side cap is `DESCRIPTION_MAX_LENGTH` by Unicode code point in `label-records.ts`). No `metadata`/`options` pair (follows `tenancy`). Helpers: `src/lib/db/label-records.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `principal`   | optional `project_id` (project principals) + optional `managed_id` (managed-engine users) + tenancies                                                                    | Behind-the-scenes account identity for hosting/database-user flows, **project principals** (`GET/POST/DELETE /api/client/v1/projects/:projectId/principals`), and **managed-engine users** (`managed_id` FK → `managed`, `ON DELETE CASCADE`). **`kind`** CHECK `('system', 'database')` — `kind='system'` is a **Linux (server) host account**; `database` covers every managed engine user. **`provider`** CHECK `('server', 'postgres', 'mysql', 'redis', 'clickhouse')`. **`username`** `varchar(255)` CHECK `^[A-Za-z_][A-Za-z0-9_-]*$` — the Linux username is operator-chosen (not derived from the UUID); server principals additionally enforce ≤ 28 at the API layer so `<username>-grp` fits the Linux 32-char group-name limit. Reserved names (e.g. `root`, `www-data`, `tpctrl`, `systemd-*`) return **400** `username_reserved`. Host-account username uniqueness is **app-enforced per organization** (trim + case-insensitive via project → workspace join; create locks the organization row `FOR UPDATE` so concurrent same-name creates cannot race) → **409** `username_in_use`. **Managed-engine usernames** (including root) are app-enforced unique across clusters whose members land on servers with the same **`server.organization_id`** (`isManagedUsernameTaken` / create locks those orgs `FOR UPDATE`) → **409** `username_in_use` (same-cluster collision remains **409** `managed_user_exists`). **`password`** is nullable + write-only; stored as a sealed `tpsecret` envelope at rest (show-once plaintext only at create/rotate). **`metadata.home`** is `/srv/users/<username>` (canonical value from `naming.ts`; metadata is a display mirror — deploy always re-derives home). Host allocates uid/gid; an optional operator `uid`/`gid` override (≥ 10001, outside the reserved 9989–9999 service band) may be persisted in `options` and mirrored into `metadata` — never an instance-allocated id. **`options.shell`** (default `/usr/sbin/nologin`) is an absolute path ≤ 255 chars with no whitespace/NUL/newline and **no parent-directory (`..`) segments** — same contract as daemon `assertSafeAbsolutePath` in `ensure-principal.ts` (`src/lib/principal-options.ts` rejects before persist; daemon remains defense-in-depth). Applied via `useradd -s` / `usermod -s`. Daemon `ensureSystemPrincipals` runs during deploy when `principalMaterial[]` is present. **Site:** a sole steward of a site service pins `sites[].principal` so the site tree (and Apache php-fpm workers) run as that Linux user. **No global unique on `username`**. |
| `tenancy`     | `principal_id NOT NULL` + `service_id NOT NULL`                                                                                                                         | Join edge: the Linux/system principal that stewards a service (runs as / owns the site tree). Distinct from `binding` (managed-database credential inject). `principal_id` FK `ON DELETE CASCADE` (deleting a principal removes its edges); `service_id` FK `ON DELETE RESTRICT` (a service still referenced by principals cannot be deleted, mirroring `container`). Unique `(principal_id, service_id)`; btree indexes on each FK. Site ownership requires **at most one** principal per service (deploy-prepare rejects ambiguous pins).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `entitlement` | `principal_id` CASCADE | Which runtime series a principal may **execute** on the host. One row becomes one unix group membership (`tpphp84`, `tpnode24`) — the only form the kernel enforces at `execve`, and therefore the only one a shell session or a cron job cannot bypass. A table rather than `principal.options` jsonb because `parsePrincipalOptions` is drop-on-invalid (wrong posture for a grant), because "which principals still hold php 8.1?" must be answerable before retiring a series, and for per-row provenance. **`runtime`** CHECK `('php','node')`; **`series`** CHECK `^[0-9]{1,3}([.][0-9]{1,3})?$` — the exec boundary, never a patch pin. **`granted_by`** CHECK `('operator','deploy')`: an operator's explicit grant vs. one deploy-prepare inserted because a service declared the runtime. Both are real and both are revocable; the distinction exists so the UI can say why. The API always records `operator` — a client cannot forge `deploy` provenance. Unique `(principal_id, runtime, series)`. No `organization_id` (derived through `principal`). |
| `ssh` | `principal_id` CASCADE; optional `user_id` SET NULL | A public key that may authenticate as this principal. Keyed here rather than in jsonb for the entitlement reasons plus one of its own: **"which principals does this fingerprint reach?" must be answerable in one query** — when a laptop is lost the operator has a fingerprint and needs every account it opens. **`public_key`** stores the **re-rendered** `<type> <base64>` from `parseSshPublicKey`, never the pasted line: an `authorized_keys` entry may legally carry a leading options field (`command="…",no-pty`) and neither honouring nor silently stripping one is acceptable; the comment is split into its own column so the stored key has exactly two fields. CHECK `^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$` is the backstop that makes a newline (a second authorized_keys entry) unable to reach the file. **`fingerprint`** `SHA256:<base64 unpadded>`, byte-identical to `ssh-keygen -lf`; CHECK `^SHA256:[A-Za-z0-9+/]{43}$`. **`key_type`** CHECK over the seven accepted types (`ssh-dss` is not one). **`user_id`** is **provenance, not ownership** — which org member added it, so "revoke everything Alice can reach" is one query without a user↔principal join table; `SET NULL` because losing who added a key must never delete the key. Unique `(principal_id, fingerprint)` — over decoded bytes, so two spellings of one key collide. Max 64 per principal, enforced at the API so the failure lands on the request that added the 65th. |
| `binding`     | `principal_id NOT NULL` + `service_id NOT NULL`                                                                                                                         | Join edge: managed-database principal → consuming compose service. Materializes system-owned `variable` rows (via `variable.binding_id`) so credentials ride the existing deploy inject rail. Columns: `database_name`, `key_prefix` (default `DATABASE`), `is_emit_engine_defaults` (at most one true per service via partial unique). FK **principal CASCADE** (user gone → drop bindings), **service RESTRICT** (service still referenced cannot be deleted). Unique `(service_id, key_prefix)`; CHECK on prefix/database-name identifiers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `network`     | `organization_id NOT NULL`; per-kind scope FKs                                                                                                                          | Org-owned network registry. **`kind`** CHECK `('datacenter', 'docker', 'compose')`. Tightened **`network_single_scope_check`**: `datacenter` requires `datacenter_id` + **`cidr`** (no `server_id` / no `environment_id`); **`uniq_network_datacenter_cidr`** is a partial unique on `(datacenter_id, cidr) WHERE kind='datacenter'`, so a datacenter may own many subnet rows but not the same range twice. `docker` requires `datacenter_id IS NULL` and `environment_id IS NULL` (`server_id` optional); `compose` is a logical spanning network (no `datacenter_id` / no `server_id`; optional **`environment_id`**). Host bridge name `tpn_<networkId>` lives in `options`. Compiler/fabric helpers insert `compose` rows — public APIs allow `datacenter\|docker` (networks) and `public\|datacenter` (IPs). `server_id` and `datacenter_id` FKs `ON DELETE RESTRICT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `datacenter`  | `organization_id NOT NULL`                                                                                                                                              | Routing domain owning many `network(kind='datacenter')` subnets, all assumed mutually routable (no per-pair records). Membership is equal `ip` pins (no home `server.datacenter_id`). First subnet is derived from the seed member’s reported prefix; further subnets arrive by auto-derive on member add or manual subnet CRUD. List/detail surface **`privateCidrs: string[]`** (one entry per subnet); detail adds **`subnets[]`**. **`options.addressPreference`** (`'ipv6' \| 'ipv4'`, absent = `ipv6` per RFC 6724, parsed by `src/lib/datacenter-options.ts`) sits alongside the existing timezone-enforcement mirror. `ON DELETE CASCADE` from org; `ip.datacenter_id` CASCADE; site `network` rows RESTRICT delete — after the **409** `datacenter_has_members` guard, the API deletes **every** `kind='datacenter'` network for that datacenter in one txn, then the datacenter; **409** `datacenter_has_networks` remains only for leftover non-site (docker) rows.                                                                                                                                                                                                                                                                                                                 |
| `ip`          | `organization_id NOT NULL`; optional `datacenter_id`, `network_id`, `server_id`                                                                                         | Canonical managed addresses. **Site subnet** = `network(kind='datacenter')`. A server may hold **any number** of membership pins per datacenter (multi-NIC, multi-subnet, dual-stack); per-address dedup is **`uniq_ip_org_address`** on `(organization_id, address)`. **Membership pin** (`scope='datacenter'` + `server_id`) now **requires** `network_id` naming its owning subnet — enforced by **`ip_datacenter_member_network_check`**; unassign **deletes** the row. **Free pool** = `datacenter_id` only (`server_id`/`network_id` null) via `ip_datacenter_anchor_check`. **`address`** is Postgres **`inet`**. **`version` is not stored**. **`scope`** `('public', 'datacenter')`. **`ip_datacenter_scope_check`**: datacenter scope requires `datacenter_id`. **`allocation`** `('dedicated', 'shared')`. Optional **`description`** (`text`; length cap is app-side) — IPs have no display name. Indexes: btree **`idx_ip_scope_server_datacenter`** on `(scope, server_id, datacenter_id)`. Overlay `tp0` addresses live on `relay.address`. `server_id` FK RESTRICT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fabric`      | `organization_id NOT NULL` unique (`uniq_fabric_organization_id`)                                                                                                       | Org TurboFabric mesh (host interface `tp0`). **Absence means TurboFabric is off.** Timestamps, `metadata`, `options`, **`cidr`** (host fabric e.g. `10.250.0.0/16`). Container-pool CIDR, listen port, and MTU defaults come from `src/lib/fabric/cidr.ts` (`DEFAULT_FABRIC_CONTAINER_POOL` `10.192.0.0/12`, `DEFAULT_FABRIC_LISTEN_PORT` `51821`, `DEFAULT_FABRIC_MTU` `1420`, `RELAY_PREFIX_LENGTH` 16) and may be overridden in `options`. **`options.allowRelay`** (boolean, default **false**, no migration) is org relay-transport policy — a relay may only tighten it; it does **not** loosen gateway datacenter locality (unrelated third-site gateways stay ineligible). Gateway next-hop route ownership lives in `planRelayPath` / `buildReconcilePeerLists`: a routed destination's `/32` and `prefix` move into exactly one gateway stanza. `ON DELETE CASCADE` from org. Helpers: `src/lib/db/fabric-records.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `relay`       | `fabric_id` CASCADE + `server_id` RESTRICT                                                                                                                              | Self-contained mesh member. **`address inet NOT NULL`** (`tp0` host address, rendered `/32`); **`role`** CHECK `relay_role_check ('gateway','member')` default `member`; **`advertised_cidrs`** jsonb default `[]` is an **operator override** (`relay_member_advertised_cidrs_empty_check` must stay empty for `member`; unchanged): an empty list on a `role='gateway'` relay resolves at reconcile/read time to the **IPv4** subnets of the datacenters that relay is pinned into (`resolveDerivedAdvertisedCidrsByRelay`, fed through `loadFabricReconcileSnapshot` / `buildFabricReconcilePayloadFromSnapshot`) and is surfaced as `resolvedAdvertisedCidrs`; IPv6 subnets are never auto-advertised; **`keepalive`** with `relay_keepalive_check` (1–65535); **`endpoint_address`** (operator pin; **null = pair-aware `planRelayPath`**: shared-datacenter `direct_lan`, else `direct_public`, else a bounded gateway next-hop when eligible; unplannable pairs are omitted from that server's peer list and recorded as `unreachablePeers`); **`options.allowRelay`** (`boolean \| null`, inherit org, may only tighten) and **`options.preferredGatewayIds`** (server-id list, max 32) persist in existing jsonb — **no migration**; **`public_key`** (null until the first successful `server.fabric.reconcile`); **`prefix`** (container aggregate `/16` carved from the pool); **`preshared_key`** (sealed `tpsecret`, **write-only — never returned on GET**). Indexes `idx_relay_fabric_id` / `idx_relay_server_id`; unique `relay_fabric_server_unique`, `uniq_relay_fabric_address`, `uniq_relay_fabric_public_key`. Private keys never leave the host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `subnet`      | `network_id` CASCADE + `server_id` RESTRICT                                                                                                                             | Server-local Docker bridge for a `kind='compose'` spanning network (physical table **`subnet`**, was `segment`, previously `bridge`; Docker's bridge driver / `docker0` / Compose `driver: bridge` are unchanged). Unique `subnet_network_server_unique` on `(network_id, server_id)`; **`cidr`** is the server-local `/24`, indexed **within the owning relay's `prefix`**. Rows are reclaimed on environment stop/delete, drain, project cascade delete, and fabric disable (`listEnvironmentComposeNetworks` / `purgeEnvironmentComposeNetworks` / `purgeEnvironmentsComposeNetworks` / `releaseSubnetsForServer` in `fabric-records.ts` — helper names unchanged this phase). Includes `metadata`/`options`. Helpers: `listServerSubnets` / `ensureNetworkSubnet`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `storage`     | `organization_id NOT NULL` CASCADE; optional `workspace_id` / `project_id` / `environment_id` / `service_id` **SET NULL**; `principal_id` **RESTRICT**                  | Logical dataset identity. **`kind`** CHECK `volume` \| `directory` \| `file` \| `object` (API this slice: volume/directory/file). **`access_mode`** `single_writer` (default) \| `multi_reader` \| `multi_writer`. **`retention`** `retain` (default) \| `delete`. Scope CHECK: **at most one** parent among workspace/project/environment/service (zero = org-wide). Compose named volumes are environment-scoped with partial unique `(environment_id, metadata.composeVolumeKey)` where `kind='volume'`. New volumes stamp **`metadata.dockerVolumeName`** to the storage UUID. Parent delete honors retention: `delete` removes the row (after clearing `mount`s — service FK is RESTRICT); `retain` detaches scope via SET NULL and leaves org-owned storage. Helper: `applyStorageRetentionOnParentDelete`. Daemon host path is per **copy**, not this row. `copy` / `mount` / `secret` are **not** grant entity types — authz inherits `storage.organization_id` (evaluator ancestry includes `workspace_id` and org-only rows).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `copy`        | `storage_id` CASCADE; optional `server_id` RESTRICT; optional `secret_id` RESTRICT                                                                                  | One physical copy. **`provider`** CHECK includes `docker` / `path` plus unused `block` / `nfs` / `cifs` / `s3` / `s3_compatible` / `sftp` / `ftp` / `webdav` (API this slice: `docker` \| `path`). **`role`** `primary` \| `replica` \| `scratch` \| `archive`; **`state`** `pending` \| `materializing` \| `ready` \| `syncing` \| `stale` \| `failed` \| `retiring`. Partial unique: one `role='primary'` per storage; `(storage_id, server_id, provider)` where `server_id IS NOT NULL`. `scratch` copies are never mountable. Docker volume **name is the storage UUID**. External Compose volumes: `options.managed=false` + `options.externalName`. Platform host layout: `<stateDir>/storage/<orgId>/<storageId>/<copyId>/data`. Principal-owned path copies without explicit `path` resolve `/srv/users/<username>/volumes/<storageId>` (`resolvedSourcePath` on the copy, never persisted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mount`       | `storage_id` CASCADE; `service_id` RESTRICT                                                                                                                             | Service consumption: **`destination_path`**, optional **`subpath`**, **`is_read_only`**. Unique `(service_id, destination_path)`. Deleting a service with mounts is blocked until mounts are removed (compose unregister clears them in the same txn as service reconcile).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `secret`      | `organization_id` CASCADE; optional `principal_id` RESTRICT                                                                                                             | Sealed provider secrets (`secret_envelope` NOT NULL). **No public CRUD** this slice. Reencrypt sweep stage `credentials` plus `storage.content_envelope`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `managed`     | `environment_id` NOT NULL (unique); optional `server_id`                                                                                                                | Environment-scoped managed DB/cache: `name`; dedicated **`engine`** / **`status`** columns (index `idx_managed_engine`); **`status`** CHECK `NULL OR IN ('provisioning','applying','ready','stopped','failed')`. Optional **`server_id`** FK → `server` `ON DELETE RESTRICT` pins the **primary** host. Residual **`metadata`**: `rootPrincipalId` / `rootUsername` / `host` / `port` / optional `error`. **`options`**: `{ settings, databases[] }` from the engine spec. Root/user creds via **`principal.managed_id`** sealed as `tpsecret`. Cluster fan-out lives on **`replica`**; apply pre-allocates one engine `service` row plus one `role='service'` container per replica at `ordinal = replica.ordinal` (`managedContainerName` → `<service.id>-N`) and sets `service.options.instances` to the replica count — **no** managed Traefik ingress container on the engine service. Client API: `src/client/managed/`. Engine specs: `src/lib/managed/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `replica`     | `managed_id` NOT NULL + `server_id` NOT NULL                                                                                                                            | One server in a managed cluster. **`role`** CHECK `('primary','replica')` with partial unique **`uniq_replica_primary`** on `(managed_id) WHERE role = 'primary'`. Nullable **`replica_class`** CHECK `('failover','read')` — required in practice for replicas (`failover` = same-datacenter, promotable; `read` = any org server over local/datacenter/fabric/public); null on primary. **`ordinal`** ≥ 1; unique `(managed_id, ordinal)` and `(managed_id, server_id)`. **`is_read_eligible`**, nullable **`replication_transport`** (`local` \| `fabric` \| `datacenter` \| `public`), nullable **`status`** (mirrors managed status CHECK). No API replica cap. Indexes on `managed_id` and `server_id`. `managed_id` CASCADE; `server_id` RESTRICT. |
| `forge`       | optional `organization_id` CASCADE (NULL = instance-wide)                                                                                                               | Registered GitHub App / GitLab OAuth application (physical table **`forge`**, was `gitapp`; export `forge`). **`provider`** CHECK. Sealed secrets live in **`envelopes`** (was `gitapp.credentials`: `privateKeyEnvelope?`, `clientSecretEnvelope?`, `webhookSecretEnvelope?`). Uniques: `uniq_forge_webhook_ref`, `uniq_forge_provider_base_external`, `uniq_forge_webhook_token_hash`. Helpers: `src/lib/git/forge-records.ts` (path unchanged this phase). |
| `connection`  | `organization_id` CASCADE; `forge_id` NOT NULL                                                                                                                          | Git provider App installation granted to one org (physical table **`connection`**, was `installation`; export `gitConnection`). **`forge_id`** FK → `forge` (was `installation.app_id`). **`provider`** kept as a denormalized filter column (CHECK `github`). **`external_installation_id`** is the provider-side id (GitHub numeric id as text); unique `uniq_connection_organization_forge_external` on `(organization_id, forge_id, external_installation_id)`. Plus `account_login` / `account_type` / `suspended_at`. **No token columns** — installation access tokens are minted on demand in `src/lib/git/github-app-token.ts` and never persisted. |
| `repository`  | `organization_id` CASCADE; optional `connection_id` **SET NULL**; optional `service_id` / `environment_id` **CASCADE** (at most one, `repository_at_most_one_parent_check`); optional `secret_id` **SET NULL** | Git repository binding (physical table **`repository`**, was `source`). **`provider`** CHECK `github` \| `git`; **`repository_url`** NOT NULL; optional `repository_external_id` (GitHub numeric repo id, webhook matching), `default_branch`, `subdirectory` (same relative-path rule as compose `x-turbopanel.root`); **`auto_deploy`** CHECK `immediate` \| `checks_passed` \| `disabled` (default `disabled`). `secret_id` is the generic-SSH deploy-key path (schema only, mirrors `secret`). Compose services reference a row via `services.<name>.x-turbopanel.source.sourceId`; the id-resolves check runs in the project/environment route layer (`knownSourceIds`), never in the pure compose parser. CRUD: `src/client/repositories/routes.ts` (path unchanged this phase). Helpers: `src/lib/db/repository-records.ts` (file name unchanged until a later phase). |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `variable`    | exactly one of `organization_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `hosting_id`, `server_id` (all nullable FKs; CHECK enforces one parent) | Config vars/secrets at any resource scope; `is_secret` flag; **`is_literal`**, **`is_for_build`**, **`is_for_runtime`** (default runtime-only) control deploy injection; secret `value` is a sealed envelope; partial unique indexes on `(key, <parent_fk>)` per scope; `ON DELETE CASCADE`. Optional **`binding_id`** (FK → `binding.id` **CASCADE**) marks system-owned rows materialised by a binding — client PATCH/DELETE returns **403** `binding_owned_variable`. Key must match `^[A-Za-z_][A-Za-z0-9_]*$`. **Inheritance** (runtime resolution; lower scope wins): service resolution uses `service` → `environment` → `project` → `workspace` → `organization`; hosting resolution uses `hosting` → `service` → `environment` → `project` → `workspace` → `organization`. **Deploy compose injection** additionally merges hosting-scoped vars for that service via `mergeHostingVariablesForService` (sorted hosting ids; later wins on key conflicts) then **re-asserts binding-owned service keys** so hosting cannot shadow a binding. **Server-scoped** variables are fetched separately and do not participate in either inheritance chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tag`         | `organization_id` NOT NULL CASCADE                                                                                                                                                  | Org-owned tag definition. **`name`** is a label (no DB format CHECK); app-enforced trim + case-insensitive uniqueness (`uniq_tag_organization_name`). Optional **`description`**, **`color`**. Helpers: `src/lib/db/tag-records.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `marker`      | `tag_id` CASCADE; exactly one of `server_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `datacenter_id`, `storage_id` (all CASCADE; CHECK `marker_exactly_one_parent_check`) | Join edge: one tag on one parent. Partial uniques `uniq_marker_server` … `uniq_marker_storage`. Org derived through `tag.organization_id` — **no** `organization_id` by design. Deleting either end cleans up. No `metadata`/`options` pair (follows `tenancy` / `label`). Helpers: `src/lib/db/tag-records.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `task`        | `service_id` NOT NULL CASCADE                                                                                                                                                       | Cron-style scheduled command on a service. Org derived through `service`. **`name`** is a label (no DB format CHECK); app-enforced trim + case-insensitive uniqueness per service (`uniq_task_service_name` is the exact-match backstop). **`schedule`** is operator cron text stored verbatim; **`command`** is an argv line stored verbatim. **`concurrency_policy`** CHECK `allow` \| `forbid` \| `replace`. No execution columns and no run-history table. Helpers: `src/lib/db/task-records.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Forward note on execution.** When execution lands, a due task will enqueue
an existing `command` and reuse the execution-log transcript rail
(`src/lib/execution-logs/`), so no new storage class appears. Compose
`x-turbopanel.cron` stays the compose-authored, deploy-time path for **site**
services, translated by `src/lib/cron.ts` into systemd `OnCalendar` at prepare.
The two are not merged in this pass; both read the same validator.

**Reserved table name `transfer`:** not created this slice. Future
replica/archive copy jobs (child `command`s) should use this physical name. Do
not reuse it for unrelated tables.

**Storage follow-ups (not this slice):** NFS/CIFS host mounts (daemon-managed;
never passwords in Compose `driver_opts`); S3 as `kind=object` / `transfer`, not
POSIX; rclone crypt scratch under `/run/turbopanel`;
`storage.copy.ensure|remove|inspect` commands. API CHECK already includes
unused providers; client this slice only accepts `docker` \| `path`.

### Resource naming contract

Generated names and principal paths live in **`src/lib/naming.ts`** — the single
source of truth for container names (`containerNameFromService` /
`managedContainerName` / `ingressContainerNameFromService` → `<service.id>-in`
for per-service Traefik **and** shared ProxySQL `managed-ingress` — suffix
contract in the repo-root `AGENTS.md` → **Container name suffix contract**;
all keyed off the **service** UUID, not the container row), Docker volume names
(`dockerVolumeNameFromStorageId` / `resolveDockerVolumeName` / legacy-only
`legacyNamespacedDockerVolumeName`), principal home/SSH/volume paths under
`/srv/users/<username>` (keyed on the operator-chosen username, not the
principal UUID), the reserved-only DNS shape (`serviceDnsName`), and the
reserved `TURBOPANEL_*` deploy variable keys (`RESERVED_DEPLOY_VARIABLE_KEYS`).
Option parsers (`project-options.ts` `containerNaming`, `service-options.ts`
`instances`, `principal-options.ts` `shell` + optional `uid`/`gid` override)
feed those helpers; deploy-prepare owns allocation (`uuid` mode ignores authored
compose `container_name`; `custom` still reads them), multi-instance expansion, compose-volume
registration, and compose emission via `apply-service-options.ts` (sole writer
of allocated `container_name` values).

Native Postgres **`inet`** and **`cidr`** columns are defined in `net-types.ts`
via Drizzle `customType` — no regex CHECK constraints belong on those types.

**Names** (`name` column, API `name`) on organization, workspace,
project, environment, service, hosting, datacenter, network, fabric, tls, team,
managed, server, license, storage, and secret are labels, not identifiers.
Phase 2 drops **only** `hosting_name_format_check` and
`datacenter_name_format_check` — those two CHECKs contradict app-side
`display-name-format.ts`. Every other name-format CHECK is **unchanged**:
`tls_name_format_check`, `workspace_name_format_check`,
`project_name_format_check`, `environment_name_format_check`,
`service_name_format_check`, `network_name_format_check`,
`fabric_name_format_check`, `team_name_format_check`,
`managed_name_format_check`, `user_name_format_check`, and
`binding_database_name_format_check`. The preferred app-side rule for labels
(and the rule that replaces the two dropped CHECKs) is
`src/lib/display-name-format.ts` (`normalizeDisplayName` + `isValidDisplayName`)
— trim, Unicode NFC, apostrophe-fold, no control characters, and a code-point
length cap (`DISPLAY_NAME_MAX_LENGTH` / `DESCRIPTION_MAX_LENGTH`, currently
255). Changing the cap is a code change, not a migration. The same length-only
rule applies to `description` columns and Docker **label values** (`label.value`;
the **key** CHECK stays). Typographic apostrophes still fold to ASCII `'` so
iOS/macOS input matches uniqueness compares.

**Identifiers vs labels.** Identifier charsets stay strict (interpolated into
SQL / Docker / Traefik / shell). Do not relax these:

| Guard | Where | Why it stays |
| --- | --- | --- |
| `service.compose_service_name` | `isValidComposeServiceName` in `src/lib/commands/schemas.ts` | Compose YAML key + `-p` project scoping |
| `principal_username_format_check` | schema + `src/client/principals/store.ts` | `useradd` / SQL `CREATE ROLE` |
| `variable_key_format_check` | schema | Shell env-var name |
| `binding_key_prefix_format_check`, `binding_database_name_format_check` | schema | SQL identifier / env prefix |
| `label_key_format_check` | schema, `ui/src/lib/server-labels.ts` | Docker engine label key → `node.labels.*` constraints |
| Hostnames | `turbopaneld` `src/instance/commands/hostname.ts`, `src/deploy/compose-labels.ts`, `src/deploy/ingress.ts` | Traefik router rules, DNS |
| `DEPLOY_INGRESS_COMPOSE_NAME_RE` / `CONTAINER_NAME_RE` | `turbopaneld` `src/instance/commands/contracts.ts`, `src/deploy/ingress-identity.ts` | Docker CLI args, on-disk file ids |

The daemon never receives display labels on a path that interpolates them.

**Project cascade delete** (`deleteProjectCascade` in `project-delete.ts`):
after all containers under the project are non-active
(`exited`/`dead`/`removing`), `DELETE /projects/:id` runs
`applyStorageRetentionOnParentDelete` (clear `mount`s first — `service_id` is
RESTRICT — then drop `retention='delete'` storage; `retain` rows stay org-owned
via SET NULL), then deletes in order `container` → `hosting` → `service` →
`environment` → `project` (variables/`managed` cascade via FK). Active
containers return **409** `project_has_running_services` — stop stacks first via
`environment.stop`. The cascade itself is Postgres-only; the route wraps it with
`planEnvironmentsTeardown` / `reclaimDeletedEnvironmentHosts`
(`client/environments/teardown.ts`) so the host's deployment dir, hosting Caddy
site, per-service tcp/udp Traefik and `tpn_*` bridges are reclaimed even when
the environment was stopped with `environment.lifecycle` (which leaves them in
place) rather than `environment.stop`. Restrictive FKs stay in place as a safety
net. Workspace /
environment / service delete paths use the same retention helper.

Authorization ancestry and `listVisible()` resolve organization through this
chain in SQL (`evaluator.ts`, `create-access-grant.ts`). **`variable`** and
**`managed`** are in `RESOURCE_KINDS`, `GRANT_ENTITY_TYPES`, and `ENTITY_TYPES`
(`catalog.ts`); `resolveEntityById()` and `can()` resolve their org via parent
joins (same paths as `create-access-grant.ts`) — **`managed`** ancestry resolves
via `environment → project → workspace`. **`principal`** is in `RESOURCE_KINDS`
and `ENTITY_TYPES` but **not** `GRANT_ENTITY_TYPES` — org is derived via
`tenancy → service → environment → project → workspace` (returns null when
unassigned); `tenancy` itself is not a grantable authz entity.
**`GET /access/check`** accepts any resolvable entity UUID (including `variable`
and `managed`). **`GET /access/resource-id`** accepts only `organization` and
`team` kinds (grant-management UI). Access grants still target org/team entities
only.

> Permissions are **static code constants** defined in
> `../../client/authz/catalog.ts` (`PERMISSIONS`, `ENTITY_TYPES`,
> `SUBJECT_TYPES`) — not DB rows. There are no `role`, `permission`, or `permit`
> tables. The Drizzle table export is **`grant`** (not `accessGrant`).

Drizzle relations are defined for future Better Auth adapter use.
`IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup.
`setting.value` is `jsonb`. The `SYSTEM_EMAIL` key stores all email settings as
a single JSON object (self-hosted mode only; env vars take precedence and leave
this table empty).

**Organizations:** a user is in an org iff they are a `teammate` of any `team`
in that org. Org owner/manager roles come from `grant` (`organization:own` /
`organization:manage`) on the user or a team — not from binding users directly
to organizations. `user.role` (`superadmin` / `admin` / `user`) is instance
authority, separate from org access. **`invitation.grants`** (JSONB) stores the
intended access grants (`InvitationGrantSpec[]` in
`src/client/authn/invitation-grants.ts`); they are materialized into `grant`
rows on accept. When `grants` is null, accept applies a default
`organization:manage` grant on the org. **`organization.options.maxServers`**
caps enrolled servers + unconsumed registration keys (`null`/omitted =
unlimited). Self-hosted operators set it via
`GET`/`PUT /organizations/:id/server-capacity`; `POST /licenses` returns **409**
`server_capacity_exceeded` when the org is at capacity. Workers/Stripe billing
will write the same field later.

**Host defaults cascade** (no schema migration — stored in existing `options`
jsonb): organization → datacenter → server, most specific wins. SSH
(`sshPort`, 1–65535) falls back to **22**. Desired NTP (`ntp`: `enabled` /
`servers` / `fallbackServers`) is separate from daemon-reported `timeSync`
columns. `defaultFabricEnabled` is organization-only and never enables the
mesh by itself (`PUT …/fabric` remains the enable path). Timezone keeps its
enforce/override resolver — do not treat org/DC timezone as a soft default.
`null` on PUT/PATCH clears that layer so the parent inherits. Canonical
parsers/resolvers: `src/lib/host-defaults.ts`.

**Uniqueness:** `teammate(team_id, user_id)` prevents duplicate team membership
rows on concurrent invite acceptance/retries.

**Install (Deno):** A fresh DB has no org or superadmin.
`src/client/authn/install-state.ts` `isInstanceInstalled()` is false until
`completeInstanceInstall` creates org → **TurboPanel workspace
(`kind='turbopanel'`)** → team → superadmin → grants → **Default Workspace**
(`kind='user'`) → colocated license. **"TurboPanel"** is therefore a
reserved workspace name from first boot (**409**
`workspace_name_in_use`). **`organization.slug`** stays **NULL** (reserved for a
future feature). Org extras (e.g. logo URL) belong in
**`organization.metadata`** — there is no `logo` column. Install sets
**`email`** and **`role`** (on `user`) only — optional user `name` stays
**NULL** until the user chooses it. The Postgres column is `name` while the
client JSON field is `name`.

**Install sentinel invariant:** `completeInstanceInstall` is race-safe. The very
first write inside its transaction is a **unique install sentinel** — a
`setting` row with `key = INSTANCE_INSTALL_SENTINEL_KEY`
(`'INSTANCE_INSTALL_SENTINEL'`), inserted with
`ON CONFLICT (key) DO NOTHING ... RETURNING`. Concurrent install transactions
block on the `setting_key_unique` constraint until the first commits, then
observe the conflict (no returned row) and abort with
`INSTANCE_ALREADY_CONFIGURED_ERROR`. After acquiring the sentinel the
transaction re-checks `isInstanceInstalled(tx)` (guards pre-sentinel installs
where org+superadmin already exist) and then performs every root setup insert
(org, **TurboPanel workspace**, team, superadmin user + credential account,
teammate, grants, Default Workspace, colocated license) in the same transaction.
This reuses the existing `setting` table (no schema migration) — only one
superadmin/organization bootstrap can ever be created, even under concurrent
requests across isolates.

### Client API (authz integration)

| Method   | Path                                                            | Purpose                                                                                                                                              |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/client/v1/invitations/{id}/accept`                        | Accept a pending invitation; creates a `teammate` row, materializes `invitation.grants` into `grant` rows, updates session `organizationId`          |
| `GET`    | `/api/client/v1/permissions`                                    | Permission catalog — static, no DB query (any authenticated user)                                                                                    |
| `GET`    | `/api/client/v1/access?resourceId=<uuid>`                       | List access grants for a resource; returns `{ access: AccessRecord[] }` with `subjectKind`, `subjectId`, `resourceId`, `effect`, and `permissionKey` |
| `GET`    | `/api/client/v1/access/check?resourceId=<uuid>&permissionKey=…` | Check a single permission for the signed-in user; returns `{ allowed: boolean }`                                                                     |
| `GET`    | `/api/client/v1/access/resource-id?kind=<kind>&itemId=<uuid>`   | Resolve `resourceId` for an entity in the session org; returns `{ resourceId, kind, itemId }`                                                        |
| `POST`   | `/api/client/v1/access`                                         | Create an access grant; body: `{ subjectKind, subjectId, resourceId, effect, permissionKey }`                                                        |
| `DELETE` | `/api/client/v1/access/{id}`                                    | Revoke an access grant                                                                                                                               |

#### Resource tree CRUD

List and get enforce visibility via `listVisible` / org-level grant checks in
SQL — never client-side. Create, update, and delete require `organization:own`
or `organization:manage` on the entity's org (via `can()`). All create/delete
operations run entity insert/delete in a single transaction.

| Method            | Path                                                                                | Permission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`             | `/api/client/v1/organizations/{id}/default-timezone`                                | org manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PUT`             | `/api/client/v1/organizations/{id}/default-timezone`                                | org manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET`             | `/api/client/v1/organizations/{id}/server-capacity`                                 | org manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PUT`             | `/api/client/v1/organizations/{id}/server-capacity`                                 | org owner (`maxServers`; null = unlimited)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET`             | `/api/client/v1/workspaces`                                                         | org owner/manager or platform admin (via `listVisible`)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET`             | `/api/client/v1/workspaces/{id}`                                                    | org owner/manager or platform admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST`            | `/api/client/v1/workspaces`                                                         | org owner/manager on org                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PATCH`           | `/api/client/v1/workspaces/{id}`                                                    | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE`          | `/api/client/v1/workspaces/{id}`                                                    | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`             | `/api/client/v1/environments`                                                       | org owner/manager (optional `?projectId=`); returns `metadata` and `options`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`             | `/api/client/v1/environments/{id}`                                                  | org owner/manager; returns `metadata` and `options`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST`            | `/api/client/v1/environments`                                                       | org owner/manager on parent project; optional `options` (plain object, e.g. `options.compose` overlay; placement stripped) and optional `serverId`                                                                                                                                                                                                                                                                                                                                                                  |
| `PATCH`           | `/api/client/v1/environments/{id}`                                                  | org owner/manager; optional `options` patch (placement stripped) and optional `serverId` (`null` clears the pin)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DELETE`          | `/api/client/v1/environments/{id}`                                                  | org owner/manager; **409** `managed_runtime_present` while a `managed` row remains (destroy first — `managed.environment_id` CASCADE would drop host runtime)                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`             | `/api/client/v1/variables`                                                          | org owner/manager (optional `?environmentId=`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET`             | `/api/client/v1/variables/{id}`                                                     | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST`            | `/api/client/v1/variables`                                                          | org owner/manager on parent environment; `isSecret=true` seals value via `encryptSecret`; sealed values are never returned; **409** `binding_key_conflict` when key is already owned by a binding on that service/hosting                                                                                                                                                                                                                                                                                           |
| `PATCH`           | `/api/client/v1/variables/{id}`                                                     | org owner/manager; re-seals on secret value update (lazy re-seal-on-write under the current data-encryption key version); **403** `binding_owned_variable` when `binding_id` is set                                                                                                                                                                                                                                                                                                                                 |
| `DELETE`          | `/api/client/v1/variables/{id}`                                                     | org owner/manager; **403** `binding_owned_variable` when `binding_id` is set                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET`             | `/api/client/v1/tags`                                                               | org read; no scope → org registry; exactly one parent query (`serverId` / `workspaceId` / `projectId` / `environmentId` / `serviceId` / `datacenterId` / `storageId`) → entity tags after resolving the parent org (**404** on mismatch) then read-gating the entity; **400** if not exactly zero or one parent                                                                                                                                                                                                                                    |
| `POST`            | `/api/client/v1/tags`                                                               | org manage; **409** `tag_name_in_use` (pre-check and unique-index backstop)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PATCH`           | `/api/client/v1/tags/{id}`                                                          | org manage; **404** on org mismatch; **409** `tag_name_in_use` when renaming onto another tag                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DELETE`          | `/api/client/v1/tags/{id}`                                                          | org manage; **404** on org mismatch; markers disappear via `marker_tag_id_tag_id_fk` CASCADE                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET`             | `/api/client/v1/markers`                                                            | org read; `?tagId=` required; **404** on org mismatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PUT`             | `/api/client/v1/markers`                                                            | replace-all; manage + `assertNotSystemOwnedOr403` on the parent entity (never a client-supplied org); **404** if the parent or any `tagId` is missing from the org; **403** `system_resource_immutable` on platform-owned parents                                                                                                                                                                                                                                                                                                          |
| `GET`             | `/api/client/v1/tasks`                                                              | org read via `listVisible` on `service`; mutually exclusive `?serviceId=` / `?environmentId=` (**400** when both); `serviceId` not in the visible set → **404**; neither filter lists tasks for every visible service; configuration only — nothing is enqueued                                                                                                                                                                                                                                                                              |
| `POST`            | `/api/client/v1/tasks`                                                              | manage + `assertNotSystemOwnedOr403` on the parent service; required `serviceId` / `name` / `schedule` / `command`; **400** `task_schedule_invalid` / `task_command_invalid`; **409** `task_limit_reached` (cap `MAX_CRON_JOBS_PER_SERVICE`); **409** `task_name_in_use` (pre-check and unique-index backstop). Stored only — no `command` row, no daemon payload                                                                                                                                                    |
| `GET`             | `/api/client/v1/tasks/{id}`                                                         | org match through parent service (**404** otherwise) then read-gate the service                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PATCH`           | `/api/client/v1/tasks/{id}`                                                         | manage + `assertNotSystemOwnedOr403` on the parent service; **404** on org mismatch; **400** `task_schedule_invalid` / `task_command_invalid`; **409** `task_name_in_use` when renaming onto another task on the same service                                                                                                                                                                                                                                                                                       |
| `DELETE`          | `/api/client/v1/tasks/{id}`                                                         | manage + `assertNotSystemOwnedOr403` on the parent service; **404** on org mismatch; no hierarchy delete (a task has no children)                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`             | `/api/client/v1/bindings?serviceId=` / `?environmentId=` / `?managedEnvironmentId=` | org manage; list bindings + emitted keys/endpoint (never values). `serviceId` = one compose service; `environmentId` = consumer services in that env; `managedEnvironmentId` = principals on that managed cluster                                                                                                                                                                                                                                                                                                   |
| `POST`            | `/api/client/v1/bindings`                                                           | org manage on target service; insert + materialize service-scoped variable rows                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PATCH`           | `/api/client/v1/bindings/{id}`                                                      | org manage; `keyPrefix` / `emitEngineDefaults` only; re-materialize                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DELETE`          | `/api/client/v1/bindings/{id}`                                                      | org manage; cascades binding-owned variables                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`             | `/api/client/v1/projects`                                                           | org owner/manager (optional `?workspaceId=`); returns `metadata` and `options`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET`             | `/api/client/v1/projects/{id}`                                                      | org owner/manager; returns `metadata` and `options`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST`            | `/api/client/v1/projects`                                                           | org owner/manager on parent workspace; optional `type` (`docker-compose` \| `template` \| `managed`, default `docker-compose`; platform-only `system` is never accepted), `code` (required for template/managed), and optional `serverId` (pins every scaffolded environment in the same transaction); managed engines scaffold a `Production` environment (no `managed` row until `POST …/managed`)                                                                                                                                                          |
| `POST`            | `/api/client/v1/environments/{id}/deploy`                                           | org manager; target from persisted `environment.server_id` only (`409 server_placement_required` when unset; body `serverId` is ignored); merges project+env compose to runtime YAML (placement stripped from both), creates `environment.deploy` command; poll status via `GET /servers/:serverId/commands/:commandId` (Postgres only — no DO reads)                                                                                                                                                               |
| `GET`             | `/api/client/v1/environments/{id}/deploy-preview`                                   | org manager; same `prepareDeployCompose` path as deploy (idempotent container allocation + volume registration) but skips daemon sealing; returns `{ ok, composeYaml, projectName, containers[], volumes[], warnings[] }` with secret values redacted; **`projectName` is the TurboPanel project UUID** (Docker Compose `-p`, never a display-name slug); container names use service UUIDs when `containerNaming` is `uuid` (default); prepare gates surface as non-fatal `warnings` so the preview always renders |
| `GET`             | `/api/client/v1/environments/{id}/managed`                                          | org manage; `{ managed, connection, settings, server, rootUsername, members[] }` (never passwords; connection null while provisioning)                                                                                                                                                                                                                                                                                                                                                                              |
| `POST`            | `/api/client/v1/environments/{id}/managed`                                          | org manage; create managed row + primary `replica` + root principal + fan-out `managed.apply`; show-once `rootPassword`; idempotent thereafter; `409 server_placement_required` / `server_offline` / `managed_busy`                                                                                                                                                                                                                                                                                                    |
| `PATCH`           | `/api/client/v1/environments/{id}/managed`                                          | org manage; persist settings only (no apply); `400 managed_settings_invalid`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST`            | `/api/client/v1/environments/{id}/managed/apply`                                    | org manage; prepare+fan-out `managed.apply` (one command per member)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST`            | `/api/client/v1/environments/{id}/managed/lifecycle`                                | org manage; fan-out `managed.lifecycle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DELETE`          | `/api/client/v1/environments/{id}/managed`                                          | org manage; hard-delete only when unplaced (`server_id` null); placed clusters always fan-out `managed.destroy` (`deleted: false`; deleteAfterDestroy on primary only) even when status is `stopped` / `failed` / `provisioning` (lifecycle stop is non-destructive; failed apply can still have containers)                                                                                                                                                                                                                   |
| `POST`            | `/api/client/v1/environments/{id}/managed/root-password`                            | org manage; rotate root password (show-once) + apply fan-out; response includes `redeployRequired` when bindings exist on the root principal                                                                                                                                                                                                                                                                                                                                                                        |
| `GET/POST/DELETE` | `/api/client/v1/environments/{id}/managed/users[/{principalId}]`                    | org manage; list/create/delete engine users (passwords show-once on create; org-wide **409** `username_in_use`; **409** `managed_user_has_bindings` when bindings remain)                                                                                                                                                                                                                                                                                                                                           |
| `POST`            | `/api/client/v1/environments/{id}/managed/users/{principalId}/password`             | org manage; rotate user password (show-once) + re-materialize bindings + apply fan-out; `redeployRequired` lists affected consumer services                                                                                                                                                                                                                                                                                                                                                                         |
| `GET/POST/DELETE` | `/api/client/v1/environments/{id}/managed/databases[/{name}]`                       | org manage; database name list/create/drop + apply; **409** `managed_database_has_bindings` when a binding references the name                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET/POST`        | `/api/client/v1/environments/{id}/managed/members`                                  | org manage; list/add replica members (`replicaClass` default `failover`; placement/private-path 422s)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PATCH/DELETE`    | `/api/client/v1/environments/{id}/managed/members/{memberId}`                       | org manage; `readEligible` / `replicaClass` patch or remove replica (primary delete → **409** `managed_member_is_primary`; read→failover conversion re-validates placement)                                                                                                                                                                                                                                                                                                                                                                       |
| `POST`            | `/api/client/v1/environments/{id}/managed/members/{memberId}/promote`               | org manage; enqueue `managed.promote` to a **failover** replica (**422** `managed_replica_not_promotable` for `read` unless `{ force: true }`)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`             | `/api/client/v1/environments/{id}/managed/status`                                   | org manage; Postgres-only status + containers + per-member status (no cell/DO)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET`             | `/api/client/v1/environments/{id}/managed/logs`                                     | org manage; cell `managed-logs-request` round-trip                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET`             | `/api/client/v1/organizations/{id}/managed`                                         | org manage; one joined list of managed services with `members[]` (Postgres only)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`             | `/api/client/v1/project-catalog`                                                    | org owner/manager (session required); UI-safe catalog summaries (`code`, `kind`, `displayName`, `description`) — no compose or secret defaults                                                                                                                                                                                                                                                                                                                                                                      |
| `PATCH`           | `/api/client/v1/projects/{id}`                                                      | org owner/manager; returns `metadata` (read-only via PATCH) and accepts patchable `options` (e.g. `options.compose`) plus optional `workspaceId` to move the project to another same-org workspace (authz on target workspace)                                                                                                                                                                                                                                                                                      |
| `DELETE`          | `/api/client/v1/projects/{id}`                                                      | org owner/manager; **409** `project_has_running_services` while compose containers are active; **409** `managed_runtime_present` while any `managed` row remains (destroy the engine first — CASCADE would drop host runtime)                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`             | `/api/client/v1/services`                                                           | org owner/manager (optional `?environmentId=`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET`             | `/api/client/v1/services/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST`            | `/api/client/v1/services`                                                           | org owner/manager on parent environment                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PATCH`           | `/api/client/v1/services/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE`          | `/api/client/v1/services/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`             | `/api/client/v1/hostings`                                                           | org owner/manager (optional `?serviceId=`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET`             | `/api/client/v1/hostings/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST`            | `/api/client/v1/hostings`                                                           | org owner/manager; `serviceId` required; optional `tlsId`, `ipId`, `options.bind`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PATCH`           | `/api/client/v1/hostings/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE`          | `/api/client/v1/hostings/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`             | `/api/client/v1/networks`                                                           | org owner/manager (optional `?datacenterId=`, `?serverId=`, `?kind=`)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET`             | `/api/client/v1/networks/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST`            | `/api/client/v1/networks`                                                           | org owner/manager; body requires `kind` (`datacenter` \| `docker` — not `compose` / not `server`); `datacenter` requires `datacenterId`; `docker` may optionally pin `serverId` (must not set `datacenterId`); `kind: docker` requires `options.dockerNetworkName`                                                                                                                                                                                                                                                  |
| `PATCH`           | `/api/client/v1/networks/{id}`                                                      | org owner/manager; `datacenterId`/`serverId` immutable; docker options patches must keep a valid `dockerNetworkName`                                                                                                                                                                                                                                                                                                                                                                                                |
| `DELETE`          | `/api/client/v1/networks/{id}`                                                      | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`             | `/api/client/v1/datacenters`                                                        | org owner/manager; each row includes **`privateCidrs: string[]`** — one entry **per subnet**                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET`             | `/api/client/v1/datacenters/{id}`                                                   | org owner/manager; includes **`privateCidrs`**, **`subnets[]`** (`id`, `cidr`, `version`, `name`, `description`, `memberCount`), **`options.addressPreference`**, and **`members[]`** pins                                                                                                                                                                                                                                                                                                               |
| `POST`            | `/api/client/v1/datacenters`                                                        | org owner/manager; `{ members: [{ serverId, address }], … }` — daemon-reported private IPs; first subnet derived from the seed prefix when present, else typical LAN `/24`/`/64`; **extra members auto-create another subnet** when their reported prefix matches none; **400** `address_cidr_unreported` / **409** `subnet_overlaps`                                                                                                                                                                                                                                                                                                                                                                               |
| `POST`            | `/api/client/v1/datacenters/{id}/members`                                           | org manager; add pins (a server may hold more than one); extra members must have a reported private IP; a pin that does not match an existing subnet creates one from the reported prefix; **409** `address_in_use` / `subnet_overlaps`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE`          | `/api/client/v1/datacenters/{id}/members/{serverId}`                                | org manager; deletes every membership `ip` row for that server in the datacenter                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST`            | `/api/client/v1/datacenters/{id}/subnets`                                           | org manage; typed v4/v6 CIDR normalized via `alignedNetworkCidr`; **400** `invalid_cidr`; **409** `subnet_overlaps` (overlap checked org-wide)                                                                                                                                                                                                                                                                                                                                                                      |
| `PATCH`           | `/api/client/v1/datacenters/{id}/subnets/{networkId}`                               | org manage; rename (`name`) only — `cidr` immutable                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DELETE`          | `/api/client/v1/datacenters/{id}/subnets/{networkId}`                               | org manage; **409** `subnet_has_members` while any `ip` row references it                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PATCH`           | `/api/client/v1/datacenters/{id}`                                                   | org owner/manager; accepts `options.addressPreference` (replace-all `options`)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DELETE`          | `/api/client/v1/datacenters/{id}`                                                   | org owner/manager; **409** `datacenter_has_members` while pins remain; otherwise deletes **all** site subnets (`kind='datacenter'`) + datacenter (**409** `datacenter_has_networks` only for leftover non-site networks)                                                                                                                                                                                                                                                                                          |
| `GET`             | `/api/client/v1/ips`                                                                | org owner/manager (optional filters); scopes `public` \| `datacenter`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET`             | `/api/client/v1/ips/{id}`                                                           | org owner/manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST`            | `/api/client/v1/ips`                                                                | org owner/manager; `scope=datacenter` free pool is `datacenterId` only; membership pin requires `datacenterId` + `serverId` + `networkId` (site subnet of that datacenter; **400** `address_not_in_any_subnet`) |
| `PATCH`           | `/api/client/v1/ips/{id}`                                                           | org owner/manager; `address` / `allocation` / `scope` immutable (`version` is derived-only and rejected if supplied); optional `description` (`text`; length cap is app-side); optional `datacenterId` / `serverId` / `networkId` patches (membership pins still require all three; **400** `address_not_in_any_subnet`) |
| `DELETE`          | `/api/client/v1/ips/{id}`                                                           | org owner/manager; **409** when hosting pins the IP                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET`             | `/api/client/v1/organizations/{id}/fabric`                                          | org manager; TurboFabric settings + relays (PSK never returned)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PUT`             | `/api/client/v1/organizations/{id}/fabric`                                          | org manager; enable/disable; PUT disable is a **real teardown** that also reclaims `network(kind='compose')` + `subnet`                                                                                                                                                                                                                                                                                                                                                                                            |
| `PATCH`           | `/api/client/v1/organizations/{id}/fabric/relays/{serverId}`                        | org manager; role / advertisedCidrs / keepalive / endpointAddress / write-only presharedKey; **422** `gateway_datacenter_required` / `gateway_datacenter_cidr_required`                                                                                                                                                                                                                                                                                                                                             |
| `POST`            | `/api/client/v1/organizations/{id}/fabric/apply`                                    | org manager; fleet-wide `server.fabric.reconcile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PATCH`           | `/api/client/v1/servers/{id}`                                                       | org manager; optional `name` / `options` (not `datacenterId` — use datacenter member routes)                                                                                                                                                                                                                                                                                                                                                                                                                  |

Implemented in `src/client/*/routes.ts`, registered from `registerClientRoutes`.

**Principals** are not exposed as public client CRUD. Hosting/database-user
flows create `principal` / `tenancy` rows via `src/client/principals/store.ts`;
passwords are sealed as `tpsecret` at rest and re-sealed to `tpdaemon` only at
delivery.

`GET /api/client/v1/servers` uses `listVisible()` for server visibility (not raw
team membership). License endpoints (`GET`/`POST` `/licenses`, `DELETE`
`/licenses/{id}`) require org ownership (`organization:own`).

### Catalog

Permissions are **static code constants** in `../../client/authz/catalog.ts` —
there is nothing to seed. Seven permissions exist: `organization:own`,
`organization:manage`, `team:own`, `team:manage`, `system:read`,
`system:operate`, and `system:manage`. `system:manage` is **not grantable**
(superadmin-only). Never edit permissions in Studio — they
do not exist as DB rows. **`ENTITY_TYPES`** and **`SUBJECT_TYPES`** (`user`,
`team`, `organization`) are also
exported from `catalog.ts` for route/body validation (`isEntityType`,
`isSubjectType`). Organization-wide subject grants apply to every teammate of
a team in that organization.

### `license` table

Organization-scoped API tokens for server registration. Each row belongs to an
`organization` (`organization_id`, cascade delete). `name` is optional. `token`
stores an Argon2id PHC hash in the same `$argon2id$…` format as
`account.password`. Soft-delete via `revoked_at` — revoked licenses remain in
the table for audit; application code should treat non-null `revoked_at` as
inactive.

**One-shot latch:** `license.server_id` (nullable FK → `server.id`,
`ON DELETE SET NULL`) is set on first successful enroll. Partial unique index
`uniq_license_server_id` on `license(server_id) WHERE server_id IS NOT NULL`
enforces one license per server. Unconsumed seats have `server_id IS NULL`.
Revoked rows may keep `server_id` until the server is deleted (SET NULL).

**Colocated control-plane license:** install and Deno boot recovery mint a
license with `name = 'this server'` (`COLOCATED_SERVER_DISPLAY_NAME`).
`POST /api/client/v1/licenses` rejects that reserved display name so user-minted
registration keys cannot collide. Uniqueness of active colocated seats is
application-level (disk rotate revokes then mints one) — there is no
display-name unique index.

**Colocated license credentials on disk:** plaintext tokens are written once at
install to `/var/lib/turbopanel/license.id` + `license.token` (+ `server.id` for
the pre-provisioned colocated seat) via `TURBOPANEL_DAEMON_STATE_DIR` /
`TURBOPANEL_STATE_DIR` and are unrecoverable from the DB hash. Missing files
after install are fail-fast — Deno boot does **not** silently rotate/recreate
seats. Operator recovery uses `rotateColocatedLicenseCredentials` +
`persistColocatedLicenseCredentials` deliberately (in-place token rotate when an
active bound `this server` seat latches a server; otherwise revoke unbound
seats, mint one, optionally rebind). Never appends a second active orphan
silently.

### `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon
connect the instance resolves `serverId` (reuse by persisted id, `machine_key`,
or `hostname` columns), tracks presence in the **Daemon Cell**, and returns
`serverId` in enrollment responses. The daemon persists it at
`/var/lib/turbopanel/daemon/state/server.id` (production: owned by **`tp:tp`**;
co-located dev: dev-user-owned under the same FHS path). See the canonical
[Production UID/GID allocation](../../../AGENTS.md#production-uidgid-allocation)
table in the repo root `AGENTS.md`. Server rows are hard-deleted — there is no
soft-delete column. `name` and `organization_id` match the old trunk shape;
daemon registration stores `machine_key` / `hostname` on dedicated columns (not
in `metadata` — see `server-metadata.ts`). Which registration key enrolled the
server is on `license.server_id` (not a column on `server`). `organization_id`
FK uses `ON DELETE RESTRICT` — Postgres blocks deleting an organization that
still has referencing server rows. `network.server_id` → `server.id` is
`ON DELETE RESTRICT` — server deletion is blocked while network rows exist.
Deleting a server clears `license.server_id` via `ON DELETE SET NULL`; the app
soft-revokes the bound license after delete.

**`machine_key`** (`text`, nullable) is a deterministic HMAC-SHA256 digest of
the host machine-id (`src/lib/machine-key.ts` → `deriveMachineKey`) — never the
raw machine-id, and not a sealed secret (it is non-reversible and safe to
index/equality-match). It is echoed into signed enroll/auth payloads and used
for reconnect/reuse matching alongside `hostname`.

Canonical column order: `id`, `created_at`, `updated_at`, `metadata`, `options`,
`organization_id`, `name`, `hostname`, `machine_key`, `os_id`, `os_family`,
`os_version`, `os_codename`, `os_pretty_name`, `os_architecture`, `timezone`,
`is_time_sync_enabled`, `ntp_servers`, `ntp_last_synced_at`, `is_connected`,
`status_changed_at`, `daemon` (shared `metadata`/`options` pair immediately
after timestamps — remaining columns follow). **No `datacenter_id`** —
membership is via `ip` pins only. Indexes: `idx_server_organization_id`,
`idx_server_machine_key`, `idx_server_hostname`, and partial
`idx_server_connected` on `(id) WHERE is_connected`. There is no `daemon_status`
column or CHECK constraint — liveness is a single boolean plus a transition
timestamp (see "Fleet status columns" below). `organization_id` FK uses
`ON DELETE RESTRICT`. `network.server_id` → `server.id` is `ON DELETE RESTRICT`
— server deletion is blocked while network rows reference it (same for
`ip.server_id` and `relay.server_id`). Deleting a server clears
`license.server_id` via `ON DELETE SET NULL`; the app soft-revokes the bound
license after delete.

**Cell metadata fields** (stored in `server.metadata` and/or `server.options`
JSONB):

| Field              | Column                              | Purpose                                                             |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------- |
| `cellLocationHint` | `options` (preferred) or `metadata.cell.locationHint` | Cloudflare Durable Object `locationHint` chosen at enrollment time. |

`options` takes precedence over `metadata` when both define a value (see
`src/daemon/cell/location.ts`). Residual `metadata` holds nested `resources`
(cpu / memory / swap **and** `ips`), `geo`, `docker`, and `cell` — not
hostname / machineKey / OS / observed timezone / NTP (those are dedicated
columns). Leftover `os` / `timeSync` / top-level `ips` keys may still exist
in old jsonb and are read as fallbacks only.

**Host OS columns:** `os_id`, `os_family`, `os_version`, `os_codename`,
`os_pretty_name`, `os_architecture`. Raspberry Pi OS 64-bit (`ID=debian` +
`/etc/rpi-issue`) is stored as `os_id = raspberry-pi-os`. The API still
composes a nested `os` object (with `variant: raspberry-pi-os` when that id
is set).

**Host time-sync columns:** `timezone` is the **daemon-reported** IANA zone
(operator override stays on `server.options.timezone`). `is_time_sync_enabled`
is the NTP client enabled flag. `ntp_servers` is a jsonb array of
`{ host, fallback? }` (Debian often has empty `NTP=` and real servers on
`FallbackNTP=`). `ntp_last_synced_at` is the last successful sync; it is
**never** rewritten to `now()` on every heartbeat — only when the daemon
reports a stamp, the host becomes unsynced (`null`), or the first synced
observation arrives while the column is still null.

**Daemon identity (`server.daemon` jsonb):** sparse `{ key, projection? }` only.
Fleet liveness lives on dedicated columns (below). No separate `serverkey` table
exists for MVP.

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
    "daemonBuild": {
      "commit": "abc",
      "buildId": "build-1",
      "builtAt": "iso",
      "channel": "trunk"
    }
  }
}
```

| Field             | Purpose                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `key.id`          | Logical key identifier returned to the daemon as `keyId` on enrollment                                        |
| `key.publicJwk`   | Raw Ed25519 public JWK `{ crv, kty, x }`                                                                      |
| `key.fingerprint` | SHA-256 hex over the canonical public JWK — duplicate-checked at enrollment (no DB unique constraint for MVP) |
| `key.revokedAt`   | Non-null blocks new JWT issuance; existing JWTs remain valid until their 15-minute expiry                     |

**`server.daemon.projection` (sparse identity summary):** optional `hostname` /
`machineKey` (also mirrored onto dedicated columns), `remoteAddress`, `keyId`,
optional `daemonBuild` (`commit`/`buildId`/`builtAt`/`channel`), optional
`update`. Updated on identity changes and daemon build identity changes (via
`control-plane-monitor.ts` outside the DO hot path on Workers). No monitor
health counts or resource graph are stored. Projection is not path-queried for
reconnect dedup — use `hostname` / `machine_key` columns.

**Fleet status columns (liveness projection):** just two columns — `is_connected`
(`boolean NOT NULL DEFAULT false`) and `status_changed_at` (last `is_connected`
flip, set on every online **and** offline transition). There is no
`daemon_status`, `last_seen_at`, `connected_at`, or `disconnected_at` column;
the old tri-state `online|offline|unknown` and the separate timestamp columns
were collapsed into this pair. `connectedAt` is **derived**, not stored:
`src/daemon/cell/server-status.ts` returns `statusChangedAt` as `connectedAt`
only while `is_connected` is true (otherwise `null`), and treats `!is_connected` as
offline-since-`statusChangedAt`. Written by `postgres-projection.ts` only on
connect/disconnect transitions and on meaningful heartbeats (daemon
build-identity change, or new `timeSync` / `resources.ips` / `docker` facts) — never on a bare
elapsed-time debounce (there is no periodic "touch `last_seen_at` every N
seconds" write path anymore). Identity columns `hostname` / `machine_key` are
written on enroll/hello/identity projection.

**Status read model:** the two status columns above are the Postgres-projected
liveness read model. UI and API status reads go through
`src/daemon/cell/server-status.ts` (`resolveFleetPresence`) for coarse presence,
plus `src/client/servers/update-status.ts` (`loadServerStatusRecords` /
`buildServerStatusRecord`) for the `ServerStatusRecord` DTO shape (`serverId`,
`connected`, `daemonStatus`, `connectedAt`, `statusChangedAt`, `hostname`,
`remoteAddress`, `geo`, `colocatedWithInstance`). Do not read status columns
directly from routes. The tri-state `daemonStatus` (`online` \| `offline` \|
`unknown`) still exists as an **API-layer derived value** —
`src/daemon/authn/daemon-state.ts` (`mapServerDaemonStatusFromColumns`) computes
it from the `is_connected` + `status_changed_at` columns at read time (`unknown` only when
`statusChangedAt` is null, i.e. the server has never transitioned) — it is never
stored as a column or CHECK constraint. The `/servers/status` and
`/servers/:id/status` endpoints serve this read model; reads are Postgres-only
and do not call the DO/Redis cell by default; both runtimes share the same
response shape. A separate, independent **status event history** in Analytics
Engine/ClickHouse (`src/daemon/metrics/AGENTS.md`) exists for historical
uptime/downtime charts — it is history-only and never authoritative for current
liveness. See `src/daemon/cell/AGENTS.md` for cost/parity rules.

**Key use tracking:** `server.daemon.key.lastUsedAt` is updated on JWT session
issuance via `touchDaemonKeyLastUsed()` (Postgres only — no cell wake).
`lastInboundAt` remains cell-only (Redis/DO snapshot), coalesced on connect and
inbound WS activity.

The `key` field is always preserved on write (read-modify-write via
`parseServerDaemonState` + merge). Status is never written into `server.daemon`
jsonb.

Re-enrollment with a valid license token replaces `server.daemon` atomically
(and resets status columns). No historical key rows are kept for MVP. To revoke
daemon auth, set `server.daemon.key.revokedAt` (via `revokeDaemonKey` helper).

### `command` table

Canonical command/job history — source of truth for UI status and history. Do
not read command history from the Daemon Cell — the cell holds only hot
pending-request correlation state. The `command` table is the canonical record.

| Column       | Type                            | Notes                                                           |
| ------------ | ------------------------------- | --------------------------------------------------------------- |
| `id`         | uuid (uuidv7)                   | Primary key                                                     |
| `created_at` | timestamptz(3) NOT NULL `now()` | Real column; index/order source                                 |
| `updated_at` | timestamptz(3) NOT NULL `now()` | Bumped by `transitionCommand`                                   |
| `metadata`   | jsonb nullable                  | Follow-up-chain blob only (`getCommandMetadata`)                |
| `options`    | jsonb nullable                  | Reserved (pair with `metadata`; unused today)                   |
| `server_id`  | uuid NOT NULL                   | FK → `server.id`, `ON DELETE CASCADE` (org derived from server) |
| `actor_type` | text NOT NULL                   | Open set — e.g. `'user'`; no FK                                 |
| `actor_id`   | uuid NOT NULL                   | ID of the acting entity; no FK                                  |
| `name`       | text NOT NULL                   | Command type (e.g. `daemon.ping`)                               |
| `status`     | text NOT NULL `'queued'`        | See status values                                               |
| `attempts`   | integer NOT NULL `0`            | Dispatch retry count                                            |
| `context`    | jsonb nullable                  | Small non-secret identifier bag (`managedId`, `environmentId`, `generation`, …) |
| `result_summary` | jsonb nullable              | Typed command output (small, bounded)                           |
| `error_code` | text nullable                   | Machine-readable terminal error code                            |
| `error_message` | text nullable                | Terminal error message                                          |
| `queued_at`  | timestamptz(3) nullable         | Set when status → `queued`                                      |
| `dispatch_started_at` | timestamptz(3) nullable| Set when status → `dispatching`                                 |
| `sent_at`    | timestamptz(3) nullable         | Set when status → `sent`                                        |
| `acked_at`   | timestamptz(3) nullable         | Set when status → `acked`                                       |
| `started_at` | timestamptz(3) nullable         | Set when status → `running`                                     |
| `finished_at`| timestamptz(3) nullable         | Set when status → terminal                                      |
| `expires_at` | timestamptz(3) nullable         | Optional command TTL                                            |

There is **no `payload` column on `command`** — the daemon execution payload
lives in the `dispatch` side table (below) and is deleted shortly after the
command reaches a terminal state, so the permanent history row is secret-free.

**JSONB usage:** `context` stores allowlisted identifiers only (extracted by
`src/lib/commands/context.ts` — never secrets, compose YAML, credential
envelopes, or TLS material); `result_summary` stores typed command output.
`metadata` is now only the follow-up-chain blob (`pendingStandbyApplies`,
`followUpPromote`, `pendingTlsLeaf`, `desiredHash`, …) read through
`getCommandMetadata`. **`options` is unused today** and is kept solely for the
schema `metadata`/`options` pairing rule (see the cutover ledger Step 3).
**Never store logs, streaming output, or large blobs in
these columns.**

**Status values:**

| Status        | Meaning                                     |
| ------------- | ------------------------------------------- |
| `queued`      | Accepted by API; waiting for queue consumer |
| `dispatching` | Consumer picked up the job                  |
| `sent`        | Enqueued to daemon cell outbox              |
| `acked`       | Daemon acknowledged receipt                 |
| `running`     | Daemon executing                            |
| `succeeded`   | Completed successfully (terminal)           |
| `failed`      | Completed with error (terminal)             |
| `timed_out`   | Expired without completion (terminal)       |
| `cancelled`   | Cancelled before completion (terminal)      |

**Indexes:**

- `idx_command_server_id_created_at` — btree on `(server_id, created_at DESC)` —
  backs `listServerCommands` ordering
- `idx_command_status` — btree on `status` — supports status-filtered queries

Only FK is `server_id → server.id` (`ON DELETE CASCADE`). Organization is
derived from the server — no `organization_id` column on `command`.

**Lifecycle timestamps are real columns.** `status`, `created_at`,
`updated_at`, `attempts`, `name`, `result_summary`, every granular timestamp
(`queued_at`…`finished_at`, `expires_at`) and both error fields
(`error_code` / `error_message`) are physical columns —
`transitionCommand` `.set()`s them directly; nothing merges into `metadata`
any more. `serializeCommandRecord` in `command-records.ts` maps those columns
onto the stable `CommandRecord` type (`result` ← `result_summary`, `error` ←
`error_message`) and normalizes postgres.js timestamptz strings (`YYYY-MM-DD
HH:mm:ss+00`) to ISO-8601; it never exposes a dispatch payload.

Server delete cascades to command rows (`ON DELETE CASCADE` on `server_id`).

### `dispatch` table

One-shot daemon execution payload for a `command` — the only place
secret-bearing command input is stored.

| Column       | Type                            | Notes                                                  |
| ------------ | ------------------------------- | ------------------------------------------------------ |
| `command_id` | uuid PK                         | FK → `command.id`, `ON DELETE CASCADE`                  |
| `created_at` | timestamptz(3) NOT NULL `now()` | Written with the command row                            |
| `payload`    | jsonb NOT NULL                  | Typed daemon command input (small, bounded)             |
| `expires_at` | timestamptz(3) nullable         | Failure-retention deadline; `NULL` until a terminal failure |

**Lifecycle / cleanup ownership:**

1. `createCommandRecord` inserts the `command` row and its `dispatch` row in
   **one transaction** — a command never exists without its payload.
2. The consumer reads it **once**, via `getCommandDispatchPayload`, right before
   building the daemon dispatch envelope, and keeps it in memory for the rest of
   that processing attempt. A missing payload fails the command
   (`dispatch_payload_missing`) instead of dispatching an empty envelope.
3. `transitionCommand` finalizes it on **any** terminal transition (consumer
   outcome, enqueue failure, expiry): `succeeded` deletes the row immediately;
   `failed` / `timed_out` / `cancelled` stamp `expires_at =
   now + COMMAND_DISPATCH_FAILURE_RETENTION_MS` (24h) for debugging. Cleanup is
   best effort and never fails the transition.
4. Expired rows are removed by `sweepExpiredCommandDispatch` on the **shared
   maintenance tick** — the Workers offline-sweep cron (reusing that cron's
   already-open Hyperdrive db) and the Deno `DAEMON_CELL_MAINTAIN_MS` timer.
   Bounded per tick (`COMMAND_DISPATCH_SWEEP_LIMIT`); no new independent timer,
   no second db client.

Index: `idx_dispatch_expires_at` (btree on `expires_at`) backs the sweep. Like
`command`, there is no `organization_id` — ancestry is `command → server`.
Server delete cascades through `command` to `dispatch`.

**Execution logs are not in Postgres.** Command transcripts (daemon
stdout/stderr) live only in the execution-log store — R2 on Workers, filesystem
or S3 on Deno. There is no transcript table, no transcript column, and no
`has_log` flag: the batched status route resolves `hasLog` by asking the store
(`ExecutionLogStore.exists`) under the existing 100-id batch cap. Do not add a
column to cache it. See `src/lib/execution-logs/AGENTS.md`.

## Layout

| File                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`                         | Drizzle table definitions — sync with dev DB via `dev/scripts/introspect.sh` or `dev/scripts/sync.sh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `deployment-records.ts`             | Deployment target helpers (`upsertDeploymentTargets`, apply/fail transitions, prune draining)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `deployment-history.ts`             | Environment deploy **history** reads from `command` (`listEnvironmentDeploymentHistory`, `getEnvironmentDeploymentDetail`) — `deployment` holds current state only. The list is keyset-paginated; the detail's same-generation fan-out is deliberately **unpaginated** so every participating host is enumerable. Replica counts (`replicaCounts` / `totalReplicas`) are historical, read from each attempt's `command.context`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `slot-records.ts`                   | Scheduled-instance helpers for the **`slot`** table (file name unchanged until phase 2; `replaceEnvironmentSlots` sticky re-plan, list by environment/server); persists nullable `slot.address` so spanning `ipv4_address` / `extra_hosts` stay stable across re-plans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `task-records.ts`                   | Cron-style scheduled-command helpers (`listTasksForService` / `listTasksForServices`, `createTask` / `updateTask` / `deleteTask`, `parseTaskNameInput`, `isTaskUniqueViolation`). Configuration only — nothing is enqueued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `repository-records.ts`                 | Git **`repository`** helpers (file name unchanged until a later phase; table was `source`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `label-records.ts`                  | Server label helpers (`parseServerLabelInput`, `setServerLabels` replace-all, fleet `listServerLabelsForServers`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fabric-records.ts`                 | TurboFabric helpers (`enableOrganizationFabric` / `disableOrganizationFabric`, `ensureFabricRelays`, `loadFabricReconcileSnapshot` + `buildFabricReconcilePayloadFromSnapshot` / `buildFabricReconcilePayload`, `stampRelayPublicKey`, `materializeSpanningNetworks`, compose-network reclaim: `listEnvironmentComposeNetworks` / `purgeEnvironmentComposeNetworks` / `purgeEnvironmentsComposeNetworks` / `purgeComposeNetworksCreatedAfter` / `releaseSubnetsForServer` — `network.environment_id` has no FK). One snapshot per fabric apply loads relays, endpoint caches, PSK envelopes, subnets, datacenter memberships, and address-family preferences once. Pair PSKs are canonical: both peer stanzas use the envelope owned by the lexicographically smaller relay id (`selectPairPresharedEnvelope`). Derived gateway advertised CIDRs are owned among **public-keyed** relays only (the same set `buildReconcilePeerLists` emits as peers); GET fabric still shows planned defaults for keyless gateways. Relay `address` allocates the lowest-free host in `fabric.cidr`; `endpoint_address` is an operator override over pair-aware `planRelayPath` (`direct_lan` via shared datacenter family intersection, else `direct_public`). An unplannable pair is omitted from that server's peer list and recorded on `unreachablePeers` (the rest of the mesh still builds). GET fabric `resolvedEndpoint` stays destination-only (no viewer/`self`). |
| `table-naming.test.ts`              | Guard: every `CREATE TABLE` across migration SQL files under `migrations/` is one lower-case word (no underscores); exception list for external-compat names; retired-name reject list (phase 2 adds `gitapp` / `installation` / `source` / `steward` / `location` / `credential` / `node` / `segment` / `rotation`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `../../db.ts`                       | Connection factories (`createDenoDb`, `createToolingDb`, `createWorkersDb`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `../../drizzle.config.mjs`          | drizzle-kit config (`TURBOPANEL_DATABASE_URL`; introspect, push, generate, migrate, studio)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `../../scripts/bootstrap-dev-db.sh` | Dev DB bootstrap: `pnpm migrate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `~/dev/scripts/introspect.sh`       | Pull DB → `schema.ts` (lives in dev repo)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `~/dev/scripts/sync.sh`             | Push `schema.ts` → DB (Deno dev only; no migration files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `../../scripts/db-connect.sh`       | Resolves `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` for drizzle-kit scripts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `../../migrations/`                 | Versioned SQL migration files (committed); applied by `pnpm migrate`; tracked in `public.migration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `../../drizzle/`                    | Ephemeral introspect scratch dir — `dev/scripts/introspect.sh` deletes after adopt; never committed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Authz engine

Runtime authorization lives in `../../client/authz/` (pure TypeScript, safe for
both Deno and Workers — no Deno-only imports). Permissions are static code
constants in `catalog.ts`. The modules below evaluate access at request time
against `grant`.

| File                              | Purpose                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../../client/authz/catalog.ts`   | Static `PERMISSIONS`, `GRANTABLE_PERMISSIONS` (excludes `system:manage`), `ENTITY_TYPES`, `SUBJECT_TYPES` (`user` / `team` / `organization`), `isPermissionKey`, `isGrantablePermissionKey`, `isEntityType`, `isSubjectType`, `getPermissionCatalog` — no DB access |
| `../../client/authz/service.ts`   | `isPlatformAdmin`, `isSuperAdmin`, `canManageOrganization`, `canOwnOrganization`, `canManageTeam`, `canOwnTeam`, `canInviteToOrganization`, `canInviteToTeam`, `assertNotLastOrgOwner` — higher-level org/team management checks built on `can()` |
| `../../client/authz/evaluator.ts` | `getSubjects`, `can`, `assertCan`, `listVisible`, `ForbiddenError` — org-level grant checks via domain-FK ancestry; superadmin and admin bypass in SQL                                                                                            |
| `../../client/authz/http.ts`      | `assertCanOr403` / `assertOrgOwnerOr403` Hono helpers; `assertNotSystemOwnedOr403` secondary guard (`403` `system_resource_immutable`) via `resolveWorkspaceKindForEntity`                                                                        |

`can()` resolves org-level access in a **single CTE query** (`subjectset` →
`ancestry` → org grant `hits`) — one round-trip. **Organization permission
evaluation respects the requested permission:** an `organization:own` check
requires an `organization:own` grant (owner only — a manager grant is NOT
sufficient), while an `organization:manage` check accepts either an
`organization:own` or `organization:manage` grant (owner or manager). A
platform-admin bypass (`EXISTS … WHERE role IN ('superadmin', 'admin')`) is OR'd
into the final result. Superadmin-only platform operations (e.g. developer
reset-dev) remain gated separately by `user.role === 'superadmin'`.
`listVisible()` returns all leaf ids in the org when the user has org-level
access (owner or manager) — **never rely on client-side filtering** for
visibility.

**Owner-only vs broad org access:** owner-only routes (access-grant management,
license lifecycle) use the exact owner-only guard `assertOrgOwnerOr403`
(`../../client/authz/http.ts`) which checks `organization:own`. Broad "owner or
manager" resource read/create/update/delete routes use `assertCanManageOr403` /
`assertCanReadOr403` / `assertCanCreateOr403` (`../../client/shared.ts`), which
check `organization:manage`. Never use `organization:own` as a broad org-access
check — it is exact owner-only.

**Install (Deno):** `completeInstanceInstall` inserts the **TurboPanel**
workspace (`kind='turbopanel'`) first, then exactly one
`organization:own` grant on the org, one `team:own` grant on the default team,
and a **Default Workspace** (`kind='user'`) for the superadmin user. Workers
sign-up (`createOrganizationForUser`) still creates only the Default Workspace
when provisioning an org — the TurboPanel workspace is ensured lazily
on first server enroll for those orgs. Self-hosted install names the org **Root
Organization**; Workers / user-created first orgs default to **My
Organization**, and `POST /organizations` defaults to **New Organization**.

**Completed:** Resource ancestry is computed directly from real domain tables
(`organization → workspace → project → environment → service/hosting`,
`organization → server`); the generic `resource` shadow table has been dropped.
The `grant` table is allow-only — every persisted row is a positive capability
grant (no deny column).

## Connection (self-hosted dev)

Self-hosted instance boot and all database tooling require
**`TURBOPANEL_DATABASE_URL`**. Unix socket connections use the libpq-style
`?host=` query param (e.g.
`postgresql://turbopanel@/turbopanel?host=/var/run/turbopanel/postgres` —
credentials live only in the env, never in git). Postgres in Docker always
publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure
(`postgres_expose_port`) is optional and unused by the instance. See repo root
`AGENTS.md` for env var details.

## Sanity check

```bash
docker exec turbopanel-database psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone
does not require a restart.
