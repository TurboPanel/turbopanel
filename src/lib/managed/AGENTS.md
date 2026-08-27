# Managed engines (`src/lib/managed/`)

Pure-TypeScript registry for environment-scoped managed database/cache engines
(Postgres, MySQL, MariaDB). Importable from both the Workers and Deno graphs —
no Deno/Node globals, `.ts` relative imports only.

Canonical CA taxonomy (**Platform CA** vs **Organization CA**):
`../tls/AGENTS.md`.

## Spec contract

Each engine implements `ManagedEngineSpec` (`types.ts`): identity defaults
(`defaultImage`, `defaultPort`, `rootUsername`, `principalProvider`),
`parseSettings`, `buildRuntimeSpec`, `buildConnectionInfo`, and declarative
`userOperations` (no SQL text — the daemon owns statement construction).

**Optional `binding` descriptor** (`ManagedBindingDescriptor` on
`ManagedEngineSpec`): the conventional unprefixed env keys plus a DSN scheme and
`buildBindingDsn` (plaintext password + the cluster's effective TLS mode).
Engines that participate in service bindings set this field; others leave it
absent.

| Engine              | Unprefixed keys                                                          | Scheme / TLS parameter                       |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `postgres`          | `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` `PGSSLMODE`         | `postgresql` / `sslmode=<mode>`              |
| `mysql` / `mariadb` | `MYSQL_HOST` `MYSQL_PORT` `MYSQL_DATABASE` `MYSQL_USER` `MYSQL_PASSWORD` | `mysql` / `ssl-mode=<MYSQL_FAMILY_SPELLING>` |

`<mode>` is the **resolved** `ManagedSslMode` threaded in by the caller, not a
constant — see **Client TLS (SSL mode)** below. Do not hardcode `verify-full` in
a DSN renderer or binding materializer again.

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

## Release catalog (versions, not image strings)

**`releases.ts` is the single source of truth for supported engine versions.** A
managed service's user-facing version is an **engine series** (`18`, `9.7`,
`12.3`) plus a base-OS **variant** (`alpine` / `debian` / `oraclelinux9` /
`ubi`); the OCI reference is derived, never typed by an operator.
`settings.image` remains the persisted field — series/variant are recovered from
it with `describeManagedImage`, so there is no second copy to drift.

| Engine   | Default  | Also creatable    |
| -------- | -------- | ----------------- |
| Postgres | **18**   | 17, 16, 15        |
| MySQL    | **9.7**  | 8.4               |
| MariaDB  | **12.3** | 11.8, 11.4, 10.11 |

PostgreSQL stops at 15 (not upstream's oldest supported major, 14) to bound the
replication/promotion test matrix. MySQL 8.0 is **absent** — it reached EOL in
April 2026 and an EOL series must never be creatable. Neither MySQL nor MariaDB
publish an official Alpine image (MySQL dropped its Alpine variant after 8.0;
MariaDB has never shipped one), so both default to the Docker Official Image's
Debian tag with the vendor-published Oracle Linux 9 (MySQL) / UBI (MariaDB)
variant as the alternative for RPM-based hosts; PostgreSQL's Alpine variant
stays its default for footprint.

**Adding or retiring a series** means editing `MANAGED_ENGINE_RELEASES` here
plus the two mirrors, in the same change:

| Layer                           | File                                                                                  | Pinned by                      |
| ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| Control plane (source of truth) | `releases.ts`                                                                         | `releases.test.ts`             |
| Daemon payload allowlist        | `turbopaneld/src/instance/commands/contracts.ts` (`MANAGED_ALLOWED_IMAGES_BY_ENGINE`) | `command-types-parity.test.ts` |
| UI picker                       | `ui/src/lib/managed-releases.ts`                                                      | `managed-releases.test.ts`     |

Everything else derives: `settings.ts` allowlists (`POSTGRES_ALLOWED_IMAGES` /
`MYSQL_ALLOWED_IMAGES` / `MARIADB_ALLOWED_IMAGES`, via
`managedAllowedImagesForEngine`) and each spec's `defaultImage`
(`requireDefaultManagedImage`). Do not reintroduce hand-written image lists.

**Enforcement** stays where it was: `parseManagedSettingsBase` rejects a
non-allowlisted `settings.image` whenever the caller passes `engine`, as does
every spec's `parseSettings`, as does `parseManagedApplyPayload`
(`../commands/schemas.ts`) and the daemon mirror — the last stop before Docker.

**Create-time selection:** `POST …/managed` accepts `engineSeries` +
`imageVariant` (`parseManagedVersionSelection` in
`../../client/managed/routes-helpers.ts`), resolved to an image and merged into
settings; unknown series/variant is **422** `managed_version_unsupported`.
Omitting both takes the engine default.

**Series are immutable after create.** `PATCH …/managed` refuses a settings
change that moves the cluster to a different series (**422**
`managed_series_immutable`, via `assertManagedSeriesUnchanged`) — an engine will
not start on another major's data directory, and cross-major replication is not
a supported topology. Variant swaps within a series are allowed. Every member of
a topology therefore shares one series by construction. A cross-major move is a
migration between two managed databases, not an in-place image change; that
migration flow is a `Future:` seam.

`GET …/managed` returns a `release` view (`series` / `variantId` / `lifecycle` /
`image`, via `buildManagedReleaseView`) so the UI can show a version without
parsing tags.

MySQL/MariaDB use **socket-auth platform admin accounts** seeded by
`initdb/00-turbopanel.sql` (MySQL `auth_socket` / MariaDB built-in
`unix_socket`) — the analogue of Postgres `local … trust`, so daemon SQL and
`backup.ts` stay credential-free (no `-p` argv, no `MYSQL_PWD`). Platform
`my.cnf` sets `authentication_policy=*,,` so that initdb can install
`auth_socket`; pinning factor 1 to `caching_sha2_password` made
`IDENTIFIED WITH auth_socket` fail and left `root@localhost` on
`MYSQL_ROOT_PASSWORD`. Official MariaDB images still set
`root@localhost` to a password plugin (`mysql_native_password`); initdb
must `ALTER USER … IDENTIFIED VIA unix_socket` (CREATE IF NOT EXISTS is a
no-op when the account already exists), and apply retries socket 1045 via a
defaults-extra-file then restores `unix_socket`.

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
   replication and remote ProxySQL backends. The address comes from the `fabric`
   → `datacenter` → `public` ladder and is tagged on
   `privateListener.transport`; a `public` bind is only ever emitted with org-CA
   TLS material (the daemon refuses it otherwise). Client traffic still enters
   via the shared ProxySQL client listeners (see Client listener ports) — never
   a per-service published map for public SQL clients and never per-managed
   Traefik.
3. **Named volumes only.** `volumes[]` are Docker named volumes — never host
   bind paths. Config/TLS dirs are relative mounts under managed state. Volume
   **names** must satisfy `SAFE_IDENTIFIER_RE` / `SAFE_VOLUME_NAME_RE`
   (`^[A-Za-z_]\w*`, ≤63 chars) — use underscores, not hyphens (e.g.
   `managed_<uuid_with_underscores>_data`).
4. **TLS is a request.** `tlsMaterial` asks the daemon to generate engine
   self-signed key material; the instance never ships private keys in the spec.
   Frontend TLS for clients uses the org `organization_ca` leaf shipped as
   `orgTlsMaterial` (`caCertPem` is the active+retired trust bundle) and written under managed `tls/proxysql/` plus the shared
   ProxySQL `configDir/proxysql/tls/` tree.
5. **Docker option denylist.** `MANAGED_DOCKER_OPTION_DENYLIST` rejects
   `privileged`, `network_mode`, `volumes`, `ports`, `cap_add`, etc. Denied or
   unknown keys make `parseSettings` return `null` (API → 400).

## Settings

Shared shape in `settings.ts` (`ManagedSettings`): `image`, `ssl`, `routing`
(`ManagedRoutingSettings`), `resources` (reuses `ServiceOptions['resources']` +
`clampManagedResources`), `dockerOptions` (strict allowlist), `engineConfig` (16
KiB cap), `exposure` (`ManagedSqlAccessScope` from `access-scope.ts`: `local` |
`datacenter` | `turbofabric` | `public`), `backups` (`retentionKeep`,
`parseBackupSettings`). Parser semantics: absent → defaults; malformed/denied →
`null`. **`ssl.mode` is optional and unset by default** — an absent mode means
"inherit" (see **Client TLS (SSL mode)**), so `DEFAULT_MANAGED_SETTINGS.ssl` is
`{}`. Legacy stored `ssl.enabled` booleans still parse: `false` → `disable`,
`true` → `require`; explicit `mode` wins when both are present. Exposure
controls which interface ProxySQL publishes on for that cluster's member servers
(see `access-address.ts` / `ingress-desired.ts`), **not** per-service published
ports. One-release read of retired `exposure.bind` (`public` | `datacenter` |
`local`) migrates to the same-named `scope`; new writes must use `scope`.

## Client routing (connection role, not regex)

`ManagedConnectionRole` (`read-write` | `read-only`, canonical in
`../commands/schemas.ts`) is chosen per **managed login** at create time and
persisted on `principal.metadata.connectionRole`. It decides that login's
ProxySQL `default_hostgroup`, so a read-only credential reaches replicas without
rewriting any application's consistency semantics:

| Login `connectionRole`         | ProxySQL default hostgroup | Reaches                                            |
| ------------------------------ | -------------------------- | -------------------------------------------------- |
| `read-write` (default, absent) | writer                     | current primary only                               |
| `read-only`                    | reader                     | `readEligible` replicas (`OFFLINE_SOFT` otherwise) |

Creating a `read-only` login with **no** read-eligible member is rejected
(**422** `managed_no_read_targets`); disabling `readEligible` afterwards is
allowed and only removes that member from reader routing — it never changes
promotion candidacy (`replicaClass` owns that).

`settings.routing.autoReadSplit` (default **off**) is the only thing that emits
a blanket `^SELECT` query rule, and it applies to `read-write` logins only
(`read-only` logins already default to the reader hostgroup). Leave it off
unless an operator asks: a regex read-split silently breaks read-after-write and
locking reads. `readEligible` alone must never turn it on.

## Client TLS (SSL mode)

`ssl.ts` owns `ManagedSslMode` — `disable` | `allow` | `prefer` | `require` |
`verify-ca` | `verify-full`. It is a **client-facing** policy at the ProxySQL
boundary and never a switch for engine TLS: the backend leg is always encrypted
(ProxySQL server rows are `use_ssl=1`, Postgres publishes only `hostssl`,
MySQL/MariaDB set `require_secure_transport=ON`), so TLS material is issued
unconditionally. The mode decides exactly two things:

| Job                                      | Where it lands                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refuse a plaintext client session        | `requireTls` on the `managed.ingress.reconcile` cluster → ProxySQL `mysql_users` / `pgsql_users` `use_ssl` (`managedSslRequiresTls` — true for `require` / `verify-ca` / `verify-full` only) |
| What verification a driver is told to do | per-engine DSN rendering (`buildConnectionInfo` / `buildBindingDsn`), Postgres `sslmode=<mode>` and MySQL-family `ssl-mode=` via `mysqlFamilySslMode`                                        |

`verify-ca` / `verify-full` differ from `require` **only** in the connection
string — certificate verification is the client's decision and ProxySQL cannot
enforce it. They are usable because the **Organization CA** is downloadable from
the managed Connect surface; do not pretend the ingress validates them.

**Resolution is three-layer, never a stored effective value:**

```text
settings.ssl.mode (service override)
  ↓ absent
organization.options.managedDatabase.sslMode (org default)
  ↓ absent
DEFAULT_MANAGED_SSL_MODE = 'require'
```

`resolveManagedSslMode(configured, orgDefault)` is the only correct way to read
it. Persisting the resolved value would freeze a service against later
org-default changes, so `parseManagedSslMode` keeps `undefined` (inherit) and
`null` (reject) distinct — an unrecognized mode is a **400/422**, never a silent
downgrade to plaintext.

| Layer            | Module                                                                                           | Route                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Org default      | `org-defaults.ts` (`parseManagedOrganizationDefaults`, `parseManagedSslModeInput`)               | `GET`/`PUT /api/client/v1/organizations/:id/managed-defaults` (manage-gated; PUT `sslMode: null` clears) |
| Per-request load | `../../client/managed/org-defaults.ts` (`loadManagedOrgDefaults`) → `ManagedContext.orgDefaults` | every managed route                                                                                      |
| Effective view   | `buildManagedSslView` (`../../client/managed/routes-helpers.ts`)                                 | `GET …/managed` → `ssl: { configured, effective, organizationDefault }`                                  |

The detail `ssl` view is present even **before** provisioning
(`buildEmptyManagedDetailResponse` takes the org default) so the create surface
can show the policy a new cluster will inherit. Threading order for a new
consumer: resolve the mode at the route/serializer edge and pass it
**explicitly** into engine builders; do not have a builder re-read
`settings.ssl` and guess at the org layer it cannot see.

## Client listener ports

`ingress-ports.ts` owns the two shared-ProxySQL **client** listeners: `postgres`
(default `15432`) and `mysqlFamily` (default `13306`, MySQL **and** MariaDB).
Engine-native backend ports (`spec.defaultPort`, 5432 / 3306) and member private
listeners (`45000`–`45999`) are untouched by this setting.

They are configurable **per organization**, never per managed service: one
ProxySQL frontend fronts every managed cluster on a host, so a per-service port
would defeat the shared-ingress design. Two families cannot share one number —
ProxySQL runs MySQL and Postgres as separate protocol modules, and there is no
protocol sniffing.

**The listener belongs to the server owner, not the asking project.** Ports must
be resolved from `server.organization_id` (`loadManagedIngressPorts`), because
`managed.ingress.reconcile` is a whole-server command and a grant can place two
orgs' members on one host. Resolving from the consumer's org would emit a DSN
pointing at a port nothing listens on, and would make the bind flap. Both
`resolveBindingEndpoint` (via `listenerForServer`) and
`resolveManagedConnectionListener` therefore take `engineCode` +
`engineDefaultPort` and resolve the port internally — do not pass a pre-resolved
`protocolPort` in from a route that only knows the consumer's org.

**Protocol family is derived from the engine, never from the port**
(`managedIngressFamilyForEngine`). Once operators pick numbers, `15432` no
longer means "Postgres", so the wire payload carries `family` (`pgsql` |
`mysql`) explicitly alongside `protocolPort`.

| Rule                                                                      | Where                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Range `1024`–`65535` (privileged ports refused outright, not preflighted) | `rejectManagedIngressPort`                                                                        |
| Not ProxySQL admin `6032` / `6132`; not the `45000`–`45999` private range | `rejectManagedIngressPort`                                                                        |
| `postgres !== mysqlFamily`                                                | `validateManagedIngressPorts` (`collision`)                                                       |
| Existing **host** listener conflict                                       | daemon-side preflight before any compose write (see `../../../turbopaneld/src/managed/AGENTS.md`) |

Read paths are lenient and write paths are strict: `resolveManagedIngressPorts`
ignores malformed stored jsonb (and falls back wholesale on a stored collision,
rather than picking a winner) so a bad key cannot make an org's managed surface
unreadable, while `PUT …/managed-defaults` rejects it with the offending field
named. Store/serve `ports` (configured, `null` per family = inherit) and
`effectivePorts` separately — never persist the resolved pair.

## Exposure / connection shape

| Surface                    | Shape                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client connection endpoint | Shared ProxySQL host:port on the **placement server** (member or bound consumer) — port from the **server-owner** org's listener config, default pgsql `15432` / mysql `13306` (see Client listener ports above), TLS to the **server-owner Organization CA**, DSN TLS parameter from the effective `ManagedSslMode` (see Client TLS above)                  |
| Routing                    | ProxySQL hostgroups map each login's `connectionRole` → primary/replica backends over the local Docker network, a fabric relay address over `tp0`, or a datacenter private address (see Client routing above; `^SELECT` rules only under `routing.autoReadSplit`)                                                                                   |
| Engine containers          | Reachable only on the managed network (container DNS / IP from apply peers); no host `ports:`                                                                                                                                                                                                                                                       |
| Desired-state command      | Whole-server `managed.ingress.reconcile` builds `clusters[]` + **resealed frontend user passwords** for every managed cluster needed on that server (local members **and** clusters bound by compose services placed on the server). Binding lookup is scoped to the target org + server; cluster members/users/endpoints are batched per reconcile |
| Organization CA scoping    | Organization CA and frontend leaf for ProxySQL come from **`server.organization_id`**, with SANs for advertised listener host/IP — not only synthetic names                                                                                                                                                                                         |
| Username uniqueness        | Logins unique across every cluster on servers owned by the same organization (see Login namespace)                                                                                                                                                                                                                                                  |

Connection info helpers surface the ProxySQL frontend port/host when exposure is
enabled (`resolveManagedAccessEndpoints` on `GET …/managed` → `endpoints[]`);
they never invent remapped engine ports. Public clients always dial ProxySQL,
not native engine container ports.

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
`ManagedEngineRuntime.backup` (mirrored in `turbopaneld/src/managed/engines/`)
owns actual argv construction. This keeps the instance spec import-safe on both
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
`managedContainerName(serviceId, ordinal)` → `<service.id>-<ordinal>`. There is
**no** per-managed Traefik / `-in` ingress container row **on the engine
service** — `-in` is not retired platform-wide; it now names the shared ProxySQL
row on the `managed-ingress` system service. Shared ProxySQL is the
**`managed-ingress`** system component (project `turbopanel-proxysql`, compose
service `proxysql`, container `<serviceId>-in`, `role: 'ingress'`) and lives in
the system inventory path when provisioned — not as an ordinal on the engine
service. Suffix contract: repo-root `AGENTS.md` → **Container name suffix
contract**. Apply writes `service.options.instances` to the member count so
reconcile keeps pending ordinal-2/3 rows.

`prepareManagedApplyPayloads` (`src/client/managed/apply-prepare.ts`) allocates
one container per member via `ensureManagedContainerAllocation`, stamps
per-member `containerName` / `memberId` / `peers` / resealed credentials and
`orgTlsMaterial` onto each `managed.apply` payload, and prunes pending service
rows outside the current member ordinal set plus any **legacy** null-id ingress
rows from the retired Traefik path. Desired ProxySQL state is assembled
separately (`ingress-desired.ts` / enqueue of `managed.ingress.reconcile`).
Binding consumers for a server reconcile are selected in SQL by env pin, task
pin, or unpinned env whose project default is that server — never every unpinned
binding in the organization. When a binding consumer is not co-resident,
ProxySQL also joins that environment's spanning `tpn_*` segments (pinned to the
reserved last-usable host) so remote consumers resolve it by name. Coverage:
`src/client/managed/apply-prepare.test.ts` and
`allocate-managed-container.test.ts`.

## Cluster members

`replica` is the authoritative fan-out set (`replica.replica_class` reads awkwardly and is expected). `managed.server_id` remains the
**primary** pin. Roles: exactly one `primary` (partial unique) plus unbounded
replicas. Each replica has **`replica_class`** `failover` (same datacenter as
the primary, local/datacenter transport only, promotable) or `read` (any org
server; local/datacenter/fabric/public). Ordinals start at 2 with no ceiling.
`replication_transport` records the private path (`local` | `fabric` |
`datacenter` | `public`) resolved via `resolvePrivateEndpoint` toward the
primary (`failover-replication` vs `read-replication` purpose). `private_port`
is an instance-allocated high port (range in `members.ts`) unique per
`(server_id, private_port)` for multi-member clusters — the host-side half of
the private listener; cleared when the cluster falls back to one member.
Create/apply call `ensureManagedPrimaryMember` so pre-member rows self-heal
without a data migration. Multi-member apply also ensures a platform
`managedReplication` principal (not listed as a client user), builds
**per-member** `postgresql.conf` + `pg_hba.conf` (platform-owned HBA), and ships
an org-CA engine leaf for `sslmode=verify-full` on both the ProxySQL backend leg
and `primary_conninfo`. Leaf `notAfter` + signing `ca_generation` are persisted
on `leaf` only after `managed.apply` succeeds (mint writes `pendingTlsLeaf`
command metadata — see `src/lib/tls/AGENTS.md` → Leaf tracking + renewal sweep)
— not at payload generation. Member CRUD: `GET/POST …/managed/members`
(`replicaClass` default `failover`), `PATCH/DELETE …/members/:memberId`
(`readEligible` / `replicaClass` conversion), `POST …/members/:memberId/promote`
(lag-gated; **failover** class required — `{ force: true }` bypasses lag/health
only, never class). Read-class promotion is
`POST …/managed/disaster-recovery/promote` (`{ memberId, confirm: true }`).
Automatic failover of same-DC `failover` replicas is TurboPanel-gated after
fencing (journal table `recovery`). Candidate pick requires `replica` +
`failover` + same datacenter **and** the same lag/health gate as operator
promote (`evaluateManagedPromoteLagGate` — streaming, fresh observation, lag
under 64 MiB / 30s). Missing observations fail closed. Unreachable old primary
on auto-failover blocks with `managed_automatic_failover_blocked`
(`Automatic
failover blocked: unable to verify previous primary is fenced`).
Same-DC failover members that fail the lag gate are skipped; if none remain,
`Automatic failover blocked: no same-datacenter failover replica is healthy
enough to promote`.
`readEligible` never selects an automatic candidate. `Future:` fail-closed HA
lease (daemon stops advertising a former writer if it loses the Orchestrator
Raft lease).

## High availability

Physical table `recovery` (one word) journals `automatic-failover` /
`switchover` / `disaster-recovery`. In-flight uniqueness is one non-terminal row
per `managed_id`. Orchestrator HTTP stays on the daemon (`managed.ha.reconcile`
/ `managed.ha.failover`); instance `ManagedHaAuthority` is policy only
(`Recover: false` on Orchestrator). Designated recover on the daemon falls back
to `managed.promote` when Orchestrator is absent or the recover API fails.
Detection is an unsolicited `managed-ha-event` over the daemon WebSocket — not a
Durable Object poll loop. DR rewrite: members no longer in the new primary's
datacenter cannot stay `failover` → `read` (keep `readEligible`). Same-DC `read`
peers are never silently upgraded to `failover`.

### Manual live HA checklist

Unit tests encode topology/lag/fence policy. A later live run (not CI) should
still walk, on PostgreSQL, MySQL, and MariaDB:

1. Kill the primary container — same-DC failover promotes; remote `read` stays
   out; DSN unchanged. Repeat with `readEligible=false` on the candidate.
2. Network isolation of the old primary — fence proven **or** refuse with the
   unfenced blocked copy.
3. Primary site down, remote replica up — no auto-promote; DR action available.
4. Manual DR of the remote replica — one writer; leftover failover class
   rewritten to `read`.
5. Access scopes `local` / `datacenter` / `turbofabric` / `public`; org port
   override; SSL modes `disable` → `verify-full`.

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

## Delete / destroy

Placed clusters (`managed.server_id` set) always enqueue `managed.destroy` on
`DELETE …/managed` — including `stopped` / `failed` / `provisioning`. Lifecycle
stop is `compose stop`, not `down`, so containers still exist. Project and
environment delete return **409** `managed_runtime_present` while a `managed`
row remains (`environment_id` CASCADE must not drop live host runtime). Hard-delete
the Postgres row only when the cluster was never placed.

Daemon teardown: `turbopaneld/src/managed/AGENTS.md` (`destroy.ts`).
