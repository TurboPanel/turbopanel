# Client API (`src/client`) — AGENTS.md

Route modules for the versioned client REST surface (`/api/client/v1/*`), one
directory per resource. Authz engine and permission catalog live in `authz/`
(engine docs: `../db/AGENTS.md` → **Authz engine** / **Catalog**; authn
flows: `authn/AGENTS.md`). The tables below are the per-endpoint permission
contract — keep them current when adding or changing routes.

## Client API (authz integration)

| Method   | Path                                                            | Purpose                                                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST`   | `/api/client/v1/invitations`                                    | Create a pending invitation (`canInviteToTeam`); optional `grants` require `organization:own`; emails the accept link (`/accept-invitation?token=<secret>`; the secret is stored only as `token_hash` and never returned); **409** `invitation_pending`, **503** `email_unavailable` |
| `GET`    | `/api/client/v1/invitations`                                    | List pending, unexpired invitations across the org's teams (`organization:manage`); `{ invitations: [{ id, email, teamId, teamName, expiresAt, createdAt, invitedBy }] }`                                                                                                            |
| `DELETE` | `/api/client/v1/invitations/{id}`                               | Revoke a pending invitation (`canInviteToTeam`); atomic `pending` → `revoked`; **404** if missing or not pending                                                                                                                                                                     |
| `POST`   | `/api/client/v1/invitations/{id}/accept`                        | Accept a pending invitation; atomically claims the row, adds team membership, materializes `invitation.grants` into `permission` rows when present (null/omitted grants confer none), updates session `organizationId`                                                               |
| `GET`    | `/api/client/v1/permissions`                                    | Permission catalog — static, no DB query (any authenticated user)                                                                                                                                                                                                                    |
| `GET`    | `/api/client/v1/access?resourceId=<uuid>`                       | List access grants for a resource; returns `{ access: AccessRecord[] }` with `subjectKind`, `subjectId`, `resourceId`, `effect`, and `permissionKey`                                                                                                                                 |
| `GET`    | `/api/client/v1/access/check?resourceId=<uuid>&permissionKey=…` | Check a single permission for the signed-in user; returns `{ allowed: boolean }`                                                                                                                                                                                                     |
| `GET`    | `/api/client/v1/access/resource-id?kind=<kind>&itemId=<uuid>`   | Resolve `resourceId` for an entity in the session org; returns `{ resourceId, kind, itemId }`                                                                                                                                                                                        |
| `POST`   | `/api/client/v1/access`                                         | Create an access grant; body: `{ subjectKind, subjectId, resourceId, effect, permissionKey }`                                                                                                                                                                                        |
| `DELETE` | `/api/client/v1/access/{id}`                                    | Revoke an access grant                                                                                                                                                                                                                                                               |

The full per-route table (100+ routes: method, path, permission, behavior) is
maintained in [`routes-contract.md`](./routes-contract.md) — **update it when
adding or changing a route.** The rules it encodes:

- List and get enforce visibility via `listVisible` / org-level grant checks
  **in SQL** — never client-side.
- Create, update, and delete require `organization:own` or `organization:manage`
  on the entity's org, via `can()`.
- All create/delete operations run entity insert/delete in a single transaction.

## Client surface feature notes

Per-feature behavior contracts for the client surface (moved from the root
`AGENTS.md` **API / WS surfaces** section). Keep current when endpoint behavior
changes.

- **Tunnel provider accounts (client surface):** `GET|POST /organizations/:id/carriers`,
  `DELETE /organizations/:id/carriers/:carrierId` (409 `carrier_in_use` while a
  tunnel uses it), `GET|POST .../carriers/:carrierId/badges`,
  `DELETE .../badges/:badgeId`, `POST .../badges/:badgeId/check`. All
  `organization:manage`. A token is write-only: checked with the provider,
  sealed into `secret`, never returned (responses carry a label and the last
  four characters; audit rows carry neither). `POST .../carriers/connect`
  takes only the API token, lists the accounts it reaches and connects the
  chosen one (the only one, else `accountIds`; 409 `account_choice_needed`). Adding one is refused with
  `badge_rejected`, `badge_wrong_account` or `badge_not_useful` (names the
  missing permissions); 502 `provider_unavailable` when the provider cannot be
  reached. See `src/features/tunnels/AGENTS.md`.
- **Org activity feed (client surface):** `GET /organizations/:id/activity` —
  every deploy / restart / stop command across the org, newest first, whatever
  the outcome (queued, running, succeeded, failed, timed out, cancelled, rolled
  back), polled by the console (nothing is pushed). Deploy rows are never
  pruned, so this is the whole deploy history. `?filter=all|deploying|succeeded|failed`
  (`deploying` = still in progress; `failed` includes timed out and rolled
  back; `crashing` / `crashed` are **not served**: no restart count is
  recorded; an unknown filter is **400**), optional `projectId` /
  `environmentId` (uuid, else **400**), `limit` 1–100 (default 50, larger
  clamps), `offset`. Returns `{ ok, items, total, totalCapped, hasMore }`:
  `total` is counted at most 1000 rows past the page (`totalCapped` says there
  are more). Each item carries `state` + `failure`, `finishedAt`, `actorType` /
  `actorName` (a current member's name or email; otherwise `Platform Admin` for an instance administrator or `Former Member`), the push `trigger` (`branch`, `commitSha`, `sourceId`, and `pushedBy`: the pusher's git login, `null` when unknown) and the `commit` (first recorded release,
  else the pushed SHA); `step` / `totalSteps` / `stepLabel` come from the
  daemon's step plan on `command.progress` (`null` until it reports one);
  `crashCount` is always `null` until restart counts are recorded. Gate as the
  members list: unreachable org or bad uuid **404**, no owner/manager rights
  **403**; rows are limited to `listVisible(server)` and to servers of the
  **path** org (never the active-org header). Reads `command` only (never
  `dispatch`); the organization comes from `command.organization_id` (copied
  from the server). Backed by `idx_command_activity`; the page orders `DESC NULLS LAST` to match the indexes (a plain `DESC` forces a sort of the whole organization).
  `features/commands/activity-query.ts`.
- **Server timezone / NTP (client surface):** daemon hello + change-detected
  heartbeats persist `timeSync` onto `server.timezone` / `is_time_sync_enabled`
  / `ntp_servers` / `ntp_last_synced_at`, and nest addresses on
  `server.metadata.resources.ips` (legacy top-level `ips` still accepted).
  Host inventory is `server.metadata.resources.cpus[]` (per-socket
  `vendorId` / `cores` / `threads` / `cache` / clocks, also re-sent on a
  heartbeat when the online CPU set changes) and hello-only `gpus[]`; leftover
  `resources.cpu` is lifted on read. Docker CLI / Compose plugin versions
  project onto `server.metadata.docker` the same way, but **only when Docker is
  installed** (the key is omitted otherwise). `GET /api/client/v1/servers` and
  `GET /servers/:id` return those facts plus an **effective timezone** =
  `server.options.timezone` unless `organization.options.enforceServerTimezone`
  is true (then org `defaultServerTimezone` wins; otherwise the daemon-reported
  `server.timezone` column). Commands: `POST /servers/:id/timezone`
  (`server.timezone.set`, also persists the server override) and
  `POST /servers/:id/ntp` (`server.ntp.set`) — manage-gated, create-then-poll.
  Org record: `GET`/`PATCH /organizations/:id` — GET is access-gated (same
  visibility as the org list: team membership, owner/manager grant, or platform
  admin; missing or inaccessible → **404**); PATCH is manage-gated (`{ name }`
  required, any characters except control characters, ≤255, cannot clear; names
  are not unique). Returns `{ organization }` / `{ ok, organization }`. Org
  defaults: `GET`/`PUT /organizations/:id/default-timezone`. Picker source:
  `GET /timezones` (`listTimezones()` / `isAllowedTimezone()`). Detail rows use
  the `server-detail` cached read model (mirrors `servers-list`).
- **Host defaults (client surface):** org → datacenter → server cascade stored
  in existing `options` jsonb (`src/features/servers/host-defaults.ts`). Most specific
  configured value wins; SSH falls back to **22**. Keys: `sshPort` (1–65535),
  `ntp` (`enabled` / `servers` / `fallbackServers` — desired config, not
  observed `timeSync`), `defaultFabricEnabled` (**organization only**; a
  preference that does **not** create or tear down the mesh). Timezone stays on
  its own enforce resolver (`resolveEffectiveServerTimezone`) — do not add a
  soft timezone default into this cascade.
  `GET`/`PUT /organizations/:id/host-defaults` is manage-gated (jsonb `||`
  merge; JSON `null` clears a key). Datacenter `PATCH` **replaces** parsed
  `options` (UI must `mergeDatacenterOptions`). Server `PATCH options.sshPort` /
  `ntp` (`null` inherits). List/detail expose effective `sshPort` /
  `sshPortSource` / `ntpDefaults` / `ntpDefaultsSource`; detail also adds
  `datacenterDefaultTimezone` / `datacenterEnforceServerTimezone`. Saving
  defaults does **not** rewrite sshd or enqueue NTP/timezone commands.
  `hideWebServerNames` (organization and server layers only; no migration, same
  `options` jsonb) is on unless a layer says off: org `PUT …/host-defaults`
  (`null` clears), server `PATCH options.hideWebServerNames` (`null` inherits);
  list/detail expose the effective value and `hideWebServerNamesSource`. It is
  read at deploy-prepare (`loadHideWebServerNames`, the server owner's
  organization) and sent as `environment.deploy.hideWebServerNames`, so it takes
  effect on each environment's next deploy; saving it enqueues nothing. Multi-DC
  membership inherits from the first pin after sort by datacenter id (same as
  timezone).
- **Server services snapshot (client surface):** `GET /servers/:id/services`
  — read-gated, org-scoped (`404` for another organization's server). Bounded
  queries per server (never per-item fan-out). One response of what is
  attached: `removal` (`canRemove`, `online`, `canForget`, plus `reasons` from
  `planServerForget` and the co-located-host rule, so the tab and
  DELETE cannot disagree; `canForget` is the same Host is gone path as
  delete-preview; an app-environment or database reason names up to three of
  them in its `message` — `"Project / Environment"` — and carries the same
  `items` the delete blockers do), `apps` (container → service → environment → project,
  domains from hosting/hostname; system-workspace rows omitted like the
  blocker scan), `databases` (replica + managed, same exclusion),
  `databaseUsers` (one entry per app on this host with the database names it
  is bound to), `backups` of databases that have a member on this server,
  `networks` / `ipCount`, and `runtimes` only from daemon facts already stored
  on the server (`server.metadata.runtimes`; otherwise empty). Apps,
  containers per app, domains per app, database users, networks, and backups
  are capped at 50 plus `more` (`{ items, more }`).
  `src/client/servers/server-services.ts`.
- **Forget an offline server (client surface):** `GET /servers/:id/delete-preview`
  (manage-gated, same as delete) lists leftover containers, networks, addresses,
  app environments that will be removed, database members that will be
  forgotten, and databases that still block forget (`online` is the live
  snapshot or stored connected flag; `canForget` only when offline, not
  co-located, and no database still has its only copy or its primary here; each
  list capped at 50 plus `more`; system-workspace rows omitted like the blocker
  scan). Every refusal names its blockers: an `environment` blocker carries
  `items: { id, name, projectId, projectName, hasDatabase }[]` for **every**
  placed environment (including the ones carrying a database, which the Services
  tab app list omits) and a `managed` / `replica` blocker carries
  `items: { id, name }[]` per database, in `blockers[]` on both the preview and
  the 409. `DELETE /servers/:id?forgetResources=true` (or JSON
  `{ forgetResources: true }` — never implied) drops leftover app environments
  (without the running-container refusal), forgettable members, leftover
  deployments / slots / copies, then container / network / address rows in the
  same transaction as the server row when the host is gone; a connected server
  answers **409** `server_online` (re-checked under row lock); a blocked
  database answers **409** `server_has_blockers` with `blockedDatabases`;
  co-located stays **403**. Without the flag, **409** `server_has_blockers` is
  unchanged. Audit `forgotten` counts include environments, members,
  deployments, slots, and copies. `src/client/servers/AGENTS.md`.
- **Server labels (client surface):** `GET`/`PUT /servers/:id/labels` —
  read-gated GET and manage-gated PUT; PUT is replace-all
  (`{ labels: { key: value } }`, no per-key DELETE). `GET /servers/:id` includes
  `labels` from a primary-connection read (not the cached `server-detail` row).
  Keys use the Docker engine-label charset so `placement.constraints`
  `node.labels.*` parses cleanly.
- **TurboFabric (client surface):** `GET`/`PUT /organizations/:id/fabric` —
  manage-gated opt-in, plus `PATCH /organizations/:id/fabric/relays/:serverId`
  and `POST /organizations/:id/fabric/apply`. TurboFabric **is** the org
  WireGuard mesh (one per org, interface `tp0`); `relay` carries the mesh
  identity (address, gateway/member role, advertised LAN CIDRs plus
  `resolvedAdvertisedCidrs` for the effective IPv4 list, keepalive, endpoint
  override, write-only PSK). GET fabric returns diagnostics-only per-relay
  `paths[]` (`peerServerId`, `selected` path kind, optional `endpoint` /
  `viaServerId` / `lastHandshakeAt` / `latencyMs`, `degraded`) plus `allowRelay`
  / `effectiveAllowRelay` / `preferredGatewayIds` / `gatewayEligible`. Org PUT
  accepts `allowRelay` (tightening-only; default off). Relay PATCH accepts
  `allowRelay` (`null` inherits org) and `preferredGatewayIds`. Reconcile
  assigns derived CIDR ownership among public-keyed relays only. Default off
  (capable single-engine Docker standalone; no `tp0`). Enabling creates the org
  `fabric` row plus per-server `relay` rows and reconciles host interface `tp0`
  on enrolled servers. Spanning compose networks persist per-host `subnet` rows
  (compose-bridge CIDR, not a datacenter subnet). A deploy plan that would use
  two or more servers without TurboFabric returns **422**
  `turbofabric_required`. Multi-server deploys **wait for membership
  convergence** (every participating relay has a public key and an applied
  payload hash that includes peers) before enqueueing `environment.deploy`
  (`422 fabric_reconcile_failed` / `409 fabric_reconcile_pending`). PUT disable
  is a teardown (reclaims `network(kind='compose')` + `subnet`).
  **Trusted LAN wins (one pair rule, `serversShareTrustedLan` in
  `features/net/private-endpoint.ts`):** two servers that share a trusted
  datacenter network giving both an IPv4 address, both daemons listing
  `fabric-lan-routes-v1`, have **no tunnel** (an IPv6-only shared network keeps
  the tunnel; the managed-database ladder still uses it): they are not WireGuard peers, the ladder never gives them a fabric
  address, and a cross-server container network between them rides the LAN
  (`lanRoutes`: each routes the other's `server.container_prefix` via its IPv4
  LAN address) with TurboFabric on, paused or off
  (`reconcileServerNetworking`; outside a running mesh the payload is
  `tunnel: false`). A pair with an older daemon keeps its tunnel over the LAN.
  While TurboFabric is not running for a pair (off, paused, a server switched
  off), a change that would end a LAN pair holding a cross-server network is
  refused (`409 lan_pair_in_use`: marking the datacenter untrusted, removing a
  member) and the deploy re-checks the rule before delivering (`422
turbofabric_required`); `features/fabric/lan-pair-guard.ts`. A daemon gaining
  or losing the feature stamps `ip.repin_pending_fanout_at` so the repin sweep
  re-plans. Remove completely keeps networks whose servers are all LAN pairs
  and resends their payload with no tunnel. The WireGuard port opens only when
  the payload has a tunnel (`serverPayloadNeedsTunnel`).
  Traffic between datacenters rides TurboFabric; a pair that shares only an
  untrusted network runs its tunnel over that LAN (`direct_lan` marked
  untrusted, GET `pairs[].path` `fabric_over_untrusted_lan`), while plain
  traffic never crosses an untrusted LAN. Failover replication and Raft never
  use fabric. The planner refuses a span only for pairs outside a shared
  trusted LAN (TurboFabric off, a switched-off server in such a pair, or no
  direct tunnel in a network that mixes LAN and remote servers). The fabric
  rung also needs both relays keyed, the other daemon connected and a fresh
  handshake in the live reading (`pairTunnelHealth` `healthy`); otherwise the
  ladder falls to public, then a network that is down.
  Whole-environment `environment.server_id` pins never require it. User-facing
  copy is **TurboFabric**; backend identifiers stay `fabric` / `tp0` / `relay` /
  `subnet`. Never ask which WireGuard network a container should join. NAT
  rendezvous feeds `direct_nat` only from a probing peer's fresh healthy
  handshake (observer-mapped endpoints stay in candidate exchange). Path-state
  strike counters are process-local across reconcile rounds. `allowRelay` is
  reserved for a future relay slot and does not loosen gateway datacenter
  locality. **Dial-in peers:** a server nothing can dial (behind NAT, no pin)
  is never dropped as unreachable when it can dial us (we have a public path
  for it, `peerCanDialIn`): its peer has no `endpoint`, WireGuard learns it from
  the server's own keepalive handshake. Peers pinned to one shared endpoint
  (servers behind one NAT) lose it the same way. GET `relays[].reconcile`
  (`features/fabric/reconcile-outcome.ts`, `relay.metadata.reconcile`) says how
  the last reconcile sent to the server ended: `pending` from enqueue until it
  answers, then `done` with the daemon's `warnings` or `failed` with its error;
  a pause counts as down only once its server is `done`.
- **Compiled runtime compose:** users author project + optional environment
  ComposeDocuments. Deploy compiles **one** `compose.yaml` (`role: 'runtime'`)
  per participating server plus a project `.env` for non-secrets. Secret
  `{$KEY}` / `{$scope.KEY}` refs compile to Compose standalone `secrets:` files
  under `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/` (YAML
  holds paths only). Preview **Prepared** shows that snapshot (plus `servers[]`
  only when scheduled across more than one host), redacted `.env`, and
  `secretPlan[]`. Runtime YAML includes `x-turbopanel.placement.server_id` as
  compile-time audit metadata. Preview **Merged** stays the user-authored merge
  (including `{$…}`) plus the live pin for review.
  `POST /api/daemon/v1/deployments/secrets/rehydrate` reseals current registry
  values after daemon boot because `/run` is tmpfs.
- **Org server seat capacity:** `organization.options.maxServers`
  (`null`/omitted = unlimited). `GET`/`PUT /organizations/:id/server-capacity`;
  `POST /licenses` returns **409** `server_capacity_exceeded` when enrolled
  servers + unconsumed keys fill the cap. Optional create `name` (legacy
  `displayName` accepted on input) is omitted when blank and otherwise uses
  `normalizeDisplayName` / `isValidDisplayName` (**400** for control characters
  or over-length). `GET`/`DELETE /licenses` are owner-only; the UI **Pending
  keys** page lists unbound keys (OpenAPI `name`). Self-hosted operators set the
  cap. When billing is configured, `POST /licenses` takes no `tierId` — the
  tier is derived from the server once it enrols — and answers **409**
  `no_license_available` (a truthful `message`, org and per-tier counts with
  `ending` / `endsAt`, `provisioning` and `unusedKeys`, so the console can say
  "use or delete the key", "restore one" or "buy one") when every purchased
  license is bound, provisioning, held by an unused key, or ending at the
  boundary (net of outstanding seat releases); `DELETE /licenses/:id` runs the
  detach-first refusal, then the billing gate (`authn/license-lifecycle.ts`),
  which records a deferred `release-seat` intent under the org's quantity lease
  so the seat drops at the period boundary (**409**
  `billing_mutation_in_progress` while held).
- **Billing (client surface):** `src/client/billing/` — `GET /billing/catalog`
  (active tiers), `GET /billing/subscription` (projection summary: status,
  period end, per-tier `{ seats, licensesUsed, licensesFree }`, grace clock,
  schedule flag, pending changes — Postgres only), `POST /billing/checkout`
  (first purchase → hosted Checkout URL, **409** `subscription_exists` after),
  `POST /billing/portal` (invoices + payment methods), `POST /billing/preview`
  (proration quote with a pinned `prorationDate`), `POST /billing/seats`
  (increase → immediate invoice, refused `licenses_ending` while that tier
  has licenses ending; decrease → deferred), `POST /billing/restore` (take
  back ending licenses at a tier, free), `POST /billing/upgrade`
  and `POST /billing/downgrade` (one license, one tier move). Owner-only; every
  route is **503** `billing_not_configured` when customer billing is not
  operational (both Stripe secrets — `isCustomerBillingOperational`), so
  self-hosted and API-key-only instances have no billing surface;
  entitlement-raising routes are **409** `subscription_past_due` while
  delinquent; every mutation holds the org quantity lease
  (`409 billing_mutation_in_progress`). The three mutation bodies are
  `billing/mutations.ts` (`changeSeats`, `upgradeLicense`, `downgradeLicense`),
  context-free functions returning the status and body the route answers with,
  so the live test-clock harness drives the same gates. Rules and the ledger:
  `src/features/billing/AGENTS.md`.
- **Org managed-database defaults:** `organization.options.managedDatabase`
  (`src/features/managed/org-defaults.ts`).
  `GET`/`PUT
/organizations/:id/managed-defaults` (manage-gated) — today only
  `sslMode`, the default client TLS policy inherited by managed SQL services
  that set no override; `null` clears it and services fall back to the platform
  `require`. These are **inheritance sources**, not applied configuration:
  saving one never overwrites a service that configured its own value, and the
  effective mode is resolved per read (`resolveManagedSslMode`) rather than
  stored. Canonical detail: `src/features/managed/AGENTS.md` → **Client TLS (SSL
  mode)**.
- **Primary environment (`environment.is_primary`, `is_pinned`):** a project has
  exactly one primary environment, a column on the environment row with a
  partial unique index (`uniq_environment_project_primary`). The first
  environment created is primary; `POST /environments/:id/primary` moves it
  (`features/projects/primary-environment.ts`, one transaction under the project
  row lock); the primary cannot be deleted while the project has others (409
  `primary_environment_cannot_be_deleted`). Nothing guesses the primary from a
  name: `ensurePrimaryEnvironment` (configure) reads the marker. Catalog
  `displayName` checks only choose which scaffolded environment is created
  primary. `pinned` (PATCH) lists an environment right after the primary one;
  `GET /environments` returns primary, pinned, then oldest first per project.
- **New project content goes to the primary environment:** `POST /projects` and
  configure leave the Base (project `options.compose`) empty and put the
  compose (a catalog entry's shared compose merged with each environment's own,
  `catalog-compose.ts`) into the environment's own changes, so a deploy sees the
  same merged compose as before. A compose that names a repository
  (`composeSource`) or has project overlays stays in the Base for now.
- **A new environment is a copy of the primary one:** `POST /environments`
  without `options` copies the primary's `compose` and `composeOverlays`
  (`start: 'copy'`, the default; `features/projects/primary-environment-copy.ts`)
  minus what must be unique: `x-turbopanel.hosting`, published host ports (moved
  to `expose`), `container_name`, and the git `branch` (with `deployOnPush: false`
  so a push never deploys the copy). Variables, secrets and the server pin are not
  copied; what the Base still gives the copy (hostnames, published ports, container name,
  auto-deploying source) is overridden in the copy's own layer with `!reset` / `!override`;
  the response lists the omissions in `notCopied`. `start: 'empty'` stands alone. The name follows
  the environment name rule on every path.
- **Edit target:** `PATCH /projects/:id` with `options.compose` or
  `options.composeOverlays` needs `target` (`base` or an environment id); with
  one environment the default is that environment, with several 400
  `edit_target_required` (`projects/edit-target.ts`).
- **Org primary environment name:**
  `organization.options.defaultEnvironmentName` (unset = `production`; the
  stored key and route keep the old name).
  `GET`/`PUT /organizations/:id/default-environment` (manage-gated) names the
  primary environment scaffolded by project create / configure. Matching for existing
  literal "production" catalog environments is unchanged. The name is also the
  scope folder on every server, so the PUT only takes a valid environment name
  (`isValidEnvironmentName`) and a saved value that is not one is ignored.
- **New-project form switches:** `organization.options.openEnvironmentSectionByDefault`
  and `openWorkspaceSectionByDefault` (unset = off).
  `GET`/`PUT /organizations/:id/project-settings` (manage-gated) read and write
  them; a PUT takes one switch or both. The client uses them only to decide
  whether the new-project form opens its Environment and Workspace sections;
  nothing on the server branches on them.
- **Folder names (`folder` table):** one row per service or volume directory per
  server (`features/folders/records.ts`). While a row exists (any state but
  `missing`) the environment's name (`environments/rename-lock.ts`) and server
  pin, the asset's `slug`, the project slug and the organization's
  `directoryNames` / `directoryNamesLocked` setting
  (`GET`/`PUT /organizations/:id/directory-defaults`) cannot change.
  - **Who writes rows** (`features/folders/allocate.ts`): `persistDeployFanOut`
    takes `lockEnvironmentRow`, then `planDeployFolders` names each host-run
    service (`slug`, the domain for web hosting) and each owned path volume that
    has none, inserts the rows as `planned` per server and site owner, and sets
    `directoryNamesLocked`. The ids go on the deploy command's
    `metadata.folderIds`; the consumer marks exactly those `present` when the
    deploy succeeds. A volume with a site owner and a `path` copy is planned when
    the copy is added (`planVolumeFolder`). The deploy, lifecycle and stop paths
    queue their command under the same environment row lock as a rename.
  - **Names and scope:** `POST /storage` takes `slug`, `directoryName`, `common`
    (a volume outside an environment is always shared). Services have no create
    body (rows come from compose), so `PATCH /services/:id` takes the same fields
    until the first folder exists (`service_slug_locked`, `scope_locked`).
    Organization setting, typed names (never suffixed) and default names
    (`-2` to `-99`) follow `features/folders/names.ts`.
  - **Delete and stop:** deleting a service or volume (and a volume copy) flips
    its rows to `removing` first and keeps them, with their locks, until the host
    confirms (`confirmFolderRemoved`, from the `server.folders.remove` result or
    a stop result's `folders[]`; see `features/folders/removal.ts` and
    `reports.ts`). The delete sends `server.folders.remove` once it commits; a
    server that is offline keeps the rows `removing` ("being removed, waiting
    for server X to come back" in the blocking list) and a sweep asks again once
    it is connected. An explicit environment stop sends no `siteReleases`, so
    every folder stays; delete teardown and a server leaving the environment
    still do. A service that leaves the compose file keeps its folder (the deploy
    result's `keptFolders` marks it an `orphan`); only an explicit delete removes
    files. Wire: `siteReleases[].folder` and
    `storageMaterial[].folder` ride beside the old fields, which stay
    authoritative until the daemon resolves folders itself.
- **Common assets (`share` table):** a common service or volume belongs to the
  site owner and lives in the owner's `common` scope; any environment of any
  project in the organization uses it through `/environments/:id/shares`
  (`features/folders/shares.ts`). Deleting the environment removes its rows;
  deleting the asset, its environment or its project is refused with
  `common_asset_in_use` while another environment uses it; common folders never
  block a rename. A deploy carries the common volumes its environment uses
  (with only its own mounts).
- **Project default server:** `project.options.defaultServerId` (optional UUID).
  Environments without their own `server_id` inherit it at deploy / lifecycle /
  stop (`resolveEffectivePlacementServerId`). Overview Base shows an inline
  picker; env-level pins still override.
- **Environment config view (`GET /environments/:id/config-view`,
  `environments/config-view-routes.ts` + `features/compose/config-view.ts`):** a
  derived, read-only answer for the editor: the effective config (project Base
  merged with the environment compose by `mergeComposeLayers`, the same merge a
  deploy uses), the changes from the Base per service/field with their sources
  (`base` / `project` / `environment`), `inheritedFromBase` on every service,
  field, Linux user and variable row, `isPrimary` and `standsAlone`. There is no
  "follows the Base" flag: every environment inherits from the Base.
  `standsAlone` is **derived, never stored**: the environment compose (or an
  extra environment layer) setting `services: !override` / `!reset` means it
  drops the Base's services. It runs
  no deploy preparation (nothing is allocated). Secret variables carry no value
  (the stored ciphertext is not even selected) and credential-looking compose
  values are masked; the raw `x-turbopanel` block is never returned. A client
  API only: not a daemon contract, so there is no twin in turbopaneld.
- **Deploy strategy settings (stage 1, nothing acts on them yet):**
  `environment.options` carries `deployStrategy` (`inplace` | `sequential` |
  `bluegreen`), `migrations` (`none` | `compatible` | `breaking` | `unknown`),
  `drainSeconds`, `healthTimeoutSeconds`, `rollbackWindowMinutes` (`0` = shut the
  old blue-green generation down as soon as cutover is confirmed); `project.options`
  may carry only the three tuning keys as defaults. Absent strategy = `inplace`
  (existing environments); every user-facing create path stamps `sequential` on a new
  environment (system-owned environments are not stamped) (`stampNewEnvironmentDeployOptions`). Writes are validated (`400
deploy_options_invalid` on environments; the reason string on projects) and a
  PATCH that omits these keys keeps the stored ones (`settleDeployOptions`) because
  `options` is replaced wholesale and the compose editor sends only `compose`.
  `null` clears a key. `environment.options.primaryHostname` (a lowercase
  hostname, `null` clears) names the hostname the environment header's Visit
  button uses; it is settled the same way so a partial save keeps it, and
  nothing on the server reads it. The deploy request accepts `strategy` / `migration`
  overrides; `strategy: inplace` and `sequential` are honored (the daemon runs the
  sequential engine: stop, migrate, start, health gate, roll back from `previous/`),
  `bluegreen` and any `migration` answer `501 deploy_strategy_unsupported`. A stored
  `bluegreen` runs as `sequential` with the `bluegreen_unavailable` reason
  (`src/features/deploy/deploy-engine.ts`, shared by deploy and preview). The deploy
  response carries `strategy: { requested, effective, fallbackReasons }`; the daemon
  reports an unfinished sequential deploy as `rolled_back: ...` or
  `needs_attention: ...` (`deploy-outcome.ts`), kept as `command.error_code`
  (`deploy_rolled_back` / `deploy_needs_attention`) and `deployment.metadata`
  (`deployment.outcome` stays `failed`: its check allows only applied/failed/timed_out),
  and deployment history entries expose `strategy`, `strategyOutcome`,
  `strategyOutcomeReason`. A multi-server `sequential` deploy
  is a rolling deploy: `deploy.update_config.parallelism` (default 1, `0` = all at once)
  that many servers update at once. Only the first batch's commands are queued; the rest are
  recorded (deployment target `pending`, `options.rollout = { batch, batches }`, command
  `queued` and undelivered) and `src/features/deploy/rollout.ts` queues each next batch
  from the command consumer when the one before is applied. The first failed or timed-out
  server stops the rollout: servers not yet started are marked `failed` and their
  commands `cancelled`. `inplace` keeps the all-at-once fan-out. The response `strategy.rollout`
  and the preview `rollout` report `{ parallelism, batches }`; `delay`, `monitor`, `order`,
  `max_failure_ratio` and `failure_action: continue` are refused at deploy
  (`field_unsupported`). Deploy preview reports `strategy`,
  `effectiveStrategy`, `migrations`, `fallbackReasons[]`
  (`src/features/deploy/deploy-strategy.ts`; blue-green falls back to sequential on
  published ports, authored `container_name`, stateful writable volumes, traffic
  services without a healthcheck, native/cron services, host-level binds, or a
  migration status other than `none`/`compatible`). Owner decisions 2026-10-01:
  unknown migrations fall back to sequential; a failed deploy after a migration ran
  stops and flags, never starts old code on a changed schema; multi-host rollout
  follows `deploy.update_config` (default parallelism 1, halt on failure).
- **Environment lifecycle:** `POST /environments/:id/lifecycle` (`start` /
  `stop` / `restart`) is non-destructive (`environment.lifecycle`);
  `POST /environments/:id/stop` tears down compose including volumes
  (`environment.stop`). Canonical detail: `src/features/commands/AGENTS.md`.
- **Containers list filters:** `GET /api/client/v1/containers` joins `service`,
  so every serialized row carries **`environmentId`** (denormalized
  `service.environmentId`). `?environmentId=` narrows already-visible rows to
  that environment; `?projectId=` narrows to every environment of a project, so
  a client scoping a whole project makes **one** call instead of one per
  environment. Both AND with `serviceId` / `serverId` / `status` and neither
  widens `listVisible`.
- **Datacenters (routing domains, many subnets):** There is no singular
  `server.datacenter_id`. Membership is an `ip` pin (`scope='datacenter'` +
  `serverId` + `datacenterId` + **required** `networkId`), unrestricted count
  per `(server, datacenter)`, deduped by address (`uniq_ip_org_address`;
  `ip_datacenter_member_network_check`). A server may hold pins in many
  datacenters. A datacenter owns **many** `network(kind='datacenter')` subnets
  (v5 and/or v6), unique per `(datacenter_id, cidr)` via
  **`uniq_network_datacenter_cidr`**; **all subnets in a datacenter are assumed
  mutually routable** — the datacenter _is_ the routing domain, there are no
  per-pair adjacency records. `POST /datacenters` body is
  `{ name?, description?, members: [{ serverId, address }],
sourceServerId? }`
  — at least one member is required; addresses must be daemon-reported private
  IPs; the first subnet is **derived** from that seed member’s reported
  interface prefix (`ips[].cidr` where `scope='private'`, aligned network form)
  when present — operator `cidr` is ignored. Hello ingest maps current
  `resources.ips` (and legacy top-level `ips[]` / the pre-rename `addresses`
  object (`privateIpv4` / …)) so remotes that have not rebuilt yet still appear
  as members. When the daemon still reports `{ address, version, scope }`
  without a prefix, create infers a typical LAN (`/24` IPv4, `/64` IPv6).
  Missing reported private IP → **400** `address_cidr_unreported`. Extra members
  no longer have to fall inside one CIDR — a non-matching reported prefix
  **auto-creates** another subnet in the same txn (**409** `subnet_overlaps`
  when that range collides org-wide, including among auto-derived CIDRs in the
  same create or member-add request). Create writes site subnet(s) + member pins
  in one txn. `POST|DELETE /datacenters/:id/members` add/remove pins (member add
  auto-derives the same way; member delete removes **every** pin for that server
  in the datacenter). Manual subnet CRUD:
  `POST|PATCH|DELETE /datacenters/:id/subnets[/:networkId]` (manage-gated;
  `cidr` immutable on PATCH). Name suggestions
  (`GET /datacenters/name-suggestions`) group geo/ASN from servers with zero
  memberships. List/detail expose `privateCidrs` (one entry per subnet) plus
  detail `subnets[]` and `options.addressPreference`. Server list/detail expose
  `datacenters: { id, name }[]`. `DELETE /datacenters/:id` returns **409**
  `datacenter_has_members` while any membership pin remains; otherwise **every**
  `kind='datacenter'` network is deleted with the datacenter (**409**
  `datacenter_has_networks` only for leftover non-site / docker rows).
- **Membership pin is the single address authority (automatic repin):** a
  datacenter membership pin (`ip.scope='datacenter'` + `server_id`) is the
  only durable record of a server's private address in a site subnet.
  Binding-owned `variable` rows, ProxySQL backend addresses, compose
  `extra_hosts`, relay `endpoint_address` / gateway `advertisedCidrs`, and
  hosting `bindAddress` are **recomputed per deploy / reconcile from the pin**
  and must never be treated as an address record or written back to. When a
  daemon's reported `resources.ips` moves, `touchServerMetadata`
  (`src/features/servers/server-registry.ts`) — the one change-detected write both the Deno
  WS hello and the Durable Object `#projectInbound` funnel through — runs
  `applyReportedAddressRepin` (`src/features/net/repin-apply.ts`) best-effort,
  gated on `serverIpsEquals` so CPU / docker-only deltas never touch `ip`
  rows. The decision is pure (`decideRepinActions`, `src/features/net/repin.ts`):
  address still reported → nothing (clears a `stale` flag); address gone with
  **exactly one** reported private address inside the pin's subnet that is
  not an `ip` row elsewhere in the org → `repin` (`ip.address` rewritten,
  `metadata.repin { at, from, pendingFanoutAt }`; re-validated through
  `validateMemberPinAddress`; a `uniq_ip_org_address` race downgrades to
  stale); zero or 2+ candidates → `metadata.stale { since, reason }`
  (`address_gone_no_candidate` / `address_gone_ambiguous`). At most one repin
  per `(server, network)` per pass. **Nothing enqueues on that path** — hello
  / DO handlers must not enqueue commands — so the routing fan-out is
  deferred: `runDatacenterRepinFanoutSweep`
  (`src/client/datacenters/repin-fanout.ts`) drains `pendingFanoutAt` from
  the shared maintenance tick (`runSystemReconcileSweepTick` in
  `platform/deno/server.ts`; the `tlsRenewal`-gated block in
  `daemon/cell/offline-sweep.ts`), one `fanOutDatacenterRoutingChange`
  (`routing-fanout.ts`, the same core `PATCH /datacenters/:id` uses) per
  `(org, datacenter)` group plus the repinned servers' own clusters via
  `listManagedIdsForServer`; the marker is cleared only after success. Leaf
  SANs re-mint through the existing `managed.ingress.reconcile` /
  `pendingTlsLeafMetadata` rail — no issuance path here. Hosting
  `bindAddress` is frozen at deploy time, so `GET /environments/:id` returns a
  derived `needsRedeploy: { serverId, environmentId }[]`
  (`src/client/environments/repin-needs-redeploy.ts`, `metadata.repin.at`
  later than the last applied `deployment.finished_at`); **no automatic
  `environment.deploy`**, and no new columns — `stale` on `GET /ips[/:id]` and
  on `GET /datacenters/:id` `members[]` is read from `ip.metadata` via
  `parseIpPinMetadata`.
- **CIDR collision authority (`src/features/net/cidr-collisions.ts`):** every CIDR
  write — `POST`/`PATCH /networks`, `POST /datacenters`,
  `POST /datacenters/:id/subnets`, the auto-derive path of
  `POST /datacenters/:id/members` — calls `assertCidrAvailable` /
  `assertCidrsAvailable` before touching `network`; do **not** add a local
  overlap scan to a route. Every pair is a hard **409** with its own code,
  returned as `{ error, cidr, conflictingCidr, networkId?, datacenterId? }`
  via `cidrCollisionResponse` (`src/client/networks/network-scope.ts`):
  `cidr_overlaps_fabric` (org `fabric.cidr`, `tp0`),
  `cidr_overlaps_fabric_pool` (`fabric.options.containerPool`, default
  `10.192.0.0/12`), `subnet_overlaps` (any site subnet in the org — the
  org-wide default is kept, not relaxed), `cidr_overlaps_gateway_advertised`
  (a site subnet in **another** datacenter when both datacenters have a
  gateway-role relay — resolved through `resolveDerivedAdvertisedCidrsByRelay`,
  so IPv6 subnets and operator overrides behave as on the wire; this is the
  case that actually breaks `AllowedIPs`), `cidr_overlaps_reserved`
  (`network(kind='reserved')`), `cidr_overlaps_docker_network`
  (`kind='docker'` / `kind='managed'` rows with a CIDR). `PATCH` passes
  `excludeNetworkId` so a row never collides with itself. **`kind='reserved'`**
  is the operator's "never allocate from here" registry (org-only scope, CIDR
  required, `name` carries the label — "Corp VPN — Chicago branch"); unlike
  `managed`, reserved rows are operator data: rename and re-range are allowed,
  `cidr: null` is **400** `network_cidr_required`. The reverse direction is
  automatic: `occupiedCidrs` (fabric-records) sweeps every `network.cidr`, so
  reserved rows constrain `pickDefaultFabricHostCidr`, and the allocators
  (`requireRelayPrefix` / `requireSubnetCidr`, `nextFreeSubnet` /
  `nextFreeSubnetCidr`) take an **exclusion list** from
  `loadCidrAllocationExclusions` so a relay `/16` or a `tpn_*` `/24` never
  lands inside a reserved range or a site subnet (exhaustion keeps the
  existing `FabricAllocationError` codes). **Org Docker host addressing**
  (`organization.options.docker`, `src/features/deploy/docker-address-pools.ts`,
  `GET`/`PUT /organizations/:id/docker-networking`) — every pool base
  **and** the aligned network of `defaultBridgeCidr` (dockerd `bip`, the
  docker0 subnet on every host), together `dockerHostCidrs()` — is part of
  the registry (`dockerHostCidrs`, same rung / code as `kind='docker'` rows
  — `cidr_overlaps_docker_network`) **and** of the exclusion list, so a
  later reserved range, site subnet, docker row or fabric allocation can
  never land inside a pool or the bridge. The PUT first refuses a submitted
  bridge that overlaps a submitted pool (`findDockerBridgePoolOverlap`, 409
  `cidr_overlaps_docker_network`), then checks each new range with
  `excludeDockerHostCidrs` so a replace never collides with the config it
  overwrites. They are host configuration, not a
  registration: the daemon pulls them over
  `GET /api/daemon/v1/host/docker-networking` and the `docker` Ansible role
  merges them into `/etc/docker/daemon.json` (restarts dockerd; existing
  networks keep their ranges). **Per-network `kind='docker'` addressing:**
  rows may carry `options.subnet` / `ipRange` / `gateway` / `mtu`
  (`docker-network-name.ts`); `network.cidr` is the registry-visible range
  and `POST`/`PATCH /networks` keep it in agreement with `options.subnet`
  (`reconcileDockerNetworkAddressing` — either may be sent, a disagreeing pair
  is **400** `docker_network_subnet_mismatch`, `cidr: null` is refused while
  `ipRange` / `gateway` remain). The addressing rides `environment.deploy` as
  the additive `dockerNetworkAddressing[]` sibling of `dockerExternalNetworks`
  (resolved by `resolveRegisteredExternalDockerNetworks` from the same rows
  the registration check loads) and is applied only when the daemon _creates_
  the network. **`fabric.options.containerPool` is operator-settable** via
  `PUT /organizations/:id/fabric` (`containerPool`, IPv4, prefix ≤ `/16`):
  validated through the same authority with the current pool excluded, and
  **409** `fabric_container_pool_in_use` when an allocated relay prefix would
  fall outside it — changing the pool never renumbers existing relays. The
  policy is handed to `enableOrganizationFabric` and written **before** relay
  allocation, in one transaction with the fabric row, so a first-time enable
  carves every relay `/16` from the requested pool; a pool too small for the
  org's servers (**409** `fabric_prefix_pool_exhausted`) or one the
  auto-picked host range lands in (**409** `cidr_overlaps_fabric`) rolls back
  and leaves TurboFabric disabled.
  `src/features/net/private-endpoint.ts` resolves reachability (`local` →
  `datacenter` → `fabric` → `public`) in an **address-family aware** way: it
  intersects the source and target pin families in each trusted shared
  datacenter (priority order — see the routing-policy bullet below) and orders
  candidates by the `datacenter.address_preference` column (default **IPv6**, RFC
  6724), never returning a family the source does not hold; a trusted shared
  datacenter with no common family is **422** `private_family_mismatch`. Fabric
  dials over `tp0`.
  Shared membership + **at least one** subnet gate managed-cluster private
  placement (`assertDatacenterHasCidr` / `assertServerDatacenterReady` in
  `src/features/net/datacenter-networks.ts`). New error codes: **400** `invalid_cidr`
  / `address_not_in_any_subnet`, **409** `address_in_use` / `subnet_overlaps` /
  `subnet_has_members`, **422** `private_family_mismatch` (alongside existing
  `datacenter_has_members` / `datacenter_has_networks`).

- **Datacenter routing policy (`options.priority` / `options.trusted` /
  `options.addressPreference`):** a datacenter is a **logical routing domain**,
  not a building — a server may belong to several. The three keys keep their
  wire names inside `options`, but are stored in real columns (`priority`,
  `is_trusted`, `address_preference`, all NOT NULL with CHECKs; migration 0004
  moved them out of the jsonb and backfilled). `datacenter-options.ts`
  (`policyColumnsFromOptions` / `storedDatacenterOptions` /
  `datacenterWireOptions`) maps between the two shapes. They describe how the
  ladder should treat each membership; the optional `kind` column (`lan`,
  `backplane`, `provider_private`, NULL = unsaid; top-level `kind` on
  `POST` / `PATCH`, **400** `invalid_kind`) says what the network is:
  - `priority` — integer `0`–`1000`, **lower wins**; absent = **`100`**
    (`DEFAULT_DATACENTER_PRIORITY`). A request (`POST` / `PATCH`) carrying an
    out-of-range or non-integer value is **400** `invalid_priority`
    (`hasInvalidPriority`); the column CHECK backs it.
  - `trusted` — boolean; absent = **`true`** (`DEFAULT_DATACENTER_TRUSTED`).
    `false` marks a datacenter whose L2 is **not** under the operator's control
    (shared or provider-owned segments).

  `PATCH /datacenters/:id` accepts both under the same **replace-all `options`**
  semantics as `addressPreference` (send the merged object; a key left out resets
  its column to the default). `GET /datacenters` and `GET /datacenters/:id`
  return `options` (the stored jsonb with the three columns laid over it)
  **and** the effective top-level `priority` / `trusted`
  (`resolveDatacenterPolicy` / `attachEffectivePolicy`), so clients never
  re-derive them. The ladder **reads both**: `loadDatacenterPolicies`
  (`src/features/net/datacenter-networks.ts`) loads the effective
  `{ addressPreference, priority, trusted }` per datacenter and
  `partitionSharedDatacenters` (`src/features/net/private-endpoint.ts`) splits the
  datacenters a pair shares into trusted / untrusted lists ordered
  `(priority asc, id asc)` — the id tiebreak is what keeps the choice
  deterministic. The datacenter rung walks **only the trusted list**, for
  every purpose; an untrusted datacenter can neither win nor raise
  `private_family_mismatch`. `read-replication` / `client-backend` then fall
  through to fabric → public as before. Every purpose on a pair that shares an
  untrusted datacenter rides TurboFabric over the LAN when the tunnel is
  healthy. `failover-replication` never uses the public address: on an
  untrusted-only pair with a keyed tunnel that is not healthy it keeps the
  fabric address marked `tunnelDown: true` (a lost host must not break a
  running cluster), and with no keyed tunnel (fabric off, opted out) it is
  **422** `untrusted_network_needs_fabric`. The other purposes that fall to
  public on such a pair carry `untrustedPublic: true`. New placements refuse
  `untrustedPublic` and `tunnelDown` with the same 422:
  a replica create checks both directions of the pair (the primary-to-replica
  direction turns `tunnelDown` when the replica's daemon is offline, so the
  offline check runs first and says offline), and a class change to failover
  checks only the replica-to-primary direction. A new binding whose app host
  would dial the database over that public address is refused too
  (`binding_endpoint_unavailable` with the TurboFabric message; the console
  tells it apart by the words "marked untrusted" in the server sentence).
  Running traffic keeps its path and `GET` server traffic map reports both
  flags on `planned` (the console does not render the traffic map yet).
  No shared datacenter at all stays `private_path_unavailable`. TurboFabric path planning
  (`lanPathCandidate` in `src/features/fabric/fabric-records.ts`) consumes the same
  partition through `EndpointAddressCaches.policyByDatacenter`, so a
  `direct_lan` WireGuard endpoint is never emitted on a segment the managed
  ladder refused; gateway locality ranking deliberately stays trust-blind
  (it only orders next hops — the hop itself is trust-filtered).
  `PATCH /datacenters/:id` compares the effective policy before/after the
  UPDATE and, only when `priority` or `trusted` actually changed, re-converges:
  every managed cluster with a member pinned into the datacenter goes through
  `fanOutManagedIngressReconcile` (recompute `replica.replication_transport`,
  re-materialize bindings, enqueue `managed.ingress.reconcile` on members and
  bound consumers), then `reconcileFabricMembership` re-plans the org fabric
  and enqueues `server.fabric.reconcile` only where the desired payload hash
  moved. The fan-out needs the command queue and both secrets on the context;
  without them (unit-test app, secretless isolate) it logs and skips, and a
  fan-out failure never turns the successful save into a 5xx. CIDR overlap /
  containment for datacenter subnets (IPv4 **or** IPv6) must go through the
  dual-family authority `cidrsOverlap` / `cidrContains` in
  `src/lib/ip-address.ts`; `src/features/fabric/cidr.ts` keeps only IPv4 pool
  arithmetic and delegates its overlap helpers there.

- **Server-to-server network choice (`POST /datacenters/:id/server-traffic`
  `{ preferred: true }`):** the point-and-click form of the priority rule, so
  nobody has to type a number. `planServerTrafficChoice`
  (`src/features/datacenters/server-traffic.ts`, pure) gives the chosen trusted
  datacenter the lowest number among the organization's trusted datacenters
  (10, or 0 when a rival is at 10 or lower; a rival at 0 moves every trusted
  rival up by 10, capped at 1000) and writes only the numbers that change, in
  one transaction, then runs the same routing fan-out a priority PATCH does.
  An untrusted datacenter is **409** `datacenter_not_trusted`. `GET
/datacenters` adds `serverTraffic: { wins, tied }` per row and a top-level
  `warnings` list (`equal_priority`, one per shared number among trusted
  datacenters); the raw number stays editable through PATCH under Advanced.

- **Best network that is up (link state) and the traffic map:** the daemon
  stamps each `resources.ips[]` entry with `link: 'up' | 'down'` (kernel
  `operstate`, then `carrier`; absent from an older daemon and read as up). The
  change-detected `touchServerMetadata` write runs `applyReportedAddressRepin`,
  which now also records `metadata.linkDown { since }` on the datacenter pins
  whose address sits on a down NIC (and removes it when the link returns) and
  stamps `repin_pending_fanout_at`, so the existing repin fan-out sweep
  re-plans (nothing is enqueued on the hello path; a flapping link is bounded
  by the sweep tick and cap, there is no hold-down timer). `splitTrustedByLink`
  (`private-endpoint.ts`) splits the trusted shared datacenters into the ones
  that are up on both servers and the ones that are not, both in `(priority,
id)` order. `resolveOneFromCaches` walks the up list first; a down network is
  only a last resort (after fabric and public for `read-replication` /
  `client-backend`, straight away for `failover-replication`, which never
  leaves the datacenter), and the result then carries `linkDown: true`. When
  the up networks have no address family both servers share, a compatible
  network that is down is still used, ahead of fabric and public in that one
  corner (never an error where a path worked before). A datacenter counts as down when any pin of either server in it is
  flagged, whatever the pin's family. The
  TurboFabric LAN rung (`directCandidates`) orders LAN-up, public, NAT, then
  LAN-down. `GET /servers/:id/traffic-map`
  (`src/features/net/server-traffic-map.ts`, loaded by
  `server-traffic-map-load.ts`, shape in `openapi/server-traffic-map.ts`) is the
  read-only data behind the map: per peer the shared networks with state
  (`chosen` / `standby` / `no_common_address` / `link_down` / `untrusted`), the
  planned address per
  purpose, and for the TurboFabric tunnel only the observed NIC and byte counts
  the daemon reported. Planned and observed stay separate: replication and
  client traffic are planned (the OS picks the NIC), only the tunnel is
  observed. Per-NIC byte counters are not duplicated: each NIC lists a
  `metrics.deviceId` and `monitored` flag that point at the existing metrics
  series route. Peers are filtered to those sharing a network or the fabric,
  then cut at 100 in name order (`truncated` says so). A server that is offline
  keeps its last reported link state until it reconnects. Nothing here probes
  the network.

- **Compose hosting projection (client surface):** `x-turbopanel.hosting[]` is
  the _declaration_; `hosting` rows are the _record_. `reconcile-hostings.ts`
  runs inside deploy-prepare, before anything reads a route, and materializes
  one row per declared entry (`ComposeHostingError` on an unresolvable
  certificate / managed address, an unsupported `tls.mode`, or a route a
  panel-authored row already claims — a hard refusal, never a silent downgrade).
  Everything downstream — `buildHostingsForService`, the daemon's ingress and
  TLS lanes — reads **rows**, never the compose block, so the projection is
  one-way and the row is the only thing a route is served from. Declaration
  shape and messages: `../lib/compose/hosting-extension.ts`; the compiler stage
  that carries the declarations is `Application.services[].hosting` in
  `../lib/compose/ir.ts`.
- **`docker run` importer (client surface):** `POST /docker-run/import` —
  session-gated, create-gated when a `projectId` is supplied. **Pure compute: it
  writes nothing.** It parses a pasted `docker container run` command into a
  one-service `ComposeDocument`, lints it, and returns the fragment plus
  `riskFlags` describing how the imported container's blast radius widens.
  Merging that fragment into a project or environment draft goes through the
  ordinary compose PATCH routes, where the write-boundary validation already
  lives — a second way into `options.compose` would mean two sets of rules.
  Nothing is emitted under `x-turbopanel`: the importer speaks plain Compose,
  per rule 1 of the frozen contract in `../lib/compose/AGENTS.md`. Parser and
  option registry: `../lib/docker-run/AGENTS.md`.
- **Webhook origins (client surface):** `GET /forges/webhook-origins`
  (`organization:manage`, like the rest of `/forges`) answers
  `{ origins, platformManaged }` — the set the manifest flow accepts as
  `webhookOrigin`. Hosted, the platform's `TURBOPANEL_BASE_URL` leads it;
  self-hosted, it is the operator list. Detail: `../webhook/AGENTS.md` →
  Reachability.
- **Forge addresses and the GitHub install callback (client surface):** a
  forge's `baseUrl` / `apiUrl` / `webhookOrigin` is validated on every write
  (`POST`/`PATCH /forges`, the manifest wizard) by `../lib/git/forge-url.ts` —
  https only, no embedded credentials, no reserved names (`localhost`, `.local`,
  `.internal`, `.arpa`, single-label), no loopback / link-local / private /
  CGNAT literal, and the name is resolved (Deno's resolver, or DNS-over-HTTPS
  on Workers) and every answer must be public — refused as `400 forge_url_rejected { field, reason }`. The
  same check re-runs at the fetch-time choke points (`githubApiBaseFor`,
  `gitlabApiBase`, the GitLab token grant), surfaced as the provider error
  those callers already map, so a row written by anything else is still never
  dialed with credentials attached. Every forge request itself goes through
  `forgeFetch` (`forge-url.ts`): the name is resolved again before each
  request (a private answer, a resolver failure or a name with no address
  refuses it), redirects are `manual`, a same-origin redirect is
  re-checked and followed (at most 3), and a cross-origin one is refused so
  the App's credentials never reach another host. `GET /repositories/github/callback` is the
  App's **callback URL** (the manifest requests user authorization during
  installation, which disables GitHub's Setup URL): it is per-user rate-limited
  (`forge-connect`, strict), requires the one-shot `code` GitHub sends beside
  `installation_id` (`install_authorization_required` otherwise), exchanges it,
  and refuses an installation the authorizing GitHub user cannot see on
  `GET /user/installations` (`install_not_authorized`) — the only proof GitHub
  offers that the operator approved the installation they are naming, since the
  id itself is a retypable integer. The user token is read once and discarded.
  One GitHub installation belongs to one organization per App instance-wide:
  `uniq_connection_forge_external_github` (partial, `provider = 'github'`) makes
  a cross-organization claim that races past `assertConnectionUnclaimed` a
  `23505` the callback maps to `claimed`. **Apps registered before this rule
  need two manual settings changes on GitHub** — enable _Request user
  authorization (OAuth) during installation_ and set the _Callback URL_ to
  `<origin>/api/client/v1/repositories/github/callback` — or every install ends
  in `install_authorization_required`.
- **Repository inspect refs (client surface):** `GET /repositories/:id/inspect?ref=`
  answers a ref the repository does not have with **404**
  `{ ok: false, error: 'ref_not_found', code: 'ref_not_found', message, ref }`
  — not the 502 an upstream failure gets. The signal is GitHub's **422** on the
  commit lookup, GitLab's 404 "Commit Not Found" (its "Project Not Found" is a
  different 404), or git's "couldn't find remote ref" from a connected server.
  A named ref git would refuse (`isValidGitRefName`, the `check-ref-format`
  rules; a blank `?ref=` included) is **400** `invalid_ref`, same body, before
  any provider or server is contacted; leaving `ref` out still means the default
  branch. Daemon-lane failures return a fixed sentence in `message`; git's
  stderr goes to the log (`repository-inspect`), never the response. The UI
  debounces the branch field, so a half-typed name is not looked up at all.

## Deploy hash and Destroy

- `desiredHash` (see `environments/deploy-inputs-digest.ts`) covers the compose document, every source's commit and build inputs, variables (including linked-database logins, which are materialized into variables before the deploy is prepared), hostnames, sites, apps and storage. The organization CA is not part of a deploy payload (it travels in its own trust command), so it neither changes the hash nor needs to. The digest input includes plaintext secret variable values, but only the SHA-256 leaves the panel and is stored; no input is kept. Inputs that cannot be compared between sends (daemon-sealed values, a source known only by branch name) make the hash unique, so those deploys always run. The host additionally verifies that what the last deploy put in place is still running before it skips.
- `POST /environments/:id/stop` is Destroy (the UI's Destroy button and the project delete wizard). The lifecycle bar's Stop uses `POST /environments/:id/lifecycle` with `stop`, which never sends `releaseCleanup`. Only the Destroy route sends `releaseCleanup`, which clears releases and keeps each service folder and its uploads.
