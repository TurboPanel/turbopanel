# Permission grid: catalogue, read side, and the write path to come

Status: the catalogue and the read side are built (Master Sheet row
`road-db-login-recipes`, first slice). Nothing here writes to a customer
database. The write path below is the design the next slices follow.

Owner decision 2026-10-15: the v1 permission editor is a full per-engine grid,
versioned ("only the version we are supporting's current list is supported and
shown"). Developers get full flexibility. Recipes (App, Migrations, Read only,
Analyst, Database admin) are presets that fill the grid. New logins default to
a recipe; "Manage permissions myself" stays available.

## What is built

| Piece                               | Where                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Catalogue data and lookup           | `catalogue.ts`, `postgres.ts`, `mysql-family.ts`, `types.ts`, `series.ts`   |
| Engine ground truth for tests       | `fixtures/<engine>-<series>.json`, `scripts/capture-privilege-fixtures.mjs` |
| `GET …/managed/privilege-catalogue` | `src/client/managed/privilege-routes.ts`                                    |

| Raw report shape and parser | `observed.ts` (twin of the daemon's `ManagedPermissionsObserved`) |
| Join of report and catalogue | `effective.ts` |
| `GET …/users/:principalId/effective-permissions` | `privilege-routes.ts`, `src/client/managed/permissions-probe.ts` |
| Daemon read | `turbopaneld/src/managed/permissions-read.ts` (cell message, feature `managed-permissions-read-v1`) |

### Where the catalogue lives, and why

In the control plane (`src/features/managed/`, pure TypeScript, importable from
the Workers and Deno graphs), not in the daemon.

- The catalogue serves screens and the API: labels, plain-words explanations,
  "may a site owner's login hold this". Only the control plane needs them.
- The read side does not need it on the host. The daemon reports what the
  engine says, in the engine's own words; the control plane classifies. A daemon
  one release behind therefore never disagrees with the catalogue about a label.
- Writes will need a small host-side allowlist (privilege keywords that may be
  placed in a `GRANT`, and the names that must never be granted). That list is
  security-relevant, so it becomes a drift-checked twin when the write slice
  lands, like the release lists mirrored in `releases.ts`. It is deliberately
  not shipped before something uses it.

### Which versions are catalogued

Exactly the series the panel creates, plus the catalogued Postgres majors:
Postgres 15, 16, 17, 18; MySQL 8.4 and 9.7; MariaDB 11.8 and 12.3. A series
outside that list has no catalogue and the route answers 422
`privilege_catalogue_unsupported_version`, so nothing outside the supported list
is ever shown. `uncataloguedCreatableSeries()` and its test fail the build when
a series becomes creatable without a catalogue.

## Catalogue model

One entry per (level, privilege): `id` (`table:SELECT`), `level`, `keyword`
(the word in `GRANT`), `aliases`, plain-words `label` and one-line
`explanation`, `since` / `removedIn` (engine series), `allowed`
(`yes` / `needs-admin` / `no`) with a `reason`, `aclLetter` (Postgres), and
`grid` (false for markers such as `USAGE` meaning "nothing").

- Levels: `global` (MySQL, MariaDB), `database`, `schema` (Postgres), `table`
  (tables, views, materialized views, foreign and partitioned tables), `column`,
  `sequence` (Postgres), `routine`, `type` (Postgres).
- Postgres extras: predefined roles (`since`, `grantable`, `allowed`), role
  attributes (`SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`,
  `BYPASSRLS` are never allowed), membership options (`INHERIT`, `SET`
  from 16; `ADMIN`), and the object kinds default privileges can name.
- `allowed`:
  - `yes`: safe inside the databases and objects the login is placed on.
  - `needs-admin`: reserved for a Database admin login (can pass access on or
    reaches across databases): `GRANT OPTION`, `ADMIN` on a membership,
    cluster-wide predefined roles such as `pg_read_all_data` and `pg_monitor`.
  - `no`: never held by a site owner's login. MySQL and MariaDB global
    privileges (`CREATE USER`, `SUPER`, `FILE`, `SET_ANY_DEFINER` / `SET USER`,
    `PROXY`, `RELOAD`, `SHUTDOWN`, `REPLICATION *`, every dynamic privilege),
    anything granted on `*.*`, anything on `mysql`, `sys`,
    `performance_schema`, `information_schema`; Postgres superuser-class
    attributes, `pg_read_server_files`, `pg_write_server_files`,
    `pg_execute_server_program`, `pg_create_subscription`, and the Postgres
    object kinds that reach the server itself or every database: settings
    (`SET`, `ALTER SYSTEM`), tablespaces, languages, foreign data wrappers and
    servers, large objects.
- Names starting `tp_` are reserved for the panel (roles and accounts), as are
  `pg_`, `mysql.`, `mariadb.` and the exact names in `blocked.reservedNames`
  (`postgres`, `root`, `mysql`, `superadmin`). The cluster's own root login name
  is added at write time. Role memberships and grants are checked against them.

Adding an engine version: capture its fixture, add the series to the engine's
series list, add or bound (`since` / `removedIn`) any entry that appeared or
went away, run the fixture tests (they list every difference).

## Validation against real engines

`scripts/capture-privilege-fixtures.mjs` starts one throwaway container per
series, probes it through `docker exec` (the password is random, lives only in the throwaway container's environment,
and never reaches argv, fixtures or output), and writes `fixtures/<engine>-<series>.json`. Unit tests compare the
catalogue with the fixtures, so CI needs no engines.

- Postgres: `acldefault` / `aclexplode` privilege types per object kind, the real
  ACL letters after a `GRANT ALL`, predefined roles, `pg_auth_members` columns,
  role attribute columns, accepted default-privilege object kinds, and whether
  `MAINTAIN`, `INHERIT`/`SET` membership options and `pg_get_acl` exist.
- MySQL and MariaDB: `SHOW PRIVILEGES`, the privileges `root` actually holds,
  grant-table columns and `SET()` member lists, and whether each candidate
  keyword is accepted at each level.

The MySQL 8.4 manual page's per-privilege "added in" versions were unreliable
(see the research notes); only privilege names from the page are trusted and the
fixtures decide what exists.

## Grid data model (write path, next slices)

A login's desired grants are a list of entries:

```
{ level, object, privileges: [keyword], columns?: [name], grantable?: [keyword] }
```

- `object` names the target as the engine does: Postgres
  `{database, schema?, name?}`; MySQL and MariaDB `{database, name?}`.
- Postgres also carries `defaults: [{database, creator, schema?, objectType,
privileges}]` (an `ALTER DEFAULT PRIVILEGES FOR ROLE creator`) and
  `memberships: [{role, inherit?, set?, admin?}]`.
- Validation: every privilege must be in the catalogue for the cluster's series
  with `allowed: yes`; the object must not be in `blocked`; column lists only at
  `column` level; no `GRANT OPTION` for a site owner's login.
- A recipe is a function `(recipe, databases, options) -> grid entries`. The
  editor shows the expansion, and editing any cell turns the login into
  "custom" without losing the recipe it started from.

### Recipes expand to grid entries

| Recipe         | Postgres (owner role per database)                                             | MySQL and MariaDB (direct grants on every host row)                                                                    |
| -------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| App            | member of the database's read-write group role                                 | SELECT, INSERT, UPDATE, DELETE, EXECUTE, CREATE TEMPORARY TABLES, LOCK TABLES, SHOW VIEW                               |
| Migrations     | member of the owner role, `INHERIT FALSE, SET TRUE`; migrations run `SET ROLE` | ALL on its database, no GRANT OPTION (App plus CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE VIEW, TRIGGER, CREATE ROUTINE, ALTER ROUTINE, EVENT) |
| Read only      | member of the read-only group; `default_transaction_read_only = on`            | SELECT, SHOW VIEW                                                                                                      |
| Analyst        | Read only limited to chosen schemas (`USAGE` + `IN SCHEMA` defaults)           | Read only on chosen tables                                                                                             |
| Database admin | member of every owner role (with SET), no superuser                            | ALL on the environment's databases WITH GRANT OPTION, never CREATE USER                                                |

On MySQL and MariaDB the App job is data only: it can never create, alter or
drop a table, index, view, routine, trigger or event, and its temporary tables
last only for the session. Read only has no EXECUTE: a stored routine runs with
its definer's rights and could change data, so a read-only login cannot call
one. Objects the Migrations login makes need no extra grant, because MySQL and
MariaDB grants are database-wide. Only Database admin holds GRANT OPTION. The
daemon (`managed-data-only-readwrite-v1`) grants a level and then revokes the
rest of the database-level privileges the row holds, so logins made under the
older wide App recipe are tightened at their next apply; the control plane
refuses a new panel-managed App login on an older daemon.

## Panel ledger

The panel must only ever take back what it gave. Postgres cannot tell panel
grants from developer grants (a grant made by a superuser or an owner-role
member is recorded as made by the owner), so the panel records its own:

- Stored in `login.metadata.grantLedger`: the exact list of grid entries it
  issued, per engine account (and per host row on MySQL and MariaDB), with the
  time and the recipe or edit that caused it.
- Reconcile adds what is wanted, revokes only ledger entries that are no longer
  wanted, and leaves everything else as foreign state.
- Not built yet. Until it exists the effective-permissions route reports every
  item as `observed` and returns `ledger: { available: false }`; no item is
  marked "set by the panel" or "set outside the panel", and nothing is revoked
  because of that view. TODO(ledger): when it lands, add `origin: 'panel' |
'outside'` by diffing observed grants against the ledger.

## Write path

1. Control plane computes desired grid entries from the login's mode (recipe,
   custom, or "manage myself" where it writes nothing) and validates them
   against the catalogue and the blocked list.
2. A SQL preview is generated by the same code that the daemon will run (shared
   statement builders, one place), shown before saving, and stored with the
   change.
3. The daemon applies a diff: grant what is wanted and missing, revoke only
   ledger entries no longer wanted, never touch a grant that is not in the
   ledger. It refuses to write when `pg_is_in_recovery()` or the engine is read
   only (primary only).
4. The daemon reads back what it applied (the same read as the effective
   permissions route) and returns it with the result; the control plane then
   updates the ledger. A failed or partly applied change leaves the old ledger
   untouched and shows the difference as drift.

Rules that carry over from the Granular logins report: Postgres objects are
owned by the database's owner role, never by a login; MySQL and MariaDB grants
are identical across all of a login's host rows and hosts that went away are
pruned; deleting a MySQL login checks definers first; no database is wiped and
every change is forward only.

## Drift display

Drift is the difference between desired entries (or the ledger) and what the
engine reports. The effective-permissions view already lists every observed
grant with its catalogue label and `allowed`; the drift view adds two columns
once the ledger exists: "missing" (wanted but not observed) and "set outside the
panel" (observed but not in the ledger), the latter kept, never reverted.
`outsidePolicyCount` is the first drift signal available today: privileges,
memberships and attributes a site owner's login must not hold.

## Engine upgrades

Adding a version means: add the series to the release list, capture a fixture,
add the series and any new or removed entries to the catalogue data, and run the
tests. The panel never offers a series without a catalogue
(`uncataloguedCreatableSeries()` is empty is asserted). Stored ledger entries
name privileges by keyword, so a privilege removed in a later series shows up as
"no longer exists in this version" instead of being silently dropped.

## High availability

Reads and writes go to the cluster's primary (`managed.server_id`). A standby
receives roles and grants through replication (Postgres WAL, MySQL and MariaDB
binlog); the panel never writes to one. The write path refuses while the target
is in recovery or read only, and a failover keeps grants because they live in
the replicated data.

## Read side contract

Cell round trip, not a queued command: a screen waits on it and the answer is
not worth storing. `managed-permissions-request` carries the applied usernames
and the Postgres databases to read; `managed-permissions-result` carries the
bounded report (50 logins, 2000 grants each, 128 KB). Advertised by feature
`managed-permissions-read-v1`; a daemon without it gets 409
`daemon_update_required`. New fields are optional on both sides.

## Owner answers (2026-10-16)

1. Postgres PUBLIC grants are shown as read-only rows labelled "everyone"
   (`viaLabel: 'everyone'` on the grant).
2. A Database admin login cannot hand out cluster-wide predefined roles
   (`pg_read_all_data`, `pg_monitor`, …) in v1; they stay `needs-admin` and
   nothing offers them.
3. The default-privilege creator ("who will create the table") is hidden behind
   recipes and shown only on the advanced grid.
4. MySQL and MariaDB wildcard databases (`shop\_%`) are shown, but the grid only
   edits exact names; hand-made wildcard grants are left alone.
5. "Custom" is not a mode. Editing any cell means "I manage permissions myself"
   (with the takeover confirmation used today).
6. MySQL and MariaDB role grants show role names only; a role's own grants are
   not expanded (`effective.ts` drops grants that arrive `via` a role on those
   engines and keeps the membership row).
