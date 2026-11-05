# Instance Hostnames and ACME (`src/features/install/`)

### Where control-plane hostnames come from

One rule per runtime, in `control-plane-origins.ts`. Links and
`resolvePublicBaseUrl`, install commands, passkey origins, the identity
document and the daemon hello URLs, published Git origins and install trust go
through it. The site-name guard (`features/hostings/panel-hostname-guard.ts`)
does not: its callers have no runtime to pass, so it reads the rows itself and
skips them when there is no `Deno` global (High Availability).

- **High availability (Workers):** only the platform environment,
  `TURBOPANEL_BASE_URL` then `TURBOPANEL_PUBLIC_URLS`, always port-free (the
  control plane answers on 443). Nothing can add or change them through the
  API: `PUT /instance/public-urls` and every hostname, certificate and ACME
  write answer the same 422 (`refuseWorkersWrite`), and
  `GET /instance/public-urls` lists the platform origins with
  `platformManaged`.
  A stored `origin` row is ignored by code; nobody inspects or cleans HA
  databases for them.
- **Self-hosted (Deno):** only the `origin` rows edited under Admin › Access ›
  Hostnames. The process environment is never a hostname source, so neither
  `TURBOPANEL_BASE_URL` nor `TURBOPANEL_PUBLIC_URLS` in the unit's env changes
  a link. With no rows, links use the discovered address
  (`https://<ip>:8443`) until an admin adds one; the installer seeds nothing.
  Mail sent outside a request (alerts, digests, retries, certificate notices)
  resolves the console link at send time (`resolveSelfHostedConsoleBaseUrl`),
  so a new primary hostname needs no restart.
- The daemon still writes `TURBOPANEL_PUBLIC_URLS` to
  `/etc/turbopanel/instance/runtime.env` on apply. That copy is derived from
  the rows and read only by the `instance-certs` role for certificate SANs.
- `migrateLegacyPublicUrls` copies the old `TURBOPANEL_PUBLIC_URLS` _setting
  row_ (database, admin-written) into `origin` once when the table is empty.
  It never reads the environment.

### Instance hostnames and instance ACME

**DNS-01 source (self-hosted).** `acme-dns-01` is a fourth `origin.source`: the
control plane orders the certificate itself (`src/platform/deno/ingress/dns01/`)
and points `uploaded_cert_id` at the issued `certificate` row
(`kind='acme-dns-01'`).
A rewrite of the hostname list keeps that pair and `acme_state`; a request body
never sets them. `effectiveCertificateSource` maps the row to `uploaded` while
the pair is live and to `platform-ca` before the first one and after expiry;
the apply payload, install trust and the `/instance/ca` decision all use it,
so the daemon needs no new wire value. The daemon wire also keeps its own name
for HTTP-01: `wireCertificateSource` sends a stored `acme-http-01` as
`lets-encrypt` in `public-urls-update`, at that one boundary only.

The control plane's own names live on `origin` (export `instanceHostname`),
not in an organization's `tls` rows. Each row stores the normalized public URL
entry plus a certificate source: `platform-ca` (the Platform CA leaf Ansible
already renders), `uploaded` (a `certificate` row whose key is a sealed
`tpsecret` envelope), `acme-http-01` (Let's Encrypt over HTTP-01, issued by the
daemon) or `acme-dns-01` (below). Let's Encrypt is refused for loopback,
private, and wildcard names, and a save with either Let's Encrypt source is
refused (422 `acme_terms_not_accepted`) while the terms are not accepted.
Issuance state (`acme_last_attempt_at`, `acme_last_error`, `not_after`) is per
hostname.

Instance-wide ACME knobs (contact email, terms acceptance, directory URL,
staging) are the `INSTANCE_ACME_SETTINGS` setting row. That group is
independent of every organization's ACME opt-in: instance ACME code does not
read or write it, and organization code does not read instance ACME.
`GET/PUT /api/admin/v1/instance/public-urls` still round-trips the flat list;
`getPublicUrls` / `setPublicUrls` project it onto `origin` with source
`platform-ca`, and the `TURBOPANEL_PUBLIC_URLS` setting stays in sync so cert
SAN generation and webhook reachability keep calling them.

Uploaded public trust is per hostname. The install command treats an
uploaded name as public only when the certificate the listener serves for it
verifies against the runtime's public root store (not the host's OpenSSL
store).

Both checks run in memory: the control plane writes no certificate file
and starts no process for them. Public trust is a TLS handshake against the
control plane's own listener on loopback port 8443, with the uploaded hostname as SNI;
the runtime's verifier decides whether the chain it serves reaches a public
root and covers the name (`src/platform/deno/public-tls-probe.ts`, registered
by the Deno composition root through `setPublicTlsProbe`). It judges what the
listener serves, so a just-uploaded certificate counts once Caddy serves it.
The private issuer is checked with WebCrypto (`verifyCertificateSignature`,
RSA or ECDSA with the hash the certificate names). A handshake that cannot
run (no listener, timeout) withholds the command with its own message
(`uploadedTrustUnchecked`), never an unhandled error. Workers never reaches
this path: the hosted control plane stores no uploaded hostnames.

`TURBOPANEL_TLS_PUBLIC` stays an aggregate signal (any Let's Encrypt hostname,
or the operator's public-TLS setting) and does not mark an unrelated upload
as public. `GET /api/daemon/v1/instance/ca` still returns the Platform CA
bundle for a name that hits the `:8443` catch-all, including an unlisted
name, when that flag is set. A name that presents a Let's Encrypt or uploaded
leaf does not. That 404 is not system trust for a private upload.
`GET /api/daemon/v1/instance/uploaded-trust` returns the issuer from that
hostname's PEM when the leaf covers the dialed name and the issuer signed
the leaf. The installer verifies that relationship against the presented
certificate before writing `/etc/turbopanel/instance-uploaded-trust.pem`.
That file is not the Platform CA bundle. A publicly trusted upload answers
404 and the daemon keeps the system roots. A private upload with no covering
issuer is refused before an install command is emitted. Bootstrap `-k` fetches
that document and is not stored as runtime trust; the daemon still verifies
the chain and the hostname. Every self-hosted `:8443` origin served by
the Platform CA catch-all — a public name, a private IP, or a `.lan`
alias, listed or not — is accepted only when that leaf's SANs cover it.
Otherwise `POST /licenses` refuses the command before it is returned.
Let's Encrypt and uploaded hostnames are checked against their own leaf.

A self-hosted command that bootstraps insecure TLS also carries
`TURBOPANEL_INSTANCE_CA_FINGERPRINT`: the SHA-256 of the DER of every
certificate the installer may fetch over that leg (the Platform CA bundle that
`/instance/ca` serves, read by the same injected `readPlatformCaPem`, plus a
private upload's issuer), lowercase hex, comma-separated so a rotation bundle
installs. The installer refuses a fetched certificate outside that list, and
the daemon refuses to connect when its stored trust drifts from it. When no
fingerprint can be computed, `POST /licenses` refuses the command instead of
emitting an unpinned one (`install-ca-pin.ts`); a document with any block that cannot be decoded counts as unreadable, and `buildLicenseInstallCommand` throws if asked for an insecure-TLS command with no fingerprint. Hosted and publicly trusted
origins carry no fingerprint.

Every hostname, whatever its certificate source, is reached at
`https://<host>:8443`. `POST /api/admin/v1/instance/public-urls/apply` sends
`public-urls-update`. Daemons at or above
`instance-cert-sources-per-hostname` (`0.1.1`) also receive `hostnames` and,
when any source is `acme-http-01` (`lets-encrypt` on the wire), `instanceAcme`. Uploaded `keyPem` values
are decrypted for that one hop. Older daemons get `urls` only. Port 80 is
open only during issuance or renewal. The issuer is the short-lived
`turbopanel-instance-acme.service`, which the daemon starts and stops for
that window. Before an `acme-http-01` hostname is applied, the daemon
publishes an HTTP-01 nonce and requires
`http://<hostname>/.well-known/acme-challenge/<nonce>` to reach the instance
ACME issuer through hosting Caddy. A miss fails the apply; the admin route
records that error on the hostname. The detail phrase is
`did not reach the instance ACME issuer`. Issuance results come back as
`instance-acme-issuance-event` and update `origin.acme_last_attempt_at` /
`acme_last_error`, accepted only from a server that runs the control plane
(`src/daemon/instance-acme-inbound.ts`). A successful probe may also include `notAfter`, which
is stored on the hostname. A failure does not clear `notAfter`. Changing
the source away from Let's Encrypt does. That message is not the tenant
`acme-issuance-event` stream.

## Install TOKEN (v2)

`install-token-command.ts` builds the single-value install command
(`curl -fsSL https://turbopanel.sh | TOKEN=<payload>.<sig> sh`). The payload is
base64url of `v2:` and six base64url fields joined by `:` (license id, license
secret, comma-joined panel URLs with the admin's install URL first, panel key
fingerprint, next key fingerprint, CA fingerprints), signed by the panel
identity key over the payload text (`encodeInstallToken`). Rules:

- **Always on, one fallback.** Every command that carries a join ticket uses
  `TOKEN`. The only exception is a control plane with no identity key (High
  Availability before `TURBOPANEL_IDENTITY_KEYS` is set; self-hosted always has
  one): it cannot sign, so the command keeps the older `TURBOPANEL_LICENSE`
  form. There is no switch. The daemon installer still accepts the older form
  until the floor bump.
- Every URL is a bare `https://host[:port]` origin; the encoder throws otherwise
  and the route falls back to the older form for an install URL that is not one.
- The `licenseToken` slot is opaque, so a one-hour join ticket can ride in it
  (the panel tells the two apart by lookup).
- `server.trust_pinned_by` records how the daemon pinned the key (hello
  `panelPin`); `unsafe` means it was installed with the skip flag.

## Public origins versus the dial

A stored hostname is the panel's dial (`:8443`, Caddy and certificate SANs).
What people type is the row's `public_port`: `public-origins.ts` builds that
origin (443 shows no port) and picks the primary row (`is_primary`, else the
oldest). Mail links, invitations, OAuth and webhook URLs, passkey origins, the
identity document and default install commands use it; never use
`publicUrlEntryToInstallOrigin` for anything a person or provider opens. The
PUT hostnames route accepts `publicPort` and `isPrimary` per entry (one
primary; omitted keeps the stored value) and warns when the primary's address
changes, because OAuth callbacks and Git webhooks registered with the old
address must be updated; a different host also stops registered passkeys
(`primary-host-changed`), and either change is audited. Apply sends
`publicPort` on `public-urls-update`, only for `cloudflare-tunnel` rows, to a
co-located daemon that advertises `instance-hostname-public-port-v1`; its
Caddy then sends a request for that hostname on any other port (a tunnel edge
answering both 443 and 8443) to the public port with a 308. Every other mode
omits it and never redirects: on a direct, proxied, Let's Encrypt or uploaded
name ports 80 and 443 belong to hosting and may serve a different site. A self-hosted control plane does not wait for a
Save: every 5 minutes its maintenance tick builds the body
(`applyStoredPublicUrls` in `src/admin/public-urls-apply-run.ts`) and sends it
when its fingerprint differs from `appliedPayloadHash` in the `EDGE_TRUST`
setting, so a field a newer build adds, or a connection-mode change, reaches
the daemon once. Key material is left out of the fingerprint (a sealed key is new on
every build), and a successful Save records the same fingerprint.

On a self-hosted control plane (the Deno server calls `setSelfHostedAddress`
at start-up) the public port is fixed at 8443, even behind a tunnel that also
answers on 443: rows read as 8443 whatever an older save stored, saves and
connection-mode changes naming any other port are refused with a 400, and
every origin above (including forwarded-host and base-URL fallbacks) ends in
`:8443`. High Availability (Workers) never sets it and keeps the per-name port.

Hostnames in the `cloudflare-proxy` or `bunny-proxy` mode also need the
provider's published edge ranges so Caddy can read the visitor address.
`edge-trust.ts` holds the ranges in the `EDGE_TRUST` setting and builds the
`edgeTrust` field of `public-urls-update` (only for a daemon advertising
`instance-edge-trust-v1`); the fetches live in
`src/platform/deno/ingress/edge-ranges.ts`.
