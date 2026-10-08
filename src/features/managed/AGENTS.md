# Managed engines (`src/features/managed/`)

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

**Delivery by service kind** (`src/features/bindings/host-run.ts`,
`computeBindingVariableSet`'s `delivery`): a container service keeps the
container name and `_CA_CERT` (output byte-identical to before). A **PHP site**
and a **native Node app** run on the host as the site owner's Linux user, where
the container name does not resolve, so they get `_HOST=127.0.0.1` (the DSN too)
and the same listener port. A PHP site gets no `_CA_CERT` (a multi-line value
breaks its web server): a daemon that lists `site-db-bindings-v1` is sent the CA
as `sites[].dbCa` and sets `<PREFIX>_CA_FILE` to a file only the owner can read
(`deploy-site-db-bindings.ts`); an older daemon gets a deploy warning instead. A
native app keeps `_CA_CERT` as text (its private environment file carries
multi-line values). The kind is decided at deploy from the merged compose
document; any other re-materialize keeps the stored form (`inferStoredDelivery`).
A PHP site can use any engine on its default listener port (the daemon's
`tp-php-loopback` firewall names 13306 and 15432): a changed port is refused
with `binding_host_site_unsupported`. Loopback needs the ProxySQL frontend
published on `127.0.0.1`: `managed.ingress.reconcile` adds the `local` scope
whenever a host-run binding is placed on the server
(`serverHasHostRunBinding`), and a deploy re-reconciles those servers.

**Extension rule:** a new engine = one spec file + one registry entry in
`MANAGED_ENGINE_SPECS` + one status entry in `MANAGED_ENGINE_STATUS` (+ optional
`binding` descriptor when the engine supports service bindings). Nothing else.

| Engine   | Spec file                                        | Default image        | Port | Account max | Config path allowlist                |
| -------- | ------------------------------------------------ | -------------------- | ---- | ----------- | ------------------------------------ |
| Postgres | `postgres.ts`                                    | `postgres:18-alpine` | 5432 | 63          | `postgresql.conf`, `pg_hba.conf`     |
| MySQL    | `mysql.ts` (+ pure helpers in `mysql-family.ts`) | `mysql:9.7`          | 3306 | **32**      | `my.cnf`, `initdb/00-turbopanel.sql` |
| MariaDB  | `mariadb.ts` (own dialect — never a MySQL alias) | `mariadb:11.8`       | 3306 | **32**      | same as MySQL                        |

## Release catalog (versions, not image strings)

**`releases.ts` is the single source of truth for supported engine versions.** A
managed service's user-facing version is an **engine series** (`18`, `9.7`,
`12.3`) plus a base-OS **variant** (`alpine` / `debian` / `oraclelinux9` /
`ubi`); the OCI reference is derived, never typed by an operator.
`settings.image` remains the persisted field — series/variant are recovered from
it with `describeManagedImage`, so there is no second copy to drift.

**Catalogued is not creatable.** Each release carries `tested: boolean`, and
only a tested series can be created, saved into `settings.image`, or reach the
daemon. Untested entries stay in the catalog for one reason: `describeManagedImage`
must still be able to name an image an existing row already holds.

| Engine   | Creatable (tested) | Catalogued but untested |
| -------- | ------------------ | ----------------------- |
| Postgres | **18**             | 17, 16, 15              |
| MySQL    | **9.7**, **8.4**   |                         |
| MariaDB  | **11.8** (default), **12.3** (single server only) | 11.4, 10.11             |

Each creatable series offers both of its base-OS variants, so the derived
allowlists hold ten images in total. `managedCreatableReleasesForEngine` is the
single filter; `managedReleasesForEngine` still returns everything for naming.
The one way past it is an explicit `ManagedReleaseGate` (`{ includeUntested:
true }`) passed by a caller that knows better — today only the catalog's own
suites. There is deliberately **no** environment-variable form: an untested
series must not become creatable because of a stray env var on a production
control plane. Promoting a series means flipping `tested` here **and** in both
mirrors in the same change.

Each release also carries `failoverCapable`. It is `true` except MariaDB 12.3
(`false`): that series is still creatable as a single server. Replica add
uses `managedImageFailoverSupport` (an unknown image counts as supported).

PostgreSQL stops at 15 (not upstream's oldest supported major, 14) to bound the
replication/promotion test matrix. MySQL 8.0 is **absent** — it reached EOL in
April 2026 and an EOL series must never be creatable. Neither MySQL nor MariaDB
publish an official Alpine image (MySQL dropped its Alpine variant after 8.0;
MariaDB has never shipped one), so both default to the Docker Official Image's
Debian tag with the vendor-published Oracle Linux 9 (MySQL) / UBI (MariaDB)
variant as the alternative for RPM-based hosts; PostgreSQL's Alpine variant
stays its default for footprint.

**Adding, promoting, or retiring a series** means editing
`MANAGED_ENGINE_RELEASES` here plus the two mirrors, in the same change:

| Layer                           | File                                                                                   | Pinned by                      |
| ------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| Control plane (source of truth) | `releases.ts`                                                                          | `releases.test.ts`             |
| Daemon payload allowlist        | `turbopaneld/src/contracts/commands-contracts.ts` (`MANAGED_ALLOWED_IMAGES_BY_ENGINE`) | `command-types-parity.test.ts` |
| UI picker                       | `ui/src/lib/managed-releases.ts`                                                       | `managed-releases.test.ts`     |

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
settings; an unknown **or untested** series/variant is **422**
`managed_version_unsupported`. Omitting both takes the engine default (always a
tested series). Create always provisions a single primary; a replica is added
later via `POST …/members`. MariaDB 12.3 is creatable that way; adding a
member is **422** `managed_failover_unsupported`. Existing single-member 12.3
databases are left as they are (no migration).

**Series are immutable after create.** `PATCH …/managed` refuses a settings
change that moves the cluster to a different series (**409**
`managed_series_immutable`, via `assertManagedSeriesUnchanged`) — an engine will
not start on another major's data directory, and cross-major replication is not
a supported topology. Every member of a topology therefore shares one series by
construction. A cross-major move is a migration between two managed databases,
not an in-place image change; that migration flow is a `Future:` seam.

**PostgreSQL variant swaps are refused too.** Moving a PostgreSQL cluster
between the Alpine image (musl libc) and the Debian image (glibc) is refused
with **409** `managed_variant_swap_unsafe` (`assertManagedVariantSwapSafe`,
policy in `isManagedVariantSwapSafe` in `releases.ts`). PostgreSQL sorts text
with the operating system's collation and the two libraries order the same text
differently, so every text index silently becomes wrong (proven on a test host:
`bt_index_check` fails with `item order invariant violated`, and an index-ordered
`ORDER BY` differs from a sequential scan). The fix for an operator is a new
cluster on the wanted image plus a backup restore. A no-op patch is never
refused, and MySQL / MariaDB variant swaps stay allowed (they ship their own
collations). The refusal is the conservative default while the owner decides
between refuse, allow plus reindex, or document; relaxing it means editing
`LIBC_FAMILY_BY_ENGINE_VARIANT` / `isManagedVariantSwapSafe` in one place.

`GET …/managed` returns a `release` view (`series` / `variantId` / `lifecycle` /
`tested` / `image`, via `buildManagedReleaseView`) so the UI can show a version
without parsing tags — and flag a cluster still running a series that is no
longer creatable.

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

**MariaDB commits are durable by default.** Platform `my.cnf` pins
`sync_binlog=1` and `innodb_flush_log_at_trx_commit=1` (MariaDB's own default
`sync_binlog=0` lost an acknowledged write after a hard reboot; MySQL 8+
already defaults to both). They are deliberately not in `RESERVED_CNF_KEYS`:
the operator block is rendered after the platform lines in the same
`[mysqld]` section and the last duplicate wins, so an operator who wants
speed can set another value. Existing clusters pick this up only when the
config is re-applied and the engine restarts; no restart is forced.

**Postgres slot retention is capped too.** Platform `postgresql.conf` sets
`max_slot_wal_keep_size = '4GB'` (`SLOT_WAL_KEEP_SIZE`; Postgres' own default
is unlimited, which let a stopped or removed replica's slot keep every WAL file
until the primary's disk filled). Reload-only, so existing clusters get it at
their next apply. Not a reserved key: the operator block comes last, so an
operator value wins. Trade-off: a replica that is alive but further behind than
the cap is invalidated (`wal_status = 'lost'`) and needs a Resync, so the cap
should sit well above any lag a healthy replica reaches. The daemon reports the
state on the **primary's** `replication.slotRetention` (`ok` / `lagging` = a
slot holds more than `max_wal_size` / `critical` = `unreserved`, `lost` or
`awaiting_resync`, with the worst slot, its `walStatus`, retained and safe
bytes, and whether a replica is attached). A cut-off replica stays `critical`
across later applies: the daemon replaces its lost slot with one that keeps no
WAL (`awaiting_resync`) until a Resync reserves it again, so the signal does
not clear on its own (daemon first: an older daemon re-creates the slot as
reserved and the signal clears). The slot is named `tp_member_<ordinal>`, which
is how the UI marks the replica itself as cut off; it is optional on every hop (apply result, `managed-health-result`,
stored member metadata) so an older peer simply omits it.

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
KiB cap), `backups` (`retentionKeep`, `parseBackupSettings`). Parser semantics: absent → defaults; malformed/denied →
`null`. **`ssl.mode` is optional and unset by default** — an absent mode means
"inherit" (see **Client TLS (SSL mode)**), so `DEFAULT_MANAGED_SETTINGS.ssl` is
`{}`. Legacy stored `ssl.enabled` booleans still parse: `false` → `disable`,
`true` → `require`; explicit `mode` wins when both are present.

### External access (one setting per server)

Who can connect from outside the server is **not** a cluster setting. One
ProxySQL runs per server and fronts every cluster on it with one listener pair
and no per-user source rule, so "allow external access to the databases on this
server" is one yes/no on the server, default **no**
(`server.options.managedExternalAccess = { enabled, pendingSince? }`, parsed by
`external-access-setting.ts`, used through `external-access.ts`). A leftover
per-cluster `exposure` key in an old stored row is ignored. The old four-way
scope menu (`local | datacenter | turbofabric | public`) is gone; address detail
stays internal.

- **No**: the listener is published on `127.0.0.1` only (never an empty
  publish): sites run by a site owner's Linux user dial `127.0.0.1:13306`
  (MySQL/MariaDB) or `:15432` (Postgres), and bound containers dial ProxySQL by
  name over the organization's managed Docker network with no host publish.
- **Yes**: published on `0.0.0.0`; the firewall (`features/firewall/`, preview
  only so far) and the network rules decide who can reach it. Every cluster on
  the server is reachable that way, by design.

`decideIngressBindAddresses` in `ingress-desired-pure.ts` turns the setting into
the one `bindAddresses` entry sent in `managed.ingress.reconcile` (a server with
no cluster to front still takes the `not_needed` / teardown path). The wire
contract is unchanged. Changes go through `PUT /servers/:id/managed-external-access`
(`client/managed/external-access-routes.ts`, org owners and managers): it saves
the setting, marks `pendingSince`, and queues the ingress reconcile at once; a
push that cannot be queued answers 502 `ingress_reconcile_failed` (saved, not
applied). Every PUT is audited as `server.managed_external_access.update` with
`{ enabled }` only. `pendingSince` clears (one conditional UPDATE that never writes `enabled`, so a
newer PUT is never reverted) when the server confirms a reconcile created
after the ask (`consumer.ts` → `confirmManagedExternalAccessForServer`), and
`runManagedExternalAccessPendingSweep` re-sends it to connected servers that
never did. `GET …/managed` reports `externalAccess.servers[]` (one row per
fronting server: `enabled`, `pending`, `otherClusters`) and `endpoints[]` as
`{ reach: 'local' | 'external', host, port }`. Access control on a published
listener is credential auth + org-CA TLS. Out of scope (future hardening idea):
per-login host restrictions via the admin login.

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

| Surface                    | Shape                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client connection endpoint | Shared ProxySQL host:port on the **placement server** (member or bound consumer) — port from the **server-owner** org's listener config, default pgsql `15432` / mysql `13306` (see Client listener ports above), TLS to the **server-owner Organization CA**, DSN TLS parameter from the effective `ManagedSslMode` (see Client TLS above)             |
| Routing                    | ProxySQL hostgroups map each login's `connectionRole` → primary/replica backends over the local Docker network, a fabric relay address over `tp0`, or a datacenter private address (see Client routing above; `^SELECT` rules only under `routing.autoReadSplit`)                                                                                       |
| Engine containers          | Reachable only on the organization's managed network (container DNS / IP from apply peers); no host `ports:`. That network's name is the `network(kind='managed')` row's bare UUID — allocated by `ensureOrganizationManagedNetwork`, never a literal (`../db/AGENTS.md`; daemon side: `turbopaneld/src/managed/AGENTS.md` → **Compose project names**) |
| Desired-state command      | Whole-server `managed.ingress.reconcile` builds `clusters[]` + **resealed frontend user passwords** for every managed cluster needed on that server (local members **and** clusters bound by compose services placed on the server). Binding lookup is scoped to the target org + server; cluster members/users/endpoints are batched per reconcile     |
| Organization CA scoping    | Organization CA and frontend leaf for ProxySQL come from **`server.organization_id`**, with SANs for advertised listener host/IP — not only synthetic names                                                                                                                                                                                             |
| Username uniqueness        | Logins unique across every cluster on servers owned by the same organization (see Login namespace)                                                                                                                                                                                                                                                      |

Connection info helpers surface the ProxySQL frontend port/host: loopback
always, plus the server's public address or hostname when external access is on
(`resolveManagedAccessEndpoints` on `GET …/managed` → `endpoints[]`);
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
seam.

**Scheduled backups** are `retention` rows (routes under
`/environments/:id/managed/backup-policies`, org owners and managers only;
`src/client/managed/backup-policies.ts`). The control plane never queues a
run: it pushes each host its full policy set as `server.backups.reconcile`
(`src/features/backups/reconcile.ts`, triggers listed in
`src/features/commands/payload-contracts.md`), and a systemd timer on the host
runs each backup. Schedules are stored as cron — presets (`hourly`, `daily` at
HH:MM, `weekly` on a day at HH:MM) normalize to cron and read back out for
display (`src/features/backups/schedules.ts`) — and are translated to
`OnCalendar` at push time; a schedule that cannot translate is refused on
write. Every new managed database gets one automatic daily policy ("Daily",
03:MM host time, keep the engine's `defaultRetentionKeep`, `created_by`
null), created in the engine's own create transaction; existing engines are
not backfilled. Policy retention is capped at the engine's
`maxRetentionKeep`, and prunes only that policy's own directory on the host.

## Container naming

One engine `service` row per managed cluster; each **member** owns one
`role='service'` container at `ordinal = member.ordinal`, named
`managedContainerName(serviceId, ordinal)` → `<service.id>-<ordinal>`. There is
**no** per-managed Traefik / `-in` ingress container row **on the engine
service** — `-in` is not retired platform-wide; it now names the shared ProxySQL
row on the `managed-ingress` system service. Shared ProxySQL is the
**`managed-ingress`** system component (project = its own `serviceId`, compose
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
and `primary_conninfo`. Both roles carry `replication.peerAddresses` (standbys
too): every member server hosts a ProxySQL ingress that dials each engine's
private listener with regular users (`tp_monitor` + client traffic), so the HBA
admits peers with `hostssl all` rules alongside the `hostssl replication`
entries — a peer-less standby HBA rejects cross-host monitor/read traffic.
Cross-host **consumer** servers (bound apps elsewhere) are admitted the same
way via `member.clientSourceAddresses` → payload `ingressSourceAddresses`
(pg_hba `hostssl all` + daemon firewall (preview only so far) + MySQL/MariaDB account host scoping);
consumers never receive replication rules.
Managed leaves are minted serverAuth **+ clientAuth** (`includeClientAuth` in
`buildManagedOrgTlsMaterial`): ProxySQL presents them as client certs on
proxy-to-server connections and Postgres verifies purpose once `ssl_ca_file`
is set. ProxySQL backend monitor credentials are control-plane minted **per
server** (`client/managed/monitor-credential.ts`: `tp_monitor_<serverId
prefix>`, sealed on the dedicated `monitor` table — **never** `server.options`,
which the server routes return verbatim and the cached read models copy into
Redis) — shipped on
`managed.ingress.reconcile` (`payload.monitor`, this server's own) and on
primary `managed.apply` (`monitorUsers[]`, every fronting server: members +
bound consumers) so each server's ProxySQL monitors every backend with its
own identity; standbys inherit the roles via WAL. Leaf `notAfter` + signing `ca_generation` are persisted
on `leaf` only after `managed.apply` succeeds (mint writes `pendingTlsLeaf`
command metadata — see `src/lib/tls/AGENTS.md` → Leaf tracking + renewal sweep)
— not at payload generation. Member CRUD: `GET/POST …/managed/members`
(`replicaClass` default `failover`; **422** `managed_failover_unsupported`
when the cluster image is not failover-capable — today MariaDB 12.3, which
stays a single-server database until failover tooling can read it), `PATCH/DELETE …/members/:memberId`
(`readEligible` / `replicaClass` conversion),
`POST …/members/:memberId/resync` (operator-forced re-seed: full apply fan-out
with `forceResync` on the target standby payload — the daemon wipes its data
dir and re-basebackups from the primary; the only way past `needs_resync`),
`DELETE …/managed` destroys **replicas first (awaited, bounded 180s), then the
primary** — the primary's `deleteAfterDestroy` outcome removes the managed row,
and destroy side effects are row-independent (`payload.environmentId`) so
concurrent outcomes never skip container-row cleanup or ingress teardown.
`?force=true` skips online checks and replica gating, enqueues best-effort
destroys, hard-deletes the runtime rows, and returns `deleted: true` (sweeps
mop up leftover containers). While any service is bound to one of the
cluster's logins the destroy is refused with 409 `managed_has_bindings` and the
bound `services` (same list shape as `managed_user_has_bindings`), for every
engine and also with `force`; `?detach=true` lets the destroy go ahead and the bindings
(their variables cascade) go with the `managed` row **when the destroy
succeeds** (at once on a forced or unplaced delete), so a destroy that fails
leaves the cluster running with its apps still bound; the response lists them
in `detached`. Detach needs no extra permission: it is the same destroy route,
scope check and step-up. While a `managed.destroy` for the cluster is queued or
running (`hasOutstandingManagedDestroy`), `POST /bindings` answers 409
`managed_busy` / `destroy_in_flight` so a new binding is not silently dropped.
`POST …/members/:memberId/promote`
(lag-gated; **failover** class required — `{ force: true }` bypasses lag/health
only, never class). **On-demand health probe:** replica health is only observed
when an apply/lifecycle result returns, so an idle healthy cluster's
observation ages past the gate's 120s window. When the stored observation is
missing, unparseable, or stale (`isManagedReplicaObservationStale` — keyed on
age, not on the gate's error code, because the gate answers
`managed_replica_not_streaming` _before_ it reads `observedAt`), the route asks
the target's daemon for a fresh reading first (`managed-health-request`, 8s,
`src/client/managed/health-probe.ts`, feature `managed-health-v1`) and runs the
**unchanged** gate on it. **Fail-closed is preserved:** timeout, offline host,
a daemon without the feature, a daemon error, a malformed reply, or a reply for
another member all fall back to the gate on the stored observation — today's 409. `force` never probes. `GET …/managed/status?refresh=1` (the panel's
Refresh) probes every **replica** in parallel (and the primary, while replicas
exist, so its `slotRetention` is current after a Resync; not counted) and returns
`healthRefresh: { observed, unavailable }`; a plain GET stays DB-only. The probe
writes replication only (never `replica.status`). Automatic failover never
honours `force`; it reads the stored, fresh observation first and probes only
on the Postgres cold-kill path below (the probe is injected by the transports;
a test pins that the failover modules do not import it). Read-class promotion is
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
peers are never silently upgraded to `failover`. After a successful
`managed.promote` or `managed.ha.failover` `recover`, remaining healthy replicas
(`ready` / `streaming`, not provisioning/applying/stopped/`needs_resync`/`failed`,
not on an offline or lost server) each get `managed.ha.failover` `phase: 'repoint'`
so they follow the new primary without a full Resync. The control plane first
queues one `repoint` on the **new primary** with `ensureSlots` (`tp_member_<ordinal>`
for those replicas) so the physical slots exist, then one replica-side `repoint`
that verifies streaming. A non-terminal replica `repoint` to a different
`targetMemberId` is cancelled and replaced so a stale follow cannot win (a
single UPDATE that leaves an already terminal command untouched). A failed
slot-ensure (`ensureSlots` non-empty) is re-queued once with `slotRetry` on
the command context; a second failure is logged (`replicas may fail to stream
until the slots exist`) and not retried. A follow-mode replica whose error
contains `did not reach streaming` is flagged `needs_resync` when it is still
`role=replica` and `status=ready`. Other repoint failures stay log-only. None
of this fails the promote. The payload always carries `engine` (loaded from the
managed row when the caller omits it).

### Completion gate: every ingress must confirm (`ha-ingress-gate.ts`)

A recovery is not `completed` when the role change is done, only when every
server that routes to the database has repointed its ProxySQL. After the
promote, `onPromoteSucceeded` queues one `managed.ingress.reconcile` per
member and consumer server (each stamped with `metadata.recoveryId`) and parks
the row at `reconciling-ingress` with `ingressCommandIds` (the commands) and
`ingressServerIds` (every server that must confirm, including one whose
command could not be built or queued). Each command's terminal result — success,
failure, timeout (stale-command sweep via `onRecoveryCommandTimedOut`), or
"daemon not connected" — calls `settleIngressCommandForRecovery`, which judges
the row from the command table (idempotent; a result that lands before the row
is parked is picked up by the judgement made right after parking):

- any listed command still live: wait;
- every required server has a succeeded command: exactly-one-writer check, then
  `completed`;
- otherwise terminal `failed` + `needsOperator` with `ingressNotRepointed`
  (server ids) and a plain "Degraded: the database proxy on <names> has not
  switched to the new primary" `failedReason`. The new primary is serving; the
  retry is Apply (it re-sends the ingress update to every server). No new
  recovery state (the CHECK list is unchanged).
- Nothing could be queued (no queue or secrets in this context): `failed`, never
  `completed`.

The daemon only reports `succeeded` after reading the ProxySQL runtime table
back and finding the new primary there, so "confirmed" means the proxy routes to
it. A daemon that predates that check still confirms by command success.

### Replica health freshness

`serializeManagedMemberForDisplay` (panel, status, member list) shows a replica
`streaming` / `catching_up` reading older than the 120 s window as `unknown`
(`stale: true`, `lastState`, `ageSeconds`; `replica-freshness.ts`); a negative
reading is never made vaguer, and a far-future `observedAt` is not trusted.

The promote gate and automatic failover read the stored probe-measured
observation (`metadata.replication`) and apply their own freshness rules
unchanged (120 s); they are unaffected by the 30 s health report push.

Fresh readings come from two sources:

- The daemon's own push (`managed-health-report`, feature
  `managed-health-report-v1`, every 30 s) writes to a display-only field
  (`metadata.replicationDisplay`): only the reporting server's own replicas are
  written, `lastStreaming` is dropped, a future time is clamped to receipt.
- The on-demand probe and apply/lifecycle results write to
  `metadata.replication` (probe-measured). When a probe is answered with
  "engine not running" the replica is stored as `not_streaming` with the receipt
  time, so a stopped replica stops showing its last `streaming` line.

For display, the newer of the two readings is shown; for promotion decisions,
only the probe-measured field is read.

### Dead-primary detectors

`managed-ha-event` may carry `detector` (absent = Orchestrator) and bounded
`evidence`. `ha-policy.ts` → `AUTOMATIC_FAILOVER_DETECTORS` is the policy
switch for which detectors may start automatic failover, per engine:

- `orchestrator` (absent field): Orchestrator DeadPrimary, **MySQL/MariaDB
  only** — Orchestrator's image has only the MySQL driver, so an
  Orchestrator-shaped event for Postgres is always rejected.
- `postgres-probe`: the daemon's own probe on the Postgres primary's host
  (`turbopaneld/src/managed/AGENTS.md` → **Postgres dead-primary detection**):
  engine dead, host alive. Sent only when the attach frame advertises
  `managed-ha-probe-v1`.

What the control plane actually checks, in order (`handleManagedHaEvent` →
`haEventRejection` → `beginAutomaticFailover`); there is **no raft-leader
check here** — Raft only matters to whether Orchestrator raises DeadPrimary at
all:

1. The detector covers the cluster's engine.
2. **Every** event (with or without `detector`): the reporting server — the
   authenticated cell session's `serverId`, never a payload field — hosts a
   member of the cluster **and** `server.organization_id` equals the cluster's
   organization (environment → project).
3. `PRIMARY_HOST_DETECTORS` (`postgres-probe`): `sourceMemberId` is the
   current primary member and the reporter is that member's server, so a stale
   daemon (old primary after a switchover) can never fail over the new primary.
   3a. `orchestrator` events are bound to the CURRENT primary
   (`orchestratorBindingRejection`): the daemon sends Orchestrator's key for
   the dead instance (`instanceHost` + `instancePort`, feature
   `managed-ha-instance-v1`), and it must equal the primary's address and port
   as the reporter's Orchestrator knows it (`haMemberDialForReporter`, the same
   dial `managed.ha.reconcile` registered: private address + `privatePort`, or
   the local container name + engine default port). A mismatch, or a missing
   instance from a daemon that advertises the feature, is recorded as a
   terminal `blocked` row with `metadata.stale = true` and a reason, and
   nothing is fenced or promoted (no in-flight resume, no cooldown). A daemon
   that does not advertise the feature keeps the legacy, unbound behavior.
4. An in-flight recovery for the cluster is resumed, not duplicated. Then the
   per-deployment switch (`TURBOPANEL_AUTO_FAILOVER`, below): when off, a
   terminal `blocked` row (`auto_failover_disabled`, no target) and stop.
5. Persisted cooldown: no new automatic failover within
   `AUTOMATIC_FAILOVER_COOLDOWN_MS` (15 min) of the last **accepted** one
   (newest `automatic-failover` recovery row with a target), read from the
   journal so it survives restarts. A refusal is recorded as a terminal
   `blocked` row (`AUTOMATIC_FAILOVER_COOLDOWN_MESSAGE`, no target, so it
   never extends the cooldown); the daemon re-sends while the primary stays
   dead, so a refusal inside the window is retried after it.
6. A same-DC `failover` replica passes the promote lag gate (streaming,
   observation ≤ 120 s old, lag under 64 MiB / 30 s). If none does and the
   engine is Postgres, each same-DC `failover` replica is probed at event time
   (`managed-health-request`, 8 s, in parallel; `ha-fresh-standby.ts`, owner
   decision 2026-10-02). A replica that is no longer streaming is accepted only
   when (a) the daemon saw it streaming no earlier than the failure start minus
   `TURBOPANEL_AUTO_FAILOVER_RECEIPT_MARGIN_SECONDS` (default 10, max 60),
   (b) its replay LSN is within 16 KiB of its received LSN (a receive position
   stopped mid-record can never be replayed exactly), and (c) that last streaming
   read's received-vs-primary byte lag (`latest_end_lsn - flushed_lsn` on the
   standby) was under 64 MiB. Seconds since the last commit are not used: on
   an idle cluster they grow while nothing is behind. The failure start is event receipt
   minus the detector's `evidence.spanMs` (its first hard failure); no usable span, no probe answer, or
   any missing field refuses. The daemon (turbopaneld `pg-standby-sampler.ts`)
   reads its standbys every 2 s and reports `lastStreaming.ageMs` on its
   monotonic clock, so no cross-host clock is compared. The outcome per replica
   is recorded as `metadata.freshStandby`; a refusal is `blocked` with
   `AUTOMATIC_FAILOVER_STANDBY_NOT_PROVEN_MESSAGE`. Otherwise `blocked`.
   A standby still `streaming` at event time must also pass (a): a silently
   dropped link reads `streaming` with zero lag until `wal_receiver_timeout`.
   Standbys run with `wal_receiver_timeout = 10s`, so even an idle link
   exchanges a message every ~5 s and the 5 s receipt rule can hold.
   Several accepted: the one with the highest `receivedLsn` wins (ties: lowest
   ordinal). A failure span over 10 min (a re-send for an old incident) is not
   anchored, so it refuses. Loss window: async replication, so an accepted
   standby may lack up to the margin's worth of commits plus the last
   sample's receive lag (≤ 64 MiB of WAL). The daemon records a streaming
   sample only when the receiver heard from the primary within 5 s.
   Fencing (step 7) and the cooldown (step 5) still apply unchanged.
7. Without a command queue (a deployment with no `TURBOPANEL_COMMAND_QUEUE`
   binding; the Durable Object passes the Worker's binding through
   `daemon/cell/managed-ha-inbound.ts`) a **terminal** `blocked` row is written with
   `AUTOMATIC_FAILOVER_NO_QUEUE_MESSAGE` (`no_command_queue`) and no target —
   never `detecting`, which would hold the in-flight slot
   (`uniq_recovery_inflight_managed`) and make every later switchover / DR
   answer `managed_busy`. With a queue: fence (drain + `managed.lifecycle
stop`; an unreachable old primary blocks) then promote.
8. A fence stop or promote/recover command that cannot be enqueued turns the
   row terminal `blocked` (`FENCE_STOP_UNQUEUED_MESSAGE` /
   `PROMOTE_UNQUEUED_MESSAGE`) instead of leaving `fencing` / `promoting`
   holding the in-flight slot.
9. Safety net: the stale sweep (Deno cleanup lane and the Workers
   offline-sweep cron) runs `expireStaleRecoveries`: a `detecting`/`fencing`
   row older than `STALE_DETECTING_RECOVERY_MS` (10 min) with no command
   recorded expires to `blocked`; any other in-flight row with no update for
   `STALE_RECOVERY_STEP_MS` (15 min) ends terminal `failed` with
   `metadata.needsOperator` (an operator checks which member is the writer).
   The same sweep, when it times out a command that carries a `recoveryId`,
   calls the recovery hooks (`onRecoveryCommandTimedOut`) so the row settles at
   once. Every mutating managed route answers `managed_busy` while the journal
   has an in-flight row (`assertManagedIdle`).

**Automatic failover switch** (`auto-failover-switch.ts`):
`TURBOPANEL_AUTO_FAILOVER=on|off` (also `true`/`false`, `1`/`0`), read at
event time — the Worker's vars on Workers (`daemon/cell/managed-ha-inbound.ts`),
`Deno.env` on self-hosted. Unset: **off** when `TURBOPANEL_ENVIRONMENT` is
`staging` or `live`, **on** everywhere else (testing, local dev, self-hosted
Deno keep the original behaviour); any other value is off, so a typo never
promotes. `wrangler.jsonc` commits `on` for testing and `off` for staging and
live. Off writes `AUTOMATIC_FAILOVER_DISABLED_MESSAGE` as a terminal `blocked`
row with no target (no cooldown) and queues nothing; like the no-queue row, a
detector that keeps re-sending writes one row per accepted event. Manual
switchover and disaster recovery never read the switch.

A rejected event is logged and dropped (no recovery row). An accepted one is
logged with its evidence and records `metadata.detector` /
`metadata.detectorEvidence` on the recovery row.

Whole-host loss is **not** a `managed-ha-event` detector (a dead host sends
nothing): the control plane detects it itself, see **Whole-host loss** below.

### Whole-host loss (power cut)

Both runtimes' sweep ticks (Workers cron `reconcile` phase first, self-hosted
Deno timer) call `daemon/cell/host-loss-tick.ts` → `ha-host-loss-sweep.ts`
(stateless: every tick re-reads who is offline) and `ha-return-fence.ts`. The
rule is the pure `ha-host-loss.ts`; anything short of a clear yes is an
**alert-only** terminal `blocked` row (reason in plain words,
`metadata.detector = 'host-loss'`, `hostLossIncident = <serverId>@<offline
mark>`; repeats of the same reason fold into one row), never a promotion:

1. The primary's server has been offline (`server.status_changed_at`) for the
   whole **window** (`TURBOPANEL_HOST_LOSS_WINDOW_SECONDS`, default 120, clamped
   60-300), on top of the 90-150 s the offline sweep needs to notice. A host
   that returns inside it stops being a candidate: nothing happens.
2. Not within 10 minutes of an operator `server.reboot` of that server or while
   a daemon update is in flight. Never later than 7.5 minutes after the offline
   mark (`HOST_LOSS_LAST_DECISION_MS` = the fresh-standby gate's 10 minute
   failure span minus the 150 s mark lag; the gate's receipt check does not
   depend on when the probe runs, so without this cap a retry long after the
   loss would still pass it): later is alert-only (`too_late`). Not for a host
   offline over half an hour.
3. Not when more than half of the organization's servers are offline.
4. PostgreSQL only (MySQL/MariaDB replicas read `reconnecting` without a source
   and cannot be proven caught up: alert, then manual promote).
5. The dead primary's daemon advertised `managed-ha-boot-hold-v1`.
6. Every other member's server is connected and answers a fresh
   `managed-health-request`, and **none** is still receiving (`streaming`) from
   the primary. One that hears the primary vetoes (the host is alive, only its
   link to the control plane is down).

Then `beginAutomaticFailover` runs with `hostLossIncident`: the per-environment
switch (off: `auto_failover_disabled` row), the persisted 15 minute cooldown, a
healthy same-DC `failover` replica proven by the fresh-standby gate anchored on
`offline mark - 150 s` (the earliest the host can have died), and a command queue all
apply unchanged. `beginRecovery` then skips the drain/stop (nothing can reach
the host), flags the old primary `needs_resync`, records `fenceBasis =
'host-loss-attested'` with `fenced = false` (`hostLossFenceAdvance`;
`verifyFenced` is untouched, so the engine-dead path still needs its stop) and
queues the promote with `demoteMemberId`. If the host reconnected in between
the row ends `blocked` (`HOST_LOSS_HOST_RETURNED_MESSAGE`) with nothing changed.

**The old primary when it returns** (`ha-return-fence.ts`), keyed on the role
the control plane holds, not on how it was replaced:

- The daemon's boot hold (`turbopaneld/src/managed/AGENTS.md`) stopped it after
  an unclean boot and reports `detector: 'boot-hold'`. `handleManagedHaEvent`
  answers it (never as a failover): still `primary` and no recovery in flight
  and no `needsOperator` row = `managed.lifecycle start` (`bootHoldRelease`); a
  replica = stays stopped, noted `returnFence: 'confirmed'`; in flight = no
  answer, the daemon asks again in a minute.
- `runReturnFenceSweep`: a `needs_resync` replica whose server is connected gets
  one `managed.lifecycle stop` per reconnect (failed stops retried up to 5
  times), metadata `returnFence`. The consumer projects **nothing** for it
  (success or failure): it would overwrite `needs_resync` and mark the cluster
  stopped/failed. It never resyncs: wiping the old primary's data is the
  operator's choice (`POST .../members/:id/resync`), its un-replicated writes
  exist nowhere else.

**Demoted marker (daemon guard):** fence stops of the _old_ primary — the
`managed.lifecycle` stop in `enqueueFenceCommands` (`params.source`) and the
return-fence stop above — set optional `demoted: true` on the payload. Ordinary
operator stops and stops of the new primary omit it. The daemon writes
`<stateDir>/managed/<managedId>/demoted.json` after that stop succeeds and a
periodic guard stops the engine again if someone starts the container by hand
(a host that stayed connected never hits the reconnect sweep). Older daemons
ignore the field; older control planes omit it. The control plane still marks
the member `needs_resync`; the daemon owns keeping it from serving writes.

**Alerts**: the offline alert (`server.offline`) now names the HA databases
whose primary the server hosts and what happens next; the outcome is the
recovery row in the journal. No new notification event (that needs a
migration).

Proven only by unit tests; the two-host power-cut runs (matrix H07, U11) are
the live proof. Not covered: a primary that stays powered but is cut off from
both the control plane and its replicas keeps taking local writes (they are
lost on resync).

**Fence bookkeeping is lock-serialized** (`ha-recovery.ts`). Every fence
command row is created first, `metadata.fenceCommandIds` is written, and only
then are the commands queued (drains, stop last), so no result can arrive for
an id the row does not hold. Fence results (parallel queue consumers on both
runtimes) go through `updateRecoveryLocked` (`SELECT … FOR UPDATE` in a
transaction): only a `fencing` row that still lists the command changes; a
duplicate, late or unknown result is ignored. The result that empties the list
picks the next state under the lock, and the promote is queued after the
commit, so it is queued once. A stop command that cannot be queued blocks the
row (`FENCE_STOP_UNQUEUED_MESSAGE`); a drain that cannot be queued just leaves
the list.

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
5. The server's external access switch (no / yes); org port
   override; SSL modes `disable` → `verify-full`.

## Login namespace

Every managed principal has the name the person typed (`username`, the display
name) and an `applied_username` — the actual engine login, the system name. A
**name scheme** decides how the system name is derived
(`src/lib/principal-name-scheme.ts`, `resolveManagedAppliedUsername`): `plain`
= the typed name, `partial` = `<typed>_<11 random chars>` (the platform default),
`random` = a fully random 12-character name with no trace of the typed name. The
org default and optional lock live on `organization.options`
(`principalNameScheme`, `principalNameSchemeLocked`; the legacy boolean
`randomizedPrincipalUsernames` is the fallback: true = partial, false = plain);
the chosen scheme is stored on `principal.options.nameScheme`. The server always
derives the system name. Root is **never** plain
(`postgres_<11 rand>` / `root_<11 rand>`, or random under the `random` scheme;
persisted on `managed.metadata.rootUsername` — spec `rootUsername` is only the
short name/prefix), so the bare engine admin name is never a login. Applied
usernames are unique across every cluster landing on servers owned by the same
organization (`server.organization_id` — not the creating org); the uniqueness
probe covers both the short and applied columns. The bare `postgres` / `root`
/ `mysql` accounts stay platform-internal (socket/bootstrap admins), and those
names plus `superadmin` are rejected for client logins
(`RESERVED_MANAGED_USERNAMES`). User create uses the same org-wide probe under
`FOR UPDATE` locks
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
