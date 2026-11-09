# Panel identity (`src/lib/panel-identity/`)

The panel's Ed25519 identity key (slots `current` and `next`) plus an X25519
sealing key, and the signed identity document served at
`GET /api/daemon/v1/instance/identity`. Contract: the panel-trust design contract (owner-held, outside git).

- **Never derive these keys from `TURBOPANEL_SECRET`.** `daemon-jwt-keyring.ts` does that for
  a different key; keep the two unrelated. Seeds are random.
- **Fingerprint** = base64url (no padding) of SHA-256 over the raw 32-byte public key (43 chars);
  it is the `kid`. `fingerprint.ts` is the only place that defines it.
- **Storage.** Workers: secret binding `TURBOPANEL_IDENTITY_KEYS` JSON
  `{keyset, current:{kid,priv}, seal:{kid,priv}, next?:{kid}}` (`priv` = base64url 32-byte seed;
  `kid` must equal the fingerprint of the key derived from it). Unset = feature off, malformed =
  throw at init. Self-hosted: `setting` row `PANEL_IDENTITY_KEYS` with the seeds sealed under the
  data-encryption key (`ensurePanelIdentity`, generated once, never regenerated); the
  re-encrypt sweep has stage `identity` for it.
- **`next`** is a fingerprint only (the private key is offline), so its document entry has an empty `pub`.
- **Signature** is the `X-TurboPanel-Signature: <kid>:<sig>` header over
  `"tp-http\n" + path + "\n" + exact body`, not a field in the body. `serializeIdentityDocument`
  writes the key order by hand; do not add a canonicaliser. The route returns the cached exact bytes.
  The document's `urls` (and the signed hello's) are the addresses servers dial: on self-hosted,
  `serverDialOrigins` (`urls.ts`, the hostname rows servers dial, primary first, the same list the
  install command carries); on High Availability, the platform environment. A pinned server rewrites
  its pin's address list from a verified document, so a row marked as not for servers must stay out.
  The document's `urls` come from the database, so with an identity loaded the route needs it: an
  unreachable database answers `503 {"error":"database unavailable"}` (reason in the log only);
  a connection-closed error is rethrown so the Workers entry replays the GET once.
- **Workers:** the identity (imported keys) may live at isolate scope; the database client never
  does. Nothing here runs crypto at module load.
- **Signed pin report.** On the first presence hello of a signed session a newer daemon signs its
  `panelPin` (`src/daemon/authn/pin-report.ts`, `"tp-panel-pin\n" + sessionId + serverId + keyId +
  pinnedBy + current + keyset + iat`, joined by `\n`, with its daemon key; the prefix is pinned in
  the daemon's drift script). `src/daemon/pin-report-intake.ts` verifies it on both runtimes in the
  background and `src/features/servers/pin-report.ts` stores it in `server.trust_pin_fingerprint`,
  `trust_pin_keyset`, `trust_pin_reported_at` and `is_trust_pin_matching` (current or next key of
  this control plane; an `unsafe` pin counts as matching, it has its own badge). A report naming
  another key raises `panel.pin_mismatch` and audit `server.panel_pin.mismatch` once per reported
  fingerprint. An unsigned report changes none of these columns. Admin's identity read returns it
  per server as `pinReport` (`resolvePinReport`); the cached client server read models do not.
- **Pin silence alarm** (`src/daemon/pin-silence.ts`). A pinned server talking to an impostor never
  completes a signed session here, so it looks offline; so does a powered-off one, or one whose daemon
  stopped or cannot sign in. The sweep runs on the existing tick (Workers offline-sweep phase
  `pin-silence`, self-hosted cleanup timer; both every 60 s), Postgres only, and escalates only on an
  independent sign of life: a TurboFabric peer's fresh reading (`relay.metadata.observed`,
  `pairTunnelHealth`) showing a healthy tunnel to the silent server. Candidates: `trust_pinned_by`
  install/upgrade, `trust_level >= 2`, offline; the episode is `status_changed_at`. The clock is
  `trust_silence_alive_at`: the first healthy peer reading in the episode, cleared when a reading turns
  `down`/`unknown` (a host booting after a long outage brings its tunnel up before its daemon connects,
  and that must not count). Stages: A ordinary `server.offline`; B `server.pin_silent` (warning) after
  `PIN_SILENT_MIN_MS` (30 min) on the clock; C `server.pin_missing` (critical, urgent) after
  `PIN_MISSING_MIN_MS` (6 h), only once B was raised. A server that went offline within
  `PIN_SILENCE_MASS_WINDOW_MS` (1 h) of enough others to meet `isMassDisconnect` (whole fleet, or its
  organization) is part of an outage and raises nothing. State in `server.trust_silence_stage`,
  `trust_silence_since`, `trust_silence_alive_at`; reset on reconnect and by a verified signed pin
  report. Known limits: a server outside TurboFabric never passes stage A, and a healthy tunnel cannot
  tell an impostor from a stopped daemon (the texts name both).
- **Pinned-by.** `pinned-by.ts` `resolvePinnedBy` is the one place that reads a server's pin state
  (`install | upgrade | unsafe | none`) from the `trust_pinned_by` column (`trustPinnedBy`); a row
  read without that column reads `none`. The admin identity read selects it; the client server read
  models (`src/query-cache/read-models/`) do not select it yet, so the server badge still reads
  `none` there. The self-hosted edge gate (`src/platform/deno/ingress/gate.ts`) reads the column
  directly.
- **Changing `next`** (`setPanelIdentityNext`) must be followed by swapping the in-memory identity
  (`onIdentityNextChanged` in `server.ts`); the document cache re-signs when the next fingerprint changes.
- **Sealed secrets (`hpke.ts`).** HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256),
  ChaCha20-Poly1305, via `@hpke/core` + `@hpke/chacha20poly1305` (pure JS, no I/O at load, builds
  the suite on first use). Envelope `{v:1, kid, enc, ct}`; `aad` is the recipient server id.
  `/secrets/decrypt` seals its answer to the daemon's registered sealing key
  (`src/daemon/secrets-decrypt-answer.ts`) whenever one is on file, whatever the unsigned hello
  `features` list says; a server with no key still gets `plaintexts`, and `server.plaintext_secrets_at` records that (read by the
  edge go-live gate through `GET /api/admin/v1/instance/identity/sealed-secrets`). The fixed vector in `src/test-fixtures/hpke-vector.ts` is the same one the
  daemon repo opens; change both together.
- **Keys sent up.** `POST /tls/issued` takes exactly one of `privateKeyPem` (older daemons) or `privateKeyEnvelope`, sealed to the identity's `seal` key with the `current` key id as aad (`src/daemon/issued-private-key.ts`). `openFromSender` accepts the identity's native non-extractable X25519 key, so no seed is kept in memory. An envelope with no identity loaded answers 503; a body or envelope is never echoed or logged.
- **Signed daemon session.** The control plane sends nothing on `/ws/daemon/v1` until the daemon's
  first frame (`src/daemon/signed-session-gate.ts`, shared by `deno-ws.ts` and the cell). A
  `hello-nonce` gets a `hello` signed over `"tp-hello\n" + exact JSON`, then every frame (the
  `version` frame is `seq` 1) carries `{sessionId, seq, iat, kid}` and a `sig` over
  `"tp-frame\n" + type + "\n" + exact JSON` (`frame-envelope.ts`, `signed-session.ts`; the sig is the
  last member, the receiver splits at the last `,"sig":"`). Only the transport pong is unsigned. The
  cell writes the next `seq` to the socket attachment before each signed send and sends one frame at a
  time per socket; Deno keeps it in the socket's sender. Any other first frame gets today's unsigned
  session unless `server.trust_level` is 1 or more (close 4403). Nothing reads the feature list to
  decide. **Bound session** (`panel-bound-session-v1`): a daemon that lists it in its `hello-nonce`
  gets `forServer` and `forKey` (the JWT `sub` and `kid`) inside the signed hello and every signed
  frame, so a session signed for one server cannot be replayed to another; both are reserved
  envelope members. No offer, no members (older daemon unchanged). In a signed session the outbox waits for the daemon's first presence `hello`; the
  `version` frame does not.
- **Daemon proofs and `trust_level`** (`src/daemon/authn/`). Only the daemon's own key raises
  `server.trust_level`, and only to 2: a verified attach proof on the first presence `hello` of a
  signed session (`attach-proof.ts`, `"tp-attach\n" + sessionId + panelFingerprint + serverId +
  keyId + iat`, joined by `\n`), or a `/auth/session` request signed with the daemon key. Nothing
  writes 1 (a bare `hello-nonce` proves nothing, so a stolen token cannot lock a server in). A
  hello with no attach proof is accepted below 2 (daemons from before it); a bad proof, or none
  at 2, closes 1008 `attach-proof-refused`. The cell checks the proof without a database read:
  `workers-ws.ts` stamps `<keyId>:<x>` of the daemon key on the upgrade (internal header) and the
  socket attachment keeps it.
- **Daemon-signed requests** (`request-signature.ts`). Header
  `X-TurboPanel-Daemon-Signature: <keyId>:<nonce>:<iat>:<sig>` over
  `"tp-request\n" + METHOD + "\n" + pathname + "\n" + panelFingerprint + "\n" + nonce + "\n" +
  base64url(SHA-256(body)) + "\n" + iat`. A signed `/auth/session` gets a token with `cnf.jkt`
  (base64url of the daemon key's SHA-256 thumbprint digest). A request must be signed when its token
  has `cnf` or the server is at level 2: REST in the key gate of `api-routes.ts` (which reads the
  body once, within the route's limit, and hands it on), and the `/ws/daemon/v1` upgrade
  (`upgrade-signature.ts`, both runtimes). `iat` more than 300 s off answers 400
  `Request clock skew` (not 401, so the daemon does not refresh its token). Nonces are single use
  (`nonce` table, kind `request`) on the upgrade and on routes that change state or hand out
  secrets; `/metrics`, transcript chunks and `/host/docker-networking` check skew only.
- **Signed responses.** `signDaemonResponses` (`signed-response.ts`) signs every answer, errors
  included, on the paths in `SIGNED_DAEMON_RESPONSE_PATHS` (the daemon keeps the same list).
- **Sign-in v2.** `/enroll` and `/auth/session` take `payloadVersion: 2` proofs that add the key
  fingerprint (current or next), method, path and `iat` (`src/daemon/authn/proof-version.ts`); v1 is
  refused only for a server with `trust_level` 1 or more until the version floor moves. `/enroll` checks the
  level of the server a re-enroll ticket names (a brand-new server is level 0, so v1 still enrolls it).
