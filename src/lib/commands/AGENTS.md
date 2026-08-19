# Command Pipeline — AGENTS.md

Typed, Postgres-canonical commands with queue transport only (Cloudflare Queues
on Workers, RabbitMQ on Deno), plus the correlated developer/admin request flows
(dev-sync, instance tunnel-token, public-URL apply) that ride the same
enqueue-then-poll contract. Live delivery/correlation lives in the daemon cell.

Root context: `../../../AGENTS.md`. Daemon cell (delivery +
`createRequestAndWait`/`waitForRequest`): `../../daemon/cell/AGENTS.md`. Compose
documents: `../compose/AGENTS.md`.

## Command Pipeline

Commands are canonical in Postgres (`command` table). Queues are transport only
— Cloudflare Queues on Workers, RabbitMQ on Deno. The Daemon Cell is live
delivery, presence, and request correlation only.

> **Cost / hibernation:** the command consumer enqueues a `command-dispatch`
> envelope into the cell outbox, then **polls** `waitForRequest` from the
> worker/Deno process — it never blocks inside the Durable Object. Do not add
> timers, polling loops, or long-lived promises inside `DaemonCellObject`; do
> not hold Hyperdrive connections open across handler returns. Never build
> general command queues inside Durable Objects — Cloudflare Queues / RabbitMQ
> own durable transport; the cell owns only the live WS outbox + pending-request
> row. Cloudflare Workers (Durable Object) mode and self-hosted Deno/Redis mode
> must keep behavioral parity for every command feature. Production daemon
> commands must be typed handlers — never arbitrary shell strings.

| Status        | Meaning                                             |
| ------------- | --------------------------------------------------- |
| `queued`      | Record created, envelope enqueued                   |
| `dispatching` | Consumer received, checking presence                |
| `sent`        | Envelope enqueued into cell outbox                  |
| `acked`       | Daemon sent `command-ack` (non-terminal)            |
| `running`     | Daemon executing (future use)                       |
| `succeeded`   | Terminal — `command-outcome ok:true` received       |
| `failed`      | Terminal — offline, validation error, or `ok:false` |
| `timed_out`   | Terminal — no outcome within `expires_at`           |
| `cancelled`   | Terminal — operator-cancelled                       |

`status`, `created_at`, `updated_at`, `attempts`, `name`, and `result` are real
columns on the `command` row. Granular lifecycle timestamps
(`queuedAt`…`finishedAt`, `expiresAt`) and `error` remain in `metadata`.
`transitionCommand` writes the column fields and merges the rest into `metadata`
atomically. `serializeCommandRecord` flattens both column and metadata fields
into a flat `CommandRecord` for callers. Organization is derived from the server
— there is no `organization_id` column on `command`. Do not store large logs or
streaming output in Postgres — `result` and `error` are bounded summaries only.

### Queue transport

- **Workers:** `TURBOPANEL_COMMAND_QUEUE` binding → per-env queue names in
  `wrangler.jsonc`: `live` uses `daemon-commands` / `daemon-commands-dlq`;
  `testing` uses `staging-daemon-commands` / `staging-daemon-commands-dlq`;
  local top-level worker uses `dev-daemon-commands` / `dev-daemon-commands-dlq`
  (max 3 retries). Declared under `queues.producers` and `queues.consumers`.
  Consumer handler: `queue(batch, env, ctx)` in `src/workers.ts`.
- **Deno:** `TURBOPANEL_AMQP_URL` (same URL as email queue, different topology).
  Exchange `turbopanel.commands`, queue `turbopanel.commands.dispatch`, routing
  key `command.dispatch`, DLX `turbopanel.commands.dlx` → DLQ
  `turbopanel.commands.dispatch.dlq`. Consumer: `startCommandConsumer()` in
  `src/lib/commands/deno-consumer.ts`, started in-process from `src/deno.ts`.
  **TODO:** extract to a dedicated `turbopanel-command-consumer.service` systemd
  unit in a future pass (mirrors the mailer pattern).
- Shared abstraction: `CommandQueue` interface in `src/lib/commands/queue.ts`;
  `getCommandQueue(c)` Hono accessor. Envelope schema in
  `src/lib/commands/envelope.ts` — small (ids + type + timestamps; no large
  payloads). The `CommandEnvelope` no longer carries `organizationId` — org is
  derived from the server at consume time.

### Client endpoints

| Method   | Path                                                       | Auth                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/client/v1/servers/:id/commands/ping`                 | session + read               | Create `daemon.ping` command, enqueue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST`   | `/api/client/v1/servers/:id/hostname`                      | session + manage             | Validate hostname, create `server.hostname.set` command, enqueue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST`   | `/api/client/v1/servers/:id/timezone`                      | session + manage             | Validate IANA timezone, persist `server.options.timezone`, create `server.timezone.set`, enqueue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST`   | `/api/client/v1/servers/:id/ntp`                           | session + manage             | Validate NTP payload, create `server.ntp.set` command, enqueue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST`   | `/api/client/v1/organizations/:id/fabric/apply`            | session + manage             | Force-reconcile TurboFabric membership (`server.fabric.reconcile`) on every org relay; `{ enabled: false }` teardown is PUT disable. Returns `{ fabricId, interfaceName: 'tp0', results[] }` (optional per-result `unreachablePeers`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PATCH`  | `/api/client/v1/organizations/:id/fabric/relays/:serverId` | session + manage             | Update relay role / advertised CIDRs / keepalive / endpoint pin / write-only PSK; then change-driven membership reconcile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST`   | `/api/client/v1/servers/:id/commands/reboot`               | session + manage             | Create `server.reboot` command, enqueue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST`   | `/api/client/v1/environments/:id/deploy`                   | session + manage             | Merge project+env ComposeDocuments → plan `task` rows → compile one runtime `compose.yaml` per participating server plus `.env` (non-secrets) and `secretPlan[]` (Compose standalone secret files). Multi-server TurboFabric deploys enqueue `server.fabric.reconcile` early (skipping already-converged relays) and **wait for membership convergence** (every participating relay has a public key **and** `appliedPayloadHash` matches the desired hash that includes peers, prefixes, and networks — after a key-filling command, follow-up peer payloads are enqueued and waited on too) **before** bumping `environment.generation`, replacing tasks, or enqueueing `environment.deploy` (`422 fabric_reconcile_failed` / `409 fabric_reconcile_pending`). Compose `network(kind='compose')` / `segment` rows created for the attempt are purged unless deployment-target writes succeed (command records and targets persist before queue delivery, so a mid-fan-out enqueue failure keeps spanning state and marks that server's target `failed`). Create `environment.deploy` on each (`409 server_placement_required` when no pin, default, or eligible host; **`422 turbofabric_required`** when the plan spans hosts without TurboFabric; **`422 variable_unresolved` / `variable_ref_invalid` / `variable_secret_interpolation`** for `{$…}` / `${SECRET}` failures; body `serverId` ignored). Optional body `noCache: true` is forwarded on the command payload so the daemon runs `docker compose build --no-cache --pull` before `up`. Response includes `commandId` (first) plus `commands[]`. Poll via existing command GET (Postgres only). **Service bindings** re-materialize as ordinary `variable` rows then auto-attach as secret files + `KEY_FILE` — they ride `variableMaterial[]` / `sealVariableMaterialForDaemon` with **no new command type**. |
| `GET`    | `/api/client/v1/environments/:id/deploy-preview`           | session + manage             | Same `prepareDeployCompose` path as deploy (idempotent allocation/registration); skips sealing; returns redacted compiled `compose.yaml` (`role: 'runtime'`) plus optional `servers[]`, `envFile` (non-secret values), and `secretPlan[]` (paths only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST`   | `/api/client/v1/environments/:id/lifecycle`                | session + manage             | Body `{ action: 'start' \| 'stop' \| 'restart' }`; fan-out `environment.lifecycle` to non-draining `deployment` rows, else the env pin / project default (`409 server_placement_required` when none). Non-destructive compose start/stop/restart. Poll via command GET.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST`   | `/api/client/v1/environments/:id/stop`                     | session + manage             | Fan-out `environment.stop` to the same target set as lifecycle; payload may include `fabricNetworks[]` (`tpn_*` names) because the instance drops compose `network`/`segment` rows after enqueue (host reclaim is best-effort). Daemon runs `compose down --volumes`, then removes those bridges; returns `{ commandId, serverId, commands[] }`. Poll via command GET.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST`   | `/api/client/v1/servers/:id/system/:component/restart`     | session + `system:operate`   | Create `system.reconcile` with `action: 'restart'` for the server's system hosting-ingress component (`hosting-ingress` today); returns `{ commandId, status, serverId }`. Poll via command GET.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE` | `/api/client/v1/projects/:id`                              | session + `organization:own` | Cascade-delete project children (`deleteProjectCascade`); **409** `project_has_running_services` when any non-stopped containers remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET`    | `/api/client/v1/servers/:id/commands/:commandId`           | session + read               | Poll status; ping includes latency breakdown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET`    | `/api/client/v1/servers/:id/commands`                      | session + read               | List recent commands (optional)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Authz: ping/get require read (`assertCanReadOr403`); hostname, timezone, ntp,
and reboot require manage (`assertCanManageOr403`). Daemon authz must not leak
into these session-authenticated routes.

### Consumer behavior

`processCommandEnvelope` in `src/lib/commands/consumer.ts` is the single source
that writes terminal `command` rows. The WS inbound path (`command-ack`,
`command-outcome`) only updates the hot `PendingRequestRecord` in the cell. For
MVP, `daemon.ping`, `server.hostname.set`, `server.timezone.set`,
`server.ntp.set`, `server.fabric.reconcile`, `server.reboot`,
`environment.deploy`, `environment.lifecycle`, `environment.stop`,
`managed.apply`, `managed.lifecycle`, `managed.destroy`, `managed.backup`,
`managed.restore`, `managed.promote`, `managed.ingress.reconcile`,
`managed.ha.reconcile`, `managed.ha.failover`, and
`system.reconcile` fail fast when the daemon is offline. For
`server.hostname.set` success, the consumer calls `touchServerMetadata` to
update the `server.hostname` column — the instance never updates hostname
speculatively. For `server.timezone.set` / `server.ntp.set` success, the
consumer writes observed timezone/NTP state onto the dedicated `server.timezone`
/ NTP columns so the read model refreshes before the next heartbeat. For
`server.fabric.reconcile` success with `enabled: true`, the consumer stamps
`relay.public_key` from the result (private key never leaves the host), records
`relay.metadata.appliedPayloadHash` / `appliedAt` / `observed` from the daemon
`peers[]`, and when that fills a previously-null key calls
`reconcileFabricMembership` so peers learn the new key without unbounded fan-out
(hash-gated). Stamp-match skips (`skipped: true`) still stamp the public key and
desired hash when the result includes a valid `publicKey` — returning early
solely because `skipped` is set would leave membership unconverged and
re-enqueue until timeout. Disable payloads (`{ enabled: false }`) skip the stamp
— they tear down `tp0`, routed bridges, `TP-FORWARD`, keys, and state. Reconcile
failures clear the applied hash so the next pass retries.

**TurboFabric gateway/member model:** relays are `role = 'gateway' | 'member'`.
Members always get a host `/32` route. Gateways also advertise `advertisedCidrs`
(datacenter LAN CIDRs); an empty gateway `advertisedCidrs` now resolves to the
derived **IPv4** subnets of that relay's datacenters (operator-set list wins
verbatim). Apply returns **422** `gateway_datacenter_required` /
`gateway_datacenter_cidr_required` when a gateway lacks a datacenter or that
datacenter has no subnet at all (`gateway_datacenter_cidr_required` now means
"that datacenter has no subnet at all"). `POST /organizations/:id/fabric/apply`
force-reconciles every relay; PUT disable tears down the mesh and reclaims
`network(kind='compose')` / `segment` rows. Overlay addresses auto-allocate from
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
`EnvironmentDeployComposeFile[]`. New deploys send a **single**
`{ filename: 'compose.yaml', role: 'runtime', source: 'inline', content }` entry
— that is the file the daemon writes under
`/var/lib/turbopanel/deployments/<projectId>/<environmentId>/` next to `.env`
(non-secrets, mode `0640`) and `deployment.json` (includes `secrets[]` plan, no
plaintext). Older queued commands may still carry a project → environment →
platform chain (`role: 'project' | 'environment' | 'platform'`). Each entry is
`{ filename, role, source?: 'inline' | 'repository', path?: string, content }`:
`filename` must match `COMPOSE_FILE_NAME_RE` (`/^[A-Za-z0-9._-]+\.ya?ml$/`,
basename-only). The deprecated top-level **`composeYaml`** field is the same
compiled body (legacy single-file fallback). Secret values never enter durable
YAML: `secretPlan[]` + `variableMaterial[]` (`tpdaemon` envelopes;
`sealVariableMaterialForDaemon` always reseals plaintext) materialize files
under `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/` (mode
`0600`). Build secrets use Compose `build.secrets`, not `build.args`. The
last-applied plan is also stored on `deployment.options.secretPlan` for boot
rehydrate (`POST /api/daemon/v1/deployments/secrets/rehydrate`). Optional
payload fields `generation`, `desiredHash`, `replicaCounts`, and `serverId`
identify the per-host snapshot.

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
The daemon reserves the platform defaults (`15432` / `16306`) **and** these
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
stay on the shared loopback Traefik via Docker labels only. Deploy-preview
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
snippet, deletes the deployment dir, and `rm -rf`s the matching
`/run/turbopanel/deployments/<projectId>/<environmentId>/secrets` tree
(`turbopaneld/src/instance/commands/stop-environment.ts`). Idempotent when the
compose file is already gone. Used as the teardown gate before project cascade
delete. **Contrast with `environment.lifecycle`:** stop is **destructive
teardown** (`down --remove-orphans --volumes`, hosting site + deployment dir +
`/run` secrets removed, `containers: []` clears pins); lifecycle is
**non-destructive** (`compose start|stop|restart`, files/volumes/deployment dir
preserved, container rows keep their ids). Lifecycle `start`/`restart` rehydrate
missing `/run` secret files first.

`environment.lifecycle` uses a 120s consumer timeout. On success the consumer
reconciles the daemon's authoritative `compose ps -a` report through
`reconcileEnvironmentContainers` (live rows update pins rather than clearing
them). An omitted `containers` field means collection failed and nothing is
reconciled. Failures write nothing beyond the terminal command row.

`system.reconcile` uses a **300 s** consumer timeout (self-heal may pull the
Traefik image). Offline fail-fast applies. The component set is
`hosting-ingress | managed-ingress | managed-ha | database | queue | analytics` — each
`SystemReconcileComponent` carries a `role` (`'ingress'` for the shared
per-server Traefik, `'turbopanel'` for managed-ingress ProxySQL, managed-ha
Orchestrator, and the
co-located self-host database/queue/analytics services) and a per-component
`containerName`: `hosting-ingress` → `<serviceId>-in`, `managed-ingress` →
`<serviceId>-sql`, `managed-ha` → `<serviceId>-ha`,
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
intentionally stops the shared `turbopanel-ingress` compose project; ordinary
`desired: 'absent'` + `action: 'reconcile'` stays report-only). Triggers:
hosting enable (`PATCH /servers/:id` → `reconcile`), hosting disable (`PATCH` →
`stop` scoped to hosting-ingress), operate restart
(`POST /servers/:id/system/:component/restart` — hosting-ingress only, see
`SYSTEM_OPERATE_COMPONENTS`), and a storage-free drift sweep (Workers
offline-sweep cron + Deno maintenance timer) that enqueues for connected servers
where either the hosting-ingress row needs heal **because demand/observation
exists** (and is not running, missing a Docker id, or the server recently
reconnected), **or** a self-host `database`/`queue`/`analytics` system-role
container is not running or missing a Docker id, throttled to one enqueue per
**server** (not per environment — one sweep hit still fans out to every system
environment) per **5 minutes** via the `command` table itself
(`actorType: 'system'`, `actorId = serverId` for sweep-driven rows —
`command.actor_id` is a uuid with no FK). Never enqueue from `onDaemonConnected`
/ Durable Object handlers. See `../../client/system/hierarchy.ts` (provisioning)
and `../../client/system/reconcile.ts` (payload/sweep); production inventory
rationale lives in `../../../AGENTS.md` → "Self-host system inventory".

**Managed engine commands** (compose + config + credentials are generated by the
platform — never conflate with `environment.deploy` hosting ingress). Like
TurboFabric membership reconcile, **apply / lifecycle / destroy fan out one
command per managed cluster `node` server**; each payload carries `memberId` /
`memberRole` / `memberOrdinal` / `readEligible` / `peers[]` (private endpoints
to other members). Exposure no longer ships an `ingress` identity on the payload
— shared ProxySQL is reconciled separately:

| Type                        | Timeout         | Success side-effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed.apply`             | 600 s           | Sets `managed.status = 'ready'`. When `memberRole` is `primary`, also pins `managed.server_id` and merges `metadata.host` / `metadata.port` (replica successes never re-home the primary pin). Reconciles `containers[]` for every member when reported. Optional `privateListener` / `replication` on multi-member clusters; `privateListener.transport` (`local` \| `datacenter` \| `fabric` \| `public`, omitted = not public) tags the resolved bind so a **`public`** listener is refused by the daemon without `orgTlsMaterial` and is firewall-scoped to known peers; result `member` health projects onto `node`. Optional `tlsMaterial` / `orgTlsMaterial` for engine + ProxySQL TLS. Apply-prepare ensures the org CA leaf (with member SANs), replication principal, and per-member config. **HTTP returns after the primary command is queued** — multi-member `pendingStandbyApplies` ride command `metadata` and the consumer enqueues standby applies only after primary success. After apply, the instance may enqueue **`managed.ingress.reconcile`**. |
| `managed.lifecycle`         | 120 s           | Projects daemon-observed `result.status` onto `managed.status` (`ready` / `stopped` / `failed`) — never infers status from the requested action. Optional `memberId` for fan-out; optional `engine` (postgres\|mysql\|mariadb) so the daemon resolves the correct runtime for member health (absent → postgres for in-flight older commands). Result may include `member` replication health for projection. Promote path fences via `stop` with **`followUpPromote` metadata** — consumer enqueues `managed.promote` only after fence success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `managed.destroy`           | 300 s           | Projects daemon-observed `result.status`, always returns `containers: []`, and reconciles pins clear. `deleteAfterDestroy` is stamped only on the **primary** member's command so the `managed` row is deleted once. Member DELETE uses **`deleteMemberAfterDestroy`**: the member stays visible (`applying`) until destroy succeeds (then deleted + optional `pendingPrimaryReapply`); destroy failure marks the member `failed` (retryable). Follow-up **`managed.ingress.reconcile`** drops destroyed clusters from ProxySQL desired state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `managed.promote`           | 600 s           | Enqueued to a replica with `{ managedId, memberId, demoteMemberId?, engine? }`. Optional `engine` selects the promotion runtime (default postgres when omitted). Sets `managed.status = 'applying'`. Lag/health gate (or `{ force: true }` on a **failover** replica only). Read-class promotion uses the disaster-recovery HTTP route, not this command's class bypass. On success: flip roles from `result.promotedMemberId`, demote → `needs_resync`, re-point `managed.server_id`, set `ready`, then fan-out ingress + HA reconcile. Failure/timeout → `failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `managed.backup`            | 1800 s (30 min) | `action: 'create'` success reads `managed.options`, appends a `ManagedBackupRecord` (`id`, `createdAt`, `sizeBytes`, `checksum`, `database?`, `path`) built from the result, drops any ids in `result.pruned`, caps the list, and writes back (read-modify-write; log-only on failure, never reverts the succeeded command). `action: 'delete'` success just removes that id from the list. **Does not** set `managed.status = 'failed'` on failure — a read-only backup failure must never mark a healthy engine failed (see asymmetry note below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `managed.restore`           | 1800 s (30 min) | Success projects `managed.status = 'ready'` via `projectManagedObservedStatus` (the engine's data changed, so status is reasserted even though it was likely already `ready`). Failure/timeout **does** set `managed.status = 'failed'` — a failed restore leaves the engine's data in an uncertain state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `managed.ingress.reconcile` | 300 s           | **Whole-server** ProxySQL desired state only — not per-managed-id. Payload: `serverId`, optional `bindAddresses`, `clusters[]` (each cluster: `managedId`, `engine`, `protocolPort` 15432\|16306 with legacy 5432\|3306 accepted for skew, writer/reader hostgroups, `backends[]`, `users[]` with passwords resealed for **this** server's daemon key), plus optional `orgTlsMaterial` scoped to the **server-owner organization** (the org that owns `server.organization_id` — may differ from a grant-placed project's org). Empty `clusters[]` (no TLS) tears the stack down. Daemon writes compose + full `proxysql.cnf`, materializes TLS under `configDir/proxysql/tls/`, restarts only when static listener section changes, otherwise admin-applies users/servers/rules. Success may reconcile the `managed-ingress` system container when reported. **Never** embeds on `managed.apply`. Offline fail-fast. Failure does **not** flip individual `managed.status` (ingress is server-scoped infrastructure).                                                    |
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

**Org TLS library (`tls` table):** organization-scoped certificates (`upload` /
`lets_encrypt` / `self_signed` / `organization_ca`) in `src/lib/tls/`. At most
one **active** `organization_ca` per org (partial unique
`uniq_tls_organization_active_ca` where `status != 'revoked'`; rotate marks the
prior row revoked). Hosting may pin `hosting.tls_id` to a library cert, or leave
null for **basic self-signed** (Caddy `tls internal`). Library certs — including
Let's Encrypt — are never auto-selected; the operator must pin them. Private
keys are sealed `tpsecret` envelopes at rest — never returned on client GET.
Deploy and managed CA-signed leaves re-seal via `resealSecretForDaemon` to
`tpdaemon(serverId, keyId)` for the target server → payload `tlsMaterial[]` /
`orgTlsMaterial`; daemon decrypts via `POST /api/daemon/v1/secrets/decrypt` and
writes files under `/etc/turbopanel/tls/<tlsId>/` or managed / ProxySQL `tls/`
PEMs. Managed apply ensure-or-creates the active org CA (mint when missing),
issues a leaf, and attaches `orgTlsMaterial` so the daemon materializes ProxySQL
PEMs without a separate TLS wizard. **Ingress reconcile scopes CA/leaf to the
server-owner org** so multi-org clusters on one host share a single frontend
identity for that server. LE rows start `metadata.status: pending` (not
selectable until ready). CRUD: `/api/client/v1/tls`; org CA ensure-or-create
**`GET /tls/ca`**, rotate **`POST /tls/ca/rotate`**, PEM-only download
**`GET /tls/ca/download`**. **TurboFabric apply** ships via
`POST /organizations/:id/fabric/apply` → `server.fabric.reconcile` (see consumer
paragraph above). **Traditional-web deploy:** compose
`serviceKind: traditional-web` services are stripped into
`traditionalWebSites[]` (nginx, Apache, and OpenLiteSpeed all supported) —
hosting `options.web.php` (`version` / `memoryLimit` / `maxExecutionTime`) and
`options.web.env` merge into the site payload (`webEnv` / `php` on each site);
Apache apply vendors php-fpm + mod_proxy_fcgi (never mod_php) and writes pool
`php_admin_value` for memory/time limits (OpenLiteSpeed is static-only — no
PHP/env hints yet). When a project principal is assigned to the service,
deploy-prepare pins `traditionalWebSites[].principal` (at most one — else
**422** `traditional_web_principal_ambiguous`); the daemon owns the site tree as
that user (engine group retains read) and runs Apache php-fpm workers as the
principal. Payload **`dockerExternalNetworks[]`** lists compose external network
host names that must already exist as org `network` rows (`kind: docker`,
`options.dockerNetworkName`); the daemon ensures them with
`docker network create` before compose up. Mixed container + traditional-web
deploys rely on daemon-side `host.docker.internal` +
`TURBOPANEL_TRADITIONAL_WEB_*` env injection — not instance payload fields. See
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
- `consumer.ts` — `processCommandEnvelope` (shared consumer logic)
- `deno-consumer.ts` — `startCommandConsumer` (Deno in-process AMQP consumer)

DB helpers: `src/lib/db/command-records.ts` — `createCommandRecord`,
`getCommandRecord`, `listServerCommands`, `transitionCommand` — all return the
flat `CommandRecord` (flattened from both real columns and the `metadata` jsonb
blob).

### Dev sync (push a daemon build without git)

`src/developer/dev-sync.ts` tars the local `../turbopaneld` checkout,
base64-encodes it, and streams `dev-sync-begin` → `dev-sync-chunk*` →
`dev-sync-end` over the daemon WS; the daemon unpacks, `deno cache`s, replies
`dev-sync-result`, and restarts. Developer routes:
`POST /api/developer/v1/daemon/:id/sync-dev` and `…/daemon/sync-dev` (all). Dev
console: **Sync source to attached checkouts**. Managed remotes (no checkout)
skip source-sync; upgrade them with **Rebuild daemon and upgrade connected
servers** (`POST /api/developer/v1/daemon/update` after `deno task release:dev`
writes the overlay catalog). Co-located is skipped on both paths.

### Instance Cloudflare tunnel

`POST /api/developer/v1/instance/tunnel-token`
(`src/developer/tunnel-routes.ts`) sends a `tunnel-token` WS message to the
co-located daemon, which writes `cloudflared/tunnels/instance.token` and
(re)starts cloudflared. External remote daemons then reach this instance via the
tunnel → Caddy → socket. Dev console: **Save Tunnel Token** in the fleet section
(empty token tears it down).

Correlated outbound work uses `createRequestAndWait` / `waitForRequest` (see
**Enqueue-then-poll request contract** above) for dev-sync, tunnel-token,
public-urls apply, and managed logs (`managed-logs-request` /
`managed-logs-result` — logs stay off the command `result` column).

### Public URL apply

**Public URL apply**: `POST /api/admin/v1/instance/public-urls/apply` (Deno
only) sends a `public-urls-update` WS message to the co-located daemon with the
current URL list. The daemon writes `TURBOPANEL_PUBLIC_URLS` to
**`/etc/turbopanel/instance/runtime.env`** — never the checkout, re-runs the
`instance-certs` Ansible role (regenerating the leaf cert with updated SANs, CA
preserved), and reloads `turbopanel-caddy`. Replies with
`public-urls-update-result { ok, error? }`. On Workers, the endpoint returns 422
(cert apply not applicable). Timeout: 60 s.

```mermaid
sequenceDiagram
    participant UI
    participant Instance as Instance API (Deno)
    participant Cell as Daemon Cell (Redis)
    participant Daemon as Co-located Daemon

    UI->>Instance: POST /api/admin/v1/instance/public-urls/apply
    Instance->>Instance: setPublicUrls(db, urls)
    Instance->>Cell: enqueue public-urls-update envelope
    Cell->>Daemon: WS: { type: "public-urls-update", urls }
    Daemon->>Daemon: write runtime.env, run instance-certs, reload caddy
    Daemon->>Cell: WS: { type: "public-urls-update-result", ok }
    Cell->>Instance: PendingRequestRecord { status: "done" }
    Instance-->>UI: { ok: true, applied: true }
```
