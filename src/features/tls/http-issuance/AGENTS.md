# Server-placed certificate orders (`src/features/tls/http-issuance/`)

One certificate per name set per organization, ordered by one serving server's
daemon over the HTTP proof (feature `acme-issue-v1`). The panel decides,
schedules and tracks; it never talks to the certificate authority for these.
The wire side is in `src/daemon/AGENTS.md`.

- `state.ts`: the private request state in `tls.metadata.httpCert` (no table, no
  migration), `canAcceptCapture`, `afterCapture`. The public row never copies it.
- `choose.ts`: who takes part. Only a server that is online, lists the feature and
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
  row (a daemon reports one certificate per name, and a row holds one pair, so a
  two-name row stays on the server's own web server until one certificate covers
  both). A pair a server captured itself keeps the
  server's own web server ordering and renewing.
- Renewal starts at the stored renewal time (about two thirds in, with a random
  head start), preferring the server that issued last time.
- Replace Key (`replaceKey`): a new order for the same names, which always makes
  a new key. At most once a day and five a week for one name set, never while an
  order runs, and the old pair keeps serving until the new one is installed.
  No route yet: the screen change adds it.

Contact address and directory come from the platform environment
(`TURBOPANEL_ACME_CONTACT_EMAIL`, and `TURBOPANEL_ACME_STAGING=true` for the
authority's test directory), not from the control plane's own certificate
settings: the two must not reference each other (`check-instance-acme-boundary`).
With no contact address, no order starts and the row says it is waiting.

Sweep selection is plain SQL and writes nothing to rows the flow does not own:
only pinned rows without a wildcard name are looked at, a row is ordered by when
it was last looked at (written inside its own request, never to the row's own
time) or by a per-minute hash when it has no request yet, and at most three new
orders begin per tick so a first run after a rollout is gradual. The cheap
answers (nothing due, a wait or cap in force, no contact address) come before any
DNS or per-server lookup.

Only a row with exactly one plain name is ordered here. A row with several names
(apex and www) would get one certificate per name from the daemon, and a row holds
one pair, so it is left entirely alone (never selected, no lookups, no marker) and
stays with each server's own web server until per-name pairs exist.
