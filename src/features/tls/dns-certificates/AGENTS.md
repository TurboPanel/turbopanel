# DNS-validated certificates (`src/features/tls/dns-certificates/`)

## The panel relays DNS records; a server's daemon orders

The control plane never talks to the certificate authority, on either edition.
A certificate over the DNS proof is ordered by the daemon on a serving server
(feature `acme-issue-dns-v1`, see `src/features/tls/http-issuance/AGENTS.md`).
The panel holds the organization's DNS token and publishes the challenge
records for the daemon: that relay is `http-issuance/dns-relay.ts`, shared by
the Deno socket (`daemon/deno-ws.ts`) and the Cloudflare cell
(`daemon/cell/do.ts`). The token never leaves the panel. What lives in this
folder is the part the relay, the cleanup and the library routes use:

| File                                                  | What it is for                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `dns-provider.ts`                                     | The DNS host port (`DnsChallengeProvider`) and the challenge record name.                                                                |
| `order-state.ts`                                      | Reads the private state under `metadata.dnsCert` (`carrierId`, `zones`, `records`, `claimUntil`) and the public marker `metadata.acme`.  |
| `records.ts`, `token.ts`, `context.ts`, `sql-time.ts` | Records removed by id through the account's DNS token (`withDnsToken`, `openDnsToken`, `withAnyDnsToken`).                               |
| `zones.ts`                                            | Which zone a name belongs to among the zones the organization's tokens cover, and where a record goes when `_acme-challenge` is a CNAME. |
| `names.ts`                                            | `parseCertificateNames`: one to ten names, exact or `*.` wildcards.                                                                      |
| `cleanup.ts`                                          | `runDnsCertificateCleanupTick` (see below).                                                                                              |

Routes (`client/organizations/dns-certificate-routes.ts`):

- `POST …/dns-certificates` takes `names` (single, several, or wildcard) and
  inserts a `lets_encrypt` row with `acme.challengeType: 'dns-01'`. The sweep
  hands it to a serving server; nothing is sent to the authority from here.
- `…/:tlsId/check` returns the row. `…/:tlsId/retry` lifts the wait after a
  failed order so the next sweep places it. It answers 409 `rate_limited` (with
  `retryAt`) while the authority's rate-limit pause is in force.
- The list shows uploaded panel-managed rows and the `lets_encrypt` dns-01
  rows; an ordered row shows `renewAt` and `nextAttemptAt`.

The relay answers `acme-dns-published` only once the TXT record reads back.
Deno reads it on the zone's own nameservers (`platform/deno/dns-confirm.ts`,
injected so `features/` never imports `platform/`). Workers cannot ask a
specific nameserver, so there the read-back is the DNS provider's own read, and
it waits a short bounded time (a Durable Object invocation has a wall-time
ceiling); a record that is not visible in time is answered as an error and
removed, and the daemon retries. Only the issuing server of an open DNS request
may publish. A record name must be `_acme-challenge.` plus a name of the order
and inside a zone the organization's token covers. Errors reach the daemon as a
plain sentence, never a token.

The sweep on both editions runs `runDnsCertificateCleanupTick`: it removes the
challenge records the panel made and still lists, by id, through the DNS
provider. The rows it covers are earlier uploaded panel-managed rows and
`lets_encrypt` rows whose request has ended (the daemon asks for removal once;
this tick is the net under that one ask). A row whose record would not go is
held an hour. `ordering-off.hostfree.test.ts` pins that no panel-side ordering
module exists and that `cleanup.ts` reaches nothing in `src/lib/acme/`.

Certificates already issued stay in the library and serve until they expire;
they are deleted like any library certificate. Deleting a row is refused (409
`tls_dns_records_outstanding`) while it lists challenge records not removed yet,
and the unused-certificate cleanup keeps such rows.

## What the row is

An uploaded panel-managed row (`tls.source = 'upload'`, the chain in
`certificate_pem`, the key sealed in `private_key_pem`), or a `lets_encrypt`
row ordered through a server (its order state is `metadata.httpCert`). The public marker is
`metadata.acme` (`managedBy: 'panel'`, `challengeType: 'dns-01'`, `stage`,
`staging`, `lastError`, `warning`). Everything private lives under
`metadata.dnsCert` (`order-state.ts`): the carrier and zones, the list of
records made. `toPublicTlsRow` never copies that block. No table and no
migration.

## Records are removed by id, never by name

A zone may hold someone else's `_acme-challenge` records. Only a record the
panel made is ever removed, by the id the provider returned, listed in
`metadata.dnsCert.records`. A token is picked at call time from the account's
tokens that reach the zone (`withDnsToken`), so a token removed after the order
started is replaced by another one that covers the zone.

## Not here

The ACME client (`src/lib/acme/`, used by the daemon-side order and the
organization terms), the TXT records on Cloudflare
(`features/tunnels/cloudflare-dns-challenge.ts`), the Caddy-issued kind
(`src/client/hostings/letsencrypt-*.ts`) and the push that sends a renewed
certificate to the sites pinning it (`client/tls/dns-certificate-context.ts`,
`renewalPusher`).
