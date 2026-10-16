# Privilege catalogue fixtures

One JSON file per engine series (`postgres-15.json` ... `mariadb-12.3.json`),
captured from a real throwaway engine container. Unit tests compare the
privilege catalogue with these files so CI needs no engines. When the catalogue
and a fixture disagree, the fixture is right.

## Re-capturing

Add the series to `SERIES` in `scripts/capture-privilege-fixtures.mjs` (or pass
`--engine X --series N`), then run it. It starts one `--rm` container with no
network and no published port, probes it through `docker exec`, writes the
fixture and removes the container, also on error or Ctrl-C.

    node scripts/capture-privilege-fixtures.mjs --engine postgres --series 17
    node scripts/capture-privilege-fixtures.mjs --all   # sequential, never parallel

Remote Docker host: `--ssh user@host --ssh-opt ...` (repeat `--ssh-opt` per ssh
argument), optional `--lock-file` (flock on that host) and `--cleanup-images`
(remove images the run pulled). Running twice gives byte-identical files.

## Rules

Fixtures never contain secrets, hostnames, ports, timestamps or raw `SHOW GRANTS`
text. The random container password goes in through `--env-file /dev/stdin` and
is used only inside the container. The only version-like fields are
`serverVersion` and `image`.

## Keys

Common: `engine`, `series`, `image`, `serverVersion`.

Postgres

- `serverVersionNum`: `server_version_num`.
- `aclPrivilegeTypes`: per object kind letter (r table, s sequence, d database,
  n schema, f function, T type, l language, F foreign data wrapper, S foreign
  server, L large object, t tablespace, p parameter, c column) the sorted
  privilege types of `aclexplode(acldefault(kind, 10))`; `null` when the engine
  rejects the kind.
- `aclLetters`: the ACL letter string stored after a real `GRANT ALL` to a scratch
  role on a scratch object; `null` when the grant is not possible.
- `columnGrants`: `accepted` (keyword to boolean for `GRANT kw (col)`), `letters`
  (attacl letters after granting the accepted ones), `refused` (sorted).
- `defaultAclAccepted`: `ALTER DEFAULT PRIVILEGES ... ON <target>` accepted?
  `defaultAclObjTypes`: resulting distinct `pg_default_acl.defaclobjtype` letters.
- `predefinedRoles`: roles named `pg_*`. `authMembersColumns`: `pg_auth_members`
  columns. `roleAttributeColumns`: boolean and integer columns of `pg_roles`.
- `functions`: `pg_get_acl`, `has_parameter_privilege` exist?
- `maintainGrantable`: `GRANT MAINTAIN ON TABLE` accepted.
  `membershipOptions`: `GRANT r1 TO r2 WITH INHERIT FALSE, SET TRUE` accepted.
  `grantableOnParameter`: `GRANT SET ON PARAMETER` accepted.

MySQL and MariaDB

- `showPrivileges`: rows of `SHOW PRIVILEGES` (Privilege, Context, Comment).
- `rootGrants`: privilege names parsed from `SHOW GRANTS FOR root@localhost`:
  `static`, `dynamic` (underscore names), `roles`, `otherLevels` (non-global
  statements such as PROXY). `ALL PRIVILEGES` is kept as the engine prints it.
- `globalGrantsDistinct`: distinct `mysql.global_grants.PRIV` (MySQL; `null` on MariaDB).
- `grantTableColumns`: sorted column names of the `mysql.*` grant tables that exist.
- `globalPrivRootKeys`, `globalPrivRootAccess` (MariaDB): keys of the root `Priv`
  JSON and its `access` bit mask.
- `enumValues`: SET() members of `tables_priv.Table_priv`,
  `columns_priv.Column_priv`, `procs_priv.Proc_priv`.
- `informationSchemaPrivilegeTypes`: distinct types for root in `USER_PRIVILEGES`
  and `SCHEMA_PRIVILEGES`.
- `grantStatementProbe`: keyword to level (`global`, `schema`, `table`, `column`,
  `procedure`) to whether the server accepts `GRANT kw ON <level>`.
- `allGrants`: privilege names `GRANT ALL` expands to at each level (global,
  schema, table, procedure) for a scratch account.
