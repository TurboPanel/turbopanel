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
  server. A placement change touches only the rows that change
  (`portalChanges`): a server that keeps its role keeps its row and what its
  connector last reported, so it does not fall back to "not reported yet". `portal.options` is reserved for per-server details (for example a
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
- **Periodic sweeps (`sweeps.ts`).** The five tunnel sweeps (routes,
  connectors, removal, daily token recheck, connector status) are one ordered
  list, `TUNNEL_SWEEPS`, and both schedulers run that list every minute: the
  hosted cron (`runQueuedCronSweeps` in `src/daemon/cell/offline-sweep.ts`,
  behind the secrets bundle like leaf renewal) and the self-hosted
  certificate timer in `src/platform/deno/server.ts`
  (`runSelfHostedTunnelSweeps`, fresh database client, no overlap, skipped
  while the command queue is the no-op one). Each sweep fails alone and
  throttles itself from the database, so the minute tick is cheap. Add a new
  tunnel sweep to the list, never to one scheduler:
  `src/platform/deno/tunnel-sweeps.hostfree.test.ts` fails when a scheduler
  calls a tunnel sweep directly, or when the hosted cron runs a sweep the
  self-hosted timers do not. Before this list existed the self-hosted control
  plane ran none of them; a tunnel left at `removing` then is finished by the
  removal sweep once the build with the list runs, with no data change.
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
  provider delete is tried by `runTunnelRemovalSweepTick` (periodic sweeps) after
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
- **A stopped connector is sent again.** A connector list that finished well is
  never resent while it is unchanged, so a connector stopped by hand (or given
  up on by systemd) used to stay down. When a status answer shows a connector
  the last list asked that server to run as stopped or failed
  (`connectorsNeedingRepair`) and that list has finished (one still on its way
  is waited for), `recordTunnelStatus` clears the remembered hash
  (`server.metadata.tunnelConnectors.stateHash`, the rest kept), so the next
  connector sweep sends the same list again; the daemon starts an installed
  connector that is stopped or failed when the list is resent. An older daemon
  ignores the resend, so at worst one list per status poll goes out while the
  connector stays down. `not-installed` is not repaired this way: a daemon
  that still holds the connector's record skips it on a resend, so the list
  would only repeat (a daemon-side reinstall from the stored token copy is not
  built yet).
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
(Cloudflare: `cfk_` prefix, or 37 to 45 lowercase hex characters). The same
check refuses text that cannot be an API token at all: a tunnel run token
(starts with `eyJ`) or anything with a space, line break or other stray
character inside (`cloudflare-token-format.ts`). When Cloudflare itself says
so (400 with error 6003 `Invalid request headers`, or 6111 in `error_chain`),
both clients throw `TunnelProviderError` with code `token_format` and one
plain sentence saying what to paste; routes answer that as `badge_rejected`
(400), never as `provider_unavailable`, because Cloudflare was reached. Checked
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

## Several API tokens on one account

One account (carrier) holds up to 50 tokens (badges): for example one that
edits tunnels and others that edit DNS, each limited to one zone or a few. What a
token reaches is stored in `badge.capabilities`: `tunnels` account-wide, `dns`
and `certificates` as zone lists (id and name). The zone **id** is what matches
(a zone deleted and added again has a new id); the name is for matching
hostnames and display.

- **One selector.** `pickBadges(badges, need)` in `records.ts` takes
  `{capability: 'tunnels'}` or `{capability: 'dns' | 'certificates', zone: {id, name?}}`
  and returns `{badges, missing}`: the active tokens that qualify, best first (a
  token limited to fewer zones before one that reaches many, then the most
  recently checked, then the oldest), and when none does `missing` is
  `'capability'` (no active token has that right) or `'zone'` (some do, none for
  this zone). `badge-use.ts` `useBadges(db, secrets, carrierId, need, run)` does
  the call with each in turn and returns `{value, badge, token}`; `openBestBadge`
  opens the first without a call. Features that need a token (origin certificates,
  Let's Encrypt DNS challenges, tunnels, hostnames) call these, never a private
  copy. `badgeRefusal` turns `BadgeUnavailable` / `BadgeRefused` into the plain
  409 text.
- **Refusal fallback.** Only read probes run when a token is added, so an edit
  right is first proved by a write. When the provider answers 403 the right (or
  that zone) is taken off the stored scope and `options.lastFailure` keeps what
  was refused (shown as a warning); a 401 takes the whole token out of use. The
  next qualifying token is tried. A check restores the scope if the right works.
- **Zone of a hostname.** First the stored zones of the account's active tokens
  (longest name wins); only when none matches is the provider asked with the
  tunnel token. A refused zone list is not an error: the route still works and
  the person makes the DNS name. Before a hostname is written, a zone with no
  token that can edit its DNS is refused (`badge_cannot_dns`, with the reason).
- **Narrow tokens.** A token limited to a zone is usually refused the account and
  zone lists, so the person names the zone (`zones` when adding the token, or
  `POST .../badges/:badgeId/zones`). Each named zone is probed with that token
  (a DNS read; a zone read too when it may make one, to learn the name and the
  account) and kept in `options.declaredZones`, so every later check and the
  daily recheck probe it again. A zone of another account is refused; a zone the
  token cannot read is refused; a token that cannot read the zone needs its name
  typed.
- **Removal order.** `removeDoorway` looks for the DNS token before it changes
  anything. With none, the route is still taken down (the name answers nothing)
  and the row stays in `attention` with the reason in `warning`; a retry with a
  token that covers the zone finishes it. Any token that covers the zone can
  remove the DNS name; the token that made it is recorded in the hostname's
  metadata (`dnsBadgeId`) for the record only.
- **Items belong to the account, never to a token.** Tunnels, hostnames, origin
  certificates and Let's Encrypt DNS orders keep only the account (`carrierId`);
  every later call picks a working token at call time. A token id kept with an
  item (`dnsBadgeId`, `providerOrigin.badgeId`) is a record of what was used, no
  foreign key points at `badge`, and nothing is moved when a token goes. Rotating
  a token is: add the new one, remove the old one.
- **Deleting a token** is refused (409 `badge_in_use`, a plain `message` naming
  them, up to 50 `dependents`) only while no other active token of the account
  covers something that needs it (`badge-dependents.ts`): it is the only token
  that reaches tunnels for an account with Tunnels, the only one that reaches DNS
  for a zone whose hostnames have DNS names or whose DNS-validated certificates
  renew there (`kind: 'certificate'`), or the only one that manages origin
  certificates of a zone that has them (`kind: 'certificate'`, retired ones too,
  since they are revoked later). Removing a named zone from a token checks the
  same. The check and the delete (or the zone write) run in one transaction
  holding the carrier row `FOR UPDATE` (`withCarrierLocked`, the lock
  `insertBadge` takes too), so two tokens that cover each other cannot both be
  removed at once: the second removal sees the first one gone and is refused.
  The provider is asked before the lock, never while holding it; a zone removal
  whose token's zones changed in between answers 409 `badge_changed`.
- **Daily recheck.** `badge-recheck.ts` (periodic sweeps) re-checks up to 10 tokens a
  tick whose last check is a day old: scopes refresh, a token the provider no
  longer accepts goes to `attention`, an outage changes nothing and the token is
  tried again in an hour. `badgeWarnings` flags a token 14 days before its expiry.

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
  certificates are optional. `badge.options.capabilityProbe` stamps which set
  of rights a check looked for; the daily recheck takes any token stamped lower
  (or unstamped, checked before certificates were probed) at its next tick, so
  raise `CAPABILITY_PROBE_REVISION` whenever a check learns a new right. The
  accounts and zones lists may be refused to a narrow token; that is treated
  as empty, not as a bad token, and zones the person named are probed one by
  one instead.
- Routes always point at `https://localhost`; the last ingress rule is a
  catch-all with no hostname.
- The client never stores the platform `fetch` and calls it as a method of
  itself: on Workers that receiver is refused ("Illegal invocation") while Deno
  accepts it, so tests alone would not catch it. The default is a wrapper that
  calls `globalThis.fetch` as a plain function; `cloudflare-client.hostfree.test.ts`
  stubs a fetch that refuses a wrong receiver.
- Rotating a Cloudflare run token: `rotateRunToken` gives the tunnel a new
  random secret (`PATCH .../cfd_tunnel/{id}` with `tunnel_secret`, 32 random
  bytes in base64) and reads the new token back with the get-token call;
  connectors already connected stay up, but the old token can no longer open a
  connection. The secret is passed to the error scrubber. `dropConnections`
  (`DELETE .../cfd_tunnel/{id}/connections`) drops every connection; connectors
  that hold the current token reconnect. Both are from the provider's
  documentation and still to be proven on canary.

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
- **A name that already has DNS records.** Before anything is stored or
  routed, the zone's records for the name are read (with a token that can edit
  that zone's DNS, `listDnsConflicts`). A CNAME that already points at this
  tunnel is kept and reused. Any other A, AAAA or CNAME record refuses the add
  with 409 `dns_record_exists`, naming each record (type, content, proxied) in
  the message and in `records`, with `replaceable` (false past
  `MAX_REPLACED_RECORDS`, 10: those are removed by hand, and the message says
  so). The person confirms by sending the same hostname with
  `replaceDnsRecords`: each record as it was shown, `{ id, type, content }`.
  It is compared by id, type and content (`sameDnsRecords`), so a record
  edited in place since it was shown is refused again, and the adapter reads
  the records again when it writes, so a record added meanwhile is never
  replaced unseen. A CNAME may not sit beside other address records, so the
  others are deleted first (every delete is tried) and then the first becomes
  the tunnel's CNAME (keeping its id). If anything fails after a delete, the
  answer is 502 `dns_replace_incomplete` with `removedRecords`, and the route
  writes a `doorway.dns_replace_failed` audit row with them: the only record
  of what was deleted. The same holds when the hostname row cannot be saved
  after a replacement. Other record types on the name (MX, TXT, …) are never
  listed, replaced or deleted. Removing the hostname later deletes the CNAME;
  the replaced records are not put back, so what they were (type, content,
  proxied) is kept in the hostname's `metadata.dnsReplaced` and in the
  `doorway.create` audit row.
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
  periodic sweep (`runTunnelRoutesSweepTick`, from the periodic sweeps, same
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
  minutes after a send that did not finish. It runs from the periodic sweeps
  (`runTunnelConnectorsSweepTick`) and through the nudge below (best effort). A rotated run token reaches each server through the same list (see **Run-token rotation** below).
- `nudge.ts` sends the tables and then the connector lists
  (`syncOrganizationTunnelConnectors`) right away instead of waiting for the
  sweep, so a server that joins or leaves an "all" tunnel starts or stops its
  connector at once too. It never throws (each pass is guarded on its own), does
  nothing for an organization with no tunnel (and no server that once held a
  table or a connector list), and each pass stops after 40 servers, in the order
  they are found; the sweep reaches the rest. Triggers: a tunnel is created,
  moved to other servers (`PUT .../placement`) or removed, a hostname is added
  to or removed from a tunnel, a server is allowed or barred from carrying
  tunnels (`/tunnel-carrying`), a site is created,
  edited or deleted (`/hostings`), a server is changed, deleted or has its
  addresses set (`/servers`), a server joins or leaves a datacenter
  (`/datacenters/:id/members`) or the datacenter is edited, an environment or
  project is deleted, a deploy that moves sites is queued (`deploy-routes.ts`),
  and a deploy result lands (`consumer.ts`, `applyEnvironmentDeploySideEffect`).
  The tunnel routes once sent only the connector lists, so a server added to a
  tunnel started its connector at once but got its forwarding table only from
  the sweep (or the next deploy result): the tables and the lists go out
  together from every trigger.
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
  hosting lists (`unlinkedDoorwayNamed`). The lookup is read only (a deploy
  preparation stores nothing but the table generation counter, see Table
  generation), and a doorway already linked to another site is
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
  Such a hosting also keeps no Let's Encrypt library row: `settleTunnelOnlyHosting`
  (`tunnel-only-certificate.ts`) drops its pin to a row made for sites, forgets
  a waiting request and removes the row once nothing else pins it. The deploy
  calls it when it sets the pin aside, `PUT /hostings/{id}/use-letsencrypt`
  calls it first (answering 200 with `tunnelOnly: true` and creating nothing),
  and the waiting-request sweep calls it before retrying, so nothing is ordered
  from or retried at the authority for a tunnel-only name.
  **The lock follows the forwarding table** (daemon feature
  `tunnel-lock-follow-v1`). The deploy writes the first lock; after that the
  table sent to a server that runs a site carries `inbound`: every tunnel name
  whose site runs there, with the exact addresses of the other servers that
  carry that name's tunnel (per name, not the server-wide `peerAddresses`, so
  one tunnel's carriers never reach another tunnel's names; empty when no other
  server carries it). The daemon rewrites only those names' lock and
  `trusted_proxies` lines, so a carrier added or removed by a placement change
  is let in or shut out within seconds of the nudge, with no redeploy, and a
  later deploy takes the same peers. `inbound` is in the table hash only when
  sent, so a daemon without the feature keeps its hash and gets no field; a
  table that holds only `inbound` is still sent. For a daemon without the
  feature the old rule holds (the lock follows the site's next deploy: a newly
  added carrier's forwards are dropped, a removed one stays allowed), and the
  tunnel's `warnings` say how many servers that run its sites are in that case
  (`serversWithDeployOnlyLock`, `siteServersOfTunnel`). The deploy-inputs
  digest already covers the `tunnel` field, so a deploy is never skipped as
  unchanged.
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
- A site is never redeployed when its carrier set changes: the resend
  (`nudge.ts`) covers forwarding tables (with the lock, see above) and
  connector lists.

## Table generation

Feature `tunnel-table-generation-v1`. One generation per organization tunnel
table, kept in `organization.options.tunnelTable` (`{ contentHash, generation }`,
no column) by `table-generation.ts`. The content hash covers the facts the
tables are built from (`loadRoutingFacts`: carriers, where each name's site
runs, those servers' addresses), every list sorted so equal content hashes
equal. When the content changes the new generation is `max(previous + 1,
Date.now())`; an unchanged table (the periodic resend, a reconnect, a deploy)
reuses the stored number, because a changed one makes every daemon apply the
whole table again. The write is a compare-and-set on the previous value, so two
callers that see the same change store one number. Both senders resolve it the
same way: `sync.ts` sets `generation` on `server.tunnel.routes` and
`resolveDeployNameLock` sets `hostings[].tunnel.generation`, only for a daemon
that lists the feature. It stays out of the table `hash` and the per-server sent
state. If it cannot be stored the send fails (a table without it would clear the
daemon's record). When a daemon answers `applied: false` with its "older than
the one in place" warning, the stored number is behind what the daemon applied
(for example after a restore). `stale-table-note.ts` logs it and heals it from
the command's success side effects (`stale-table-heal.ts`): the organization's
generation is raised to `max(previous + 1, now)` with the same compare-and-set
(`bumpedAt` in the stored value limits that to once a minute per organization,
so two stuck daemons cannot loop) and that server is sent its table again
through `syncServerTunnelRoutes` with `force`. A server refused inside the
minute is not requeued at once; the sweep sends it the table again.
Anything that writes `organization.options` must merge into it (a jsonb merge or
`jsonb_set`), never replace it whole, or the counter is lost. A deploy
preparation (a preview too) can write the counter: the generation is stored the
first time a changed table is seen, whoever sees it first. The peers and the
generation of a deploy come from one unchanged read of the routing facts
(`peersWithGeneration` in `name-lock.ts`).

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
  and stores the result before it refuses. Tokens are chosen by the shared
  selector (`pickBadges` / `useBadges`, capability `certificates`, zone by id).
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
  the shared selector (`useBadges`, capability `certificates`) uses the
  account's active tokens with certificate rights for the zone, matched by zone
  id, narrowest first; the next one is tried when the provider refuses a token. The token used is recorded in the audit row
  (`revokedWithBadgeId`). With no such token a revoke is refused (`badge_missing`)
  unless forced. Removing a token is refused (`badge_in_use`, the
  certificate named) only when it is the last active token that could renew or
  revoke a certificate; removing the account is refused
  (`origin_certificate_in_use`) while it still owns certificates. The TLS library routes
  refuse to revoke or create a `provider_origin` row (`409
provider_origin_managed`, `400 provider_origin_unsupported`). Deleting one from
  the library (`DELETE /tls/:id`) revokes it at the provider through the same
  selector and then removes the row; a site that pins it answers `409 tls_in_use`
  with a plain sentence, and a row without a provider link is never touched.
- **Compose-owned sites keep the pin.** The compose reconcile re-asserts a
  site's `tls_id` from its declaration on every deploy, which used to hand a site
  pinned by the verified connection back to the declared mode (internal or
  Let's Encrypt) and left the connector with no matching certificate (502). The
  reconcile now keeps a pin on an unretired `provider_origin` row unless the
  declaration names a certificate itself; once the certificate is retired
  (verified connection off) the next deploy returns the site to its declaration
  and the sweep can revoke the certificate. Removing a tunnel also retires the
  certificates nothing needs.
- If storing fails after the provider issued the certificate, it is revoked
  again. A provider that no longer knows the id counts as revoked.
- Renewal issues a replacement for the same names and scope, re-pins the sites
  (it does not redeploy: `renewOriginCertificate` returns the re-pinned hosting
  ids so a surface that can queue a hostings-only deploy can push them) and
  retires the old row.
- **Scheduled pass:** `runOriginCertificateSweepTick` (`origin-certificate-sweep.ts`)
  rides `runHostingLetsEncryptSweepTick`, which both the Deno interval and the
  Workers cron already call, so there is no new timer. Per tick it handles at most
  10 rows (`ORIGIN_SWEEP_BATCH`) across organizations, soonest-ending certificate
  first, each organization getting a fair share and the list rotated by the minute
  so none is always last (a pass also stops starting organizations after 20
  seconds), and only rows
  that need it (retired, or close to expiry); a pinned certificate close to expiry
  is renewed even when retired (verification turned off), so a server never keeps
  an expired one. Sites re-pinned by a renewal get their hostings-only apply. It
  needs the data-encryption secrets and does nothing without them.
- **Back-off** (`origin-certificate-retry.ts`): a row whose renewal or revoke
  fails (or that has no token able to issue) waits one hour, then two, doubling
  to a day, kept in `metadata.originRetry` (`attempts`, `nextTryAt`; a sibling
  of `providerOrigin` so rebuilding the link never drops it, and never copied
  to the public row). The sweep skips rows whose time has not come. A provider
  answer of 429 or 503 with `Retry-After` (`TunnelProviderError.retryAfterMs`)
  is used as the wait as given, does not count as an attempt, and holds back
  every other row of the same API Token for that long. A renewal clears it.
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
names were added. One request asks the provider for at most 10 certificates
(`MAX_CERTIFICATES_PER_VERIFY`); the other sites come back as
`deferredHostingIds` and the next apply continues without issuing anything twice.
A wildcard request is checked against every site's names before anything is issued.

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

## Run-token rotation

`run-token-rotation.ts` (driver) and `rotation-state.ts` (pure), route
`POST /organizations/:id/tunnels/:tunnelId/run-token/rotate`, periodic sweep
`runRunTokenRotationSweepTick`. A tunnel's run token is replaced without
removing the tunnel:

- Refused (409) while the tunnel is being removed or not yet at the provider,
  while a rotation is under way (`rotation_in_progress`), when a carrying
  server's daemon lacks `tunnel-connector-token-change-v1`, `tunnel-connector-v1`
  or `tunnel-status-v1` (`tunnel_daemon_too_old`, with `serverIds`; an older
  daemon keeps the old token, which can no longer reconnect), and for a single
  carrier without `confirmSingleServer` (`rotation_single_server`: visitors
  lose the tunnel for a few seconds). Every start warns that connectors
  briefly reconnect. The same refusals (all but the single carrier) are
  computed by `rotationBlock` and shown on every tunnel answer as
  `runTokenRotationBlock` (code, message, serverIds), so the screen can disable
  the action with the reason before it is pressed.
- Progress is `tunnel.metadata.runTokenRotation` (no new table, column or
  status value): `phase` (`starting`, `rolling`, `finishing`, `done`,
  `stopped`), a `step` counter every save is guarded on (one writer wins),
  `tunnelSecretId` (the tunnel secret, 32 random bytes chosen once and sealed in
  a `secret` row before the provider is ever asked, so every attempt, retry or
  second advancer sends the same secret and gets the same token), `claimedAt`
  (a two-minute lease, taken with a guarded save, around each provider
  attempt), `newSecretId` (the new sealed token, a second `secret` row; the
  chosen secret is deleted once it is saved), `pending` and `moved` servers,
  `unconfirmed` (moved servers that went out of reach before confirming) and
  the `current` one.
- Until the end, `runSecretFor` gives each server the old token while it waits
  its turn and the new one once moved (or when it started carrying the tunnel
  after the rotation began), so a repair resend or a placement change never
  moves a server early. The one exception: the driver moves a waiting server
  whose connector reported `down` or `error` (portal `reported`) at or after
  the rotation's `startedAt` (`last_seen_at`; an older or missing reading is
  ignored, because the connector may have been restarted since) out of
  `pending` into `unconfirmed` at once, since it holds no connection and the
  old token could not open one; it keeps the new token from then on (state,
  not the latest report, decides) and is checked again at the end.
  Connector sync hashes the secret row id, so moving a server changes its list
  and it is sent.
- One server at a time: its list goes out with the new token (the daemon
  restarts that connector in place), and once that command succeeded the
  server is asked `server.tunnel.status` (again every 30 s) until this tunnel's
  connector answers `connected`. Then traffic is given ten minutes to move onto
  that connector (`ROTATION_SETTLE_MS`, from the provider's own rotation steps:
  "Wait 10 minutes for traffic to route through the new connectors") before the
  next server is moved or old connections are dropped. Before a server's list
  goes out, the rotation waits until no other connector list is on its way to
  it, so an older list carrying the old token can never land after the new
  one. A server that cannot be reached waits behind the others; the current
  server going out of reach mid-move keeps the new token (in `unconfirmed`)
  and is checked again once every waiting server has moved. Once a secret was
  chosen, a stop would strand the waiting servers on a token the provider may
  already have retired, so every stop that can clear up by itself (a provider
  error, which may have landed anyway; no remaining server reachable; a list
  refused, not confirming the new token, or not connected within ten minutes)
  is `retryable`: the answer says so (`resumesOnItsOwn`) and the sweep resumes
  it two minutes later (`ROTATION_RETRY_MS`). Nothing more moves and no
  connection is dropped while stopped. A person can resume at once; a resume
  after a secret was chosen skips the start-only "every server reachable"
  check. `oldTokenServerIds` lists the servers that may still hold the old
  token: the waiting ones once the new token is known, and every carrier when
  it stopped after the secret was chosen but before the token came back. Only
  a gone provider account or chosen secret stops it for good.
- Then every connection is dropped once, under the same lease, so two
  advancers never drop twice (`dropConnections`; a provider account
  that is gone, or a provider that cannot drop them, stops the rotation rather
  than marking it done), the tunnel takes the new secret row (renamed to the
  tunnel's run token) and the old one is deleted, in one transaction with the
  `done` save. Deleting a tunnel also deletes the token and the chosen secret
  of a rotation that never finished. The token is never logged, audited (`tunnel.run_token.rotate`
  records the phase and server count) or returned.
