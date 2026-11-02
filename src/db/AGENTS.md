# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`,
run `pnpm drizzle-kit generate --name <summary>` to create SQL files (always
pass `--name` — see below). Apply pending migrations with
`TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command.
`pnpm migrate` first runs `scripts/check-postgres-compat.mjs`, which refuses to
proceed unless the target server has the built-in `uuidv7()` (PostgreSQL 18
minimum — the baseline defaults every surrogate primary key to it). Applied
migration versions are recorded in **`public.migration`** (configured in
`drizzle.config.mjs`; see “Documented exception: `public.migration`” below).

**`0000_base.sql` is the baseline for a fresh database, and nothing else.**
Do not edit it to carry a schema change: a provisioned instance has already
recorded `0000_base` in `public.migration` and will never replay it, so an edit
there reaches new installs only and leaves every upgraded instance querying
relations that were never created. Schema changes land as **additive forward
migrations** — `pnpm drizzle-kit generate --name <summary>` writes the next
`NNNN_*.sql` plus its `migrations/meta/NNNN_snapshot.json` and appends the
journal entry; commit all three and leave `0000_base.sql` untouched.

**Every column with a fixed value set carries a `CHECK (col IN (…))`**
(decided 2026-09-11 — integrity first). The literal list in `schema.ts` is
pinned to the TypeScript constant that writes the column by
`src/db/enum-checks.test.ts`; add a value in both places or that test
fails. Widening a list later is `ADD CONSTRAINT … NOT VALID; VALIDATE`. A
provider-owned vocabulary (`subscription.status`) is split: a checked
normalized column plus a raw `provider_status`, with an `unknown` member so a
provider change never becomes a refused write. A daemon-reported vocabulary
(`container.status`, Docker's engine states) is normalized to `unknown` on the
way in for the same reason.

**History, and the rule from here on.** While the product was pre-MVP the
baseline was regenerated several times. The final fold (owner decision
2026-10-22) replaced every migration shipped before it (`0000` to `0009`) with
one new baseline, `0000_base.sql`, written by `pnpm generate --name base` from
`schema.ts` plus the `COMMENT ON` statements printed by
`scripts/schema-comments.mjs` (manifest generation 13, `frozen: true`). The
owner wipes the panel database and every server and installs production from
this baseline; nothing is carried over. Checked against the migrations it
replaced, a fresh `0000_base` database dumps to the same schema, constraints,
indexes and comments, except for the changes made in the baseline before the
wipe because they are hard to make later: `organization.deploy_timeout_minutes`
(integer, `CHECK` 5 to 240, null means 30; it replaces the `deployTimeoutMinutes`
option key), the project template stamp (`template_code`, `template_track`,
`template_version`, `template_digest`: all four set or all null, each shaped by a
`CHECK`) and `server.preferred_datacenter_id` (nullable, `ON DELETE SET NULL`).
Otherwise only the column order of a few tables differs, because the old
baseline had columns added later.

**Re-baselining is closed for good.** `0000_base.sql` is the baseline and every
later migration is additive and immutable, tested as an upgrade from the
previous release with a backup taken first. The freeze manifest is `frozen: true`,
so `scripts/check-migration-additions.mjs` (in `build.yml`, `verify-ci.sh`)
refuses any commit that modifies or deletes a shipped `NNNN_*.sql` or snapshot,
and `migration-manifest.test.ts` refuses a working tree whose files no longer
hash to the manifest. Restructuring an existing table is a forward migration
that moves data, never an edit to the file that created it. No mode, flag or
constant lets a shipped migration be edited, removed or regenerated.

The final fold got past the freeze guards through one named, owner-approved
exception in `check-migration-additions.mjs` (generation 12 to 13, one
`0000_base` journal entry). It has been deleted, and no mode or flag brings it
back. The upgrade check (`check-migration-upgrade.mjs`) keeps a lasting rule,
not a bypass: when the previous release tag's manifest has a lower generation than
the checkout's, there is nothing to upgrade from, so it only builds a fresh
database and proves the seed fits; once a release is tagged from the baseline
the generations match and the full comparison resumes by itself.

**The `audit` table is append-only.** Nothing updates or deletes a row, which
is why it has no `updated_at` — a trail an operator can edit after the fact is
not one. `organization_id` is nullable so an instance-wide action (a superadmin
editing a forge that belongs to no organization) is still recorded, even though
the organization-scoped read cannot show it; `actor_email` is denormalized so
the trail survives the account's deletion (`actor_user_id` is a plain
id with no foreign key, so history outlives the user). `context` is a small jsonb bag of non-secret facts —
the same rule `setting` rows follow. Written from `recordAudit`
(`audit-records.ts`) at the security-relevant routes: daemon-key revoke,
server delete, grant create/delete, forge create/update/delete, the three
organization gates, and project, environment and Hosting Account (`principal`)
deletes. A project delete writes one entry (its environments and hostnames ride
in `context`), after the rows are gone and before any host is asked to remove
folders; a refused delete writes none. The automatic removal sweep
(`removal-sweep.ts`) does not audit yet. Read by owners only, at `GET /organizations/:id/audit`.

**The notification tables** (`channel`, `rule`, `notification`, `attempt` —
created in `0002_notifications` under `notification_*` names and renamed to
single words in `0003_notification_table_names`, 2026-09-18; `table-naming.test.ts`
folds `ALTER TABLE … RENAME TO` in journal order so a shipped file never has to change) are owned by `src/features/notifications/records.ts` and documented in
`src/features/notifications/AGENTS.md`. A channel's `address` is a sealed `tpsecret`
for every kind but `email`, `signing_secret` always is, and both are a stage of
the re-encrypt sweep; every fixed-value column carries a CHECK pinned by
`enum-checks.test.ts` to the catalogue in `events.ts`.

**The `folder` table** (`0035_folder_table_and_slugs`) holds one row per service
or volume directory per server. It carries no `metadata` / `options` pair: every
column is a fact the locks read. `service_id` and `storage_id` are `ON DELETE SET
NULL` because a `removing` row must outlive the asset it came from (a server that
was offline when the asset was deleted), and `folder_asset_present_check` lets
only `removing`, `orphan` and `missing` rows have neither. `server_id`,
`principal_id` and `environment_id` are `RESTRICT`: a server, site owner or
environment with folders cannot be deleted until the rows are gone, so the
server-delete flow removes or settles them first, and the environment and
project deletes turn them into `removing` rows with `environment_id` NULL
(`folder_common_scope_check` allows that, as for an `orphan`).
`project.slug` is `NOT NULL`; `service.slug` and `storage.slug` stay nullable
because the folder allocator picks them when it plans a folder. Boolean
columns follow the `is_` rule, so the spec's `common` is `is_common`. The CHECK
patterns are built from `contracts/directory-names.ts`, so a rule cannot drift
from the database.

`removal_note` keeps
the host's own words when it kept a `removing` folder, so the panel can say why; it is
cleared whenever the row moves to `removing` or back to `planned`. An `orphan` that no
service or volume row names is taken over by the next asset planned under the same
site owner, scope, kind and name; `POST /folders/:id/remove` moves an orphan to
`removing`, asks the server again for one already `removing`, and forgets a `missing` row.

**The tunnel tables' two deferrable keys** (`0005_tunnel_tables`):
`badge.secret_id` -> `secret.id` and `tunnel.carrier_id` -> `carrier.id` are `NO
ACTION DEFERRABLE INITIALLY DEFERRED`, on purpose. Deleting an organization
cascades through `secret`, `carrier`, `badge` and `tunnel` in one transaction,
and Postgres checks `RESTRICT` and immediate `NO ACTION` per cascaded statement,
so any other setting fails it depending on the order the cascades run. Checked
at commit, the delete succeeds, while deleting a carrier that still has tunnels
or a secret that still has a badge fails at commit. drizzle cannot express
`DEFERRABLE`, so the migration adds it by hand after the generated statement and
`schema.ts` only says `no action`; `drizzle-kit generate` still produces no diff
because the snapshot has no such field. Any future migration that touches either
key must keep `DEFERRABLE INITIALLY DEFERRED`; `src/features/tunnels/records.test.ts`
reads `pg_constraint` and fails if it is lost.

**The `share` table** (`0036_share_table`) records that an environment uses a
common (shared) service or volume: an asset of a site owner that lives in the
owner's `common` folder scope and belongs to no one environment, so an
environment of any project in the organization can use it. It carries no
`metadata` / `options` pair. Exactly one of `service_id` and `storage_id` is set
(`share_asset_check`), each unique per environment. `environment_id` is `ON
DELETE CASCADE` (deleting the environment detaches it); `service_id` and
`storage_id` are `RESTRICT`, so an asset cannot be deleted while a row names it
and the routes refuse first, in plain words, listing who uses it. The asset's own
environment (the service row still needs one) uses it without a row.

**Shipped migration files are immutable, and the guard for that is
`migrations/manifest.json`** (`scripts/check-migration-freeze.mjs`,
enforced by `src/db/migration-manifest.test.ts`). It pins every journal
entry's idx/tag/`when` and the file's sha256 exactly as drizzle's
`readMigrationFiles` computes it — the same value as `public.migration.hash`
on a live instance. The reason it exists: drizzle applies a migration only
when its journal `when` is newer than the newest `created_at` already
recorded, and never re-reads the hash, so an edited shipped file is silently
skipped on every instance that already ran it. After `pnpm generate`, run
`node scripts/check-migration-freeze.mjs --update` (appends only; refuses a
changed or removed entry) and commit the manifest with the migration. The
test also checks the journal is contiguous and strictly increasing, every
`NNNN_*.sql` on disk is journaled, and the `meta/NNNN_snapshot.json` `prevId`
chain is intact. The manifest is frozen (generation 13); the fold of
2026-10-22 (12 → 13) was the last. With the manifest frozen, layer two
(`scripts/check-migration-additions.mjs`, `pnpm check:migration-additions
[base-ref]`) diffs `migrations/` against the base ref in CI and accepts
additions only; it reads the _base's_ `frozen` flag, so a commit cannot
un-freeze its own way past it.

**New migrations must be forward-compatible with the previous Worker.** A
deploy migrates first and ships the Worker second, and a rollback leaves the old
Worker on the new schema, so `scripts/check-migration-forward-only.mjs`
(`pnpm check:migration-forward-only [base-ref]`, CI `build.yml`, next to the
additions check) refuses an _added_ migration containing DROP TABLE/COLUMN/
SCHEMA/TYPE, RENAME, SET NOT NULL, ALTER COLUMN TYPE or TRUNCATE. Breaking
changes ship as expand then contract across two releases; a genuinely safe one
carries a `-- breaking-ok: <reason>` line. Deploy serialization: there is no
Actions deploy to put `concurrency:` on (Workers Builds deploys by branch);
concurrent migrates are serialized by the advisory lock in
`scripts/migrate-locked.mjs`, and the migrate URL is checked against the env's
Hyperdrive origin by `scripts/check-deploy-env.mjs`.

**A database's history is checked against the manifest before anything runs on
it** (`src/db/schema-state.ts`; Node twin `scripts/schema-state.mjs`,
pinned by `schema-state.test.ts`). `public.migration.hash` in `created_at`
order must be a prefix of the manifest: `unmigrated`/`behind` → migrate
proceeds; `ahead` (a hash this build does not ship — a newer release migrated
it, or it predates the frozen baseline) or `diverged` → `pnpm migrate` and
`turbopanel migrate` refuse under the advisory lock, because drizzle
keys replay on the journal `when` and would otherwise apply our files on top
of a foreign history and fail mid-DDL. The Deno instance runs the same check
at boot and refuses to start on anything but `current` (it never migrates on
boot; a database that is merely unreachable propagates as a connection error
and systemd retries). The Workers runtime skips it — `pnpm deploy` migrates
before `wrangler deploy`, and a Worker has no boot. Under `pnpm deploy`
(`CLOUDFLARE_ENV` set), `scripts/check-deploy-env.mjs` first refuses a
`TURBOPANEL_DATABASE_URL` whose host/port/database are not that env's
`HYPERDRIVE` origin as read from wrangler.jsonc + the Cloudflare API or
`wrangler hyperdrive get` — the migrate role may differ from Hyperdrive's
runtime user; fail closed when the origin cannot be read; skipped entirely
when `CLOUDFLARE_ENV` is unset.

**Every migration is tested as an upgrade from the previous release**
(`scripts/check-migration-upgrade.mjs`, `pnpm check:migration-upgrade`, CI
`deno db-1`). It takes the newest stable `vX.Y.Z` tag on `live` (else the
newest stable tag), applies _that tag's_ `migrations/` (read from git) to an
empty scratch database, inserts `scripts/migration-upgrade-seed.sql`, runs
this checkout's `pnpm migrate` path on top, and fails unless every seeded row
keeps its values, `public.migration` is `current`, and the schema (columns,
constraints, indexes, comments, sequences, triggers, functions, views, types,
history) matches a fresh apply. On the 20 seeded tables (of 81) that catches a
NOT NULL without a default, a CHECK or FK the existing rows break, a backfill
that rewrites or deletes rows, and DDL that depends on their data. Other
tables are empty in the run, so none of those catches reach them: seed a
table before a migration that touches its existing rows.

The seed targets the previous release's schema, and the fresh database gets
it too, so a migration that makes the seed invalid fails in its own PR: update
the seed there. The one sanctioned loss is the contract step: a pending
migration with a `-- breaking-ok: <reason>` line may drop tables
(`DROP TABLE`), drop columns (`DROP COLUMN`) and rename either
(`RENAME TO`, `RENAME COLUMN`); seeded rows are then compared under the new
names and dropped ones are skipped, but only when the old name is really
gone afterwards (a dropped and re-added column, or a new column renamed into
the old name, is compared as usual). Nothing else is excused. A drop of a
column the seed names means removing it from the seed in the same PR; a
rename cannot be seeded on both sides, so while one is pending a fresh-seed
failure that names a renamed table or column is a warning and the seed is updated once that release ships.

Locally, start a throwaway Postgres 18 whose role has CREATEDB (only
`tp_upgrade_check_*` databases are created and dropped; nothing runs in the
named database; refused when `CLOUDFLARE_ENV` is set), then:

```sh
git fetch origin --tags live
TURBOPANEL_DATABASE_URL='postgresql://…@127.0.0.1:5432/postgres' pnpm check:migration-upgrade
```

`node scripts/check-migration-upgrade.mjs --from <tag>` tests the upgrade from
an older release instead (the seed may not fit releases before the newest).

Physical boolean columns use an `is_` prefix (`is_connected`,
`is_read_eligible`, `is_for_build`, `is_for_runtime`, `is_emit_engine_defaults`,
`is_read_only`). Public API JSON still uses `connected`, `readEligible`,
`forBuild`, `forRuntime`, `emitEngineDefaults`, and `readOnly`.

The co-located dev server has live data — treat every database change as
production-adjacent.

**Server metrics is never stored in Postgres.** Host metrics live in Analytics
Engine (Workers) or DuckDB (Deno) only — see instance `AGENTS.md` (Server
metrics). Do not add metrics tables or columns here; there are no per-minute
Postgres projection writes for metrics.

## Multi-node PostgreSQL model

"Multi-node PostgreSQL" for the instance database means **primary/standby
replication with exactly one writable primary** — physical (streaming)
replication for HA/failover, logical replication for read replicas or DR. Every
writer (Workers, the Deno instance, `pnpm migrate`) connects to the single
current primary; migrations require PostgreSQL 18+ (built-in `uuidv7()`),
preflighted by `scripts/check-postgres-compat.mjs` before `drizzle-kit migrate`
runs.

**Sharded / distributed SQL is explicitly out of scope for this schema.** UUIDv7
primary keys (`uuid … DEFAULT uuidv7()`) buy exactly three things:
collision-free ids across writers and restores without sequence coordination, no
serial/identity hotspot to renumber on failover, and time-ordered index
locality. They do **not** make the schema distributed-SQL ready: no distribution
key has been chosen, no reference/global table classification exists, and every
foreign key and unique constraint assumes one coherent node. Targeting a sharded
or distributed engine (Citus, CockroachDB, YugabyteDB, …) would require a
dedicated design pass over `schema.ts` — choose a distribution key, classify
reference tables, and rework primary keys, foreign keys, and unique constraints
together — never piecemeal per-table edits.

Guard: `primary-key.test.ts` — every `CREATE TABLE` in committed migration SQL
under `migrations/` has a `PRIMARY KEY`; application primary keys are
`uuid … DEFAULT uuidv7()` or the single allowlisted natural key
`dispatch.command_id`; `serial` / identity columns / `nextval()` defaults are
rejected in application tables.

### Documented exception: `public.migration` (drizzle bookkeeping)

`pnpm migrate` (drizzle-kit → drizzle-orm `PgDialect.migrate`) creates its
bookkeeping table — verified against the vendored
`drizzle-orm/pg-core/dialect.js` and pinned by `primary-key.test.ts` — as:

```sql
CREATE TABLE IF NOT EXISTS "public"."migration" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)
```

Audit: it **has** a primary key, but the key is sequence-backed (`SERIAL`). That
cannot meet the application-table invariant, and it doesn't need to: the table
is written only while migrations apply — an operator-controlled,
**single-writer, coordinator-local** operation against the primary
(`pnpm migrate`, Workers deploy, `bootstrap-dev-db.sh`) — never at request time
and never from concurrent writers. It is exempt from the UUID primary-key guard
(it is created by the migrator, not by SQL under `migrations/`); do not model
application tables on it. A drizzle-orm upgrade that changes this DDL fails
`primary-key.test.ts` and re-opens this audit.

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

1. Edit `src/db/schema.ts`.
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

1. Edit `src/db/schema.ts`.
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

## Schema descriptions — Postgres comments

**Every table and non-obvious column carries a Postgres comment.** The
comments are generated from one file, and a test holds that file to the
shipped schema, so "I'll document it later" fails CI rather than drifting.
The descriptions live in the database (`COMMENT ON`, visible with `\d+` in
`psql`). The website's `/docs/database` reference was removed for 0.2.x (a
browsable reference may return later); nothing generates or checks website
pages any more.

| Piece           | Path                                                              | Role                                                                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source of truth | [`schema-descriptions.ts`](./schema-descriptions.ts)              | Physical table name → `group`, one-sentence `summary`, and one sentence per non-obvious column. Hand-maintained.                                                                                                                                        |
| Guard           | [`schema-descriptions.test.ts`](./schema-descriptions.test.ts)    | Against the **latest snapshot**: every table has a group + summary; every non-obvious column has a sentence; nothing describes a missing table/column; sentences obey the writing rules; **and every sentence is already in a `COMMENT ON` migration**. |
| Comment delta   | `scripts/schema-comments.mjs` (`pnpm schema:comments`, `--check`) | Replays `COMMENT ON` across `migrations/*.sql` (journal order, last wins) and prints only the statements still missing, in drizzle's `--> statement-breakpoint` format.                                                                                 |
| Snapshot reader | `scripts/schema-snapshot.mjs`                                     | The comment script reads the snapshot behind the newest journal entry — never `schema.ts` — so an ungenerated edit cannot reach comments ahead of its migration.                                                                                        |

**"Obvious" is a rule, not a judgement** (`isObviousColumn`): `id`,
`created_at`, `updated_at`, and a foreign key named exactly
`<referenced table>_id`. Those **need** no database comment (an authored
sentence on one is still emitted). A foreign key under any other name
(`server.assigned_tier_id`, `audit.actor_user_id`) must be described — the
name signals a rule. `metadata` / `options` (only on tables that really use them) always need a sentence saying
what keys they hold and who writes them.

**Writing rules** (enforced by the test): one sentence, ≤ 160 characters, no
line breaks, none of `| { } < > "` (GFM cells, MDX, SQL quoting). Backticks
for identifiers and literal values; single quotes are fine. Say what the
value is, who writes it, and the members / units / derived-vs-stored fact.
"daemon", never "agent" (`pnpm check:vocabulary` scans this file).

### The loop (every schema change, same PR)

1. Edit `schema.ts`; `pnpm drizzle-kit generate --name <summary>` as usual.
2. Edit `schema-descriptions.ts` — the test lists exactly what is missing:
   `deno test --allow-read src/db/schema-descriptions.test.ts`.
3. `pnpm schema:comments` prints the pending `COMMENT ON` statements. Append
   them to the **new, unshipped** migration from step 1 (after a
   `--> statement-breakpoint`). A description-only change with no schema
   change gets its own empty migration:
   `pnpm drizzle-kit generate --custom --name <summary>` (needs any
   `TURBOPANEL_DATABASE_URL`, e.g. `postgresql://postgres@localhost/postgres` — generate is
   offline), then paste there.
4. `node scripts/check-migration-freeze.mjs --update` (appends the manifest
   entry).
5. Run the db suites in the guest (`pnpm verify:ci`, or at least
   `deno test --allow-read src/db/`) and `pnpm check:vocabulary`.

The agent policy above still holds: generate and edit the unshipped SQL,
yes; apply (`pnpm migrate`) or commit migrations, no — hand the developer
the review / apply / commit step. Comments reach a database only through
`pnpm migrate`; a dev database brought up with `dev/scripts/sync.sh` (push)
has the columns but not the comments, which is cosmetic.

## Schema (ported from old trunk `apps/api`)

`schema.ts` mirrors the old monorepo database layout (Better Auth–compatible
tables, no auth runtime yet). Grouped by concern — see **Table groupings** below
(post-cutover names).

**Column order:** tables that carry `metadata` / `options` declare them
immediately after timestamps — `id` → `created_at` → `updated_at` → `metadata` →
`options` → remaining columns, both always nullable. A table carries one of
them only while something writes it (owner decision 2026-10-17: the empty pairs
were dropped in the baseline); add the column back, with its description, in the
change that first writes it.

## Schema cutover (executed)

The phase-1 cutover ledger (the full table/column/constraint inventory, locked
renames, and per-item keep/rename/drop adjudications with reasons) is no longer
kept in this repo. Phase 2 executed it: `schema.ts` and the squashed migrations
use the post-cutover names below, and the retired names are rejected by
`table-naming.test.ts`.

## Table groupings

| Group             | Tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**      | `user`, `account`, `session`, `verification`, `passkey`, `totp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Organizations** | `organization`, `team`, `teammate` (org membership SoT), `invitation` (no `organization_id`; `team_id NOT NULL`), `tls`, `changeover`, `leaf`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Billing**       | `tier` (platform-global priced offerings), `license`, `payer`, `subscription`, `seat` (export `subscriptionItem`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Networking**    | `datacenter` (logical routing domain, not a building — a server may belong to several; `priority` / `is_trusted` / `address_preference` columns, optional `kind`), `network` (kinds `datacenter` / `docker` / `compose` / `managed` / `reserved` — `reserved` is an org-only, CIDR-required operator hole every CIDR write and fabric allocator routes around via `src/features/net/cidr-collisions.ts`), `ip` (scopes `public` / `datacenter`), `fabric` (0–1 per org; TurboFabric on when present and `is_enabled`, paused when `is_enabled = false`), `relay` (`kind` `server`; `external` reserved), servers opt out with `server.is_fabric_enabled` and carry a stored `fabric_role`, `subnet`, `address` (addresses clients use: per-server public + per-datacenter name and address overrides), `carrier` / `badge` / `tunnel` / `portal` / `doorway` (tunnels, `0005_tunnel_tables`: provider account, its sealed API token pointer, the tunnel, one connector per server, one hostname; see `src/features/tunnels/AGENTS.md`) |
| **Resource tree** | `workspace`, `project`, `environment`, `service`, `folder` (one service or volume directory per server), `hosting`, `container`, `managed`, `replica`, `recovery`, `variable`, `principal`, `placement`, `tenancy`, `login`, `database`, `scope`, `binding`                                                                                                                                                                                                                                                                                                                            |
| **Storage**       | `storage`, `copy` (export `storageCopy`), `mount`, `secret`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Git**           | `forge`, `connection`, `repository`; `delivery` is the webhook ledger for every kind (git _and_ Stripe)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Authorization** | `permission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Config**        | `setting` (`value` is `jsonb`), `origin` (control-plane public names + certificate source), `certificate` (uploaded control-plane pairs; key sealed `tpsecret`)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Runtime**       | `server`, `monitor` (per-server sealed ProxySQL monitor credential), `command`, `dispatch`, `deployment`, `slot`, `task`, `label`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Upgrades**      | `upgrade` (instance-wide run; partial unique one active), `stage` (export `stage`; one daemon or instance unit per server)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Tagging**       | `tag`, `marker`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Secrets never live on `server.options`

`server.options` is operator-facing configuration: `GET /servers`,
`GET /servers/:id` and the developer routes return the jsonb verbatim, and the
approved cached read models copy it into Redis. Anything written there is
therefore published to every reader of the server and cached outside Postgres.

The per-server ProxySQL monitor password (`tp_monitor_<serverId prefix>`) used
to live at `server.options.managedMonitor`; it now has its own **`monitor`**
table (one row per server, `secret_envelope` sealed with the data-encryption
key, `ON DELETE CASCADE` from `server`) — see
`src/client/managed/monitor-credential.ts`. Two guards keep it that way:
`REDACTED_SERVER_OPTION_KEYS` / `redactServerOptions` in `server-metadata.ts`
strip the legacy key at every read-model and response boundary, and
`parseServerOptions` is an allowlist. A new server-scoped secret gets its own
table; it does not get added to the redaction list.

## Physical table naming rule

Every physical `CREATE TABLE` name is **one standalone lower-case word** —
letter-first alphanumeric token, **no underscores** — and a _real_ word, not
two words glued into one token (`backuppolicy`, `backuprun` and `volumebackup`
shipped in 0009 and were renamed to `retention`, `snapshot` and `archive` in
`0010_single_word_table_names`). Guarded by `src/db/table-naming.test.ts`, which
scans every migration SQL file under `migrations/`: the regex catches
underscores, and `APPROVED_TABLE_NAMES` catches everything else — a new table
fails until its name is added there in the same PR, after the owner approves the
word. `PENDING_RENAMES` lists glued names still on disk with the reason each is
held (none today: the last one, `upgradestep`, became `stage` in
`0011_rename_upgradestep_to_stage`).

| Physical name  | Drizzle export                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invitation`   | `invitation`                  | Pending org/team invite (`grants` jsonb materialized on accept). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `organization` | `organization`                | Tenant org. **`slug` dropped 2026-09-17** (pre-fold batch, now in `0000_base`) — it was reserved, never written, and no feature ever claimed it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tls`          | `tls`                         | Org TLS library + Organization CA row. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `changeover`   | `changeover`                  | Organization CA rotation journal (fan-out progress; partial unique in-flight per org). Was `rotation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `passkey`      | `passkey`                     | WebAuthn credentials. Unique `credential_id` (`uniq_passkey_credential_id`); bigint `counter`. Consumed by `passkeys.ts` (a user may register several passkeys).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `datacenter`   | `datacenter`                  | Logical routing domain of mutually routable subnets (IPv4 and/or IPv6), not a physical site — a server may belong to several. `priority` (lower wins, default 100) / `is_trusted` (default true) / `address_preference` (`ipv6` default or `ipv4`) are columns since migration 0004 (wire names `options.priority` / `options.trusted` / `options.addressPreference` unchanged); optional `kind` (`lan`, `backplane`, `provider_private`). **`datacenter_name_format_check` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `server`       | `server`                      | Enrolled host. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `monitor`      | `monitor`                     | Per-server sealed ProxySQL backend monitor credential (`uniq_monitor_server`; `ON DELETE CASCADE` from `server`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `license`      | `license`                     | One-shot registration key. Optional `tier_id` FK → `tier.id` (`ON DELETE RESTRICT`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ticket`       | `ticket`                      | One-hour, single-use enrolment ticket (`0013_enroll_tickets_and_token_erase`): join ticket (`license_id`) or re-enroll ticket (`server_id`), Argon2id `token` hash, `used_at` set atomically. the licence token column became nullable in the same migration (erased at the bind). |
| `tier`         | `tier`                        | Platform-global billed offering (`generation` / `rank` / `label`). No `organization_id`. Rows are deactivated, never deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `command`      | `command`                     | Typed command row (lifecycle columns, no payload). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `dispatch`     | `dispatch`                    | One-shot daemon execution payload for a `command` (deleted on success, ~24h retention on failure). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `upgrade`      | `upgrade`                     | Instance-wide upgrade run. Partial unique `uniq_upgrade_active` allows one `pending` or `running` row. `counts` keeps the summary after steps are pruned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stage`        | `stage`                       | One daemon or instance install on one server inside an `upgrade` run (`ON DELETE CASCADE` from both parents). Was `upgradestep` (renamed in `0011_rename_upgradestep_to_stage`); its phase stays in `detail.phase`. Column `last_stage_at` became `status_changed_at` in `0012_rename_stage_last_stage_at`; the API and the `UpgradeStepRow` field keep the name `lastStageAt`. A restarted control-plane row (`restarting` / `verifying`) unchanged for `TURBOPANEL_UPGRADE_VERIFY_TIMEOUT_MINUTES` (default 20) becomes `needs_attention` / `verify_timeout` (`../features/upgrades/AGENTS.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `network`      | `network`                     | Org network registry (`datacenter` / `docker` / `compose` / `managed` / `reserved`). `reserved` added by `0002_add_reserved_network_kind` (widens `network_kind_check` + `network_single_scope_check`: org-only scope, `cidr NOT NULL`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fabric`       | `fabric`                      | Org TurboFabric mesh (0–1 per org; on when present). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `address`      | `clientAddress`               | An address clients use to reach a server, set by an operator (0034): one `public` entry per server (`uniq_address_server_public`) and one per datacenter it belongs to (`uniq_address_server_datacenter`), optional `hostname` (always dotted), `address_v4` / `address_v6` overrides (NULL = the server's own address), `options.ports`, at most one `is_primary` (`uniq_address_server_primary`). Cascades with server, datacenter and organization. Not in `ip`, so one router address may front several servers. Read by `src/features/net/client-addresses.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ip`           | `ip`                          | Canonical managed addresses (`public` / `datacenter`). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `relay`        | `relay`                       | One server in the org TurboFabric mesh — `tp0` address, role, container prefix, advertised CIDRs, PSK. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `subnet`       | `subnet`                      | Server-local Docker bridge for a `kind='compose'` spanning network. Was `segment`. SQL-adjacent — double-quote in raw `sql` tagged templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workspace`    | `workspace`                   | Resource-tree root (`project.workspace_id` → `workspace.id`). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `project`      | `project`                     | Docker Compose / catalog / managed project. Unchanged. **`project_name_format_check` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `environment`  | `environment`                 | Staging/production/etc. within a project; optional `server_id` pin. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `managed`      | `managed`                     | Environment-scoped managed engine cluster. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `retention`    | `retention`                   | A scheduled backup of one managed engine or one storage copy: schedule, timezone, how many artifacts to keep. Pushed to its host as a systemd timer (`server.backups.reconcile`). Was `backuppolicy` (0009 → 0010).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `snapshot`     | `snapshot`                    | One finished scheduled run of a `retention`, reported by the host that ran it; unique per (`retention_id`, `run_id`). Was `backuprun`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `archive`      | `archive`                     | One storage-copy backup artifact (the volume twin of `backup`). Was `volumebackup`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `edict`        | `edict`                       | One firewall rule an operator typed, in the `server.firewall.reconcile` wire words (`scope`, `action`, `proto`, `ports`); `server_id` null means every server in the org, `source_addresses` is an `inet[]` used only by `source_kind` `addresses`. Rules derived from what is deployed are computed per server and never stored. Capped at 200 per org.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bulwark`      | `bulwark`                     | One server's firewall state (unique `server_id`): `mode` (`observe` default / `managed` / `off`), a monotonic `generation`, the host's last digest and result, and the confirm-or-roll-back `state`. The row is created on first use; a server with none reads as observe, generation 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `replica`      | `replica`                     | One server’s participation in a managed cluster (primary / replica). Was `node`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `leaf`         | `leaf`                        | Organization-CA-signed managed leaf tracking (`ingress` / `engine`; upsert on re-issue). Engine unique is `uniq_leaf_engine_replica` on `replica_id`. Unchanged physical name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `recovery`     | `recovery`                    | Managed HA journal (automatic failover / switchover / disaster recovery). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `variable`     | `variable`                    | Scoped config/secret. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `service`      | `service`                     | Deployable unit within an environment. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `deployment`   | `deployment`                  | Current apply state per `(environment, server)`. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `slot`         | `slot`                        | Scheduled replica instance of a logical service (0-based `slot` column). Was `task` (replica-slot meaning).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `label`        | `label`                       | Server Docker-engine labels. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hosting`      | `hosting`                     | Public routing for a service. Unchanged. **`hosting_name_format_check` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `container`    | `container`                   | Deployed Docker container pin. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `principal`    | `principal`                   | A site owner's Linux user only; database logins are in `login`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ssh`          | `sshKey`                      | Public key that may authenticate as a principal. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tenancy`      | `tenancy`                     | Linux/system principal that runs as / owns a service. Was `steward`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `binding`      | `binding`                     | Database login (and database) → compose service inject. `principal_id` and `database_name` are gone: `login_id` and `database_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `login`        | `login`                       | One engine role on one managed cluster. Settings are columns (`metadata`, `grant_mode`, `recipe`, `is_all_databases`, `is_tool`, `allowed_sources`, `max_connections`, `access`, `privileges`); not a principal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `database`     | `managedDatabase`             | One database in a cluster (`name`, `is_role_owned`, `owner_login_id`). Replaces the `managed.options` lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `scope`        | `scope`                       | Which databases a login may use (`login_id`, `database_id`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `secret`       | `secret`                      | Sealed provider secrets (NFS/S3/rclone + Git deploy keys). Was `credential`. **`expires_at` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `storage`      | `storage`                     | Logical dataset identity (volume / directory / file / object). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `copy`         | `storageCopy`                 | One physical copy of a storage identity. Was `location`. SQL-adjacent — double-quote in raw `sql` tagged templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mount`        | `mount`                       | Service attachment of a storage identity. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `forge`        | `forge`                       | Registered GitHub App / GitLab OAuth application (`organization_id` NULL = instance-wide). Was `gitapp`. **`envelopes`** was `credentials`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `connection`   | `gitConnection`               | Git provider App installation granted to one org. Was `installation` (export `gitConnection`). **`forge_id`** FK → `forge`. **`provider`** kept as a denormalized filter column. **`external_installation_id`** is the provider-side id. No token columns — installation access tokens are minted on demand in `src/features/git/github-app-token.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `repository`   | `repository`                  | Git repository connected to an organization — **one row per repo per org**, deduped by `UNIQUE (organization_id, repository_url)` over the canonicalized clone URL (`canonicalizeRepositoryUrl`: lower-cased host, `.git` suffix). Was `source`. No `service_id` / `environment_id` parent columns — attachment is `project.repository_id` plus compose `services.<name>.x-turbopanel.source.sourceId` references. **`connection_id`** SET NULL; optional `secret_id` SET NULL. Provider-observed facts (`detected_default_branch`, `default_branch_checked_at`, `last_inspected_at`, `last_inspected_commit_sha`) are real columns, refreshed by `POST /repositories/:id/refresh`. CRUD: `src/client/repositories/routes.ts`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `delivery`     | `webhookDelivery`             | Inbound provider-webhook delivery ledger — replay protection plus Stripe's pending-projection handoff. Org-agnostic on purpose: the delivery id arrives before the payload is matched to a connection. `provider` CHECK `github` / `gitlab` / `stripe` — not git-only; unique `(provider, external_delivery_id)`; `created_at` is the received time and the sweep cursor. No secret. Stripe rows also store `object_id` / `object_type` until `projected_at` is set; pending Stripe rows are excluded from the retention prune. Claimed by `claimWebhookDelivery`, Stripe handoff via `enqueueStripeProjection`, pruned after `WEBHOOK_DELIVERY_RETENTION_MS` (`src/features/webhook-delivery/webhook-delivery-records.ts`).                                                                                                                                                                                                                                                                                                                                                                                             |
| `payer`        | `payer`                       | Billing projection — who pays. Polymorphic over its subject: `organization_id` **or** `user_id`, exactly one (`payer_subject_check`: `(organization_id IS NULL) <> (user_id IS NULL)`), so an in-app subscription tied to a person stays expressible without rewriting every FK that points at billing. Columns are `provider_*`, never `stripe_*` (`payer_provider_check`: `stripe` only — Apple dropped 2026-09-17, decided 2026-09-12). Unique `(provider, provider_customer_id)` is the webhook upsert target; partial uniques give one payer per provider per subject. Written only by `src/features/billing/billing-records.ts` from the Stripe webhook — **Stripe owns money, Postgres owns entitlement** (`src/features/billing/AGENTS.md`).                                                                                                                                                                                                                                                                                                                                                                     |
| `subscription` | `subscription`                | One provider subscription per `payer` (cascade). Unique `provider_subscription_id` is the upsert target. `status` is TurboPanel's **checked** vocabulary (`subscription_status_check`: Stripe's eight + `unknown`) and `provider_status` is the raw provider value beside it — the split decided 2026-09-11 for provider-owned lists, landed 2026-09-17 (pre-fold batch, now in `0000_base`). A Stripe status the code has never seen lands as `unknown` with the verbatim string next to it, never a refused webhook; `upsertSubscriptionFromProvider` normalizes on write via `parseSubscriptionStatus`. `past_due_since` latches on the first delinquent status (`past_due` / `unpaid`) and clears on recovery; Stripe's own dunning ends a delinquent subscription, so `grace_expires_at` is always written `null` (unused since 2026-09-30, kept by the migration freeze). `schedule_id` is the provider schedule a deferred change (downgrade / seat release) is parked on; `null` when none.                                                                                                                      |
| `seat`         | `subscriptionItem`            | One line of a subscription: `quantity` seats at one `tier`. Physical name `seat` because `subscription_item` breaks the one-word rule and a row _is_ N seats at one tier (reads correctly beside `license`); the export keeps the provider's vocabulary. Unique `provider_item_id` (upsert target) **and** unique `(subscription_id, tier_id)` — the reconciliation invariant compares seats to licenses per tier, so two rows for one tier must be impossible. `tier_id` is `ON DELETE RESTRICT`. `provider_price_id` is the item's own price (what a mutation restates when it rewrites `items[]` or a schedule phase); nullable only so it could be added under existing rows. Projection is delete-then-insert per subscription (`replaceSubscriptionItems`), in that order, because a replaced item at the same tier would otherwise trip the per-tier unique. Items map to tiers by **product** (`item.price.product` → `tier.provider_product_id`); an item whose product maps to no tier is logged and skipped, never inserted with a null tier, and two items on one tier are summed under the first item's id. |
| `permission`   | `grant`                       | Authz grant row (physical name `permission` since the single-word rule; the Drizzle export is still `grant`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session`      | `session`                     | Opaque DB-backed user session. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `setting`      | `setting`                     | Instance settings (`value` is `jsonb`). Unchanged. `TURBOPANEL_PUBLIC_URLS` remains a flat projection of `origin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `origin`       | `instanceHostname`            | One published control-plane name. `source` is `platform-ca`, `uploaded`, or `lets-encrypt`. Let's Encrypt attempt state (`acme_last_attempt_at`, `acme_last_error`, `not_after`) is per name. `uploaded_cert_id` points at `certificate` when `source` is `uploaded`. Physical name is `origin` because `hostname` is the hosting uniqueness mirror.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `certificate`  | `instanceUploadedCertificate` | Control-plane certificate pair: an upload (`kind='uploaded'`) or a pair the control plane issued over DNS-01 (`kind='dns-01'`, never listed as an upload). `key_pem` is a sealed `tpsecret` envelope. Several `origin` rows may share one pair.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ingress`      | `ingressAccount`              | One install-level provider account (`cloudflare` or `bunny`) for the self-hosted ingress modes. `token_envelope` is a sealed `tpsecret`; `origin.ingress_id` points here. Never read on Workers; physical name `ingress` stays one word. |
| `account`      | `account`                     | Credential / OAuth account. Unique `(provider_id, provider_user_id)` (`uniq_account_provider_user`) — consumed by the credential path (`credentials.ts`) and `oauth/oauth-http.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `teammate`     | `teammate`                    | User ↔ team; org membership is derived through `team.organization_id`. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `team`         | `team`                        | Org team. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `user`         | `user`                        | Instance user (email identity). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `totp`         | `twoFactor`                   | TOTP enrolment. Unique `user_id` (`uniq_totp_user_id`); `secret` is a sealed `tpsecret` envelope, not plaintext. Consumed by `two-factor.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `verification` | `verification`                | Email / OTP verification tokens. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tag`          | `tag`                         | Org-owned tag definition. App-enforced trim + case-insensitive uniqueness backed by `uniq_tag_organization_name`. SQL-adjacent — double-quote in raw `sql` tagged templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `marker`       | `marker`                      | Join edge: one tag on exactly one parent (`marker_exactly_one_parent_check`); seven partial uniques (`uniq_marker_server` … `uniq_marker_storage`). Org derived through `tag.organization_id`. No `metadata`/`options` pair (follows `tenancy` / `label`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `task`         | `task`                        | Cron-style scheduled command on a service. `uniq_task_service_name`; `task_concurrency_policy_check` (`allow` \| `forbid` \| `replace`). No execution columns (`last_run_at` / result) and no run-history table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Better Auth:** do not reintroduce a physical `member` or `membership` table.
Org membership is `teammate` → `team.organization_id`. Platform authority stays
on `user.role` (`superadmin` / `admin` / `user`), separate from org grants.

**Retired names:** `vpn` / `peer` / `tlsleaf` / `tlsrotation` /
`principal_entitlement` / `principal_ssh_key` / `gitapp` / `installation` /
`source` / `steward` / `location` / `credential` / `node` / `segment` /
`rotation` are retired physical table names, guarded by `table-naming.test.ts`
(same reject list as `member` / `bridge` / `managed_member`). Do not reintroduce
them. Do **not** retire `task`: the replica-slot table is `slot`; `task` is the
cron scheduled-command table.

**Naming exceptions** (external compatibility only — listed in the guard test
and here). There are none: `2fa` became `totp` and `grant` became `permission`.

## Resource hierarchy

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

Canonical ancestry order and the dense per-resource detail (semantics of every
table in the tree, storage model, principals, managed runtimes, …) live in
[`resource-hierarchy.md`](./resource-hierarchy.md).

## Resource naming contract

Generated names and principal paths live in **`src/lib/naming.ts`** — the single
source of truth for container names (`containerNameFromService` /
`managedContainerName` / `ingressContainerNameFromService` → `<service.id>-in`
for per-service Traefik **and** shared ProxySQL `managed-ingress` — suffix
contract in `src/client/system/AGENTS.md` → **Container name suffix contract**; all
keyed off the **service** UUID, not the container row), Docker volume names
(`dockerVolumeNameFromStorageId` / `resolveDockerVolumeName` / legacy-only
`legacyNamespacedDockerVolumeName`), principal home/SSH/volume paths under
`/srv/users/<username>` (keyed on the operator-chosen username, not the
principal UUID), the reserved-only DNS shape (`serviceDnsName`), and the
reserved `TURBOPANEL_*` deploy variable keys (`RESERVED_DEPLOY_VARIABLE_KEYS`).
Option parsers (`project-options.ts` `containerNaming`, `service-options.ts`
`instances`, `principal-options.ts` optional `uid`/`gid` override)
feed those helpers; deploy-prepare owns allocation (`uuid` mode ignores authored
compose `container_name`; `custom` still reads them), multi-instance expansion,
compose-volume registration, and compose emission via `apply-service-options.ts`
(sole writer of allocated `container_name` values).

Native Postgres **`inet`** and **`cidr`** columns are defined in `net-types.ts`
via Drizzle `customType` — no regex CHECK constraints belong on those types.

**Names** (`name` column, API `name`) on organization, workspace, project,
environment, service, hosting, datacenter, network, fabric, tls, team, managed,
server, license, storage, and secret are labels, not identifiers. Dropped
charset CHECKs (they contradicted app-side `display-name-format.ts`):
`hosting_name_format_check`, `datacenter_name_format_check`,
`project_name_format_check`. Every other name-format CHECK remains:
`tls_name_format_check`, `workspace_name_format_check`,
`environment_name_format_check`, `service_name_format_check`,
`network_name_format_check`, `fabric_name_format_check`,
`team_name_format_check`, `managed_name_format_check` and `user_name_format_check`. The preferred app-side rule for labels
(and the rule that replaces the dropped CHECKs) is
`src/lib/display-name-format.ts` (`normalizeDisplayName` + `isValidDisplayName`)
— trim, Unicode NFC, apostrophe-fold, no control characters, and a code-point
length cap (`DISPLAY_NAME_MAX_LENGTH` / `DESCRIPTION_MAX_LENGTH`, currently
255). Changing the cap is a code change, not a migration. The same length-only
rule applies to `description` columns and Docker **label values**
(`label.value`; the **key** CHECK stays). Typographic apostrophes still fold to
ASCII `'` so iOS/macOS input matches uniqueness compares.

**Identifiers vs labels.** Identifier charsets stay strict (interpolated into
SQL / Docker / Traefik / shell). Do not relax these:

| Guard                                                  | Where                                                                                             | Why it stays                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `service.compose_service_name`                         | `isValidComposeServiceName` in `src/contracts/commands/schemas.ts`                                | Compose YAML key + `-p` project scoping               |
| `principal_username_format_check`                      | schema + `src/features/principals/store.ts`                                                       | `useradd` / SQL `CREATE ROLE`                         |
| `variable_key_format_check`                            | schema                                                                                            | Shell env-var name                                    |
| `binding_key_prefix_format_check`                      | schema                                                                                            | SQL identifier / env prefix                           |
| `label_key_format_check`                               | schema, `ui/src/lib/server-labels.ts`                                                             | Docker engine label key → `node.labels.*` constraints |
| Hostnames                                              | `turbopaneld` `src/commands/hostname.ts`, `src/deploy/compose-labels.ts`, `src/deploy/ingress.ts` | Traefik router rules, DNS                             |
| `DEPLOY_INGRESS_COMPOSE_NAME_RE` / `CONTAINER_NAME_RE` | `turbopaneld` `src/contracts/commands-contracts.ts`, `src/deploy/ingress-identity.ts`             | Docker CLI args, on-disk file ids                     |

The daemon never receives display labels on a path that interpolates them.

**Project cascade delete** (`deleteProjectCascade` in `project-delete.ts`):
one step from the user's point of view. The route first reads the delete plan
(`features/projects/delete-plan.ts`) and refuses, before anything is stopped,
while a `managed` row remains (the database is deleted on its own, with its own
confirmation), while another project uses a shared asset that would go, or while
a server the delete has to reach is offline (the stop cannot wait for it). It
then sends `environment.stop` to every server (refused as `project_stop_failed`
when that does not go out) and, in one transaction, runs
`applyStorageRetentionOnParentDelete` (clear `mount`s first — `service_id` is
RESTRICT — then drop `retention='delete'` storage; `retain` rows stay org-owned
via SET NULL), lets go of every folder row under the environments
(`releaseEnvironmentFolders`: `removing` with `environment_id` NULL, a kept
volume's row `orphan`), deletes in order `container` → `hosting` (compose-owned
ones too) → `tenancy` → `binding` → `service` → `environment`, marks the
project's principals nothing else uses (`removal_requested_at`), then deletes
the `project` (variables and `managed` cascade via FK; `principal.project_id`
is SET NULL). After commit the servers are asked to remove the folders (the
folder removal sweep asks again until they confirm), and the principal removal
sweep (`client/principals/removal-sweep.ts`) retires each marked principal's
Linux user and home once no folder row names it, its servers are connected
and no stop is still running there; its placements turn `retiring`, the
command consumer turns them `absent` when the host reports the account
retired, an unconfirmed retire is asked again, and the row is deleted once
none is left. A principal still used elsewhere is kept and listed.
`tenancy.service_id` and `binding.service_id` are RESTRICT (a direct service
delete must not leave a dangling run-as or inject edge), so the cascade drops
those rows first. Running `ingress` / `turbopanel` rows (ProxySQL, per-service
Traefik, Orchestrator) are server-scoped (destroy fan-out + orphan sweep).
Restrictive FKs stay in place as a safety net. Workspace / environment /
service delete paths use the same retention helper.

Authorization ancestry and `listVisible()` resolve organization through this
chain in SQL (`evaluator.ts`, `create-access-grant.ts`). **`variable`** and
**`managed`** are in `RESOURCE_KINDS`, `GRANT_ENTITY_TYPES`, and `ENTITY_TYPES`
(`catalog.ts`); `resolveEntityById()` and `can()` resolve their org via parent
joins (same paths as `create-access-grant.ts`) — **`managed`** ancestry resolves
via `environment → project → workspace`. **`principal`** is in `RESOURCE_KINDS`
and `ENTITY_TYPES` but **not** `GRANT_ENTITY_TYPES` — org is derived via
`tenancy → service → environment → project → workspace` (returns null when
unassigned); `tenancy` itself is not a grantable authz entity.

**Where `principal` / `tenancy` rows come from at deploy time.** A compose
document names an account by **alias** — a document-local key under the root
`x-turbopanel.principals` — never by Linux username, because everything that
decides what the account _is_ on a host (uid, gid, home, shell, keys, password)
is a privilege decision gated by `organization:manage` on the `principal` row.
`reconcilePrincipalsFromCompose` (`../client/principals/tenancies.ts`) runs
inside deploy-prepare and turns each declared alias into a `principal` row plus
the `tenancy` edge that says which `service` runs as it. The alias →
`principal.id` map it returns is carried through the compiler as
**`ResolvedApplication.principals[]`** (`{ logicalAlias, principalId }`) — see
the four-model IR in `../compose/AGENTS.md` and `../compose/ir.ts`. That mapping
is the _only_ bridge between the document's aliases and these rows: nothing
downstream re-derives an account from a compose key, and a service whose alias
never became a row is refused (`principal_alias_unknown`) rather than run as
nobody. **`GET /access/check`** accepts any resolvable entity UUID (including
`variable` and `managed`). **`GET /access/resource-id`** accepts only
`organization` and `team` kinds (grant-management UI). Access grants still
target org/team entities only.

> Permissions are **static code constants** defined in
> `../client/authz/catalog.ts` (`PERMISSIONS`, `ENTITY_TYPES`,
> `SUBJECT_TYPES`) — not DB rows. The only table is `permission`, which holds
> the allow-only grants of those constants to a subject. There are no `role` or
> `permit` tables. The Drizzle table export is **`grant`** (not `accessGrant`).

Drizzle relations are defined for future Better Auth adapter use.
`IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup.
`setting.value` is `jsonb`. The `SYSTEM_EMAIL` key stores all email settings as
a single JSON object (self-hosted mode only; env vars take precedence and leave
this table empty).

**Organizations:** a user is in an org iff they are a `teammate` of any `team`
in that org. Org owner/manager roles come from `permission` (`organization:own` /
`organization:manage`) on the user or a team — not from binding users directly
to organizations. `user.role` (`superadmin` / `admin` / `user`) is instance
authority, separate from org access. **`invitation.grants`** (JSONB) stores the
intended access grants (`InvitationGrantSpec[]` in
`src/client/authn/invitation-grants.ts`); they are materialized into `permission`
rows on accept. When `grants` is null or omitted, accept adds team membership
only — no default org grant. **`organization.options.maxServers`**
caps enrolled servers + unconsumed registration keys (`null`/omitted =
unlimited). Self-hosted operators set it via
`GET`/`PUT /organizations/:id/server-capacity`; `POST /licenses` returns **409**
`server_capacity_exceeded` when the org is at capacity. Workers/Stripe billing
will write the same field later.

**Host defaults cascade** (no schema migration — stored in existing `options`
jsonb): organization → datacenter → server, most specific wins. SSH (`sshPort`,
1–65535) falls back to **22**. Desired NTP (`ntp`: `enabled` / `servers` /
`fallbackServers`) is separate from daemon-reported `timeSync` columns.
`defaultFabricEnabled` is organization-only and never enables the mesh by itself
(`PUT …/fabric` remains the enable path). Timezone keeps its enforce/override
resolver — do not treat org/DC timezone as a soft default. `null` on PUT/PATCH
clears that layer so the parent inherits. Canonical parsers/resolvers:
`src/features/servers/host-defaults.ts`.

**Uniqueness:** `teammate(team_id, user_id)` prevents duplicate team membership
rows on concurrent invite acceptance/retries.

**Install (Deno):** A fresh DB has no org or superadmin.
`src/client/authn/install-state.ts` `isInstanceInstalled()` is false until
`completeInstanceInstall` creates org → **TurboPanel workspace
(`kind='turbopanel'`)** → team → superadmin → grants → **Default Workspace**
(`kind='user'`) → colocated license. **"TurboPanel"** is therefore a reserved
workspace name from first boot (**409** `workspace_name_in_use`).
**`organization.slug`** no longer exists (dropped 2026-09-17 with the pre-tag DDL
batch; it was reserved, never written, and no feature claimed it). Org
extras (e.g. logo URL) belong in **`organization.metadata`** — there is no
`logo` column. Install sets **`email`** and **`role`** (on `user`) only —
optional user `name` stays **NULL** until the user chooses it. The Postgres
column is `name` while the client JSON field is `name`.

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

## Client API (authz integration)

The client REST endpoint inventory — access/permission endpoints and the full
resource-tree CRUD table with per-route permission contracts — moved to
`../client/AGENTS.md`. The rules in short: list/get enforce visibility via
`listVisible` / org-level grant checks **in SQL** (never client-side);
create/update/delete require `organization:own` or `organization:manage` on the
entity's org via `can()`; create/delete run entity insert/delete in a single
transaction.

## Catalog

Permissions are **static code constants** in `../client/authz/catalog.ts` —
there is nothing to seed. Seven permissions exist: `organization:own`,
`organization:manage`, `team:own`, `team:manage`, `system:read`,
`system:operate`, and `system:manage`. `system:manage` is **not grantable**
(superadmin-only). Never edit permissions in Studio — they do not exist as DB
rows. **`ENTITY_TYPES`** and **`SUBJECT_TYPES`** (`user`, `team`,
`organization`) are also exported from `catalog.ts` for route/body validation
(`isEntityType`, `isSubjectType`). Organization-wide subject grants apply to
every teammate of a team in that organization.

## `tier` table

Platform-global billed offerings: a ladder label bound to a payment-provider
**product**. Everything a tier _entitles_ lives in code —
`src/features/tiers/ladder.ts`, keyed by `label` (cores / RAM ceilings, NIC /
drive / GPU / filesystem slots, list price) — so the row holds only what the
code cannot know: which provider product the label bills against, plus a
cached display price. There is no `organization_id` — every org sees the
same catalogue. Rows are chosen from the provider's product list under
Admin → Tiers and verified before they are written; nothing seeds them.

| Column                | Notes                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`               | `"S1"`…`"S7"`, `"SX"` — the key into the ladder. Unique (`uniq_tier_label`).                                                                                                                                           |
| `rank`                | Copied from the ladder on insert, never from a request. Unique (`uniq_tier_rank`): rank orders tiers, decides upgrade-versus-downgrade direction and the greedy assignment.                                            |
| `provider`            | `stripe` only — Apple was dropped before the first tag (2026-09-17); `tier_provider_check` matches `payer_provider_check`.                                                                                             |
| `provider_product_id` | The provider's Product. **Null** on the custom / SX row, which is therefore never purchasable. Unique with `provider` where not null (`uniq_tier_provider_product`): the projection's product→tier map is keyed on it. |
| `price_cents`         | Display cache of the product's default price, written on verify and refreshed by the provider's `product.updated` / `price.updated` webhooks. Nothing does arithmetic on it.                                           |
| `currency`            | Display cache beside `price_cents`; lower-case ISO code.                                                                                                                                                               |
| `is_custom`           | Copied from the ladder (true for SX).                                                                                                                                                                                  |
| `is_active`           | Tiers are deactivated, never deleted — `is_active = false` hides a row from new purchases without breaking the seats that count against it.                                                                            |

No `metadata` / `options` pair. `seat.tier_id` and `server.assigned_tier_id`
reference it (`RESTRICT` and `SET NULL` respectively). A re-price is a new
default price on the product in the provider's Dashboard; no row changes.

## `license` table

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

**No tier on a license.** A license is the key that ties one server to
this instance and nothing more. Which purchased tier the server sits on is
derived per organization (`server.assigned_tier_id`, below), so a mint never
names a tier: on hosted, `POST /licenses` is gated only on
`purchased − releasing − held > 0` (`summarizeLicenses` in
`src/client/billing/routes-helpers.ts`, read under the quantity lease), and a
revoke never calls the provider — what was bought stays bought until the
billing page reduces it. The one case billing revokes licenses is an ended
subscription (`revokeAllLicensesForOrganization`, bound ones included).

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

## `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon
connect the instance resolves `serverId` (reuse by persisted id, `machine_key`,
or `hostname` columns), tracks presence in the **Daemon Cell**, and returns
`serverId` in enrollment responses. The daemon persists it at
`/var/lib/turbopanel/daemon/state/server.id` (production: owned by **`tp:tp`**;
co-located dev: dev-user-owned under the same FHS path). See the canonical
[Production UID/GID allocation](../../docs/host-layout.md#production-uidgid-allocation)
table in `docs/host-layout.md`. Server rows are hard-deleted — there is no
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

Column order: see `server` in `schema.ts` for the current list (the shared
`metadata`/`options` pair sits immediately after the timestamps, remaining
columns follow). **No `datacenter_id`** —
membership is via `ip` pins only. Indexes: `idx_server_organization_id`,
unique `uniq_server_machine_key` (one machine belongs to exactly one organization), and partial
`idx_server_connected` on `(id) WHERE is_connected`, `idx_server_offline` and `idx_server_updating`. Latest hardware and the latest metrics plan are the jsonb columns `hardware` and `capability` (latest only: older generations are not kept); `machine_class_source` says whether `machine_class` was `detected` or set by an `operator`; `offline_reason`, `daemon_commit`, `daemon_built_at`, `daemon_update_status` and `external_access_pending_at` are the columns the sweeps filter on. There is no `daemon_status`
column or CHECK constraint — liveness is a single boolean plus a transition
timestamp (see "Fleet status columns" below). `organization_id` FK uses
`ON DELETE RESTRICT`. `network.server_id` → `server.id` is `ON DELETE RESTRICT`
— server deletion is blocked while network rows reference it (same for
`ip.server_id` and `relay.server_id`). Deleting a server clears
`license.server_id` via `ON DELETE SET NULL`; the app soft-revokes the bound
license after delete.

**Assigned tier:** `server.assigned_tier_id` (nullable FK → `tier.id`,
`ON DELETE SET NULL`, `idx_server_assigned_tier_id`) is the tier this server
holds — **chosen by the organization's managers, never computed**. It is
written only by the manager route `PUT /servers/:id/license-tier`
(`assignServerTier` in `src/features/tiers/assignment-records.ts`, needs a free
seat at that tier, writes only that server) and, on the self-hosted runtime
only, by the grant fill (`fillSelfHostedGrantTier`, sets `SX` where the column
is null). No hardware report, enroll, session, seat or subscription change, or
server delete writes it. `preferred_tier_id` is written in step with it by the
manager route. Ingest, the capability plan, placement and the notice sweep read
this column. Null on an unlicensed server and on a licensed server no manager
has assigned yet — the daemon still connects. A server that measures bigger
than its tier keeps it and is flagged (`metadata.overPlan`). The highest RAM and
physical cores of the last 7 days (the grace window) live in the `peak` table,
one row per server per UTC hour (`features/servers/peak.ts`); the 15-minute
cron prunes older buckets.

**Cell metadata fields** (stored in `server.metadata` and/or `server.options`
JSONB):

| Field              | Column                                                | Purpose                                                             |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `cellLocationHint` | `options` (preferred) or `metadata.cell.locationHint` | Cloudflare Durable Object `locationHint` chosen at enrollment time. |

`options` takes precedence over `metadata` when both define a value (see
`src/daemon/cell/location.ts`). Residual `metadata` holds nested `resources`
(cpu / memory / swap **and** `ips`), `geo`, `docker`, and `cell` — not hostname
/ machineKey / OS / observed timezone / NTP (those are dedicated columns).
Leftover `os` / `timeSync` / top-level `ips` keys may still exist in old jsonb
and are read as fallbacks only.

**Host OS columns:** `os_id`, `os_family`, `os_version`, `os_codename`,
`os_pretty_name`, `os_architecture`. Raspberry Pi OS 64-bit (`ID=debian` +
`/etc/rpi-issue`) is stored as `os_id = raspberry-pi-os`. The API still composes
a nested `os` object (with `variant: raspberry-pi-os` when that id is set).
`os_architecture` is `NULL` or `x86_64` / `aarch64` (`server_os_architecture_check`,
migration 0003): `normalizeServerOsArchitecture` (`src/contracts/capability-plan.ts`)
maps `amd64` / `arm64` and similar spellings on ingest, so older daemons keep
working, and drops CPUs that are neither (for example `armv7l`).

**Host time-sync columns:** `timezone` is the **daemon-reported** IANA zone
(operator override stays on `server.options.timezone`). `is_time_sync_enabled`
is the NTP client enabled flag. `ntp_servers` is a jsonb array of
`{ host, fallback? }` (Debian often has empty `NTP=` and real servers on
`FallbackNTP=`). `ntp_last_synced_at` is the last successful sync; it is
**never** rewritten to `now()` on every heartbeat — only when the daemon reports
a stamp, the host becomes unsynced (`null`), or the first synced observation
arrives while the column is still null.

**Daemon identity:** the key lives in its own `key` table, one row per server
(unique `uniq_key_server` on `server_id`, `ON DELETE CASCADE`), and the sparse
`server.daemon` jsonb holds only the optional projection. The assembled shape
is `{ key, projection? }` (`ServerDaemonState` in
`src/features/servers/daemon-state.ts`), built by the readers in
`src/features/servers/server-identity-db.ts`, which join `key` to `server`; a
server with no `key` row is not enrolled. Fleet liveness lives on dedicated
columns (below).

```json
{
  "key": {
    "id": "uuid",
    "algorithm": "Ed25519",
    "publicJwk": {},
    "fingerprint": "sha256-public-jwk-fingerprint",
    "createdAt": "iso timestamp",
    "revokedAt": "iso timestamp or null",
    "lastUsedAt": "iso timestamp or null"
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

The `key` object above is the `key` table row; only `projection` is stored in
`server.daemon`.

| Field             | Purpose                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `key.id`          | Logical key identifier returned to the daemon as `keyId` on enrollment                     |
| `key.publicJwk`   | Raw Ed25519 public JWK `{ crv, kty, x }`                                                   |
| `key.fingerprint` | SHA-256 hex over the canonical public JWK — unique across servers (`uniq_key_fingerprint`) |
| `key.revokedAt`   | Non-null blocks new JWT issuance; existing JWTs remain valid until their 15-minute expiry  |

**`server.daemon.projection` (sparse identity summary):** optional `hostname` /
`machineKey` (also mirrored onto dedicated columns), `remoteAddress`, `keyId`,
optional `daemonBuild` (`commit`/`buildId`/`builtAt`/`channel`), optional
`update`, `features` (wire features advertised in `hello`) and `offlineReason`
(`disconnect` or `sweep_stale`). Updated on identity changes and daemon build
identity changes (via `control-plane-monitor.ts` outside the DO hot path on
Workers). No monitor
health counts or resource graph are stored. Projection is not path-queried for
reconnect dedup — use `hostname` / `machine_key` columns.

**Fleet status columns (liveness projection):** just two columns —
`is_connected` (`boolean NOT NULL DEFAULT false`) and `status_changed_at` (last
`is_connected` flip, set on every online **and** offline transition). There is
no `daemon_status`, `last_seen_at`, `connected_at`, or `disconnected_at` column;
the old tri-state `online|offline|unknown` and the separate timestamp columns
were collapsed into this pair. `connectedAt` is **derived**, not stored:
`src/daemon/cell/server-status.ts` returns `statusChangedAt` as `connectedAt`
only while `is_connected` is true (otherwise `null`), and treats `!is_connected`
as offline-since-`statusChangedAt`. Written by `postgres-projection.ts` only on
connect/disconnect transitions and on meaningful heartbeats (daemon
build-identity change, or new `timeSync` / `resources.ips` / `docker` facts) —
never on a bare elapsed-time debounce (there is no periodic "touch
`last_seen_at` every N seconds" write path anymore). Identity columns `hostname`
/ `machine_key` are written on enroll/hello/identity projection.

**Status read model:** the two status columns above are the Postgres-projected
liveness read model. UI and API status reads go through
`src/daemon/cell/server-status.ts` (`resolveFleetPresence`) for coarse presence,
plus `src/client/servers/update-status.ts` (`loadServerStatusRecords` /
`buildServerStatusRecord`) for the `ServerStatusRecord` DTO shape (`serverId`,
`connected`, `daemonStatus`, `connectedAt`, `statusChangedAt`, `hostname`,
`remoteAddress`, `geo`, `colocatedWithInstance`). Do not read status columns
directly from routes. The tri-state `daemonStatus` (`online` \| `offline` \|
`unknown`) still exists as an **API-layer derived value** —
`src/features/servers/daemon-state.ts` (`mapServerDaemonStatusFromColumns`) computes
it from the `is_connected` + `status_changed_at` columns at read time (`unknown`
only when `statusChangedAt` is null, i.e. the server has never transitioned) —
it is never stored as a column or CHECK constraint. The `/servers/status` and
`/servers/:id/status` endpoints serve this read model; reads are Postgres-only
and do not call the DO/Redis cell by default; both runtimes share the same
response shape. A separate, independent **status event history** in Analytics
Engine/DuckDB (`src/daemon/metrics/AGENTS.md`) exists for historical
uptime/downtime charts — it is history-only and never authoritative for current
liveness. See `src/daemon/cell/AGENTS.md` for cost/parity rules.

**Key use tracking:** `key.last_used_at` is updated on JWT session
issuance via `touchDaemonKeyLastUsed()` (Postgres only — no cell wake).
`lastInboundAt` remains cell-only (Redis/DO snapshot), coalesced on connect and
inbound WS activity.

Status is never written into `server.daemon` jsonb.

Re-enrollment with a valid license token replaces the server's `key` row (a new
`id`, fingerprint and `created_at`; the old key is not kept) and resets
`server.daemon` to null together with the status columns, in one transaction.
A revoked key is never replaced by re-enrollment. To revoke daemon auth, set
`key.revoked_at` (via the `revokeDaemonKey` helper).

## `command` table

Canonical command/job history — source of truth for UI status and history. Do
not read command history from the Daemon Cell — the cell holds only hot
pending-request correlation state. The `command` table is the canonical record.

| Column                | Type                            | Notes                                                                                          |
| --------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                  | uuid (uuidv7)                   | Primary key                                                                                    |
| `created_at`          | timestamptz(3) NOT NULL `now()` | Real column; index/order source                                                                |
| `updated_at`          | timestamptz(3) NOT NULL `now()` | Bumped by `transitionCommand`                                                                  |
| `metadata`            | jsonb nullable                  | Follow-up-chain blob only (`getCommandMetadata`)                                               |
| `server_id`           | uuid NOT NULL                   | FK → `server.id`, `ON DELETE CASCADE`                                                          |
| `organization_id`     | uuid nullable                   | FK → `organization.id`, `ON DELETE SET NULL`; copied from the server at insert (activity feed) |
| `environment_id`      | uuid nullable                   | FK → `environment.id`, `ON DELETE SET NULL` (deploy history)                                   |
| `managed_id`          | uuid nullable                   | FK → `managed.id`, `ON DELETE SET NULL` (managed follow-up lookups)                            |
| `actor_type`          | text NOT NULL                   | `'user'` \| `'system'` (`command_actor_type_check`, mirrors `COMMAND_ACTOR_TYPES`); no FK      |
| `actor_id`            | uuid NOT NULL                   | ID of the acting entity; no FK                                                                 |
| `name`                | text NOT NULL                   | Command type (e.g. `daemon.ping`)                                                              |
| `status`              | text NOT NULL `'queued'`        | `command_status_check` — exactly `COMMAND_STATUSES`                                            |
| `attempts`            | integer NOT NULL `0`            | Dispatch retry count                                                                           |
| `context`             | jsonb nullable                  | Small non-secret identifier bag (`generation`, …); ids that are filtered on are columns        |
| `result_summary`      | jsonb nullable                  | Typed command output (small, bounded)                                                          |
| `error_code`          | text nullable                   | Machine-readable terminal error code                                                           |
| `error_message`       | text nullable                   | Terminal error message                                                                         |
| `queued_at`           | timestamptz(3) nullable         | Set when status → `queued`                                                                     |
| `dispatch_started_at` | timestamptz(3) nullable         | Set when status → `dispatching`                                                                |
| `sent_at`             | timestamptz(3) nullable         | Set when status → `sent`                                                                       |
| `acked_at`            | timestamptz(3) nullable         | Set when status → `acked`                                                                      |
| `started_at`          | timestamptz(3) nullable         | Set when status → `running`                                                                    |
| `finished_at`         | timestamptz(3) nullable         | Set when status → terminal                                                                     |
| `expires_at`          | timestamptz(3) nullable         | Optional command TTL                                                                           |

There is **no `payload` column on `command`** — the daemon execution payload
lives in the `dispatch` side table (below) and is deleted shortly after the
command reaches a terminal state, so the permanent history row is secret-free.

**JSONB usage:** `context` stores allowlisted identifiers only (extracted by
`src/features/commands/context.ts` — never secrets, compose YAML, credential
envelopes, or TLS material); `result_summary` stores typed command output.
`metadata` is now only the follow-up-chain blob (`pendingStandbyApplies`,
`managedDestroyGate`, `followUpPromote`, `pendingTlsLeaf`, `desiredHash`, …)
read through `getCommandMetadata`. It is also where a fan-out takes a one-shot
claim: `claimCommandMetadataFlag` merges a key with a conditional UPDATE, so
sibling commands finishing at once elect exactly one follow-up enqueuer.
`command` has no `options` column.
**Never store logs, streaming output, or large blobs in these columns.**

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

- `idx_command_server_recent` — `(server_id, created_at DESC, id DESC)` — backs
  `listServerCommands` ordering without a sort
- `idx_command_open` — `(status, updated_at)` partial on the five open statuses —
  the stale-command sweep
- `idx_command_deploy` — `(environment_id, created_at DESC, id DESC)` partial on
  `name = 'environment.deploy'` — deploy history
- `idx_command_managed` — `(managed_id)` partial on open rows with a managed id
- `idx_command_feed` — `(organization_id, created_at DESC, id DESC)` partial on
  the three deploy-family names and the open or failed statuses — the activity
  feed's in-progress and failed filters
- `idx_command_activity` — the same key, partial on the three deploy-family
  names only — the activity feed with every outcome (all, succeeded)
- `idx_command_server_id_name_created_at` — reconcile "was one sent since X" probes
- `idx_command_managed_destroy_gate_id` — partial on rows with a gate id

A partial index only helps when the SQL repeats its predicate literally: write
the status lists as literals (`commandIsOpen()` in `features/commands/open-statuses.ts`).
`server_id` cascades; `organization_id`, `environment_id` and `managed_id` set null.

**Lifecycle timestamps are real columns.** `status`, `created_at`, `updated_at`,
`attempts`, `name`, `result_summary`, every granular timestamp
(`queued_at`…`finished_at`, `expires_at`) and both error fields (`error_code` /
`error_message`) are physical columns — `transitionCommand` `.set()`s them
directly; nothing merges into `metadata` any more. `serializeCommandRecord` in
`command-records.ts` maps those columns onto the stable `CommandRecord` type
(`result` ← `result_summary`, `error` ← `error_message`) and normalizes
postgres.js timestamptz strings (`YYYY-MM-DD
HH:mm:ss+00`) to ISO-8601; it never
exposes a dispatch payload.

Server delete cascades to command rows (`ON DELETE CASCADE` on `server_id`).

## `dispatch` table

One-shot daemon execution payload for a `command` — the only place
secret-bearing command input is stored.

| Column       | Type                            | Notes                                                       |
| ------------ | ------------------------------- | ----------------------------------------------------------- |
| `command_id` | uuid PK                         | FK → `command.id`, `ON DELETE CASCADE`                      |
| `created_at` | timestamptz(3) NOT NULL `now()` | Written with the command row                                |
| `payload`    | jsonb NOT NULL                  | Typed daemon command input (small, bounded)                 |
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
   `failed` / `timed_out` / `cancelled` stamp
   `expires_at =
now + COMMAND_DISPATCH_FAILURE_RETENTION_MS` (24h) for
   debugging. Cleanup is best effort and never fails the transition.
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
column to cache it. See `src/features/execution-logs/AGENTS.md`.

## Layout

| File                                                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`                                           | Drizzle table definitions — sync with dev DB via `dev/scripts/introspect.sh` or `dev/scripts/sync.sh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `deployment-records.ts`                               | Deployment target helpers (`upsertDeploymentTargets`, apply/fail transitions, prune draining)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `deployment-history.ts`                               | Environment deploy **history** reads from `command` (`listEnvironmentDeploymentHistory`, `getEnvironmentDeploymentDetail`) — `deployment` holds current state only. The list is keyset-paginated; the detail's same-generation fan-out is deliberately **unpaginated** so every participating host is enumerable. Replica counts (`replicaCounts` / `totalReplicas`) are historical, read from each attempt's `command.context`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `slot-records.ts`                                     | Scheduled-instance helpers for the **`slot`** table (file name unchanged until phase 2; `replaceEnvironmentSlots` sticky re-plan, list by environment/server); persists nullable `slot.address` so spanning `ipv4_address` / `extra_hosts` stay stable across re-plans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `task-records.ts`                                     | Cron-style scheduled-command helpers (`listTasksForService` / `listTasksForServices`, `createTask` / `updateTask` / `deleteTask`, `parseTaskNameInput`, `isTaskUniqueViolation`). Configuration only — nothing is enqueued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `repository-records.ts`                               | Git **`repository`** helpers (file name unchanged until a later phase; table was `source`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `label-records.ts`                                    | Server label helpers (`parseServerLabelInput`, `setServerLabels` replace-all, fleet `listServerLabelsForServers`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fabric-records.ts`                                   | TurboFabric helpers (`enableOrganizationFabric` (optional `FabricEnablePolicy` — `allowRelay` / `containerPool` — written before relay allocation, in one transaction with the fabric row; `FabricContainerPoolOverlapError` when the auto-picked host range lands in the pool) / `disableOrganizationFabric`, `ensureFabricRelays`, `loadFabricReconcileSnapshot` + `buildFabricReconcilePayloadFromSnapshot` / `buildFabricReconcilePayload`, `stampRelayPublicKey`, `materializeSpanningNetworks`, compose-network reclaim: `listEnvironmentComposeNetworks` / `purgeEnvironmentComposeNetworks` / `purgeEnvironmentsComposeNetworks` / `purgeComposeNetworksCreatedAfter` / `releaseSubnetsForServer` — `network.environment_id` has no FK). One snapshot per fabric apply loads relays, endpoint caches, PSK envelopes, subnets, datacenter memberships, and address-family preferences once. Pair PSKs are canonical: both peer stanzas use the envelope owned by the lexicographically smaller relay id (`selectPairPresharedEnvelope`). Derived gateway advertised CIDRs are owned among **public-keyed** relays only (the same set `buildReconcilePeerLists` emits as peers); GET fabric still shows planned defaults for keyless gateways. Relay `address` allocates the lowest-free host in `fabric.cidr`; `endpoint_address` is an operator override over pair-aware `planRelayPath` (`direct_lan` via shared datacenter family intersection, else `direct_public`). An unplannable pair is omitted from that server's peer list and recorded on `unreachablePeers` (the rest of the mesh still builds). GET fabric `resolvedEndpoint` stays destination-only (no viewer/`self`). |
| `table-naming.test.ts`                                | Guard: every `CREATE TABLE` across migration SQL files under `migrations/` is one lower-case word (no underscores); exception list for external-compat names; retired-name reject list (phase 2 adds `gitapp` / `installation` / `source` / `steward` / `location` / `credential` / `node` / `segment` / `rotation`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `primary-key.test.ts`                                 | Guard: every `CREATE TABLE` across migration SQL files under `migrations/` has a `PRIMARY KEY`; application PKs are `uuid … DEFAULT uuidv7()` or the allowlisted natural key `dispatch.command_id`; rejects `serial` / identity / `nextval()`; pins the drizzle-orm `public.migration` bookkeeping DDL (see Multi-node PostgreSQL model)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `migration-manifest.test.ts`                          | Guard: every shipped migration file still hashes to what `../../migrations/manifest.json` recorded (drizzle's own sha256, equal to `public.migration.hash`); journal idx contiguous, `when` strictly increasing, every `NNNN_*.sql` journaled, snapshot `prevId` chain intact; also runs `scripts/check-migration-freeze.mjs` in check mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `../../scripts/check-migration-freeze.mjs`            | Migration freeze guard: `check` (default), `--update` (append new journal entries after `pnpm generate`; refuses a changed/removed entry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `../../scripts/check-migration-additions.mjs`         | Freeze guard layer two (CI): with the base ref's manifest `frozen`, refuses any modified or deleted `NNNN_*.sql` / snapshot under `migrations/` — additions only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `audit-records.ts` · `audit-records.hostfree.test.ts` | Append-only audit trail (`recordAudit` never throws — an audit row must not fail the action it records; `listAuditForOrganization` keyset-paginates newest-first). `AUDIT_ACTIONS` is a TS list, deliberately not a CHECK: it grows with every route that starts auditing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `schema-state.ts` · `schema-state.test.ts`            | Migration-history check against the frozen manifest (`compareSchemaState` → current/unmigrated/behind/ahead/diverged); `assertSchemaCurrent` is the Deno boot gate; `MIGRATIONS_FOLDER` (checkout or `--include`d copy); twin `../../scripts/schema-state.mjs` for `pnpm migrate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `../../scripts/check-deploy-env.mjs`                  | `pnpm deploy` gate: with `CLOUDFLARE_ENV` set, the migrate URL must be that env's Hyperdrive origin (host/port/database; migrate user may differ); fail closed; skipped when unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `connection.ts`                                         | Connection factories (`createDenoDb`, `createToolingDb`, `createWorkersDb`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `../../drizzle.config.mjs`                            | drizzle-kit config (`TURBOPANEL_DATABASE_URL`; introspect, push, generate, migrate, studio)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `../../scripts/bootstrap-dev-db.sh`                   | Dev DB bootstrap: `pnpm migrate` (includes the PostgreSQL 18 / `uuidv7()` preflight)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `../../scripts/check-postgres-compat.mjs`             | Pre-migration gate run by `pnpm migrate`: verifies the target server has `uuidv7()` (PostgreSQL 18 minimum) before `drizzle-kit migrate` touches it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `~/dev/scripts/introspect.sh`                         | Pull DB → `schema.ts` (lives in dev repo)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `~/dev/scripts/sync.sh`                               | Push `schema.ts` → DB (Deno dev only; no migration files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `../../scripts/db-connect.sh`                         | Resolves `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` for drizzle-kit scripts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `../../migrations/`                                   | Versioned SQL migration files (committed); applied by `pnpm migrate`; tracked in `public.migration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `../../drizzle/`                                      | Ephemeral introspect scratch dir — `dev/scripts/introspect.sh` deletes after adopt; never committed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Authz engine

Runtime authorization lives in `../client/authz/` (pure TypeScript, safe for
both Deno and Workers — no Deno-only imports). Permissions are static code
constants in `catalog.ts`. The modules below evaluate access at request time
against `permission`.

| File                              | Purpose                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../client/authz/catalog.ts`   | Static `PERMISSIONS`, `GRANTABLE_PERMISSIONS` (excludes `system:manage`), `ENTITY_TYPES`, `SUBJECT_TYPES` (`user` / `team` / `organization`), `isPermissionKey`, `isGrantablePermissionKey`, `isEntityType`, `isSubjectType`, `getPermissionCatalog` — no DB access |
| `../client/authz/service.ts`   | `isPlatformAdmin`, `isSuperAdmin`, `canManageOrganization`, `canOwnOrganization`, `canManageTeam`, `canOwnTeam`, `canInviteToOrganization`, `canInviteToTeam`, `assertNotLastOrgOwner` — higher-level org/team management checks built on `can()`                   |
| `../client/authz/evaluator.ts` | `getSubjects`, `can`, `assertCan`, `listVisible`, `ForbiddenError` — org-level grant checks via domain-FK ancestry; superadmin and admin bypass in SQL                                                                                                              |
| `../client/authz/http.ts`      | `assertCanOr403` / `assertOrgOwnerOr403` Hono helpers; `assertNotSystemOwnedOr403` secondary guard (`403` `system_resource_immutable`) via `resolveWorkspaceKindForEntity`                                                                                          |

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
(`../client/authz/http.ts`) which checks `organization:own`. Broad "owner or
manager" resource read/create/update/delete routes use `assertCanManageOr403` /
`assertCanReadOr403` / `assertCanCreateOr403` (`../client/shared.ts`), which
check `organization:manage`. Never use `organization:own` as a broad org-access
check — it is exact owner-only.

**Install (Deno):** `completeInstanceInstall` inserts the **TurboPanel**
workspace (`kind='turbopanel'`) first, then exactly one `organization:own` grant
on the org, one `team:own` grant on the default team, and a **Default
Workspace** (`kind='user'`) for the superadmin user. Workers sign-up
(`createOrganizationForUser`) still creates only the Default Workspace when
provisioning an org — the TurboPanel workspace is ensured lazily on first server
enroll for those orgs. Self-hosted install names the org **Root Organization**.
Sign-up that provisions a first org (`createOrganizationForUser` /
`createOrganizationForUserInTx` — password sign-up and OAuth/social on every
deployment that creates one) defaults via
`resolveDefaultSignupOrganizationName` to **`you@example.com's organization`**
from the account email, or **My Organization** when the email is missing, blank,
or the composed label fails display-name validation. `POST /organizations`
defaults to **New Organization**.

**Completed:** Resource ancestry is computed directly from real domain tables
(`organization → workspace → project → environment → service/hosting`,
`organization → server`); the generic `resource` shadow table has been dropped.
The `permission` table is allow-only — every persisted row is a positive capability
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

## Database (Drizzle + Postgres.js)

The instance uses **Drizzle ORM** over **postgres.js**. The Workers/Hyperdrive
client uses `prepare: true` and `fetch_types: false`, and the cached client also sends drizzle's
`unsafe()` calls as named prepared statements (see `src/platform/workers/AGENTS.md`); the Deno client uses
`prepare: false` (direct Postgres, no Hyperdrive). Connection factories live in
`src/db/connection.ts`; schema in `src/db/schema.ts`; drizzle-kit config in
`drizzle.config.mjs`. **Read `src/db/AGENTS.md` before touching schema or the
database.** Schema changes are versioned in `migrations/`; `pnpm migrate`
applies pending SQL during Workers deploy (after a preflight that requires
PostgreSQL 18+ / built-in `uuidv7()` — `scripts/check-postgres-compat.mjs`).
Applied versions are recorded in `public.migration`.

**Multi-node model:** "multi-node PostgreSQL" means primary/standby replication
with exactly one writable primary (streaming replication for HA/failover;
logical replication for read replicas/DR). UUIDv7 primary keys remove sequence
coordination across writers and failovers — they are **not** distributed-SQL
readiness, and sharded/distributed SQL (Citus, CockroachDB, YugabyteDB, …) is
out of scope for this schema. See `src/db/AGENTS.md` (Multi-node PostgreSQL
model) before changing key strategy or targeting a distributed engine.

| Runtime            | Factory                                                                      | When connected                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers | `createWorkersDb(env.HYPERDRIVE)` or `createWorkersDb({ connectionString })` | `HYPERDRIVE` binding in `wrangler.jsonc` (all named envs including `testing`); **`wrangler dev`** may fall back to `TURBOPANEL_DATABASE_URL` when Hyperdrive is absent |
| Deno (self-hosted) | `createDenoDb()`                                                             | `TURBOPANEL_DATABASE_URL` set by `instance-launch`                                                                                                                     |

Route handlers read the per-request client via `getDb(c)` (set by
`createApp({ db })`). **Deno boot requires `TURBOPANEL_DATABASE_URL`:**
`createDenoDb()` throws before `createApp()` when the variable is missing or
blank, so the process exits instead of serving without a database.

| Variable                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURBOPANEL_DATABASE_URL` | Full postgres connection URL. **Deno mode:** required at boot — `createDenoDb()` throws immediately when missing or blank (self-hosted instance will not start). Passed directly to postgres.js (supports Unix socket URLs via libpq `?host=` / directory form, e.g. host `/var/run/turbopanel/postgres` or `/run/turbopanel/postgres`). **Workers runtime:** prefers the `HYPERDRIVE` binding; `src/workers.ts` falls back to this env var when Hyperdrive is unset (local `wrangler dev` without a binding). When the URL uses `?host=` for a Unix socket, ensure Deno has read access to that directory (`/run/turbopanel` covers the default Docker bind-mount path). |
| `DATABASE_URL`            | **Tooling only** (drizzle-kit, `pnpm migrate`, `dev/scripts/introspect.sh` / `dev/scripts/sync.sh` overrides). Accepted as a fallback when `TURBOPANEL_DATABASE_URL` is unset — common in CI and Cloudflare dashboard deploy workflows. Not read by the Deno instance or Workers runtime at request time.                                                                                                                                                                                                                                                                                                                                                                 |


### Tooling

- `pnpm install` — pulls `drizzle-orm`, `postgres`, `drizzle-kit`
- After editing `schema.ts`, run `pnpm drizzle-kit generate` to create SQL in
  `migrations/`; apply locally with `TURBOPANEL_DATABASE_URL=… pnpm migrate` or
  `DATABASE_URL=… pnpm migrate`. Workers deploy runs `pnpm migrate`
  automatically (Node only — no Deno). Deno dev can still use
  `dev/scripts/sync.sh` (`push`) — see `src/db/AGENTS.md`.
