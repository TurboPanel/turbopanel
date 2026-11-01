# Instance Hostnames and ACME (`src/features/install/`)

### Instance hostnames and instance ACME

**DNS-01 source (self-hosted).** `dns-01` is a fourth `origin.source`: the
control plane orders the certificate itself (`src/platform/deno/ingress/dns01/`)
and points `uploaded_cert_id` at the issued `certificate` row (`kind='dns-01'`).
A rewrite of the hostname list keeps that pair and `acme_state`; a request body
never sets them. `effectiveCertificateSource` maps the row to `uploaded` while
the pair is live and to `platform-ca` before the first one and after expiry;
the apply payload, install trust and the `/instance/ca` decision all use it,
so the daemon needs no new wire value.

The control plane's own names live on `origin` (export `instanceHostname`),
not in an organization's `tls` rows. Each row stores the normalized public URL
entry plus a certificate source: `platform-ca` (the Platform CA leaf Ansible
already renders), `uploaded` (a `certificate` row whose key is a sealed
`tpsecret` envelope), or `lets-encrypt`. Let's Encrypt is refused for loopback,
private, and wildcard names. Issuance state (`acme_last_attempt_at`,
`acme_last_error`, `not_after`) is per hostname.

Instance-wide ACME knobs (contact email, terms acceptance, directory URL,
staging) are the `INSTANCE_ACME_SETTINGS` setting row. That group is
independent of every organization's ACME opt-in: instance ACME code does not
read or write it, and organization code does not read instance ACME.
`GET/PUT /api/admin/v1/instance/public-urls` still round-trips the flat list;
`getPublicUrls` / `setPublicUrls` project it onto `origin` with source
`platform-ca`, and the `TURBOPANEL_PUBLIC_URLS` setting stays in sync so cert
SAN generation and webhook reachability keep calling them.

Uploaded public trust is per certificate. The install command treats an
uploaded leaf as public only when that PEM chains to a system root.
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
when any source is `lets-encrypt`, `instanceAcme`. Uploaded `keyPem` values
are decrypted for that one hop. Older daemons get `urls` only. Port 80 is
open only during issuance or renewal. The issuer is the short-lived
`turbopanel-instance-acme.service`, which the daemon starts and stops for
that window. Before a `lets-encrypt` hostname is applied, the daemon
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
(`primary-host-changed`), and either change is audited.
