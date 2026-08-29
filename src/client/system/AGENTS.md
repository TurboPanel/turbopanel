# System components & inventory (`src/client/system`) — AGENTS.md

Repo-wide rules: `../../../AGENTS.md`. Covers the self-host platform
component inventory (what is `container`-tracked vs host-native) and the
container name suffix contract.

Co-located (self-hosted) installs run a fixed set of platform components on the
same host as the instance. Some of them are Postgres/`container`-tracked
inventory managed by the daemon; the rest stay host-native and are never
represented as `container` rows.

| Component                                                         | Today                                | Decision                                                        | Inventory                                |
| ----------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- | ---------------------------------------- |
| PostgreSQL                                                        | `docker run turbopanel-database`     | Compose service `database`                                      | service + container row                  |
| RabbitMQ                                                          | `docker run turbopanel-queue`        | Compose service `queue`                                         | service + container row                  |
| ClickHouse                                                        | `docker run turbopanel-analytics`    | Compose service `analytics`                                     | service + container row                  |
| ProxySQL (managed DB ingress)                                     | daemon compose, project = its own `serviceId` | Compose service `proxysql` / system component `managed-ingress` | service + container row when provisioned (`role: 'ingress'`, `<serviceId>-in`) |
| Control plane (`turbopanel-instance.service`)                     | systemd + Deno                       | stays host-native                                               | none                                     |
| Control-plane Caddy                                               | vendored binary                      | stays host-native                                               | none                                     |
| Hosting Caddy                                                     | vendored binary + systemd            | stays host-native                                               | none                                     |
| `turbopaneld.service`                                             | native / Deno JS                     | stays host-native                                               | none                                     |
| Redis                                                             | vendored `.deb`, unix socket         | stays host-native                                               | none                                     |
| Mailer, dbstudio, Expo UI, website, mailpit, tabix, redis-insight | systemd / dev-only                   | excluded                                                        | none                                     |

`project.metadata.component` maps to project display names (`src/client/system/hierarchy.ts` — single source of truth): `hosting-ingress` → HTTP/HTTPS Ingress, `managed-ingress` → Database Ingress, `managed-ha` → Database High-Availability, `turbopanel` → Self Hosted TurboPanel Instance.

The three databases/brokers above are provisioned into the `turbopanel-system`
Compose project (see daemon `src/deploy/AGENTS.md` → **Shared HTTP ingress
identity**) so their container identity/status is inspectable through the same
`container` table and client `GET /api/client/v1/containers` surface as tenant
deploys — with `role: 'turbopanel'` and `service.composeServiceName` in
`database` / `queue` / `analytics`. They remain **inspect-only**: the daemon
reports their `docker compose ps` identity for inventory but never starts,
stops, or self-heals them (no restart-via-`system.reconcile` path — see
`SYSTEM_OPERATE_COMPONENTS` in `src/client/system/routes.ts`, which only lists
`hosting-ingress`).

**ProxySQL / managed-ingress** is a separate compose project — the allocated
`managed-ingress` `serviceId` — under `/etc/turbopanel/proxysql/`. Ansible role
`proxysql` installs host prerequisites (dirs, `admin.cnf`, base static
`proxysql.cnf` when absent, `turbopanel-proxysql-stack.service`). It does
**not** create the organization's managed Docker network and does **not**
template a project name: both are control-plane-allocated identifiers Ansible
cannot know at converge time. The **daemon** writes `docker-compose.yml` and
the durable dynamic config on `managed.ingress.reconcile` (creating the managed
network first) and can self-heal via `system.reconcile` (`selfHeal: proxysql`).
It is **not** part of `turbopanel-system` and is **not** inspect-only. The
inventory container is `role: 'ingress'` named `<serviceId>-in` — distinct from
the bare-uuid `turbopanel-system` rows and from the `-ha` Orchestrator. Client
SQL enters ProxySQL's published `15432`/`13306` listeners; managed engines never
publish arbitrary host ports. When a binding consumer is not co-resident,
ProxySQL also joins the organization's managed network **plus each consuming
environment's spanning `tpn_*` network** (pinned to the reserved last-usable
host address). Tenant docker-compose raw TCP/UDP Traefik remains a separate
pattern (compose project = the bare `<serviceId>`). Managed-network naming:
`src/lib/db/AGENTS.md` → `network` `kind: 'managed'`.

## Container name suffix contract

Canonical mapping (implementation: `src/lib/naming.ts`):

| Container name | Who | `container.role` |
| --- | --- | --- |
| `<serviceId>` | single-instance tenant service; self-host stack (`database` / `queue` / `analytics`) | `service` / `turbopanel` |
| `<serviceId>-<ordinal>` | multi-instance tenant service; **all** managed engine members (including a lone primary) | `service` |
| `<serviceId>-in` | per-service/hosting Traefik **and** shared ProxySQL `managed-ingress` | `ingress` |
| `<serviceId>-ha` | per-org Orchestrator `managed-ha` (documented exception) | `turbopanel` |

Two different components legitimately land on `-in` / `role: 'ingress'` — the
shared HTTP Traefik (`hosting-ingress`) and the shared ProxySQL
(`managed-ingress`) — so **the suffix alone never disambiguates them**. What
does: the `com.turbopanel.system.component` label, and the **compose project**,
which is each component's own allocated `serviceId`. Both projects are bare
UUIDs; there is no `turbopanel-ingress` / `turbopanel-proxysql` literal to key
off. Only the self-hosted instance stack keeps a human-readable project name
(`turbopanel-system`).

**Why instance/Caddy/daemon/Redis stay host-native rather than joining the
compose stack:**

- The control plane needs `pamtester`/PAM to gate the self-hosted install
  wizard, `systemctl`/`git` access to check for and apply trunk updates, and
  ownership of `/run/turbopanel/instance.sock` at a specific uid/gid so the
  co-located daemon can connect — none of that is available to a process running
  inside a container.
- The daemon itself runs Ansible (which provisions the compose stack) — it
  cannot be a container the daemon manages, and it needs host-level `systemctl`
  control over every other unit.
- Both Caddy units terminate TLS and bind privileged/host ports directly and are
  simplest to keep as vendored host binaries under systemd, matching the
  daemon's own vendored-runtime model.
- Redis is reached over a unix socket (`redis.sock`) with permissions scoped to
  the dev user / `tpcache` group — a socket-permission model that is simpler to
  keep host-native than to thread through a container network.

**Bootstrap ordering:** Self-hosted install creates the **TurboPanel**
workspace (`kind='turbopanel'`) inside the install transaction — before any
daemon enrolls. Self-host project/environment/services still wait on the
colocated server (`ensureSelfHostSystemHierarchy`). Then `docker compose up`
(with the labels below) runs via the `system-compose` Ansible role → the
hierarchy allocates the `service` / `container` rows and assigns each service a
UUID → a `system.reconcile` command carries that allocated `serviceId` (as the
compose service's container name) to the daemon → the daemon inspects
`docker compose ps` by the `com.turbopanel.system.component` label and reports
identity/status back by container name. Inventory rows exist before the daemon
ever inspects the stack; the daemon never invents ids.

The first reconcile is **not** operator-driven. After hierarchy is created,
`completeInstanceInstall` enqueues `system.reconcile` from the install request
when the colocated daemon is already connected (typical co-located / Vagrant
dev: daemon hello'd before the wizard). It must **not** enqueue while
`server.is_connected` is false — a fail-fast offline command would trip the
5-minute sweep throttle. Deno boot also runs `runSystemReconcileSweep`
immediately (then every `DAEMON_CELL_MAINTAIN_MS`) so a daemon that hello's
after install is observed on the next tick without waiting a full minute.
Never enqueue from `onDaemonConnected` / Durable Object handlers. Until that
inspect lands, client rows stay allocator `pending` with no Docker id — the UI
shows **Not started yet** / **Unknown** even when `turbopanel-database` is
already up.

**Co-located delete / license revoke:** Server delete and license revoke are
guarded by the durable self-host environment pin (the server that owns the
`turbopanel` system environment), not only live registry / machine-id probes —
so neither succeeds while the daemon is offline or the registry is unavailable.

**Status / restart surface:** host-native components (Caddy, Redis, the
instance, `turbopaneld`) have no `container` row and therefore never appear in a
project/environment container table. Their health/restart affordances belong on
the server **Control** tab / a system-component control API (e.g.
`POST /servers/:id/system/:component/restart`, scoped to `hosting-ingress`
today) — never bolted onto the tenant containers list.

