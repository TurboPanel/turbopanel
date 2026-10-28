# Tunnels (`src/features/tunnels`)

Provider-neutral tunnel plumbing. This first slice holds the tables, one
adapter per provider, the routes that connect a provider account and its
API tokens, and the tunnel lifecycle (create and remove a tunnel, where it
runs, the hostnames it carries) with the pure route builder for the daemon.

## Tables

`carrier` (a provider account an organization connected), `badge` (one API
token on a carrier), `tunnel`, `portal` (one server running one connector) and
`doorway` (one hostname a tunnel carries). Created in `0005_tunnel_tables`.
Nothing in a table name, column or migration says Cloudflare: the provider is
a value (`TUNNEL_PROVIDERS` in `vocabulary.ts`, pinned to the CHECK
constraints by `src/db/enum-checks.test.ts`). Adding a provider is one new
member there, a widened CHECK (forward migration) and one adapter.

- `tunnel.datacenter_id` is nullable and only says what `placement = 'all'`
  means (every server of that datacenter). It does not limit a tunnel to one
  datacenter, and `portal` is keyed by (tunnel, server) with no datacenter
  constraint. The code that adds a portal requires the server to be in the
  tunnel's datacenter for now; that rule lives in code so it can be relaxed
  without a migration.
- `placement` is read from `portal`: `chosen` is the servers with a `run`
  portal, `all` is every server of `tunnel.datacenter_id` except those with a
  `skip` portal, `one` is exactly one `run` portal. `portal.reported`
  (`unknown`, `connected`, `down`, `error`) is separate from `wanted`. A
  server runs many tunnels and tunnels of several organizations may share a
  server, so the key is (tunnel, server) and nothing assumes one tunnel per
  server. `portal.options` is reserved for per-server details (for example a
  local endpoint).
- `tunnel.organization_id` owns the tunnel; `tunnel.routing_organization_id`
  is the organization whose servers and sites it carries (named as on
  `hostname`). They must be equal for now: `assertSameHostingOrganization`
  refuses a difference, and no CHECK enforces it, so it can be relaxed without
  a migration. A tunnel can reach other organizations' hostnames on a shared
  server; that is a documented risk, not isolated per tunnel.
- The connector program is not a column: `tunnel.options.connector` names it
  (`cloudflared` for the Cloudflare provider) while only one exists. Each
  server reports the version it runs in `portal.connector_version`, with
  `portal.version_checked_at` for when, so the panel can show program and
  version per tunnel per server.
- `doorway` keeps the hostname text and a nullable `hosting_id` (SET NULL). It
  is unique on (`routing_organization_id`, `hostname`), because a doorway with
  no hosting is not in `hostname` and one name must not sit on two tunnels in
  one organization. It has no foreign key to `hostname`:
  `replaceHostingHostnames` deletes and reinserts a hosting's hostname rows on
  every save. The doorway code path must return the same 409
  `hostname_in_use` when either table already holds the name. The hostname
  must be lower case and 1 to 253 characters (a CHECK); format is validated in
  code with the existing hostname validator.
- `tunnel` is unique on (`carrier_id`, `external_id`) so two rows cannot stand
  for one provider tunnel. `placement = 'all'` needs a `datacenter_id` (a
  CHECK), and the datacenter delete route answers 409 `datacenter_has_tunnels`
  while an `all` tunnel covers it.
- Delete behavior of every new foreign key: organization deleted removes its
  carriers, tunnels and doorways (cascade, both organization columns on
  `tunnel`); server deleted removes its portals; tunnel deleted removes its
  portals and doorways; hosting deleted sets `doorway.hosting_id` NULL;
  datacenter deleted sets `tunnel.datacenter_id` NULL. `badge.secret_id` and
  `tunnel.carrier_id` are NO ACTION and DEFERRABLE INITIALLY DEFERRED (the
  migration adds the last words, drizzle cannot express them): checked at
  commit, so an organization delete that removes both sides in one transaction
  succeeds, while deleting a carrier that has tunnels, or a secret that has a
  badge, fails at commit. RESTRICT and immediate NO ACTION were rejected because
  Postgres checks them per cascaded statement and an organization delete
  removes `secret` and `carrier` before `badge` and `tunnel`. The routes answer
  409 `carrier_in_use` first. A `secret` row is never removed by the database:
  removing a badge or carrier deletes its secrets in the same transaction
  (`deleteBadge`, `deleteCarrier`), removing a tunnel deletes its run-token
  secret (`deleteTunnelRecord`), and `tunnel.secret_id` is SET NULL.
- `carrier` is unique on (organization, provider, external account id); a
  provider with no account stores NULL, and NULLs never collide.

## Tokens

A token is never stored in these tables. `badge.secret_id` (and later
`tunnel.secret_id` for the run token) points at a `secret` row whose
`secret_envelope` is the token sealed with `encryptSecret`. `secret.provider`
is `carrier_badge` for an API token and `tunnel_run` for a run token, neutral
so a new provider never widens `secret_provider_check` again (widened once in
`0005`; the vendor is in `carrier.provider` / `tunnel.provider`). Because the tokens are
`secret` rows, the at-rest re-encrypt sweep (`src/admin/reencrypt-secrets.ts`,
the `secrets` stage reads every row of `secret`) already covers them; there is
no new sealed column. Removing a badge or carrier deletes the `secret` rows in
the same transaction.

A badge row keeps the label, the last four characters and what the token
reaches: `capabilities` is `{ tunnels: boolean, dns: [{id, name}], certificates:
[{id, name}] }`. A tunnel belongs to the account, so `tunnels` is one
account-wide yes or no; DNS rights can be limited to zones, so `dns` lists the
zones found reachable by one safe read each (`certificates` stays empty, since
no safe read shows it). Looking up the zone for a hostname uses only those
zones of the carrier's account. Responses and audit rows carry only those. Provider errors are
scrubbed by `TunnelProviderError` (known secrets, bearer values and token-shaped
runs are redacted) before they are logged, audited, stored or returned.

## API tokens at the provider

Say "API token" everywhere: a Global API Key is a different credential (it needs
an email and is not a bearer token) and is refused by `tokenShapeProblem`
(Cloudflare: `cfk_` prefix, or 37 to 45 lowercase hex characters). Checked
against Cloudflare's documentation: user-owned tokens verify at
`GET /user/tokens/verify` and account-owned tokens at
`GET /accounts/{account_id}/tokens/verify` (both return `id`, `status`,
optional `expires_on`); Tunnel and DNS are supported by account-owned tokens;
new tokens carry a prefix (`cfut_` user-owned, `cfat_` account-owned), older
ones are 40 plain characters. The check tries the endpoint that fits first
(by prefix, else the account one when exactly one account is known) and falls
back to the other. Not stated in the documentation and so not assumed: that an
account-owned token belongs to exactly one account (a verify success is not
used to prove it), and whether an account-owned token may list `/accounts`
(a refusal is read as an empty list, so the person then adds the account by id).
`badge.options` records `kind` and the provider's `tokenId` (a second add of
the same token to one carrier is refused with 409 `badge_exists`; a user-owned
token reaching two accounts becomes one badge under each carrier, sealed
separately), and `badge.expires_at` holds the reported expiry.

## Adapter

`adapter.ts` is the interface: check a credential, create a tunnel, fetch or
rotate the run token, set routes, create or remove the DNS name, delete a
tunnel. `cloudflare-adapter.ts` builds on `cloudflare-client.ts` (a small
typed client over an injected `fetch`; tests never call the real service).

- A credential is checked with read calls only (accounts, zones, tunnels,
  DNS records) and the report says what succeeded. A read proves the token
  reaches that area, not that it can edit; edit rights are confirmed by the
  first write. Certificate rights cannot be seen by a safe read and are
  reported as not shown. The accounts and zones lists may be refused to a
  narrow token; that is treated as empty, not as a bad token.
- Routes always point at `https://localhost`; the last ingress rule is a
  catch-all with no hostname.
- Rotating a Cloudflare run token is not confirmed against the API, so the
  adapter reports it as unsupported rather than guess an endpoint.

## Routes

`src/client/organizations/carrier-routes.ts`, `organization:manage` like backup
targets: `GET|POST /organizations/:id/carriers`, `DELETE .../carriers/:carrierId`,
`GET|POST .../carriers/:carrierId/badges`,
`DELETE .../badges/:badgeId`, `POST .../badges/:badgeId/check`. Adding a
badge checks the token first and refuses one that cannot do anything useful,
naming the missing permissions. OpenAPI: `src/client/openapi/tunnels.ts`.

## Tunnel lifecycle

`lifecycle.ts` (database writes and reads), `placement.ts` (pure rules and the
body parser), `route-builder.ts` (pure), `route-facts.ts` (loads the facts),
routes in `src/client/organizations/tunnel-routes.ts`, same permission as
provider accounts.

- Create: the tunnel is made at the provider first, then stored with its sealed
  run token and its portals in one transaction; a failed store removes the
  provider tunnel again. Remove: refused (409 `tunnel_in_use`) while the tunnel
  carries hostnames, then removed at the provider, then here.
- Placement is read from the portals (see Tables). `one` and `chosen` need
  `run` portals, `all` needs a datacenter, only `all` picks up a new server by
  itself, a `skip` portal leaves a server out of an `all` tunnel. A server with
  `server.options.tunnels.carry === false` never carries any tunnel (set at
  `PUT /organizations/:id/servers/:serverId/tunnel-carrying`). One carrying
  server gets a warning in `warnings`, none gets another.
- Adding a hostname stores the `doorway` row first (the unique keys settle
  races), then sets the provider routes and creates the DNS name in the zone
  found for the name; the zone id is kept in `doorway.metadata`. A name outside
  every zone the carrier's tokens reach is still routed, with no DNS name made
  (`dns: none`). Any failure removes the row again and writes the provider
  route set back. A hostname may be both a site name and a tunnel name, so only
  other doorways make `hostname_in_use`. DNS is never a gate for an ordinary
  site hostname; nothing here is called from the site hostname paths.
- The route builder turns the facts into the `server.tunnel.routes` payload for
  one server: routes only for tunnels the server carries; a name whose site
  runs on this server is `local`; otherwise the upstreams are the datacenter
  addresses of the servers that run the site (exact addresses, preferred
  family first). `peerAddresses` is the other carrying servers of a tunnel
  whose site runs here (inbound only: servers allowed to forward to this one). A
  server that only carries tunnels sends an empty list. Sites count as running on a server through an
  `applied` deployment of their environment. The hash covers the routes, the
  addresses, the certificate and the trust bundle, not the sealed key.
- `daemon-gate.ts`: nothing tunnel related goes to a server, and no name is
  tunnel-only there, unless the daemon advertised `tunnel-forwarding-v1` on its
  `hello` (an older daemon would serve a tunnel-only name unlocked).
- `sync.ts` sends each server its table. It remembers the hash of the last
  table (without the certificate) and the command in
  `server.metadata.tunnelRoutes`, and sends again when the wanted table
  changed, when the last command did not succeed (a server that was offline
  never got it: the consumer does not queue for a disconnected server), or
  when the daemon reported warnings or fewer forwarded names than wanted. The
  periodic sweep (`runTunnelRoutesSweepTick`, from the offline sweep, same
  gate as leaf renewal) covers reconnects. A server is only sent a table while
  connected and advertising the feature. The peer leaf is minted when a table
  needs a certificate; the renewal sweep hands a fresh leaf through
  `peerLeafDelivery`, and the command carries `pendingTlsLeaf` so tracking is
  committed only after the daemon confirmed. The route hash covers the
  certificate and trust bundle, so a renewed leaf with the same routes is still
  applied. The same table is not sent again sooner than ten minutes after the
  previous send, so a table a server keeps refusing does not mint a new
  certificate every tick; a different table is always sent at once.
- `connector-sync.ts` sends each carrying server its connectors with
  `server.tunnel.connectors` (feature `tunnel-connector-v1`): the provider's
  tunnel id and the run token sealed for that one server (`tpdaemon.`; the
  stored command never holds the token in the clear and no log line names it).
  A server runs the tunnels whose placement names it (`carryingServers`) and
  that have a provider id and a run token. The panel remembers, per server, the
  hash of the last list, the command and the ids it asked the server to run in
  `server.metadata.tunnelConnectors`; a tunnel that moved off a server or was
  removed is listed under `remove` on the next send, and stays listed (in
  `removing`) with every send until a command that carried it finished well,
  so a removal that failed is never forgotten. Only ids this code
  installed are ever removed, so the instance's own tunnel and a hand-placed
  connector stay alone. A resend is harmless (the daemon leaves a running
  connector as it is), and the same list is not sent again sooner than ten
  minutes after a send that did not finish. It runs from the offline sweep
  (`runTunnelConnectorsSweepTick`) and right after a tunnel is created, moved
  or removed (best effort). Changing a tunnel's run token is not supported
  yet: remove the connector, then send it again.
- `nudge.ts` sends the tables and then the connector lists
  (`syncOrganizationTunnelConnectors`) right away instead of waiting for the
  sweep, so a server that joins or leaves an "all" tunnel starts or stops its
  connector at once too. It never throws (each pass is guarded on its own), does
  nothing for an organization with no tunnel (and no server that once held a
  table or a connector list), and each pass stops after 40 servers, in the order
  they are found; the sweep reaches the rest. Triggers: a site is created,
  edited or deleted (`/hostings`), a server is changed, deleted or has its
  addresses set (`/servers`), a server joins or leaves a datacenter
  (`/datacenters/:id/members`) or the datacenter is edited, an environment or
  project is deleted, a deploy that moves sites is queued (`deploy-routes.ts`),
  and a deploy result lands (`consumer.ts`, `applyEnvironmentDeploySideEffect`).
  **A request handler never waits for it**: it calls
  `nudgeTunnelRoutesAfterResponse` (`src/client/organizations/tunnel-nudge.ts`),
  which runs the work after the response (`runAfterResponse`) on its own
  database client on Workers (the request's client is closed by `src/workers.ts`)
  and on the process client on Deno. Tests set `tunnelNudgeSchedule` on the
  context to collect the task and run it. The consumer runs it as the very last
  step of the deploy side effect (after all the bookkeeping, also when that
  returned early), through `nudgeTunnelRoutesForEnvironment`. Not covered, left
  to the sweep: the raw `/ips` routes, which are not formatted by the repo
  formatter (editing them would fail the format check). Known follow-ups (not
  built): the `tunnelRoutes` and `tunnelConnectors` markers on a server stay
  after its last tunnel is deleted, so the organization keeps counting as having
  tunnel work (clear them once the empty table or list is confirmed), and the
  first 40 servers are always the same ones (rotate the start).
- `doorway-links.ts` re-reads which site holds each doorway's name from the
  `hostname` table before tables are built (the nudge and the sweep both do).
  A doorway keeps the hostname text, but its site link is read once when it is
  added, and a site's names are deleted and inserted again on every edit, a name
  can move to another site, and a site can be made later or deleted.
- The local-only lock on tunnel names is applied at deploy time
  (`name-lock.ts`, called from `deploy-prepare.ts`): a hosting with a doorway sends
  `hostings[].tunnel`, which makes the daemon answer the name only to loopback and
  the listed peers and drop everyone else. Peers are the exact datacenter
  addresses of the _other_ servers that carry the same tunnel (the tunnels of the
  doorways whose hostname the hosting serves, joined, sorted, cut at 64); when no other server carries it, `127.0.0.1`
  is sent so the list is never empty (the contract refuses an empty list;
  loopback is always allowed, so nothing widens). `extraBind` is this server's own
  datacenter addresses and is sent only when there are real peers. A doorway with
  `isLocalOnly = false` goes in `openHostnames` (lock off for that name). Only the
  hosting's own non-removing doorways of the same organization count.
  Refused with 409: `tunnel_daemon_too_old` (the daemon lacks
  `tunnel-forwarding-v1` and the hosting has a locked name; an all-public hosting is
  allowed and sends nothing) and `tunnel_name_public_certificate` (a locked name
  pinned to a public Let's Encrypt certificate; the daemon contract needs every
  name open in that mode).
  **The lock follows the next deploy.** Adding or removing a carrier changes the
  peer set, but nothing redeploys the site by itself: until the site is deployed
  again, a newly added carrier's forwards to that server are dropped (closed, not
  open) and a removed carrier stays allowed. The deploy-inputs digest already
  covers the `tunnel` field, so the next deploy is never skipped as unchanged.
- Limits: 50 tunnels and 2000 hostnames per organization, 200 hostnames per
  tunnel. A table is cut at the daemon contract caps (2000 names, 16 upstreams
  per name, 8 addresses per upstream, 64 peer and listen addresses) with a
  logged note, never sent whole to be refused. A hostname whose site belongs to
  another organization is refused (409 `hosting_mismatch`), and a site counts as
  running on a server only when its hosting is in the tunnel's organization.
- Firewall: `peer-exposure.ts` turns the same `peerAddresses` the route builder
  sends a server into one derived rule, accept tcp 443 on the host from exactly
  those addresses (`facts.ts` adds it to the hosting exposures; not 80, not
  443/udp, not the panel port). The rule and the Caddy address lock therefore
  name the same servers, and a carrier-only server gets no rule. A successful
  `server.tunnel.routes` is a firewall preview trigger
  (`commandMayChangeFirewallPreview`), so the rule follows the table. It only
  restricts anything once default-drop is enabled (still on hold); until then
  it is shown in the preview. When the hosting is already public the rule is
  redundant and the Caddy lock is the protection.
  Only bare IP addresses pass (the same test the table contract applies), so
  an address row holding a range can never widen the rule while the table is
  refused. The rule is derived without the sync readiness gate (offline or old
  daemon servers are not skipped here). It currently lands after the table: the
  preview fires once `server.tunnel.routes` succeeds, so under default-drop the
  first forwarded requests could be dropped. Default-drop must not ship before
  that order is fixed (send the rule before the routes, or apply it from the
  sync path).
- Not in this slice: redeploying a site when its carrier set changes. The resend
  (`nudge.ts`) covers forwarding tables and connector lists; the name lock on the
  site follows its next deploy (see above).
