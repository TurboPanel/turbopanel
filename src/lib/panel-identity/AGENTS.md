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
- **Workers:** the identity (imported keys) may live at isolate scope; the database client never
  does. Nothing here runs crypto at module load.
- **Pinned-by.** `pinned-by.ts` `resolvePinnedBy` is the one place that reads a server's pin state
  (`install | upgrade | unsafe | none`); it returns `none` until the server `trust_pinned_by` column
  exists. The admin read and the client server read model both call it.
- **Changing `next`** (`setPanelIdentityNext`) must be followed by swapping the in-memory identity
  (`onIdentityNextChanged` in `server.ts`); the document cache re-signs when the next fingerprint changes.
- **Sealed secrets (`hpke.ts`).** HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256),
  ChaCha20-Poly1305, via `@hpke/core` + `@hpke/chacha20poly1305` (pure JS, no I/O at load, builds
  the suite on first use). Envelope `{v:1, kid, enc, ct}`; `aad` is the recipient server id.
  `/secrets/decrypt` seals its answer to the daemon's registered sealing key
  (`src/daemon/secrets-decrypt-answer.ts`) when the daemon lists `daemon-sealed-secrets-v1`; every
  other daemon still gets `plaintexts`, and `server.plaintext_secrets_at` records that (read by the
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
  decide. `trust_level` is raised only by the daemon's own attach proof, which is a later change.
- **Signed responses.** `signDaemonResponses` (`signed-response.ts`) signs every answer, errors
  included, on the paths in `SIGNED_DAEMON_RESPONSE_PATHS` (the daemon keeps the same list).
- **Sign-in v2.** `/enroll` and `/auth/session` take `payloadVersion: 2` proofs that add the key
  fingerprint (current or next), method, path and `iat` (`src/daemon/authn/proof-version.ts`); v1 is
  refused only for a server with `trust_level` 1 or more until the version floor moves.
