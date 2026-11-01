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
  edge go-live gate). The fixed vector in `src/test-fixtures/hpke-vector.ts` is the same one the
  daemon repo opens; change both together.
