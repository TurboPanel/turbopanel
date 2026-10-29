# DNS-validated certificates (`src/features/tls/dns-certificates/`)

A library certificate this panel orders itself from an ACME authority
(Let's Encrypt), proving control of the names with a DNS challenge through the
account that hosts the domain's DNS. The server is not involved, so it works
before a site is deployed, behind a tunnel, with no port 80, and for wildcards.
It sits beside the Caddy-issued kind (`tlsMode: 'acme'`, HTTP challenge on the
server) and never replaces it.

## What the row is

An ordinary library certificate: `tls.source = 'upload'`, the chain in
`certificate_pem`, the key sealed in `private_key_pem`, status `pending` until
the first certificate arrives. The public marker is `metadata.acme`
(`managedBy: 'panel'`, `challengeType: 'dns-01'`, `stage`, `staging`,
`lastError`, `warning`, `renewAt`). Everything private lives under
`metadata.dnsCert` (`order-state.ts`): the carrier and zones, the open order
(sealed one-order account key, the authority's addresses, the challenge
records), the list of records made, `renewAt`, back-off. `toPublicTlsRow`
never copies that key. No table and no migration: a step reads the row, does a
few requests and writes it back.

Because it is a library pin (`tlsId`, no `tlsMode`), a site that uses it is
delivered the pair like any uploaded certificate. That is why a locked tunnel
name may use it: the lock decides who may connect, the certificate only decides
what the server presents, and nothing is asked of the authority from the
server. `tunnel_name_public_certificate` is for the Caddy-issued kind only
(`name-lock.ts`); `name-lock.test.ts` pins this.

## Exact names first, wildcard only on request

`names` are what the person asks for. `example.com` and `*.example.com` are
both allowed in one order (two challenges, two TXT values at the same name).
Nothing turns a name into a wildcard on its own. An existing certificate that
covers the names (an exact one, or a wildcard the person ordered) is reused;
an order already running for the same names is returned instead of a second.

## One order, in small steps (`steps.ts`, `issuance.ts`)

`queued` (open the order, publish the records) → `presented` (wait ten
seconds, answer the challenges) → `validating` (poll; all valid, send the
request) → `finalizing` (poll, download) → `issued`. Each call to
`advanceDnsCertificate` does at most three steps and writes the result. A
conditional update takes the row for 90 seconds, so the sweep and "check now"
at once cannot run the same step twice (`busy`). The routes only start an order
and report; the sweep carries it on (`sweep.ts`, wired into the Workers
offline sweep and the Deno interval).

## Records are removed by id, never by name

A zone may hold someone else's `_acme-challenge` records. Only a record the
panel made is ever removed, by the id the provider returned. Each id is written
to `metadata.dnsCert.records` the moment the record exists, apart from the rest
of the state, so an interrupted request still leaves a list. Records are
removed when the order ends, succeeds or fails; the sweep removes any still
listed after two hours, but only by id. A record is not kept for the next
renewal: the value depends on a fresh token the authority picks each time.

If `_acme-challenge.<name>` is a CNAME, the record goes where it points (a TXT
cannot sit beside a CNAME); when the account cannot edit that zone the order
stops with the plain-words reason and nothing is written.

## Waiting, limits and renewal

- A refusal because of rate limits is waited out for as long as the authority
  said. Other failures wait one hour, then two, doubling up to a day; a first
  certificate gives up after three failed orders (`failed`, a person can retry
  after a quarter hour). A renewal that keeps failing keeps trying and keeps
  the certificate it has.
- At most ten new certificates per organization per day.
- Renewal time is the authority's own advice (ACME Renewal Information,
  RFC 9773: a random moment in the suggested window, never later than two days
  before the end), refreshed at most every six hours. Without it, when a third
  of the lifetime is left. The new pair is swapped in only when the order
  succeeds, and the sites that pin it are sent the new pair by the same apply a
  library pick queues.
- Renewal needs the stored token. Between orders the sweep checks that the
  account still exists and a token still reaches each zone; if not,
  `metadata.acme.warning` says so, with the date, long before the certificate
  matters. It clears itself when the token is back.
- Every test uses the authority's staging directory (`staging: true`): its
  certificates are not trusted by browsers.

## Not here

The ACME client (`src/lib/acme/`), the TXT records on Cloudflare
(`features/tunnels/cloudflare-dns-challenge.ts`), the routes
(`client/organizations/dns-certificate-routes.ts`), and the Caddy-issued kind
(`src/client/hostings/letsencrypt-*.ts`, which this does not touch).
