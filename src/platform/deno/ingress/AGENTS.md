# Self-Hosted Ingress (`src/platform/deno/ingress/`)

Code and admin routes that exist only on the self-hosted build. TurboPanel
High Availability (Workers) must not contain any of it.

- **Import rule.** Only `src/platform/deno/**`, `src/deno.ts` and
  `src/deno-dev.ts` may import this directory, test files included.
  `pnpm check:import-boundaries` fails any other importer (surfaces, features,
  lib, daemon cell).
- **Mounting.** `src/platform/deno/server.ts` imports `admin-routes.ts` and
  passes `registerIngressAdminRoutes` as `registerPlatformAdminRoutes` to
  `registerAdminRoutes`, so the admin session middleware still applies. Add new
  routes inside that registrar; never mount them from anywhere else.
- **Workers answers 404, not 422.** The route does not exist there.
  `src/admin/platform-admin-routes.hostfree.test.ts` and
  `src/workers.entry.test.ts` assert the route table has no `tunnel-token`,
  `ingress` or `acme-dns` paths.
- **ACME boundary.** This directory is scanned by
  `scripts/check-instance-acme-boundary.mjs` as instance code: it must not
  reference an organization ACME opt-in.
- **Prefix.** Every route sits under `/api/admin/v1`, so no Caddy or
  `wrangler.jsonc` `routes` change is needed.
- **Routes.** `admin-routes.ts` keeps `POST /instance/tunnel-token` (left out of
  the Workers OpenAPI spec) and calls three registrars: `account-routes.ts`
  (`/instance/ingress/accounts`), `hostname-routes.ts`
  (`/instance/ingress/capabilities`, which carries the edge gate,
  `/instance/ingress/hostnames/:id` PATCH plus `preflight`, `apply`, `status`,
  `remove`) and `dns01/routes.ts` (`/instance/acme-dns/hostnames/:id`, `order`,
  `retry`). Reads are admin; every change is `rootOnly`; adding or removing an
  account also needs step-up. Deps come from the Hono context
  (`route-context.ts`); `server.ts` adds `selfKid` and `getEnv`.
  `admin-routes.ts` also keeps `GET /instance/ingress/trusted-proxies` and
  `POST /instance/ingress/trusted-proxies/refresh` (both `rootOnly`).
- **Provider interface.** `provider.ts` defines `preflight`, `apply`, `status`
  and `remove`; `capabilities.ts` holds the capability table (one record per
  mode, pinned cell by cell by `capabilities.hostfree.test.ts`); `planner.ts`
  checks a hostname against its mode; `registry.ts` maps a mode to a provider.
  `direct`, `lan-only` and `cloudflare-tunnel` are implemented. API-driven
  providers get `IngressContext.deps` (built by `service.ts`); `apply` stores
  nothing, and `service.ts` keeps `origin.ingress_state` as
  `{ provider, status, lastApply }`. No token is ever written there.
- **Mode and account per name** change through `PATCH
/instance/ingress/hostnames/:id` (`setHostnameIngress`), not the
  replace-all hostname PUT. A name whose provider setup is still in place must
  be removed (Disconnect) before its mode or account changes (409).
- **Edge set.** `isEdge` in the table must equal `EDGE_MODES` in
  `src/features/install/heartbeat-policy.ts` (that file cannot import this
  directory, so the test lives here). The Deno heartbeat reader is fed the
  hostname modes from `server.ts` every five minutes.
- **Edge gate** (`gate.ts`), decided by the control plane alone. An `isEdge`
  mode is allowed only when every remote server has this control plane's key
  pinned (`server.trust_pinned_by` is `install` or `upgrade`; NULL and
  `unsafe` hold it shut). The co-located server (`resolveColocatedServerIdSet`
  with `orgScoped` and the self-host pin: strong signals only, never the
  hostname or single-unassigned-server guesses) never counts, and no remote server means ready. The
  connection-mode PATCH answers 409 with the reason and `waiting` (the servers
  holding it shut) when a row is switched to an edge mode while shut, and
  `registry.applyHostname` refuses (`gate-closed`) as a second line. The gate
  is read lazily (`IngressDeps.gate()`), only on those two paths and on
  `GET /instance/ingress/capabilities`, because it scans every server row.
  `TURBOPANEL_EDGE_GATE=closed` keeps it shut whatever the servers say; no
  value opens it. There is no confirm step: an older `EDGE_GATE_CONFIRMED`
  setting row is never read, and the audit action `instance.edge_gate.set`
  stays only for old audit rows.
- **Provider account.** `cloudflare/account.ts` checks a pasted token: verify
  (the answer carries the token id), then read the token's own policies
  (`GET /accounts/{id}/tokens/{token_id}` for an account-owned token, needing
  Account › Account API Tokens › Read; `GET /user/tokens/{token_id}` for a
  user-owned one, needing User › API Tokens › Read) and evaluate them in
  `cloudflare/token-policies.ts`. Reading itself is optional (owner
  decision 2026-11-03): a token that cannot (401, 403 or 404, or no token id)
  passes `token-policies` with a note naming the optional permission, and the
  scopes come from read probes instead (list tunnels on the account, one DNS
  read per zone, up to 25); Connect then confirms Tunnel Edit and names the
  failing step. On that path DNS-01 is offered for every zone the token can
  read: DNS Edit is confirmed at the first certificate (its preflight writes a
  probe TXT record), and a zone it cannot read fails the DNS line with
  "cannot read". A refused probe is a no, a transient one throws. Cloudflare Tunnel Edit counts only in a policy whose
  resources cover the account; in a zone-only policy it does not (read
  probes passed such a token and Connect then failed with a bare 403). DNS
  Edit counts per zone (zone, all-zones wildcard, the account, or the nested
  zones-of-account form); `scopes.zones` is exactly those zones, so DNS-01 is
  offered only there. Every zone of the account passes with a warning in the
  detail. Deny policies win. Permission groups match by name (Write or Edit).
  A recheck evaluates the stored account the same way, so a refused policy
  read never fails a working account. When the answer is unknown rather
  than no (Cloudflare rate limits, fails with 5xx or cannot be reached) it keeps the stored scopes and sets `last_error`,
  so an account stored before this check, or a bad minute at Cloudflare, does
  not wipe a working account for a day. It also
  refuses a token that expires within 30 days, and seals it in
  `ingress.token_envelope` (re-encrypt stage `ingress`). Token rotation is
  remove and add. A daily recheck rides the tick. Connect (`applyWith`) names
  the step in every provider error (`Creating the tunnel failed: …`).
- **Cloudflare tunnel** (`providers/cloudflare-tunnel.ts`,
  `cloudflare/tunnel-config.ts`). One remotely managed tunnel per account,
  named `turbopanel-control-plane-<INSTANCE_ID prefix>`, adopted by stored id or
  name before one is created. Before writing routes, Connect reads the
  tunnel (`config_src`, falling back to the deprecated `remote_config`) and
  refuses a locally managed one (`config_src: local`: routes live in a file on
  the connector) before anything is written. A configuration read that answers
  404 (a remotely managed tunnel that never had one) is an empty configuration
  (`CloudflareClient.getConfiguration`), for apply, remove and the edge view. Every tunnel name on the account is rebuilt into
  the ingress list on each apply and remove, all to `https://127.0.0.1:8443`
  with `originServerName` and `noTLSVerify` on the loopback hop, and no
  `httpHostHeader`: the visitor's Host (with its port) must reach Caddy, whose
  edge-port redirect reads the port from it (a forced bare name looped it).
  A dashboard tunnel adopted with a top-level `originRequest.httpHostHeader`
  would bring the loop back (its top-level settings are kept). Changing the
  rule shape means raising `PANEL_RULES_VERSION`: the tick re-applies every
  tunnel row stored with an older version (`tunnelRulesStale`), so installs
  already connected pick the change up.
  A locally managed tunnel is refused with cause `tunnel-locally-managed`;
  verifying the loopback hop with `caPool` is a later step. `noTLSVerify` drops for a name whose ACME
  pair (DNS-01 or HTTP-01) is issued and unexpired (`originCertVerifiable`);
  the ingress tick re-applies a name whose stored `originVerified` no longer
  matches, so issue, expiry and fallback rebuild the rules. The CNAME is proxied; another record on the
  name is refused unless the operator asks to replace it. The run token goes
  only to the co-located daemon (`dispatchInstanceTunnelToken`); the daemon
  refuses it anywhere else. Healthy = four connections; the status then
  fetches `/api/daemon/v1/instance/identity` through the edge and checks the
  signature names this control plane's key. Removing the last name stops the
  connector (empty token) and deletes the tunnel.
- **Connector facts without an account** (`cloudflare/instance-tunnel.ts`,
  `tunnel-routes.ts`). `GET /instance/ingress/tunnel` fills
  `connector.edgeConnections` and `connector.hostnames` from the daemon's
  `server.tunnel.status` (daemon feature `tunnel-status-facts-v1`: the
  connector's own `/ready` and `/config`), null when an older daemon does not
  send them. For a tunnel run from a pasted token those are the routes the
  Cloudflare dashboard pushed, so no account is needed to show them; the
  account only adds DNS-01 and edge details (locations, edge status).
- **Pasted run token per hostname.** A `cloudflare-tunnel` row with no account
  and nothing applied reads its status from the connector
  (`IngressDeps.connectorHostnames`): `healthy` when the connector routes the
  name (exact or one-label `*.` wildcard), else `not-applied` with a sentence.
  Marking such a row needs no account (the PATCH accepts `ingressId: null`);
  Preflight and Connect still need one.
- **DNS-01 for the control plane's own names** (`dns01/`). The panel orders on
  the existing ACME client with its own account (`INSTANCE_ACME_ACCOUNT`
  setting, sealed, swept by the re-encrypt `identity` stage; contact, terms and
  directory from `INSTANCE_ACME_SETTINGS`). One step per tick: preflight
  (zone on the account, a probe TXT write, CAA, nameservers: the provider's
  own list first (`DnsChallengeProvider.nameservers`, Cloudflare's zone
  `name_servers`), this host's resolver only as the fallback, because a
  resolver behind split DNS answers the zone locally with no NS records; each
  NS or address lookup that this host's resolver answers empty or not at all is
  asked again of the public resolvers `PUBLIC_RESOLVERS` (1.1.1.1, then
  8.8.8.8)), order and publish
  the TXT record, wait until every authoritative nameserver address that
  answers has it (up to 10 minutes; `txtVisibleOnAll`: an address this host
  cannot reach, such as IPv6 on an IPv4-only host, is left out, a NotFound
  answer counts as an answer without the record, and at least one address must
  confirm), answer, then finalize with a key made inside that step (never
  stored before the pair), store the pair sealed in `certificate` with
  `kind='acme-dns-01'`, point `origin.uploaded_cert_id` at it, remove the record and
  push the hostname list to the daemon. Renewal time is a random moment in the
  ARI window, else a third of the lifetime before expiry (at least 7 days);
  renewals send `replaces`. Every issued name is public in certificate
  transparency logs.
- **Wire mapping.** The daemon never sees `acme-dns-01`: `effectiveCertificateSource`
  (`features/install/instance-hostnames.ts`) turns a row with a live pair into
  `uploaded` and one without (or expired) into `platform-ca`, in the apply
  payload, the install trust and the `/instance/ca` decision alike. Derived,
  never stored. The apply payload then passes it through
  `wireCertificateSource`, which sends `acme-http-01` under the daemon's
  original name `lets-encrypt`; the stored and API names never reach the wire.
- **Failure handling.** Each failure maps to one cause (`dns01/state.ts`
  `DNS01_CAUSES`). Retries back off with full jitter from 5 minutes, capped at
  an hour, never more than 4 starts in a rolling hour; the weekly duplicate
  limit and the hourly failed-validation limit set `stopUntil`, which a manual
  Retry also honours (422 with the time). After 6 failed orders the name waits
  for Retry; every cause counts toward that except `dns-lookup`. `dns-lookup`
  (no nameserver address found in preflight, or no authoritative server
  reachable while waiting for the record) is this host's problem, not the
  authority's: it backs off 1, 5, 15, 60 minutes, then hourly
  (`DNS01_LOOKUP_BACKOFF_MS`, counted in `lookupFailures`), never reaches
  `failed`, alerts only from the third in a row, and a preflight lookup
  failure does not use the hourly start budget. Retry clears both counts. The last valid certificate keeps serving until it expires; at
  expiry the tick pushes the Platform CA fallback once. Alerts use the one
  instance event `certificate.expiring`: `kind: failed` once per cause, then a
  countdown at 14, 7, 3 and 1 days (`certificate.renewal_failed` is
  organization-scoped and cannot carry it).
- **Tick** (`tick.ts`, started from `server.ts`): every minute with a fresh
  database client and no overlap; DNS-01 steps (5 names per tick), edge status
  and the token recheck every 5 minutes / daily. Each part fails alone.
- **Edge ranges.** `edge-ranges.ts` fetches the Cloudflare list (etag, daily) and
  the Bunny lists for the proxy modes in use and keeps them in the `EDGE_TRUST`
  setting (`src/features/install/edge-trust.ts`, Workers-safe). The apply body
  carries `edgeTrust` only to a daemon advertising `instance-edge-trust-v1`;
  Caddy picks the visitor address from them, so `resolvePeerAddress` is unchanged.
  A vendor answer is refused whole (the last good list stays, the error is
  recorded) when any entry is wider than /8 (v4) or /16 (v6), overlaps loopback,
  private, link-local, CGNAT, ULA or multicast space, or the list passes 5000
  entries. Fetches time out after 10 s, refuse redirects and stop reading at
  1 MiB, so a slow vendor cannot stall the maintenance tick or an apply.
