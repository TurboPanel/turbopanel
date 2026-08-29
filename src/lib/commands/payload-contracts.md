# Command payload contracts (per command type)

Referenced from `AGENTS.md` (**Consumer behavior**). Per-command-type
payload and result contracts the consumer and daemon both honor —
TurboFabric, `environment.deploy` (compose files, releases, hosting,
raw ports, sites), managed engines + HA, org TLS, system reconcile.
**Keep current when a command payload or result shape changes**
(`schemas.ts` / `types.ts` are the code-side source of truth).

**TurboFabric gateway/member model:** relays are `role = 'gateway' | 'member'`.
Members always get a host `/32` route. Gateways also advertise `advertisedCidrs`
(datacenter LAN CIDRs); an empty gateway `advertisedCidrs` now resolves to the
derived **IPv4** subnets of that relay's datacenters (operator-set list wins
verbatim). Apply returns **422** `gateway_datacenter_required` /
`gateway_datacenter_cidr_required` when a gateway lacks a datacenter or that
datacenter has no subnet at all (`gateway_datacenter_cidr_required` now means
"that datacenter has no subnet at all"). `POST /organizations/:id/fabric/apply`
force-reconciles every relay; PUT disable tears down the mesh and reclaims
`network(kind='compose')` / `subnet` rows (compose-bridge CIDRs, not datacenter subnets). Overlay addresses auto-allocate from
`fabric.cidr`. For `environment.deploy` / `environment.stop` success, the
consumer reconciles canonical `container` rows via
`reconcileEnvironmentContainers` (`src/lib/db/container-records.ts`) from the
daemon's authoritative `containers[]` result (identity match by
`container_name`, else compose service / ordinal — including multi-instance
`web-N` clones). Stop returns `containers: []` so rows reset to `exited` with
null `container_id` (identity preserved for restart). When a reported compose
service has no `service` row yet (deploy before hostname config), reconcile
creates that service so container FKs can resolve; reconciliation failures are
logged and never revert the already-succeeded command.

`server.reboot` requires `organization:manage`, carries an empty payload, uses a
120s consumer timeout, has no `touchServerMetadata` side-effect, and is executed
daemon-side via `sudo systemctl reboot` (handler implemented in a separate
phase).

`environment.deploy` uses a 600s consumer timeout. Compose merge + Traefik label
injection + Docker/Caddy bootstrap run on the daemon
(`turbopaneld/src/instance/commands/deploy-environment.ts`). Optional payload
`noCache: true` (from UI cacheless redeploy) asks the daemon to run
`docker compose build --no-cache --pull` before `up`. On success the daemon may
also return best-effort per-container identity/status from `docker compose ps`;
the consumer reconciles those into `container` rows (ids/status only). **Cost:**
one cell outbox enqueue; UI polls Postgres command rows only — never Durable
Object reads for deploy status. Hosting Caddy (`:80`/`:443`) is distinct from
control-plane Caddy (`:8443`).

**`composeFiles[]` (compiled runtime file):** `environment.deploy` carries
`EnvironmentDeployComposeFile[]`. Deploys send a **single**
`{ filename: 'compose.yaml', role: 'runtime', source: 'inline', content }` entry
— that is the file the daemon writes under
`/var/lib/turbopanel/deployments/<projectId>/<environmentId>/` next to `.env`
(non-secrets, mode `0640`) and `deployment.json` (includes `secrets[]` plan, no
plaintext). `filename` must match `COMPOSE_FILE_NAME_RE`
(`/^[A-Za-z0-9._-]+\.ya?ml$/`, basename-only). Secret values never enter durable
YAML: `secretPlan[]` + `variableMaterial[]` (`tpdaemon` envelopes;
`sealVariableMaterialForDaemon` always reseals plaintext) materialize files
under `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/` (mode
`0600`). Build secrets use Compose `build.secrets`, not `build.args`. The
last-applied plan is also stored on `deployment.options.secretPlan` for boot
rehydrate (`POST /api/daemon/v1/deployments/secrets/rehydrate`). Optional
payload fields `generation`, `desiredHash`, `replicaCounts`, and `serverId`
identify the per-host snapshot.

**`command.context.releases[]`:** the Git-backed releases one
`environment.deploy` attempt published, written onto the permanent row at
enqueue time next to `replicaCounts` and for the same reason — `deployment` is
upsert-per-target and `dispatch.payload` is deleted at terminal state, so this
is the only durable record that release id `X` of service `web` ever existed.
Each entry is `{ composeServiceName, releaseId, sourceId, commitSha,
commitMessage?, commitAuthor?, rollbackToReleaseId? }`, all non-secret;
`normalizeContextReleases` drops the whole array rather than persisting a
partial one when a **required** field is missing, because a releases list with
holes would offer a rollback target that was never built — the display-only
commit subject/author are dropped individually instead. It is the read model
behind `lib/db/releases.ts` (`listServiceReleases`) and therefore behind `GET
/environments/:id/releases` and the `POST /environments/:id/rollback` gate.

Release ids are allocated **once per compose service per deploy**
(`createReleaseIdAllocator`, `client/environments/deploy-sources.ts`), before
the per-server prepare fan-out, and the same allocator is threaded through every
`prepareDeployCompose()` call in that deploy. So a service scheduled onto three
servers writes three `command` rows carrying the *same* release id, and
`listServiceReleases` folds them back into one environment-scoped record whose
status is the aggregate over all of them. Minting the id inside the per-host
prepare instead would make each host's release id different, and a rollback
naming one of them would fail the daemon's `promoteExistingRelease()`
missing-release check on every other host.

A rollback is **not** a new command type: it enqueues an ordinary
`environment.deploy` whose `sourceMaterial[]` entries carry
`rollbackToReleaseId`, so it bumps `generation` and inherits the supersede rule
like any other deploy. The rollback route only offers a release whose aggregate
status is `succeeded` **and** which is materialized on every server the
environment currently deploys to (`isReleaseMaterializedEverywhere`), and it
carries the release's recorded commit metadata forward so the rollback's own
release row names the commit going live rather than the branch placeholder.

**`EnvironmentDeployHosting.bindAddress`:** optional IPv4/IPv6 literal resolved
on the instance at deploy-prepare time (`resolveHostingBindAddress`) from
hosting `options.bind` (`public` / `datacenter` / `local`) plus optional
`hosting.ip_id`. Public with no pin omits the field (daemon emits no `bind`
directive — today's behavior). `local` → `127.0.0.1`. `datacenter` requires an
`ip` row with `scope = 'datacenter'` on the target server; when missing, deploy
validation fails with typed `DeployPrepareError`
`{ kind: 'datacenter_ip_required', serverId }` (**422**
`datacenter_ip_required`) before command dispatch — the daemon stays DB-free.

**`EnvironmentDeployPayload.listenerPorts`:** optional server-owner org
effective ProxySQL client listener ports echoed on every `environment.deploy`.
The daemon reserves the platform defaults (`15432` / `13306`) **and** these
overrides when checking tenant raw `tcp`/`udp` published-port claims — same
source as `managed.ingress.reconcile`.

**`EnvironmentDeployHosting.protocol` / `.ports` (raw TCP/UDP port hosting):**
`hosting.options.protocol` (`http` default/omitted, or `tcp`/`udp`,
`src/lib/hosting-options.ts` —
`HostingOptions.protocol`/`resolveHostingProtocol`) lets a Docker service
publish raw port(s) straight through a **per-service Traefik** instead of
routing hostnames through hosting Caddy — no hostname/TLS/path-prefix routing
for that hosting. `hosting.options.ports` (`HostingPortMapping[]`, capped at 10,
invalid/duplicate-published entries dropped rather than failing the document) is
`{ published, target }`; **required non-empty** when `protocol` is `tcp`/`udp` —
`hostings[].ports must not be empty for <protocol> protocol` (both
`deploy-validation.ts` and the daemon-side `contracts.ts`/`compose-labels.ts`
reject an empty list). `bind`/`ip_id` still apply identically to HTTP hostings
(resolved the same way into `bindAddress`), but
`hostnames`/`tlsId`/`pathPrefix`/`targetPort` are ignored for `tcp`/`udp`.
`resolveHostingEntry` in `deploy-routes.ts` branches on protocol
(`resolveHttpHostingEntry` vs `resolveTcpUdpHostingEntry`) when building the
deploy payload. Every service that publishes at least one `tcp`/`udp` port gets
an `ingressServices[]` entry (`EnvironmentDeployIngressService`: `serviceId`,
`composeServiceName`, `containerName === <serviceId>-in`) pre-allocated via
`ensureServiceIngressContainerAllocation` (same `(serviceId, 'ingress', 1)`
upsert as managed ingress). HTTP hostings never get an ingress container — they
stay on the shared loopback Traefik via Docker labels only. HTTP hostname
deploys also carry `hostingIngress` (`EnvironmentDeployIngressService` with
`composeServiceName: 'traefik'` and `containerName === <hosting-ingress
serviceId>-in`) so the daemon can write `<stateDir>/system/hosting-ingress.json`
before `ensureHostingIngress` on first tenant HTTP deploy — that is the
**platform** hosting-ingress UUID, not the workload service UUID, and not a
per-tenant Traefik. Deploy-preview
merges those ingress rows into `containers[]` with `role: 'ingress'`. See daemon
`src/deploy/AGENTS.md` → "Raw TCP/UDP port hosting" for the per-service Traefik
project / claim-file / conflict-detection mechanics — cross-service
published-port uniqueness is enforced **daemon-side** (the instance does not
track other services' claimed ports), so two deploys racing the same `tcp`/`udp`
port on the same server can both enqueue successfully and one command will fail
at apply time with a port-conflict error. `environment.stop` also passes
`ingressServices[]` (`{ serviceId }[]`) so the daemon can tear down those
per-service projects.

`environment.stop` uses a 120s consumer timeout. Daemon runs
`docker compose down --remove-orphans --volumes`, removes listed
`fabricNetworks[]` bridges (best-effort), removes the hosting Caddy site
snippet, reclaims listed `siteReleases[]` trees, deletes the deployment dir, and
`rm -rf`s the matching
`/run/turbopanel/deployments/<projectId>/<environmentId>/secrets` tree
(`turbopaneld/src/instance/commands/stop-environment.ts`).

**`siteReleases[]` (`{ serviceId, username }[]`) is generic host reclaim, not a
site detail.** It names `<principalHome>/sites/<serviceId>` — the
tree the Git release engine publishes into (`releases/`, `current`, `shared/`)
and the one the native-runtime phase will run out of. Like `fabricNetworks[]`,
it is resolved from `tenancy` rows **before** they can
go away (`client/environments/site-releases.ts`, shared by the explicit stop
route, the drained-server stop, and delete teardown), because the payload is the
only remaining copy by the time a delete-triggered stop reaches the host. The
resolver returns a **union**: the trees the current merged compose still
declares, plus the ones recorded in `deployment.options.siteReleases` by the
deploy that published them. Without the recorded half, a Git-backed service
removed from the compose would vanish from the current document and leave its
tree orphaned on the host. What each deploy _records_ stays current-only
(`resolveSourcedEnvironmentSiteReleases`), so the record cannot grow without
bound — a redeploy reclaims removed trees on the host itself, from
`deployment.json` `releases[]`. The tree is root-owned, so the daemon removes it
through its privileged runner; removal is best-effort per entry and never fails
the stop. Idempotent when the compose file is already gone. Used as the teardown
gate before project cascade delete. **Contrast with `environment.lifecycle`:**
stop is **destructive teardown** (`down --remove-orphans --volumes`, hosting
site + deployment dir + `/run` secrets removed, `containers: []` clears pins);
lifecycle is **non-destructive** (`compose start|stop|restart`,
files/volumes/deployment dir preserved, container rows keep their ids).
Lifecycle `start`/`restart` rehydrate missing `/run` secret files first.

`environment.lifecycle` uses a 120s consumer timeout. On success the consumer
reconciles the daemon's authoritative `compose ps -a` report through
`reconcileEnvironmentContainers` (live rows update pins rather than clearing
them). An omitted `containers` field means collection failed and nothing is
reconciled. Failures write nothing beyond the terminal command row.

`system.reconcile` uses a **300 s** consumer timeout (self-heal may pull the
Traefik image). Offline fail-fast applies. The component set is
`hosting-ingress | managed-ingress | managed-ha | database | queue | analytics` — each
`SystemReconcileComponent` carries a `role` (`'ingress'` for the shared
per-server Traefik and managed-ingress ProxySQL, `'turbopanel'` for managed-ha
Orchestrator, and the
co-located self-host database/queue/analytics services) and a per-component
`containerName`: `hosting-ingress` → `<serviceId>-in`, `managed-ingress` →
`<serviceId>-in`, `managed-ha` → `<serviceId>-ha`,
`database`/`queue`/`analytics` → bare `serviceId` (uuid
naming). `buildSystemReconcilePayload` resolves **every** system-workspace
environment pinned to the server in one query (component identity from
**`project.metadata.component`**, never `environment.metadata.component`) and
returns **one payload per environment** — a colocated server can carry both a
`hosting-ingress` environment and the `turbopanel` self-host environment side by
side, and `enqueueSystemReconcile` creates one `system.reconcile` command per
payload (or the single payload matching an explicit `environmentId`) because
`reconcileEnvironmentContainers` only prunes within one environment. On success
the consumer reconciles each command's reported `containers[]` against **that
command's payload** `environmentId` only — never a daemon-supplied one — and
passes the payload's expected `(serviceId, role, ordinal)` allocations so a
**partial** self-host report resets missing expected rows to `exited` / null
Docker id instead of deleting preallocated identity. An omitted `containers`
field skips reconcile; `containers: []` is an authoritative empty report
(ingress row settles to `exited` + null `container_id`). Failures/timeouts write
nothing beyond the terminal command row (no managed-style status projection).
**`database` / `queue` / `analytics` are inspect-only** — the daemon reports
their `docker compose ps` identity/status for inventory but never starts, stops,
or self-heals them (no `desired: 'absent'` path, no image pull); only
`hosting-ingress` self-heals via `ensureDocker`, and only when
`desired: 'present'`. Hosting-ingress **`desired: 'present'` is demand-driven**:
hosting enabled **and** (an HTTP hostname hosting on that server, or the ingress
row already observed after first start) — bare enroll / enable-hosting with an
empty pending `-in` inventory must not start Traefik. Tenant
`environment.deploy` starts shared Traefik only when that deploy carries HTTP
hostnames (see daemon `src/deploy/AGENTS.md`). Actions: `reconcile` (default
drift / enable), `restart` (operate), and **`stop`** (hosting-disable PATCH —
intentionally stops the shared hosting-ingress compose project; ordinary
`desired: 'absent'` + `action: 'reconcile'` stays report-only). Triggers:
hosting enable (`PATCH /servers/:id` → `reconcile`), hosting disable (`PATCH` →
`stop` scoped to hosting-ingress), operate restart
(`POST /servers/:id/system/:component/restart` — hosting-ingress only, see
`SYSTEM_OPERATE_COMPONENTS`), and a storage-free drift sweep (Workers
offline-sweep cron + Deno maintenance timer, including an immediate tick on
Deno boot) that enqueues for connected servers
where either the hosting-ingress row needs heal **because demand/observation
exists** (and is not running, missing a Docker id, or the server recently
reconnected), **or** a self-host `database`/`queue`/`analytics` system-role
container is not running or missing a Docker id, throttled to one enqueue per
**server** (not per environment — one sweep hit still fans out to every system
environment) per **5 minutes** via the `command` table itself
(`actorType: 'system'`, `actorId = serverId` for sweep-driven rows —
`command.actor_id` is a uuid with no FK). Install (`completeInstanceInstall`)
also enqueues from the request isolate when the colocated daemon is already
connected. Never enqueue from `onDaemonConnected` / Durable Object handlers.
See `../../client/system/hierarchy.ts` (provisioning)
and `../../client/system/reconcile.ts` (payload/sweep); production inventory
rationale lives in `../../../AGENTS.md` → "Self-host system inventory".

**Managed engine commands** (compose + config + credentials are generated by the
platform — never conflate with `environment.deploy` hosting ingress). Like
TurboFabric membership reconcile, **apply / lifecycle / destroy fan out one
command per managed cluster `replica` server**; each payload carries `memberId` /
`memberRole` / `memberOrdinal` / `readEligible` / `peers[]` (private endpoints
to other members). Exposure no longer ships an `ingress` identity on the payload
— shared ProxySQL is reconciled separately:

| Type                        | Timeout         | Success side-effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed.apply`             | 600 s           | Sets `managed.status = 'ready'`. When `memberRole` is `primary`, also pins `managed.server_id` and merges `metadata.host` / `metadata.port` (replica successes never re-home the primary pin). Reconciles `containers[]` for every member when reported. Optional `privateListener` / `replication` on multi-member clusters; `privateListener.transport` (`local` \| `datacenter` \| `fabric` \| `public`, omitted = not public) tags the resolved bind so a **`public`** listener is refused by the daemon without `orgTlsMaterial` and is firewall-scoped to known peers; result `member` health projects onto `replica`. Optional `tlsMaterial` / `orgTlsMaterial` for engine + ProxySQL TLS. Apply-prepare ensures the Organization CA leaf (with member SANs), replication principal, and per-member config. Minted engine-leaf tracking rides command `pendingTlsLeaf` metadata and is upserted onto `leaf` only on success (enqueue / terminal failure leaves the previous deployed expiry visible to the renewal sweep). **HTTP returns after the primary command is queued** — multi-member `pendingStandbyApplies` ride command `metadata` and the consumer enqueues standby applies only after primary success. After apply, the instance may enqueue **`managed.ingress.reconcile`**. |
| `managed.lifecycle`         | 120 s           | Projects daemon-observed `result.status` onto `managed.status` (`ready` / `stopped` / `failed`) — never infers status from the requested action. Optional `memberId` for fan-out; optional `engine` (postgres\|mysql\|mariadb) so the daemon resolves the correct runtime for member health (absent → postgres for in-flight older commands). Result may include `member` replication health for projection. Promote path fences via `stop` with **`followUpPromote` metadata** — consumer enqueues `managed.promote` only after fence success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `managed.destroy`           | 300 s           | Always tears down host runtime (`compose -p <managedId> down` — the bare `managed` row UUID — plus leftover-container sweep) even when the state dir is missing; compose down failure is **not** success while labeled containers remain. Projects daemon-observed `result.status`, always returns `containers: []`, and reconciles pins clear. `deleteAfterDestroy` is stamped only on the **primary** member's command so the `managed` row is deleted once. Member DELETE uses **`deleteMemberAfterDestroy`**: the member stays visible (`applying`) until destroy succeeds (then deleted + optional `pendingPrimaryReapply`); destroy failure marks the member `failed` (retryable). Follow-up **`managed.ingress.reconcile`** drops destroyed clusters from ProxySQL desired state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `managed.promote`           | 600 s           | Enqueued to a replica with `{ managedId, memberId, demoteMemberId?, engine? }`. Optional `engine` selects the promotion runtime (default postgres when omitted). Sets `managed.status = 'applying'`. Lag/health gate (or `{ force: true }` on a **failover** replica only). Read-class promotion uses the disaster-recovery HTTP route, not this command's class bypass. On success: flip roles from `result.promotedMemberId`, demote → `needs_resync`, re-point `managed.server_id`, set `ready`, then fan-out ingress + HA reconcile. Failure/timeout → `failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `managed.backup`            | 1800 s (30 min) | `action: 'create'` success reads `managed.options`, appends a `ManagedBackupRecord` (`id`, `createdAt`, `sizeBytes`, `checksum`, `database?`, `path`) built from the result, drops any ids in `result.pruned`, caps the list, and writes back (read-modify-write; log-only on failure, never reverts the succeeded command). `action: 'delete'` success just removes that id from the list. **Does not** set `managed.status = 'failed'` on failure — a read-only backup failure must never mark a healthy engine failed (see asymmetry note below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `managed.restore`           | 1800 s (30 min) | Success projects `managed.status = 'ready'` via `projectManagedObservedStatus` (the engine's data changed, so status is reasserted even though it was likely already `ready`). Failure/timeout **does** set `managed.status = 'failed'` — a failed restore leaves the engine's data in an uncertain state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `managed.ingress.reconcile` | 300 s           | **Whole-server** ProxySQL desired state only — not per-managed-id. Payload: `serverId`, optional `bindAddresses`, `clusters[]` (each cluster: `managedId`, `engine`, `protocolPort` 15432\|13306 with legacy 5432\|3306 accepted for skew, writer/reader hostgroups, `backends[]`, `users[]` with passwords resealed for **this** server's daemon key), plus optional `orgTlsMaterial` scoped to the **server-owner organization** (the org that owns `server.organization_id` — may differ from a grant-placed project's org). Empty `clusters[]` (no TLS) tears the stack down. Daemon writes compose + full `proxysql.cnf`, materializes TLS under `configDir/proxysql/tls/`, restarts only when static listener section changes, otherwise admin-applies users/servers/rules. Success may reconcile the `managed-ingress` system container when reported. Success also commits `pendingTlsLeaf` metadata onto `leaf` `kind='ingress'` (mint no longer upserts at payload generation). **Never** embeds on `managed.apply`. Offline fail-fast. Failure does **not** flip individual `managed.status` (ingress is server-scoped infrastructure).                                                    |
| `managed.ha.reconcile`      | 300 s           | **Whole-server** Orchestrator desired state (mirror of ingress reconcile). Payload: `serverId`, `desired` present/absent, Raft peers/advertise, registered cluster aliases (managed UUIDs), `identity` (`serviceId` + `-ha` container). Ansible host-prep then daemon compose. Offline fail-fast. Failure does **not** flip individual `managed.status`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `managed.ha.failover`       | 600 s           | Per-cluster fence/recover step `{ managedId, sourceMemberId, targetMemberId, phase: 'drain' \| 'recover', … }`. Drain applies ProxySQL writer drain; recover calls Orchestrator recover-to after TurboPanel policy, then falls back to `managed.promote` if Orchestrator is absent or recover fails (`Recover: false` — TurboPanel still picks the candidate). `Future:` fail-closed HA lease. Consumer advances the `recovery` journal. Offline fail-fast.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Managed failure/timeout paths (`failed` / `timed_out` on apply, lifecycle,
destroy, promote, or **restore**) set `managed.status = 'failed'` without
altering terminal `command` row semantics. **`managed.backup` is the deliberate
exception** — it is read-only against the engine, so a failed/timed-out backup
leaves `managed.status` untouched. **`managed.ingress.reconcile`** and
**`managed.ha.reconcile` / `managed.ha.failover` failure** also
leave per-engine `managed.status` untouched unless the recovery journal is
already promoting that cluster (then the consumer marks the journal `failed`). Other command types still write
nothing beyond the terminal `command` row on failure (same resiliency contract
as deploy/stop — never revert an already-succeeded command).

**Organization CA & org TLS library (`tls` table):** organization-scoped
certificates (`upload` / `lets_encrypt` / `self_signed` / `organization_ca`) in
`src/lib/tls/`. Canonical Platform CA vs Organization CA boundary:
`../tls/AGENTS.md`. At most one **active** `organization_ca` per org (partial
unique `uniq_tls_organization_active_ca` where `ca_state = 'active'`; rotate
retires the prior row (`ca_state='retired'`, `status` stays `'ready'`), inserts
generation N+1 as `ca_state='active'`, and records a `changeover` journal). Hosting may pin `hosting.tls_id` to a library
cert, or leave null for **basic self-signed** (Caddy `tls internal`). Library
certs — including Let's Encrypt — are never auto-selected; the operator must pin
them. Private keys are sealed `tpsecret` envelopes at rest — never returned on
client GET. Deploy and managed Organization-CA-signed leaves re-seal via
`resealSecretForDaemon` to `tpdaemon(serverId, keyId)` for the target server →
payload `tlsMaterial[]` / `orgTlsMaterial`; daemon decrypts via
`POST /api/daemon/v1/secrets/decrypt` and writes files under
`/etc/turbopanel/tls/<tlsId>/` or managed / ProxySQL `tls/` PEMs. Managed apply
ensure-or-creates the active Organization CA (mint when missing), issues a leaf,
and attaches `orgTlsMaterial` so the daemon materializes ProxySQL PEMs without a
separate TLS wizard (`caCertPem` is the active+retired trust bundle; ProxySQL
`ssl_ca` and Postgres `ssl_ca_file` accept multi-PEM). **Ingress reconcile scopes Organization CA/leaf to the
server-owner org** so multi-org clusters on one host share a single frontend
identity for that server. LE rows start `metadata.status: pending` (not
selectable until ready). CRUD: `/api/client/v1/tls`; Organization CA
ensure-or-create **`GET /tls/ca`** (`{ tls, trustBundlePem }`), rotate **`POST /tls/ca/rotate`**
(lease-guarded journal + fan-out of existing **`managed.apply`** /
**`managed.ingress.reconcile`** plus binding rematerialize — no new command type,
no `environment.deploy`; see `../tls/AGENTS.md`), status **`GET /tls/ca/rotation`**,
retire-gate **`POST /tls/ca/retire`** (revokes retired generations only after every
tracked command `succeeded` and binding rematerialize rows are not failed;
`PATCH /tls/:id` `revoke:true` cannot revoke an Organization CA), PEM-only
download **`GET /tls/ca/download`** (concatenated active+retired bundle). **TurboFabric apply** ships via
`POST /organizations/:id/fabric/apply` → `server.fabric.reconcile` (see consumer
paragraph above). **Platform CA rotation** ships via admin public-URL apply /
explicit rotate → `server.tls.trust.reconcile` (`{ bundlePem, fingerprint,
allowRemoval? }`) to every connected server over the existing WSS session.
**Site deploy:** compose
`serviceKind: site` services are stripped into
`sites[]` (nginx, Apache, and OpenLiteSpeed all supported) —
hosting `options.web.php` (`version` / `memoryLimit` / `maxExecutionTime`) and
`options.web.env` merge into the site payload (`webEnv` / `php` on each site);
all three engines run PHP: nginx/Apache apply vendors php-fpm (never mod_php)
and writes pool `php_admin_value` for memory/time limits, reached via
`fastcgi_pass` / `mod_proxy_fcgi`; OpenLiteSpeed apply vendors `lsphp` and gives
each vhost its own LSAPI processor under suEXEC, with the same limits as
`phpIniOverride` values. One PHP series per host across all three engines —
conflicting `version` hints fail the deploy. `web.env` is still Apache-only
(`SetEnv`). When a project principal is assigned to the service,
deploy-prepare pins `sites[].principal` (at most one — else
**422** `site_principal_ambiguous`); the daemon owns the site tree as
that user (engine group retains read) and runs the site's PHP workers — FPM pool
or LSAPI process — as the principal. **Git-backed releases:** compose services declaring
`x-turbopanel.source` are resolved into payload **`sourceMaterial[]`**
(`{ sourceId, composeServiceName, provider, cloneUrl, ref, commitSha,
subdirectory?, credential?, releaseId, principal?, build }`)
by `src/client/environments/deploy-sources.ts` — GitHub refs resolve to a commit
via the REST API using a freshly minted installation token, which is then sealed
as the daemon-recipient `credential` envelope and discarded (never persisted,
never in `cloneUrl`). The same sole-principal rule applies (**422**
`source_principal_ambiguous`); a ref that cannot be pinned is **422**
`source_ref_unresolved`. Each entry's `commitSha` folds into **`desiredHash`**
so an unchanged commit stays a no-op and a moved one is not. The daemon checks
out, builds, and atomically promotes `<principalHome>/sites/<serviceId>/current`
(`turbopaneld/src/deploy/release/`) — it does **not** yet change how the service
is served or supervised. Payload **`dockerExternalNetworks[]`** lists compose
external network host names that must already exist as org `network` rows
(`kind: docker`, `options.dockerNetworkName`); the daemon ensures them with
`docker network create` before compose up. Mixed container + site
deploys rely on daemon-side `host.docker.internal` +
`TURBOPANEL_SITE_*` env injection — not instance payload fields. See
`../compose/AGENTS.md` and daemon `src/deploy/AGENTS.md`. Future: swarm-style
replicas — seams only.

Future webhook-triggered operations — deploy service, rebuild app, rotate tunnel
token, update daemon, restart service, collect diagnostics, stream logs — reuse
the same `command` table, `CommandQueue` abstraction, and typed-handler model on
the daemon. No new queue infrastructure is needed.

`src/lib/commands/` is pure TypeScript (no Deno/Workers-only imports) so it is
importable from both runtimes and the in-process consumer:

- `types.ts` — `CommandType`, `CommandStatus`, `TERMINAL_COMMAND_STATUSES`
- `schemas.ts` — per-type payload/result validators (`parseCommandPayload`,
  `parseCommandResult`)
- `envelope.ts` — `CommandEnvelope`, `encodeCommandEnvelope`,
  `parseCommandEnvelope`
- `hostname.ts` — `isValidHostname`, `assertValidHostname` (RFC-1123 allowlist;
  canonical — daemon mirrors it)
- `ids.ts` — `newCorrelationId()`, `nowIso()`
- `queue.ts` — `CommandQueue` interface, `getCommandQueue`
- `command-amqp-topology.ts` — Deno AMQP topology constants +
  `assertCommandAmqpTopology`
- `deno-amqp-queue.ts` — Deno RabbitMQ producer
- `workers-queue.ts` — Workers Cloudflare Queues producer
- `noop-command-queue.ts` — fallback when broker/binding unavailable
- `context.ts` — `commandContextFromPayload` (allowlisted, non-secret
  identifiers copied onto `command.context`) + `normalizeReplicaCounts` (the
  one structured value on the allowlist: a `service -> positive integer` map,
  kept durable so deploy-history detail can report replica counts after the
  `dispatch` payload is deleted)
- `consumer.ts` — `processCommandEnvelope` (shared consumer logic)
- `deno-consumer.ts` — `startCommandConsumer` (Deno in-process AMQP consumer)

DB helpers: `src/lib/db/command-records.ts` — `createCommandRecord`,
`getCommandRecord`, `listServerCommands`, `transitionCommand` — all return the
flat `CommandRecord` (mapped from real columns; no payload). Dispatch-payload
helpers live beside them: `getCommandDispatchPayload`, `deleteCommandDispatch`,
`retainCommandDispatch`, `sweepExpiredCommandDispatch`.

