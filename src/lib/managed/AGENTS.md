# Managed engines (`src/lib/managed/`)

Pure-TypeScript registry for environment-scoped managed database/cache engines
(Postgres, MySQL, MariaDB). Importable from both the Workers and Deno graphs —
no Deno/Node globals, `.ts` relative imports only.

## Spec contract

Each engine implements `ManagedEngineSpec` (`types.ts`): identity defaults
(`defaultImage`, `defaultPort`, `rootUsername`, `principalProvider`),
`parseSettings`, `buildRuntimeSpec`, `buildConnectionInfo`, and declarative
`userOperations` (no SQL text — the daemon owns statement construction).

**Optional `binding` descriptor** (`ManagedBindingDescriptor` on
`ManagedEngineSpec`): the conventional unprefixed env keys plus a DSN scheme and
`buildBindingDsn` (plaintext password + forced TLS verify). Engines that
participate in service bindings set this field; others leave it absent.

| Engine              | Unprefixed keys                                                          | Scheme / verify                      |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `postgres`          | `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` `PGSSLMODE`         | `postgresql` / `sslmode=verify-full` |
| `mysql` / `mariadb` | `MYSQL_HOST` `MYSQL_PORT` `MYSQL_DATABASE` `MYSQL_USER` `MYSQL_PASSWORD` | `mysql` / `ssl-mode=VERIFY_IDENTITY` |

Prefixed keys (`<PREFIX>_URL`, `_CA_CERT`, `_READ_SPLIT`, `_HOST`, `_PORT`,
`_NAME`, `_USER`, `_PASSWORD`) are computed in `src/lib/naming.ts`
(`bindingPrefixedKeys`). **`<PREFIX>_CA_CERT` is PEM text** — the consuming app
materializes it; do not emit `PGSSLROOTCERT` (no file path). A file-mount
variant is an explicit `Future:` seam.

**Extension rule:** a new engine = one spec file + one registry entry in
`MANAGED_ENGINE_SPECS` + one status entry in `MANAGED_ENGINE_STATUS` (+ optional
`binding` descriptor when the engine supports service bindings). Nothing else.

| Engine   | Spec file                                        | Default image        | Port | Account max | Config path allowlist                |
| -------- | ------------------------------------------------ | -------------------- | ---- | ----------- | ------------------------------------ |
| Postgres | `postgres.ts`                                    | `postgres:18-alpine` | 5432 | 63          | `postgresql.conf`, `pg_hba.conf`     |
| MySQL    | `mysql.ts` (+ pure helpers in `mysql-family.ts`) | `mysql:9.7`          | 3306 | **32**      | `my.cnf`, `initdb/00-turbopanel.sql` |
| MariaDB  | `mariadb.ts` (own dialect — never a MySQL alias) | `mariadb:12.3`       | 3306 | **32**      | same as MySQL                        |

**Image allowlist:** `settings.ts` exports a curated, engine-keyed allowlist
(`POSTGRES_ALLOWED_IMAGES` / `MYSQL_ALLOWED_IMAGES` / `MARIADB_ALLOWED_IMAGES`,
via `getManagedAllowedImages` / `isManagedImageAllowed`) —
`parseManagedSettingsBase` enforces it whenever a caller passes the `engine`
argument, and every one of the three specs' `parseSettings` does. This is the
**only** place an unsupported/EOL major version can be rejected before it
reaches a compose file, so any surface that can ultimately produce a
`settings.image` value — the `managed.apply` command payload parser
(`parseManagedApplyPayload` in `../commands/schemas.ts`), the daemon mirror
(`turbopaneld/src/instance/commands/contracts.ts`), and the UI catalog
(`ui/src/lib/managed-services.ts` `ManagedServiceCatalogEntry.allowedImages`) —
must mirror the same list. Bump all four together when approving a new image; a
version bump landed in only one of them is a bug. Neither MySQL nor MariaDB
publish an official Alpine-based image (MySQL dropped its Alpine variant after
8.0; MariaDB has never shipped one), so both default to the Docker Official
Image's Debian-based tag, with the vendor-published Oracle Linux 9 (MySQL) / UBI
(MariaDB) variant offered as the documented, allowlisted alternative for
RPM-based hosts. PostgreSQL's official Alpine variant stays the default for its
smaller footprint.

MySQL/MariaDB use **socket-auth platform admin accounts** seeded by
`initdb/00-turbopanel.sql` (MySQL `auth_socket` / MariaDB built-in
`unix_socket`) — the analogue of Postgres `local … trust`, so daemon SQL and
`backup.ts` stay credential-free (no `-p` argv, no `MYSQL_PWD`).

**MySQL has no replication slots.** Binary log retention is the disk-fill hazard
that slots cover on Postgres: platform `my.cnf` always sets a bounded
`binlog_expire_logs_seconds` (7 days). Operator snippets cannot override that
key (see `RESERVED_CNF_KEYS` in `mysql-family.ts`).

Reserved env keys: `POSTGRES_RESERVED_ENV_KEYS`, `MYSQL_RESERVED_ENV_KEYS`, and
`MARIADB_RESERVED_ENV_KEYS` (MariaDB + legacy `MYSQL_*` names — the image still
honours both). Registered in `MANAGED_RESERVED_ENV_KEYS_BY_ENGINE` and
re-asserted at the daemon command-contract boundary.

## Runtime spec rules

1. **No plaintext secrets.** Credential slots in `ManagedRuntimeSpec.env` use
   the literal `ManagedSecretPlaceholder`
   (`${TURBOPANEL_MANAGED_ROOT_PASSWORD}`). The daemon substitutes from the
   decrypted `credentials[]` envelope. Plaintext passwords must never appear in
   a runtime spec.
2. **Native port, no remap; private listener is the only published port.**
   Compose fragments never publish host ports for single-member clusters.
   Multi-member clusters may include one deliberate `ports:` entry
   (`privateListener.address:private_port:enginePort`) for cross-host
   replication and remote ProxySQL backends. Client traffic still enters via
   shared ProxySQL (`5432` / `3306`) — never a per-service published map for
   public SQL clients and never per-managed Traefik.
3. **Named volumes only.** `volumes[]` are Docker named volumes — never host
   bind paths. Config/TLS dirs are relative mounts under managed state. Volume
   **names** must satisfy `SAFE_IDENTIFIER_RE` / `SAFE_VOLUME_NAME_RE`
   (`^[A-Za-z_]\w*`, ≤63 chars) — use underscores, not hyphens (e.g.
   `managed_<uuid_with_underscores>_data`).
4. **TLS is a request.** `tlsMaterial` asks the daemon to generate engine
   self-signed key material; the instance never ships private keys in the spec.
   Frontend TLS for clients uses the org `organization_ca` leaf shipped as
   `orgTlsMaterial` and written under managed `tls/proxysql/` plus the shared
   ProxySQL `configDir/proxysql/tls/` tree.
5. **Docker option denylist.** `MANAGED_DOCKER_OPTION_DENYLIST` rejects
   `privileged`, `network_mode`, `volumes`, `ports`, `cap_add`, etc. Denied or
   unknown keys make `parseSettings` return `null` (API → 400).

## Settings

Shared shape in `settings.ts` (`ManagedSettings`): `image`, `ssl`, `resources`
(reuses `ServiceOptions['resources']` + `clampManagedResources`),
`dockerOptions` (strict allowlist), `engineConfig` (16 KiB cap), `exposure`
(`HostingBindScope` from `hosting-options.ts`), `backups` (`retentionKeep`,
`parseBackupSettings`). Parser semantics: absent → defaults; malformed/denied →
`null`. **`ssl.enabled` defaults to `true`** (`DEFAULT_MANAGED_SETTINGS`).
Exposure controls which interface ProxySQL publishes on for that cluster's
member servers (`public` / `datacenter` / `local` → bind address on
`managed.ingress.reconcile`), **not** per-service published ports. Managed apply
ensures/issues org-library `organization_ca` leaves into
`payload.orgTlsMaterial` for ProxySQL materialization on the daemon
(`tls/proxysql/`); engine self-signed material still uses `tlsMaterial` /
`ensureManagedSelfSignedCert`.

## Exposure / connection shape

| Surface                    | Shape                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client connection endpoint | Shared ProxySQL host:port — **pgsql `5432`** and **mysql `3306`** on the **placement server** (member or bound consumer), TLS to the **server-owner org CA**, default `sslmode=verify-full` for Postgres                                                                                                                                            |
| Routing                    | ProxySQL hostgroups + query rules map username → primary/replica backends over the local Docker network, a fabric relay address over `tp0`, or a datacenter private address                                                                                                                                                                         |
| Engine containers          | Reachable only on the managed network (container DNS / IP from apply peers); no host `ports:`                                                                                                                                                                                                                                                       |
| Desired-state command      | Whole-server `managed.ingress.reconcile` builds `clusters[]` + **resealed frontend user passwords** for every managed cluster needed on that server (local members **and** clusters bound by compose services placed on the server). Binding lookup is scoped to the target org + server; cluster members/users/endpoints are batched per reconcile |
| Org CA scoping             | CA and frontend leaf for ProxySQL come from **`server.organization_id`**, with SANs for advertised listener host/IP — not only synthetic names                                                                                                                                                                                                      |
| Username uniqueness        | Logins unique across every cluster on servers owned by the same organization (see Login namespace)                                                                                                                                                                                                                                                  |

Connection info helpers surface the ProxySQL frontend port/host when exposure is
enabled; they never invent remapped engine ports.

## Backup descriptor

`ManagedEngineSpec.backup` (`types.ts`) is an **optional** capability — engines
without it are simply unsupported for backup/restore (the API and daemon both
check for its presence rather than special-casing engine codes). It carries
`artifactExtension` (from the `MANAGED_BACKUP_ARTIFACT_EXTENSIONS` allowlist —
`dump` \| `sql`), `supportsDatabaseScope` / `supportsInstanceScope`,
`defaultRetentionKeep` / `maxRetentionKeep`, and an
`executor: { kind: 'docker-exec', dumpClient, restoreClient }`.

**Same rule as `userOperations`: no argv or SQL text here.** The descriptor only
names the client binaries (`pg_dump` / `pg_restore` for Postgres) — the daemon's
`ManagedEngineRuntime.backup` (mirrored in `turbopaneld/src/managed/engines/`) owns
actual argv construction. This keeps the instance spec import-safe on both
Workers and Deno and keeps command construction in one place (the daemon, which
also validates identifiers before they reach argv).

Postgres backs up via `pg_dump -Fc` (custom format), per-database only —
`supportsInstanceScope: false` documents `pg_dumpall` as an explicit future
seam. **Scheduled backups are also an explicit future seam** — this pass adds
on-demand create/delete/restore only; no timers, no cron, no retention sweep
outside of the retention-keep pruning that runs on every successful backup.

## Container naming

One engine `service` row per managed cluster; each **member** owns one
`role='service'` container at `ordinal = member.ordinal`, named
`managedContainerName(serviceId, ordinal)` → `<service.id>-1`|`-2`|`-3`. There
is **no** per-managed Traefik / `-in` ingress container row on the engine
service. Shared ProxySQL is the **`managed-ingress`** system component (project
`turbopanel-proxysql`, compose service `proxysql`) and lives in the system
inventory path when provisioned — not as an ordinal on the engine service. Apply
writes `service.options.instances` to the member count so reconcile keeps
pending ordinal-2/3 rows.

`prepareManagedApplyPayloads` (`src/client/managed/apply-prepare.ts`) allocates
one container per member via `ensureManagedContainerAllocation`, stamps
per-member `containerName` / `memberId` / `peers` / resealed credentials and
`orgTlsMaterial` onto each `managed.apply` payload, and prunes pending service
rows outside the current member ordinal set plus any **legacy** null-id ingress
rows from the retired Traefik path. Desired ProxySQL state is assembled
separately (`ingress-desired.ts` / enqueue of `managed.ingress.reconcile`). Binding
consumers for a server reconcile are selected in SQL by env pin, task pin, or
unpinned env whose project default is that server — never every unpinned binding
in the organization. When a binding consumer is not co-resident, ProxySQL also
joins that environment's spanning `tpn_*` segments (pinned to the reserved
last-usable host) so remote consumers resolve it by name. Coverage:
`src/client/managed/apply-prepare.test.ts` and
`allocate-managed-container.test.ts`.

## Cluster members

`node` is the authoritative fan-out set. `managed.server_id` remains the
**primary** pin. Roles: exactly one `primary` (partial unique), up to **2
replicas** (API-enforced `MANAGED_MAX_REPLICAS`, ordinals 2–3).
`replication_transport` records the private path (`local` | `fabric` |
`datacenter`) resolved via `resolvePrivateEndpoint` toward the primary (`local`
co-resident container name → `fabric` relay address over `tp0` → `datacenter`
private address). `private_port` is an instance-allocated high port (range in
`members.ts`) unique per `(server_id, private_port)` for multi-member clusters —
the host-side half of the private listener; cleared when the cluster falls back
to one member. Create/apply call `ensureManagedPrimaryMember` so pre-member rows
self-heal without a data migration. Multi-member apply also ensures a platform
`managedReplication` principal (not listed as a client user), builds
**per-member** `postgresql.conf` + `pg_hba.conf` (platform-owned HBA), and ships
an org-CA engine leaf for `sslmode=verify-full` on both the ProxySQL backend leg
and `primary_conninfo`. Member CRUD: `GET/POST …/managed/members`,
`PATCH/DELETE …/members/:memberId`, `POST …/members/:memberId/promote` (lag-
gated; `{ force: true }` bypasses for dead-primary failover).

## Login namespace

Managed usernames (including root) are unique across every cluster landing on
servers owned by the same organization (`server.organization_id` — not the
creating org). Root is resolved at create via
`resolveAvailableManagedRootUsername` and persisted on
`managed.metadata.rootUsername` (spec `rootUsername` is only the default
preference). User create uses the same org-wide probe under `FOR UPDATE` locks
**inside the same transaction as principal insert** (`username_in_use` vs
same-cluster `managed_user_exists`). Adding a replica rechecks every existing
managed principal against the prospective server owner's namespace before
insert; placement uses `organization:manage` on the target server (not ownership
equality with the environment org) so grant-backed hosts are allowed. The daemon
mirrors this as a frontend-user conflict guard on `managed.ingress.reconcile`
(`ManagedFrontendUserConflictError`).
