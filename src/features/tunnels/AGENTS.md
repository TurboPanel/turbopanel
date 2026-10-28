# Tunnels (`src/features/tunnels`)

Provider-neutral tunnel plumbing. This first slice holds the tables, one
adapter per provider and the routes that connect a provider account and its
API tokens. No tunnel, portal or doorway route exists yet.

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
- Rotating a Cloudflare run token is not confirmed against the API, so the
  adapter reports it as unsupported rather than guess an endpoint.

## Routes

`src/client/organizations/carrier-routes.ts`, `organization:manage` like backup
targets: `GET|POST /organizations/:id/carriers`, `DELETE .../carriers/:carrierId`,
`GET|POST .../carriers/:carrierId/badges`,
`DELETE .../badges/:badgeId`, `POST .../badges/:badgeId/check`. Adding a
badge checks the token first and refuses one that cannot do anything useful,
naming the missing permissions. OpenAPI: `src/client/openapi/tunnels.ts`.

## Origin certificates

Optional. The default hop from the connector to the local web server skips
certificate verification (`noTLSVerify: true`, the connector still sends the
hostname as the origin server name). With an origin certificate on the web
server the hop can be verified: `setRoutes` takes `verifyOrigin: true`, which
sets `noTLSVerify: false` and nothing else. No certificate file or path is
needed: the connector's origin pool is the system pool plus its built-in
Cloudflare roots, which include the origin ECC and RSA roots (read from the
upstream source on 2026-10-28 and not yet proved on a real connector; the
testing round settles it). Nothing sets `verifyOrigin` yet.

`origin-certificate.ts` keeps one certificate per account and zone in the
organization certificate library (`tls`, source `provider_origin`): the zone and
`*.` the zone. The key is an ECDSA P-256 key made in the panel
(`mintCertificateRequest`); only the request goes to the provider; the key is
sealed like every library key. `tls.metadata.providerOrigin` holds the account,
the token that can revoke it, the zone and the provider's certificate id; the
TLS routes never return it. Rules the code enforces:

- A token may issue only for a zone its recorded `certificates` rights name.
  Existing tokens have none recorded: the issue route runs one credential check
  and stores the result before it refuses.
- A site that pins the certificate blocks revoking it (`tls_in_use`); an account
  or token that issued one cannot be removed first (`origin_certificate_in_use`),
  because the certificate could then never be revoked. The TLS library routes
  refuse to revoke, delete or create a `provider_origin` row (`409
provider_origin_managed`, `400 provider_origin_unsupported`).
- If storing fails after the provider issued the certificate, it is revoked
  again. A provider that no longer knows the id counts as revoked.
- Validity is 365 days and renewal starts 30 days before expiry. Renewal issues
  a replacement and re-pins the sites; **it does not redeploy**. The old
  certificate stays valid until its own expiry and is only removed after that,
  so a site that has not been redeployed keeps a working certificate.
  `renewOriginCertificate` returns the re-pinned hosting ids so a surface that
  can queue a hostings-only deploy (`client/hostings/letsencrypt-apply.ts`)
  can push them; the feature layer cannot import it.
- `sweepOriginCertificates` (renew, then drop replaced and expired rows) is not
  wired to any timer yet, and no tunnel option pins a hostname to a certificate
  yet. Both wait for the tunnel hostname code and the automatic pin.
- Deleting an organization removes the rows without revoking them at the
  provider.

Routes (`client/organizations/origin-certificate-routes.ts`, `organization:manage`):
`GET|POST /organizations/:id/carriers/:carrierId/origin-certificates` and
`DELETE .../origin-certificates/:tlsId`. A healthy certificate for the same
zone is returned again instead of issuing a second one. Tunnel-only names never
get an automatic public certificate request; nothing here touches that path.
