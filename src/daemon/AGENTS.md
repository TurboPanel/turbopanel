# Daemon surface — AGENTS.md

`src/daemon/` is the **control-plane side** of the daemon protocol
(`/api/daemon/v1`, `/ws/daemon/v1`). It is **not** the TurboPanel Daemon
checkout (`turbopaneld`). Keep the directory name: it matches the URL prefix.

Nested docs:

| Area                                          | Read first          |
| --------------------------------------------- | ------------------- |
| Cell (presence, DO + Redis, hibernation/cost) | `cell/AGENTS.md`    |
| Host-metrics ingest + stores                  | `metrics/AGENTS.md` |

## Producer-owns

Wire shapes are owned by **one** repo. The other copies them (or drift-checks
them). Do not “fix” a shape in the consumer and leave the producer behind.

| Shape                                      | Owner                                                                     | Copy / check                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Command payload + result schemas           | **this repo** (`src/contracts/commands/`)                                 | daemon rewrites a twin under `turbopaneld/src/contracts/`                                                                        |
| Cell protocol (`DaemonMessage`, envelopes) | **this repo** (`src/contracts/cell-protocol.ts`, `src/contracts/cell.ts`) | daemon extracts a twin; fields the daemon added (`hello`/`heartbeat`, `drivetemp`) stay daemon-local until this repo adopts them |
| Metrics contract                           | **daemon** (`turbopaneld/src/contracts/metrics-contract.ts`)              | this repo vendors a **byte-identical** twin (`src/contracts/metrics-contract.ts`); CI compares bodies below the header           |
| Topology types + slot mapping              | **daemon**                                                                | this repo drift-checks `src/contracts/topology-*.ts`                                                                             |

CI:

- Instance: `pnpm check:contract-drift`
- Daemon: `deno task check:contract-drift`

When adding a field the daemon discovers (host facts, metrics, topology),
change `turbopaneld` first, then copy/check here. When adding a command the
control plane enqueues, change this repo first, then the daemon twin.

## What stays here

- REST + WS entry (`api-routes.ts`, `deno-ws.ts`, `workers-ws.ts`)
- Durable Object + Redis cell pair (`cell/` — four path pins; do not move)
- Daemon JWT authn (`authn/`)
- Metrics **ingest** (control-plane store + query). Discovery of what to
  sample lives on the daemon.

### Co-location is not the transport

A **co-located** daemon runs on the control plane's own host. Whether it
_reaches_ the instance over the Unix socket is a separate fact, and it follows
the runtime:

| Runtime                     | Co-located daemon connects via                      | Stored peer address                     |
| --------------------------- | --------------------------------------------------- | --------------------------------------- |
| Deno (self-hosted)          | `/run/turbopanel/instance.sock`                     | `__direct__` (`DIRECT_ATTACH_SENTINEL`) |
| Workers (High Availability) | HTTPS/WSS to the hosted URL, like any remote daemon | its real peer address                   |

`shapeServerPresenceFields` therefore takes the transport from
`presence.directAttach` (the stored peer address _was_ the sentinel), narrowed
by the deployment — never from `colocated`:

- **`colocated` must not substitute the sentinel.** It used to, which labelled a
  co-located host on Workers "via Local Unix Socket" for a connection that never
  touched a socket.
- **`directAttach` is ignored when the deployment is hosted.** Only the Deno
  transport writes the sentinel, so on Workers it is necessarily a stale row
  from a control plane that used to run on Deno — precisely what a development
  instance switching runtimes leaves behind. Believing it pins the co-located
  host to the socket label until something else rewrites the projection, and
  under `wrangler dev` nothing does:
  `resolvePeerAddress(…, {runtime:'workers'})` reads `CF-Connecting-IP` only,
  and the dev Caddy in front of wrangler sends `X-Real-IP`, so
  `identity.remoteAddress` arrives undefined and `postgres-projection.ts` keeps
  whatever was there.

The console's connection line follows `addressSource === 'local'` for the same
reason.

Identity guards are the other way round: "you may not delete, or remotely
update, the host this control plane runs on" must hold on **both** runtimes, so
they pass `includeSelfHostPin: true` to `resolveColocatedServerIdSet`. The pin
is the `turbopanel` system environment — plain SQL that works on Workers, where
the transport probes (`__direct__`, `/etc/machine-id`, `Deno.hostname()`) all
come up empty. The cached read models deliberately do _not_ pass it, so their
approved-SQL profile stays unchanged; their `colocatedWithInstance` is a display
badge, not a guard.

The control plane's own tunnel token is the exception that also passes
`orgScoped: true` (`assertColocatedForInstanceTunnel`): the canonical lookup's
fallbacks (hostname, "the single unassigned server") can name a remote server,
so only the direct socket attach, this host's machine key and the self-host
pin count.

## Certificate orders placed by a server (`acme-issue-v1`)

A daemon that lists the `acme-issue-v1` feature in `hello.features` can be asked
to place one certificate order for a name set from its own addresses over the
HTTP proof. The messages are `acme-issue-request`, `acme-proof-forward` and
`acme-proof-forward-end` (control plane to daemon) and `acme-issue-event`,
`acme-proof-forward-ready` and `acme-proof-forward-failed` (daemon to control
plane). Their shapes and validators are in `src/contracts/cell-protocol.ts`.

- No message ever carries the certificate or its key. The finished pair goes
  through `POST /api/daemon/v1/tls/issued` with the `requestId` of the open
  request; the validators refuse any field that looks like certificate material.
- The control plane sends these only to a daemon that lists the feature, receivers
  ignore unknown optional fields, and no version floor moves.
- A pair with a `requestId` is accepted only from the server the request was made
  to, while the request is open (`src/features/tls/http-issuance/state.ts`). A pair
  without one follows the older rule: only a server that holds a pin may report.
- The three daemon-to-control-plane messages are in `DAEMON_INBOUND_ALLOWED` and
  handled on both runtimes (`src/features/tls/http-issuance/events.ts`: the Deno
  socket handler and the Durable Object, no timers). A message only changes the
  stored request; the scheduler's sweep sends whatever comes next. Each is matched
  to its row by request id inside the reporting server's organization, and only
  the server the request names may answer for it.
- The control plane sends the three outbound messages as cell outbox envelopes
  (`acme-issue-request`, `acme-proof-forward`, `acme-proof-forward-end` kinds in
  `DaemonOutboundEnvelope`, mapped by `outboundEnvelopeToWireMessage`). The cell's
  own correlation id is separate from the order's `requestId`; the replies are
  fire and forget.
- What the daemon must do: post the pair with `POST /api/daemon/v1/tls/issued`
  first and send `issued` after (either order is tolerated, but a request closes
  only when both have arrived); send `failed` with a plain reason (an authority
  rate-limit answer should keep the words `rateLimited`, so the panel waits an
  hour); answer every `acme-proof-forward` with `-ready` or `-failed`.

## Advised heartbeat

The attach `version` frame carries an optional `heartbeatSeconds` (the idle-ping
cadence). It is unsigned advice: daemons clamp it to 15-120 s and pinned
daemons take the interval from the signed hello instead. High Availability
always sends 60; the Deno control plane sends 25 when a panel hostname sits
behind an edge (`src/features/install/heartbeat-policy.ts`), read from a cached
value so the attach path makes no database call. No feature gate and no floor
change: older daemons ignore the field.

## Signed reports (`signed-reports-v1`)

On a signed session a daemon that lists the feature (and sees it on the
attach frame) signs `command-outcome` and `fabric-peers-report` with its own
key: the frame carries `{sessionId, iat, kid}` (kid = the daemon key id) and
`,"sig":"<base64url>"}` last, signed as `"tp-report\n" + type + "\n" +`
the bytes before the marker plus `}` (`authn/report-signature.ts`; the prefix
is pinned in both contract-drift scripts). Both runtimes check it before the
frame validator, with the daemon key the upgrade checked (`deno-ws.ts`, and
the key stamped on the socket attachment in `cell/do.ts`). Verified: the
envelope is removed and the frame is handled as before. Wrong key id, other
session, `iat` more than 300 s off or a bad signature: one warn line; a peer
report is dropped, and a `command-outcome` is replaced by a failed one with
error `signature_invalid` for the same id, so the command ends and the
daemon still gets its `command-outcome-ack` instead of resending forever.
No `seq`: a result is idempotent by id.

**Ratchet (owner decision 2026-11-05, no floor bump).** A proxy that ends TLS
can strip the signature and the feature from the unsigned hello, so the
hello's list is never what decides. After a server's first verified signed
report the control plane sets `server.trust_reports_signed_at` (one
conditional update, `recordServerSignsReports` in
`features/servers/trust-level.ts`; cleared only when the identity key is
replaced or removed, i.e. re-enroll, key replacement or key removal, owner
decision 2026-11-06, in `features/servers/server-identity-db.ts`; clearing
only the sealing key keeps it), and from then on that server's unsigned
reports on a signed session are refused exactly like a bad signature (peer
report dropped, `command-outcome` failed with `signature_invalid` and acked).
The flag is read at upgrade with the daemon state (`reportsSigned`); Deno
keeps it in the socket closure, Workers gets it from the internal
`X-Turbopanel-Cell-Reports-Signed` header onto the socket attachment
(`reportsSigned`), and both flip it at once on the first verified report of
the socket, then write the row (Workers through `#withProjectionDb`, bounded
and in the background). Before the flag is set an unsigned report is still
accepted (older daemons) and the warning, when the hello listed the feature,
is logged once per connection (`warnedUnsigned` on the attachment). The
daemon holds reports until the attach frame's feature list arrives
(the daemon repo's instance guide), so an honest daemon never sends an
unsigned report on a signed session. The cost: a server that once ran a
signing daemon cannot go back to an older daemon on a signed session unless
it is re-enrolled.

**Signed HA events (`signed-ha-events-v1`, owner decision 2026-11-10, no floor bump).** On a signed session a daemon that sees the feature on the attach frame also signs every `managed-ha-event` (dead-primary and boot-hold reports) with the same envelope. These frames are in `SIGNATURE_REQUIRED_TYPES` (`authn/report-signature.ts`): the control plane acts on one only when its signature verifies, on every session and whatever the ratchet says. The intake never drops one; it hands it on marked `verified`, `unsigned` or `invalid`, and a frame on a session that is not signed is `session-unsigned` (`haEventSignature` in `features/managed/ha-event.ts`). Both runtimes pass that to `handleManagedHaEvent`, which refuses anything but `verified` before any other check (`recordRefusedHaEvent`): a report from a server that hosts a member of the cluster in its organization becomes one terminal `blocked` row that says why and the exact fix (`HA_EVENT_REFUSED_MESSAGES`, `BOOT_HOLD_REFUSED_MESSAGES`, fixes in `HA_EVENT_REFUSAL_FIXES`; `metadata.reportRefused`; no target, so no cooldown; repeats fold into it), anything else is logged only. A refused boot-hold report leaves its held primary stopped. Owner decision 2026-11-10: strict, with no exception for the co-located daemon. A server must be pinned (hold the panel identity pin) to have a signed session; a server installed before panel keys is pinned by its next daemon update to a new release when that update can fetch and check the identity document (learn-on-upgrade in `run.sh`; a failure leaves it unpinned), no other unpinned server can be pinned from the control plane today, and the server a self-hosted control plane runs on is never pinned (`run.sh` writes no panel pin for a control-plane install or a co-located refresh), so its databases do not fail over automatically. A refused report is filed only when it passes every check a signed one would before any action (detector, reporter and current-primary gate, the Orchestrator instance binding; a boot-hold report must name a member on the reporting server), so a late report about a replaced primary is only logged; repeats from one server fold into its own row per cluster and member, whatever the reason, even when other rows were written since (`findRefusedReportRow`). The Durable Object writes a refusal for one cluster at most every 10 minutes per socket (`haRefusalsAt` on the attachment, stamped after a successful write) before it opens a database client. A signed `managed-ha-event` is refused when signed more than 30 s ahead of the control plane's clock or more than 60 s ago, so a held-back copy cannot be replayed. Readers that decide from the newest recovery (the boot-hold hold, the re-seed guard, the abort-restart guard) use `findLatestActedRecovery` (refused rows filtered out in SQL, so no number of them can hide the row that matters), and the fence-deadline run skips refused rows, so a refused report never hides a failed failover that needs an operator. The cost, accepted by the owner: a server whose daemon has not updated, or whose connection is not a signed session (trust level 0, no panel identity pin), no longer fails over automatically, and its held primaries are not released after an unclean boot. A verified event also sets the reports ratchet, like any verified report. A signed event can still be delayed by whoever ends TLS, within that 60 s window.

## Sealed secrets (`daemon-sealed-secrets-v1`)

A daemon with this feature generates an X25519 sealing key and registers it with
`POST /api/daemon/v1/servers/self/sealing-key` `{kid, pub, sig}`; `sig` is its
Ed25519 signature over `"tp-sealing-key\n" + pub`, checked against the key on file
(`sealing-key-registration.ts`). `POST /secrets/decrypt` then answers `{ sealed:
[envelope | null, ...] }` (same order as the request, `aad` = server id) and
omits `plaintexts` whenever a sealing key is on file, whatever the hello
`features` list says (that list is unsigned, so keying on it let a token holder
ask for plaintext); a server with no registered key still gets `plaintexts`, and `server.plaintext_secrets_at` is stamped (at most
hourly) so the edge go-live gate can read that nothing is still answered in
plaintext. The answer is never both fields. Only the key id may be logged. The
Hosting Account password hash rides as `passwordHashEnvelope` (a `tpdaemon`
envelope) to such a daemon on environment deploys and on
`server.principals.reconcile`; every reconcile caller passes the secrets config
(`enqueuePrincipalsReconcile`). A verified sealing-key registration also adds
`daemon-sealed-secrets-v1` to the stored hello features when it is missing
(`setDaemonSealingKey`): a daemon that connected before this control plane knew
the feature had it filtered from its hello. The decrypt answer, the deploy's
and the reconcile's `passwordHashEnvelope` all key on the stored sealing key,
never on that list: a stripped hello cannot turn sealing off.
`daemon-sealed-principal-reconcile-v1` is informational, because no released
daemon registers a sealing key without opening an envelope on reconcile too.
The key stays on file until the server's identity key is replaced (enrollment
attach) or removed (`clearServerDaemonState`), which clear
`sealing_key_kid`, `sealing_key_pub` and `sealing_key_reported_at` with it; the
new daemon registers its own key when it connects with the new key id, and the
server is treated as one with no key until that lands. Recovery for a
host rolled back (break glass) to a build without the feature is a superadmin's
Clear Sealing Key (`DELETE /api/admin/v1/instance/identity/sealed-secrets/:serverId/key`,
see `src/admin/AGENTS.md`); nothing on the daemon wire can clear the key. A
plaintext decrypt answer is how a daemon learns the key is gone, and a daemon
that has opened a sealed answer still refuses plaintext. The superadmin read `GET
/api/admin/v1/instance/identity/sealed-secrets` reports, per server, the
feature, the key id and `plaintext_secrets_at`, for the edge go-live gate. The `MIN_SUPPORTED_*` floors are untouched.
