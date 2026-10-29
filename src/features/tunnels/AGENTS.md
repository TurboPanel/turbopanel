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
- **Removing a tunnel (`deleteTunnel`, `removal.ts`).** The mark is one guarded
  `UPDATE ... WHERE NOT EXISTS (doorway)`, and `addDoorway` re-reads the status
  after storing its row, so a hostname added at the same moment either stops the
  removal (`tunnel_in_use`) or is refused (`tunnel_removing`); `finishTunnelRemoval`
  checks for hostnames again right before the provider delete. A `removing`
  tunnel takes no new hostname and no placement change (`tunnel_removing`).
  A tunnel with a provider id but no usable account or token stays `removing`
  with the reason instead of being deleted, so a provider tunnel is never
  forgotten. The sweep query takes only the tunnels whose wait is over. The provider refuses to
  delete a tunnel with a connected connector (409, mapped to the error code
  `conflict`), so a tunnel that has a connector somewhere is first marked
  `removing`. `carryingServers` is empty for a `removing` tunnel, so the next
  connector send tells its servers to stop (the usual remove list), and the
  provider delete is tried by `runTunnelRemovalSweepTick` (offline sweep) after
  each wait: 30 s, doubling, up to 10 min (`tunnel.metadata.removal` holds
  `attempts`, `nextAt` and the plain reason, shown as a warning on the tunnel).
  A tunnel with no connector is deleted at once; one the provider no longer has
  (404) counts as removed. The token wipe, the run-token secret and the portals
  go in `deleteTunnelRecord` as before; hostnames must be removed first.
- **Tunnel status follows the connectors.** `recordTunnelStatus` (status poll) moves
  `tunnel.status` with `nextTunnelStatus`: a connected connector makes it
  `active`; with none connected, a down or failed one makes it `attention`; a
  tunnel being removed keeps `removing`. An all-servers tunnel has no portal
  rows (only `one` and `chosen` store them), so the answer is applied to the
  tunnel directly and a down answer only moves it off `pending`. Only a server
  that carries the tunnel (`carryingServers`) can move it.
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
zones found reachable by one safe read each (`certificates` lists the zones whose
origin certificate list the token can read; a token added before this check
has none until it is checked again, and the issue route does that once). Looking up the zone for a hostname uses only those
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
  first write. Reading a zone's origin certificate list proves certificate
  rights the same way and is never reported as a missing permission, since
  certificates are optional. The accounts and zones lists may be refused to a
  narrow token; that is treated as empty, not as a bad token.
- Routes always point at `https://localhost`; the last ingress rule is a
  catch-all with no hostname.
- The client never stores the platform `fetch` and calls it as a method of
  itself: on Workers that receiver is refused ("Illegal invocation") while Deno
  accepts it, so tests alone would not catch it. The default is a wrapper that
  calls `globalThis.fetch` as a plain function; `cloudflare-client.hostfree.test.ts`
  stubs a fetch that refuses a wrong receiver.
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
  A doorway put on the tunnel before the site has the name has no `hostingId`
  yet (the sweep and the resend fill it in later); the lock is built before
  that, so `loadNameLock` also takes the organization's non-removing doorways
  that have no site and whose name (compared without case) the deploying
  hosting lists (`unlinkedDoorwayNamed`). It is read only (a deploy
  preparation writes nothing), and a doorway already linked to another site is
  never taken. Without it the first deploy sent no lock.
  Refused with 409: `tunnel_daemon_too_old` (the daemon lacks
  `tunnel-forwarding-v1` and the hosting has a locked name; an all-public hosting is
  allowed and sends nothing) and `tunnel_name_public_certificate` (a locked name
  pinned to a public Let's Encrypt certificate while the hosting also serves
  ordinary public names; the daemon contract needs every name open in that mode).
  The names counted are those the certificate would cover
  (`hostingCertificateNames`): under a `www` mode the other spelling is served or
  redirected too, is not a tunnel name unless typed as one, and so counts as a
  public name.
  A tunnel block never asks for a public certificate: when every name the
  hosting serves is a locked tunnel name, the pin (the Let's Encrypt box that
  switches on when a hostname is typed) is set aside for the deploy
  (`dropPublicCertificate`: no `tlsMode` on the wire, internal certificate) and
  nothing is refused.
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

## Origin certificates

Optional, per tunnel. The default hop from the connector to the local web server
skips certificate verification (`noTLSVerify: true`; the connector still sends
the hostname as the origin server name). With the choice "verify the
connection" (`tunnel.options.verifyOrigin`) the sites that serve the tunnel's
names present an origin certificate and the connector verifies it
(`setRoutes` with `verifyOrigin: true`, which sets `noTLSVerify: false` and
nothing else; no certificate file or path is needed, the connector's origin pool
includes the provider's origin roots, proved on a real connector, see the end of
this section.)

**The default is a certificate for EXACT hostnames, not a wildcard.** One
certificate per site (a site pins one `tlsId`), listing exactly the names that
site serves, issued on demand. A wildcard (the zone and `*.` the zone) exists
only when the person asks for it (`wildcard: true`). Why: a wildcard key can
impersonate any name under the zone, revoking it takes every site with it, it
does not cover a name two labels down (`a.b.zone`), and names are added one at a
time anyway.

`origin-certificate.ts` keeps the issued pairs in the organization certificate
library (`tls`, source `provider_origin`), one row per certificate. The key is
an ECDSA P-256 key made in the panel (`mintCertificateRequest`); only the
request goes to the provider; the key is sealed like every library key.
`tls.metadata.providerOrigin` holds the account, the token that can revoke it,
the zone, the provider's certificate id, the exact names (`hostnames`), the
`scope` (`names` or `wildcard`) and `retiredAt`; the TLS routes never return it.

Real API facts (checked against the live service on 2026-10-28):

- Validity must be one of 7, 30, 90, 365, 730, 1095 or 5475 days. We use 365 and
  renew 30 days before expiry.
- A certificate lists at most 100 names ("up to 100 per certificate"); the code
  refuses more. Names must be inside a zone of the account; a foreign name is
  refused (code 1010).
- Only one wildcard, and only first: `*.zone` is allowed (also `*.sub.zone`),
  `*.*.zone` and `a.*.zone` are not. A wildcard covers one label.
- The list (`GET /certificates?zone_id=`) returns `id`, `hostnames`, `expires_on`
  and the certificate PEM; never a private key, and it carries no request type
  or validity. Revoked certificates drop out of it. `expires_on` is
  `2027-10-29 02:12:00 +0000 UTC`.
- Revoking twice answers 400 "Certificate already revoked" (code 1014), and an
  unknown id answers 400 "Failed to read certificate" (1101), not 404. The client
  reports both as `not_found`, which callers treat as already gone.

Rules the code enforces:

- A token may issue only for a zone its recorded `certificates` rights name.
  Existing tokens have none recorded: the issue route runs one credential check
  and stores the result before it refuses. (Token selection for the routes is
  being replaced by the shared selector; `pickCertificateBadges` is the single
  function to swap.)
- **Reuse:** a healthy, unretired TurboPanel certificate of the same account
  that already covers every name (an exact certificate, or an opted-in wildcard
  one label up) is returned instead of issuing another (`findCoveringCertificate`).
- **Replace, never edit:** when a site gains a name, a new certificate lists all
  of them; the exact certificates it makes redundant are marked **retired**
  (`retiredAt`), not revoked. A certificate whose last name is gone is retired
  too (`retireUnusedOriginCertificates`, run when a hostname is removed and by
  the sweep). The sweep (`sweepOriginCertificates`) revokes a retired certificate
  only once no site pins it and 24 hours have passed, or just drops it when it has
  expired. So a server that has not been redeployed keeps a working certificate.
- **Only certificates TurboPanel issued are ever revoked.** The provider list
  (`describeExistingOriginCertificates`, `GET .../origin-certificates/existing`)
  shows every certificate the zone holds and marks the ones issued here; a
  certificate made elsewhere is shown but cannot be installed (its key was never
  ours): upload its certificate and key to the library, or issue a new one.
- A site that pins the certificate blocks revoking it (`tls_in_use`). **Revoking
  and renewing are not tied to the token that issued a certificate:**
  `pickCertificateBadges` (the one place a token is chosen for certificate work)
  returns the account's active tokens with certificate rights for the zone,
  matched by zone id, narrowest first; the next one is tried when the provider
  refuses a token. The token used is recorded in the audit row
  (`revokedWithBadgeId`). With no such token a revoke is refused (`badge_missing`)
  unless forced. Removing a token is refused (`origin_certificate_in_use`) only
  when it is the last active token that could revoke a certificate; removing the
  account is refused while it still owns certificates. The TLS library routes
  refuse to revoke, delete or create a `provider_origin` row (`409
provider_origin_managed`, `400 provider_origin_unsupported`).
- If storing fails after the provider issued the certificate, it is revoked
  again. A provider that no longer knows the id counts as revoked.
- Renewal issues a replacement for the same names and scope, re-pins the sites
  (it does not redeploy: `renewOriginCertificate` returns the re-pinned hosting
  ids so a surface that can queue a hostings-only deploy can push them) and
  retires the old row. The sweep is not on a timer yet.
- Deleting an organization removes the rows without revoking them at the
  provider.

**Turning it on** (`verify-origin.ts`, `PUT /organizations/:id/tunnels/:tunnelId/verify-origin`
`{ enabled, wildcard? }`): each site that serves the tunnel's names gets the
certificate for exactly the names it serves (`hostingCertificateNames`, so the
`www` sibling counts) and `hosting.tlsId` is pointed at it. The daemon already
renders a pinned pair for a locked tunnel name instead of `tls internal`, so no
daemon change is needed; the server gets the new pair with the site's next
deploy (`needsDeploy`). Refused (409) when the site also serves a name that is
not a verified tunnel name (`verify_origin_public_names`: browsers do not trust
an origin certificate), when its names span more than one zone
(`verify_origin_zones`), or when a chosen wildcard does not cover a deeper name
(`verify_origin_names`). Safe to repeat: run it again when a site was missing or
names were added.

**The connector only verifies while every name is covered.** `tunnelVerifyState`
(`verify-state.ts`) is `active` only when every non-removing name of the tunnel
belongs to a site that pins a ready, unexpired origin certificate covering it;
the routes sent to the provider use `active`, never the bare choice, so a site
that does not exist yet can never make a verified tunnel unreachable. `pendingNames`
(in the tunnel's `verifyOrigin`) says which names still wait.

Routes (`client/organizations/origin-certificate-routes.ts`, `organization:manage`):
`GET|POST /organizations/:id/carriers/:carrierId/origin-certificates`,
`GET .../origin-certificates/existing?zone=`, `DELETE .../origin-certificates/:tlsId`
and the tunnel route above. Tunnel-only names never get an automatic public
certificate request; nothing here touches that path.

**Proved on a real connector (2026-10-28, testing server w, connector 2026.5.2):**
a throwaway tunnel routed one hostname to a small TLS server on the same machine
that presented an origin certificate issued for exactly that name, with the
route set to `originServerName` = the hostname and `noTLSVerify: false`. A request
through Cloudflare returned the page (200), so the connector verifies the origin
certificate against its built-in roots with no file or path configured. The same
server presenting a self-signed certificate answered 502 and the connector log
said `x509: certificate signed by unknown authority`, so verification really was
on. The tunnel, DNS name and certificate were removed afterwards. Not yet tried
through the full panel flow (turning the option on for a tunnel with a site): that
is the next testing round.
