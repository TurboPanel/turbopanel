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
