# Server-placed certificate orders (`src/features/tls/http-issuance/`)

One certificate per name set per organization, ordered by one serving server's
daemon over the HTTP proof (feature `acme-issue-v1`). The panel decides,
schedules and tracks; it never talks to the certificate authority for these.
The wire side is in `src/daemon/AGENTS.md`.

- `state.ts`: the private request state in `tls.metadata.httpCert` (no table, no
  migration), `canAcceptCapture`, `afterCapture`. The public row never copies it.
- `choose.ts`: who takes part over the HTTP proof (for the DNS proof see `chooseDnsIssuer` below). Only a server that is online, lists the feature and
  is in the name's DNS (the A and AAAA answers against the server's public
  addresses). Others are skipped and get the certificate later. With no known
  public address anywhere, every online server with the feature counts.
- `attempts.ts`: at most 3 attempts in a rolling hour, waits of 10 minutes, 30
  minutes, 1 hour, 2 hours, then doubling to a day, and an authority rate-limit
  answer waits an hour. Keeps the panel under the authority's 5 failed checks an
  hour.
- `progress.ts`: what happens next from the state and the clock (helpers get 2
  minutes, the issuing server 3 minutes to say started and 10 minutes between
  events, the pair 5 minutes after `issued`, the whole request 30 minutes), and
  the public marker (`metadata.acme`, with one plain line per server).
- `orchestrator.ts`: reads, locks the row (`for update`), decides, writes, then
  sends. A send that fails to the issuing server closes the attempt; the silence
  timeouts cover anything lost after the write.
- `events.ts`: the three daemon messages. A request closes only when both the
  pair (the capture call) and the `issued` event have arrived, in either order.
- Status wording never says the key was exposed (`status-text.ts`).

## The sweep, delivery and renewal

`src/client/tls/http-issuance-sweep.ts` runs each minute inside the Workers cron
and the Deno interval (a bounded batch, oldest first, 20 seconds at most). It
picks rows with work to do in SQL from the private state: no certificate yet, an
open request, a finished pair not handed out or due for renewal, a failed attempt
whose wait is over. A row a server's own web server captured (a pair, no request)
is never picked.

- Delivery: when a request closes as issued, the sweep queues the certificate
  apply for every site pinned to the row (the pair goes out sealed per server)
  and tells the helpers to stop. Marked delivered once tried; a site the apply
  cannot reach gets the pair on its next deploy.
- Pin switch (`deploy-prepare.ts`): an automatic pin goes out as a pinned
  certificate with its pair, and no `tlsMode: 'acme'`, only when the pair came
  from this flow (`centralPair`, set by the capture of an open request) and the
  target daemon lists the feature and the stored certificate covers every name of the
  row and every name the site answers on (its www mode adds the other spelling); a
  pair that covers less stays on the server's own web server. A pair a server
  captured itself keeps the
  server's own web server ordering and renewing.
- Renewal starts at the stored renewal time (about two thirds in, with a random
  head start), preferring the server that issued last time.
- Replace Key (`replaceKey`): a new order for the same names, which always makes
  a new key. At most once a day and five a week for one name set, never while an
  order runs, and the old pair keeps serving until the new one is installed.
  No route yet: the screen change adds it.

The contact address is the organization's own (`organization.acme_contact_email`,
read by `organizationAcmeContactEmail`, set by org managers). It travels in each
`acme-issue-request`; the daemon holds one authority account per issuing server per
contact address, and the panel holds no account for this flow. With no address no
order is sent and nothing is looked up; the row says it is waiting for an address
only when a serving server's daemon lists the feature (an unchanged marker is not
rewritten), otherwise it is left alone. The test directory is a platform setting
(`TURBOPANEL_ACME_STAGING=true`).

Sweep selection is plain SQL and writes nothing to rows the flow does not own:
only pinned rows without a wildcard name are looked at, a row is ordered by when
it was last looked at (written inside its own request, never to the row's own
time) or by a per-minute hash when it has no request yet, and at most three new
orders begin per tick so a first run after a rollout is gradual. The cheap
answers (nothing due, a wait or cap in force, no contact address) come before any
DNS or per-server lookup.

Which names an order asks for, and who may take it (`names.ts`). The order asks for the row's names plus every www name the pinning sites' www mode adds (a pinned pair serves that name too); a wildcard is never ordered here. The serving daemon places the order with its own client and gets one certificate for all the names. A row with no serving server answers `not_eligible` before any DNS lookup or write. The names an order asks for are fixed in the request state when it starts (`orderNames`), so a site edited mid-request does not change them between the forwards and the order; a request an older release started has none and uses the row's current names. Names are folded (`foldHostname`). A pair that covers every stored name (the same names, or more, such as a renewal that now also covers the www name) replaces the stored pair when it expires later (`replaces` in `src/client/tls/issued-certificate.ts`); before, a wider pair was kept only as a note, the request closed on the old pair's renewal time, and the sweep ordered again every minute.

One order at a time per issuing server: the daemon runs one issuer window at a time, so
a second order would wait behind the first and could pass the panel's silence limit.
The start takes an advisory lock on the server and refuses (`busy`) while any row has
an open request asked of it.

Platform switches, both environment settings read by the sweep:
`TURBOPANEL_SHARED_CERTIFICATES=off` turns the whole flow off (default on), and
`TURBOPANEL_ACME_STAGING=true` orders from the authority's test directory. While the
first is off the sweep does nothing, and the sweep is the only timer-driven thing that
ends a request: open requests are not timed out and keep holding their issuing server,
helper notices do not go out, and pairs a daemon sends are still stored. A daemon
message is not switched off either, so an `issued` or `failed` event can still end a
request (an `issued` event closes it when the pair is already stored for every name). A row's own web server is unaffected. When the switch goes back on,
the close rule runs before the start-by check: a request with a stored pair for every
name closes as issued, and the rest fail and back off.

## The DNS proof (`acme-issue-dns-v1`)

A name list with a wildcard is proved over DNS, and so may any other order
(`acme.challengeType: 'dns-01'`; the request state records `challenge`). The
panel publishes the TXT records for the daemon.

- `choose.ts` `chooseDnsIssuer`: any online serving server whose daemon lists
  `acme-issue-dns-v1`, with no address or port-80 check and no helpers. With
  none able, the request waits. An older daemon would drop `challenge` and run
  the HTTP proof for names meant for DNS, so `orchestrator.ts` `sendAll` never
  sends `challenge: 'dns-01'` to a server that does not list the feature now
  (pinned in `dns-orders.hostfree.test.ts`).
- `progress.ts`: a DNS request fails after the daemon's 10 minute order
  deadline plus a minute of grace, and lives 15 minutes in all.
- `dns-relay.ts`: handles `acme-dns-publish` (replied to with
  `acme-dns-published` once the record reads back) and `acme-dns-remove`, on
  both runtimes. The record is written to `metadata.dnsCert.records` as soon as
  it exists and removed only by id. See `../dns-certificates/AGENTS.md`.
- `caps.ts`: at most 10 new certificates per organization per day, and a pause
  for every new start while an authority rate limit is in force. New starts are
  kept in `organization.options.acmeNewStarts` (ISO times, pruned to a day), so
  deleting a row does not free the cap. A retry is subject to the pause only.
- The sweep starts at most 2 renewals per tick.
- A name still waiting for its pair goes to the daemon as an internal name.
