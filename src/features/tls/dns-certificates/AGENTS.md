# DNS-validated certificates (`src/features/tls/dns-certificates/`)

## Ordering is gone (owner decisions 2026-11-04 and 2026-11-12)

The control plane does not order, renew or retry these certificates, on either
edition, and the code that did is deleted: there is no certificate authority
account, no order state machine and no ordering sweep here. An organization
certificate is ordered by the daemon on a server that runs the service; the
control plane only schedules the work and relays the DNS records (decision
2026-11-04, certificates ordered only by the serving daemon). What stays in this
folder is the part both sides still use:

| File | What it is for |
| --- | --- |
| `dns-provider.ts` | The DNS host port (`DnsChallengeProvider`) and the challenge record name. Used by the daemon-side order in `platform/deno/ingress/dns01/` and by `features/tunnels/cloudflare-dns-challenge.ts`. |
| `order-state.ts` | Reads the private state under `metadata.dnsCert` and the public marker `metadata.acme`; `isPanelManagedAcme` picks the rows the list route shows. |
| `records.ts`, `token.ts`, `context.ts`, `sql-time.ts` | The DNS records a past order left listed, removed by id through the account's DNS token (`withDnsToken`, `openDnsToken`). |
| `cleanup.ts` | `runDnsCertificateCleanupTick`, the only sweep step left (see below). |

Routes (`client/organizations/dns-certificate-routes.ts`):

- `POST …/dns-certificates`, `…/:tlsId/check` and `…/:tlsId/retry` answer 422
  `certificate_ordering_off` with a plain `message`, for anyone signed in, before
  anything is read. The UI still calls these three paths and the list, so they
  stay until the UI drops them.
- The list shows the rows that carry the marker; an issued row in use says in
  `warning` that it will not renew from the control plane (`renewAt` and
  `nextAttemptAt` are null).

The sweep on both editions (Workers offline sweep, Deno interval) runs only
`runDnsCertificateCleanupTick`: it removes the challenge records the panel made
and still lists, by id, through the DNS provider. Every listed record is a
leftover. A row whose record would not go is held an hour. It never asks the
certificate authority anything. `ordering-off.hostfree.test.ts` pins that no
ordering module exists and that `cleanup.ts` reaches nothing in `src/lib/acme/`.
Wiring ordering back into the control plane is a new owner decision.

Certificates already issued stay in the library and serve until they expire;
they are deleted like any library certificate. The databases are wiped before
the release that removed the ordering code, so no `acme_account` secrets and no
open orders exist after it (the secret provider value and its index leave with
the reset).

## What the row is

An ordinary library certificate: `tls.source = 'upload'`, the chain in
`certificate_pem`, the key sealed in `private_key_pem`. The public marker is
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
