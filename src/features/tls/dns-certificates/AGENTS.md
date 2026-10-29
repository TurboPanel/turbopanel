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
(a sealed copy of the account key, the authority's addresses, the challenge
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

## The account

One certificate-authority account per organization and per directory (staging
and production never share one), made on the first order and used by every
later order and every renewal (`account.ts`). The key is sealed in `secret`
(`provider = 'acme_account'`, `name` the directory); the account address sits
in the row's `metadata`. A unique index on (organization, name) for these rows
makes the first insert race-safe: two first orders at once read back the same
row and so the same key, and registering again with a known key returns the
account the authority already made. If the authority stops accepting the
account (deactivated or unknown) the key is replaced and registered again
once; if that is refused too the order fails with a plain reason.

## Test certificates

An order with `staging: true` uses the authority's test directory. Its
library row is named `Test Certificate …` and carries `acme.staging`, so a
screen can mark it. It can be listed and deleted but never pinned to a site:
`parseOptionalTlsId` refuses it when a hosting is saved (`tls_pin_staging`) and
`resolveTlsForHosting` refuses it at deploy (`pin_staging`).

## One order, in small steps (`steps.ts`, `issuance.ts`)

`queued` (open the order, publish the records) → `presented` (wait ten
seconds, answer the challenges) → `validating` (poll; all valid, send the
request) → `finalizing` (poll, download) → `issued`. Each call to
`advanceDnsCertificate` does at most three steps and writes the result. A
conditional update takes the row for 90 seconds, so the sweep and "check now"
at once cannot run the same step twice (`busy`). The routes only start an order
and report; the sweep carries it on (`sweep.ts`, wired into the Workers
offline sweep and the Deno interval).

## The sweep tick

`runDnsCertificateSweepTick` (`sweep.ts`, `sweep-select.ts`) runs every minute
on both editions. It picks work by due time, read out of the private state in
the database with no column or index (a certificate's back-off and renewal
time, an open order is due now), skips rows another worker holds and
organizations whose authority pause is running, and takes rank one of every
organization before rank two, so one organization cannot starve the rest. Per
tick: up to 25 steps and 25 upkeep jobs (`options.batch`, `maintainBatch`), no new
certificate started after 20 seconds (`budgetMs`), each step a few requests, so
a Workers invocation stays inside its subrequest limit; whatever is left stays
due for the next minute. Upkeep only visits certificates whose renewal-information
check came due or that hold leftover records. The result also counts issued,
failed and waiting, and `throttled`: the 429 and 503 answers met, by who sent them
(`authority429`, `authority503`, `cloudflare429`, `cloudflare503`), repeated in the
summary log line. The origin certificate sweep result carries the same counters.
Nothing is stored.

## Checks before the authority is asked

Before an order is opened the DNS host is asked a cheap read for every zone
(`checkZone`), so a token that was rolled or narrowed stops the order with
nothing spent at the authority. Before the challenges are answered the TXT
values are read back through the host's own API (`txtValues`); the authority is
not asked to validate a record that is not yet published (one of its few failed
validations an hour). A host without these calls is answered after the usual
short pause. Each sweep tick that did anything logs one summary line
(`src/lib/sweep-report.ts`) and an alert line when three or more attempts failed
and at least half of those tried.

## Calls to the authority

Clients share what is safe to share inside one process (`src/lib/acme/session.ts`):
the directory for an hour and spare `Replay-Nonce` values for five minutes,
keyed by the `fetch` in use. It is only a cache: no keys, no account addresses,
no clients, and an isolate that starts empty just asks. A stale nonce is
answered with `badNonce` and the client retries once. The requests of one step
go one after the other so each answer hands the next its nonce. The order is
polled first (one request); the authorizations are read only to learn why an
order went invalid, and when the answer to the request for the certificate
already names it (`order.certificateUrl`) it is downloaded without another poll.
An order for one name costs about eight calls (directory and nonce once, then
account, order, authorization, answer, poll, request, download) and the next one
six.

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
  said. The same holds for any 429 or 503 with a `Retry-After`, on any
  request (directory, nonce, order, challenge, certificate) and for the DNS
  host: it is not a failed order, so the open order and its records stay, no
  attempt is counted, and the row waits as told (`holdOrder`). An answer from the
  authority also pauses every other order of the organization for that long,
  kept as `pausedUntil` in the account row's metadata (`pauseAcme`), so one
  throttled organization sends no more requests while it lasts. A validation
  that failed is never retried before its back-off ends. Other failures wait
  one hour, then two, doubling up to a day; a first certificate gives up
  after three failed orders (`failed`, a person can retry
  after a quarter hour). A renewal that keeps failing keeps trying and keeps
  the certificate it has.
- At most ten new certificates per organization per day.
- Renewal time is the authority's own advice (ACME Renewal Information,
  RFC 9773: a random moment in the suggested window, never later than two days
  before the end). The authority is asked again no sooner than its own
  `Retry-After`, less up to a tenth so certificates do not ask together, then
  kept between a minute and twelve hours (twelve hours when it sends none, six
  after a failed ask): never fewer than two asks a day, two to four instead of
  eight. The next-ask time is
  `ariNextCheckAt` in the private state. A failed ask keeps the stored renewal
  time rather than dropping to the fallback. Without advice, when a third of
  the lifetime is left, started up to a tenth of the lifetime earlier at a random
  moment that is stored with the certificate, so certificates issued together do
  not all renew on one day.
- A renewal order carries `replaces` (the old certificate's renewal-information
  identifier) so the authority recognises it as a renewal; if the authority
  refuses because of it (`alreadyReplaced`, `malformed`) the order is opened again
  without it. Renewals add no rows, so they never count toward the ten new
  certificates a day. The sweep begins at most two renewals per organization per
  tick and keeps at most five open per organization (`limitRenewalStarts`), so a
  mass event cannot start them all at once; open orders and first certificates
  are not held back. The new pair is swapped in only when the order
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
