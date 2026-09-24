# Caddy (production) — reference

Referenced from `AGENTS.md` (**Caddy**). Covers the production Caddyfile:
server addresses, certs and entrypoint, the daemon TLS trust model, and the
static UI catch-all. Read before editing the daemon's Caddyfile template or
`scripts/download-caddy.mjs` (pinned **2.11.4**, SHA-256 verified — keep in
step with `turbopaneld/orchestration/roles/caddy/defaults/main.yml`).

The production Caddyfile lives in the **daemon** repo as a Jinja template —
`turbopaneld/orchestration/roles/instance-launch/templates/Caddyfile.j2` —
and the `instance-launch` role renders it into
`/etc/turbopanel/caddy/Caddyfile` (root:tp `0640`) on every converge,
restarting `turbopanel-caddy` when it changes. One template. `:8443` is the
only listener. The certificate is chosen by hostname: the Platform CA leaf
is the catch-all, and an `uploaded` or `lets-encrypt` name is an extra site
on the same port once its files exist. Port 80 is open only during issuance
or renewal, on hosting Caddy, for the short-lived
`turbopanel-instance-acme` issuer. `turbopanel_tls_mode` is a display-only
derivation of that hostname list. Ports, leaf paths, and the optional ACME
contact are
baked in at render time. The instance release package ships no site config, and the rendered
file is never hand-edited: change the template, converge. Caddy terminates
TLS and routes:

- `/api/*`, `/ws/*`, and `/webhook/*` → Deno instance
  (`unix:///run/turbopanel/instance.sock`)
- everything else → static UI export (`TURBOPANEL_UI_ROOT`, default
  `/opt/turbopanel/share/ui`)

**The catch-all is why the prefix list is load-bearing.** It answers
`try_files {path} /index.html`, so a prefix the instance owns but Caddy does not
match is served the SPA shell with **HTTP 200** rather than a 404. For a Git
webhook that means the provider records a successful delivery and never
retries — silent, unrecoverable loss. The same trap exists on Workers, where
the UI worker holds the apex as a custom domain with
`not_found_handling: "single-page-application"`; add the prefix to `routes` in
`wrangler.jsonc` at the same time. `src/app/surfaces.test.ts` pins the strings.

`reverse_proxy` to the Unix socket sets `X-Real-IP {client_ip}` on all three.
Global `trusted_proxies` trusts loopback, so a hosting Caddy hop keeps the
original client. The instance uses that header to deduplicate daemon WebSocket reconnects
(without it, every reconnect looked like a new fleet member behind the proxy),
and to key the webhook rate limiter per peer address.

Each site block also strips `CF-Connecting-IP`, `True-Client-IP`, and
`X-Forwarded-For` from any peer that is **not** loopback, so only a connector
running beside Caddy can present them. See **Server addresses** below.

**Co-located development** does not use this file. When `turbopanel_dev_user` is
set, `turbopanel-caddy.service` loads `~/dev/orchestration/Caddyfile` instead
(Expo proxy, optional wrangler upstream,
`/downloads/daemon` + installer at `/run.sh`). See **`../dev/AGENTS.md`**
(Ansible overlay / Caddyfile).

## Server addresses

`src/lib/peer-address.ts` is the one place that answers "what address is
this server at". Two distinct questions, deliberately separated:

**Connect time — `resolvePeerAddress()`.** Turns the request headers into
the peer address stored on the daemon projection. `CF-Connecting-IP` (and
`X-Forwarded-For`) are read **only when the immediate peer is a trusted proxy**,
which by default means loopback: the Deno instance listens on a Unix socket, so
its only direct callers are local processes — Caddy, or a `cloudflared`
connector beside it. A daemon that dialled Caddy over the network arrives with a
non-loopback `X-Real-IP` and cannot forge its own address. Widen the trusted set
with `TURBOPANEL_TRUSTED_PROXY_CIDRS` (comma-separated CIDRs) when the connector
runs on another host; the value **replaces** the loopback default rather than
extending it. A loopback value inside a forwarding header is ignored, because
Caddy synthesizes `X-Forwarded-For: 127.0.0.1` for a loopback peer and that
would shadow the `X-Real-IP` fallback. Absent every header means a co-located
daemon dialled the socket: the `__direct__` sentinel, not an error. Workers read
`CF-Connecting-IP` and nothing else — the edge strips any client copy.

**Read time — `resolveServerAddress()`.** The address on the wire is frequently
*not* the host's address, so `shapeServerPresenceFields()` reconciles it against
the interfaces the daemon reported before any reader sees it, and returns
`address` / `addressSource` / `addressScope` / `addressInterface`. Order:
`__direct__` → public observed → observed that the daemon also reports on an
interface → the daemon's best reported interface → an unmatched private observed
address. **The interface fallback is the whole point.** Behind a co-located
reverse proxy, or through a forwarded port — every development Vagrant guest,
which forwards over SSH — the wire address is `127.0.0.1` for *every* server, so
the panel showed `127.0.0.1` for a LAN host, a Cloudflare Tunnel host, and a
remote host alike. `remoteAddress` is still exposed, raw, for diagnostics.

Daemons mark the addresses on their **default-route interface** `preferred`
(`readDefaultRouteInterfaces()`, from `/proc/net/route` and
`/proc/net/ipv6_route`), so a multi-homed host advertises the NIC a peer would
actually reach it on instead of whichever address sorted first. The instance
does the same for its own addresses, which is what builds the install-command
URL in `resolve-public-base-url.ts`.

## Certs and entrypoint

Caddy/cert installs are handled by the daemon's `caddy`, `instance-certs`, and
`instance-launch` Ansible roles; `turbopanel-caddy.service` runs as `tpcaddy:tp`
in production. Listeners are derived from `turbopanel_hostnames`
(`{host, source, cert_id}`). An empty list is synthesized from the deprecated
`turbopanel_tls_mode` aliases so an existing converge keeps working. The
template's display-only mode is `upload` if any hostname is uploaded,
`lets_encrypt` if any is ACME, otherwise `self_signed`.

| Listener | Always | What it serves |
| --- | --- | --- |
| `:8443` | yes | Platform CA leaf `platform-ca.crt` / `platform-ca.key`. Recovery address. Every `platform-ca` hostname is a SAN. Still minted when no hostname uses that source. `self-signed.{crt,key}` is a symlink to `platform-ca.*` for one release. A Let's Encrypt or uploaded hostname is an additional site on this same port once its files exist. |
| `:80` | hosting Caddy, and only while instance issuance is running | Let's Encrypt HTTP-01. The reserved site `00-instance-acme-http01.caddy` forwards `/.well-known/acme-challenge/*` to the issuer socket and returns 404 for every other path. |

`lets-encrypt` is managed-install only (the co-located dev overlay Caddyfile
wins over `turbopanel_caddyfile` and has no per-hostname sites).
The account email is an issuer setting, not a line in this Caddyfile.
`TURBOPANEL_TLS_PUBLIC` is forced true when any hostname
is `lets-encrypt` (or the deprecated mode is `lets_encrypt`).
`GET /api/daemon/v1/instance/ca` still serves the Platform CA bundle when
the dialed name hits the catch-all, including an unlisted name, even when
`TURBOPANEL_TLS_PUBLIC` is set and no stored hostname uses `platform-ca`.
It 404s for a name that presents a Let's Encrypt or uploaded leaf.
Install `curl -k` follows the dialed hostname: Let's Encrypt uses the system
trust store. An uploaded leaf uses it when that certificate chains to a
public root. `TURBOPANEL_TLS_PUBLIC` does not mark an unrelated upload as
public, including when a Let's Encrypt sibling forced the flag. A Platform
CA hostname, and an unlisted name on the self-hosted `:8443` listener whose
SAN the catch-all leaf covers, still need `-k`. A public unlisted name the
leaf does not cover is refused. The Platform CA is still minted.
`:8443` still presents it as the catch-all.

**Why port 80 when the panel serves `:8443`.** Let's Encrypt HTTP-01 dials the
public hostname on port 80. Control-plane Caddy does not bind that port. The
daemon opens a window only while issuance runs:

1. If port 80 is free, `ensureHostingCaddyRuntime` installs hosting Caddy. If another process holds it, the apply fails with `port 80 is held by <process>`.
2. The daemon writes `00-instance-acme-http01.caddy`. For each Let's Encrypt hostname, `http://<host>` reverse-proxies `/.well-known/acme-challenge/*` to `unix/<run dir>/instance-acme.sock` and keeps the Host header. Every other path returns 404.
3. `turbopanel-instance-acme.service` (not enabled; the daemon starts and stops it) runs vendored Caddy with `tls.certificates.automate`, TLS-ALPN disabled, and that socket as its only listener. Storage is `<state>/instance-acme`. JSON logs are `/var/log/turbopanel/instance-acme.log`.
4. Before the order, the daemon answers a nonce on the socket and requires the public URL to return it. A miss says the request `did not reach the instance ACME issuer`.
5. When each leaf is in issuer storage, the daemon copies `letsencrypt-<host>.{crt,key}` into the instance certs directory, stops the issuer, removes the reserved site, and runs `instance-certs-apply` so `<host>:8443` renders. If the sites directory then holds only daemon-reserved files, hosting Caddy is disabled.

`instance-certs-apply` loads the candidate through the admin Unix socket
(`turbopanel_caddy_admin_socket`, default `unix//run/turbopanel/caddy/admin.sock`)
and replaces the persistent Caddyfile only after the running process accepts
it. A failed validate or a rejected reload does not replace the live file.
`:8443` stays up either way.

**Wildcards are upload-only.** HTTP-01 cannot prove a `*.` name, and DNS-01
needs a DNS-provider module the stock Caddy binary (pinned **2.11.4**,
`scripts/download-caddy.mjs` and the `caddy` role) does not include. The
control plane refuses Let's Encrypt for a wildcard, a loopback name, and a
private name.

**Instance Let's Encrypt is its own settings row** (`INSTANCE_ACME_SETTINGS`:
contact email, terms, directory URL, staging; env prefix
`TURBOPANEL_INSTANCE_ACME__`). It applies to this control plane's hostnames.
An organization's `acmeEnabled` opt-in applies to that organization's hosting
certificates. Saving one leaves the other unchanged. The issuer's ACME
storage is `<state>/instance-acme` (`XDG_DATA_HOME`), distinct from
control-plane Caddy (`<state>/caddy/.local/share`), hosting Caddy
(`<state>/hosting-caddy`), and site Caddy (`<state>/site-caddy`).

- Entrypoint: `https://<host>:8443` for every hostname. The certificate
  follows the name. The listener binds all interfaces; use `localhost` or
  the machine's LAN IP.
- Self-hosted TLS uses a **Platform CA** stored in the durable state tree
  (`/var/lib/turbopanel/tls/ca.crt` + `ca.key`, plus `ca-bundle.pem` for
  current+retired overlap). The `:8443` leaf stays under the instance `certs/`
  dir (`platform-ca.*`). Hostname sites that use Let's Encrypt obtain their
  own certificate. Uploaded pairs are files beside the leaf.
  Tenant hosting leaves stay on the per-server hosting Caddy. All other cert
  issuance goes through `scripts/generate-self-signed-cert.mjs` (self-hosted,
  **Platform CA**) or an explicitly-configured uploaded pair. The
  `instance-certs-apply.yml` playbook is the runtime **leaf-only** cert-regen
  path triggered by the admin hostname apply — it never passes
  `TURBOPANEL_TLS_CA_ROTATE`. `ensureCa()` validates readable existing durable
  **Platform CA** files, rotates when requested, or mints a new durable root —
  and refuses to mint over an unreadable existing **Platform CA**. Rotation is
  opt-in (`TURBOPANEL_TLS_CA_ROTATE=1`) and keeps the outgoing **Platform CA**
  root in the bundle until daemons ack `server.tls.trust.reconcile`. Daemons
  fetch the bundle from `GET /api/daemon/v1/instance/ca` unless
  `TURBOPANEL_TLS_PUBLIC` is set and no hostname still presents the Platform
  CA leaf (404 → system trust store). Trust the
  **Platform CA** in browsers/OS to avoid warnings on `:8443`. The
  **Organization CA** and org TLS library (`/api/client/v1/tls`, `/tls/ca`)
  are a separate per-organization store for managed-database / ProxySQL /
  replication leaves and must never write **Platform CA** paths — see
  `src/lib/tls/AGENTS.md`. Tenant **hosting** leaves (Caddy-fronted web
  services) are operator-pinned library certificates, Caddy `tls internal`,
  or — only once the organization has opted in
  (`organization.options.acmeEnabled`, off by default) — a `managed`
  `lets_encrypt` row (`tlsMode: 'acme'`) that Caddy issues and renews on the
  serving host. They are never issued by the Organization CA, and the
  organization's opt-in does not obtain a certificate for the panel. The
  opt-in gate is enforced both at `POST /tls` (creation) and at deploy time
  (`hostingTlsWireFromResolved`), so a `managed` row created before the org
  opted out still can't wire `tlsMode: 'acme'` once the gate is off.
  `pnpm check:instance-acme-boundary` fails the build if instance ACME code
  references an organization's opt-in, or organization code references
  instance ACME settings or the `origin` / `certificate` tables.
- Override the resolved binary with `TURBOPANEL_CADDY` (and `TURBOPANEL_DENO`
  for Deno).

Every rendered site sets a global `header` block
(`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`) on the instance site. HSTS applies on the Platform CA
listener too: a browser that already trusts the leaf (Platform CA
import, or an uploaded/publicly-trusted cert) should not be silently
downgraded to plaintext on a later visit. This is **control-plane only** —
tenant hosting sites are a separate, per-server Caddy config the daemon
generates (`turbopaneld/src/deploy/ingress.ts`), which does not inherit these
headers.

## Daemon TLS trust model

The daemon validates the instance server cert on **every** connect — both chain
trust **and** hostname (SAN). There is **no** insecure/skip-verification mode at
runtime (the old `TURBOPANEL_TLS_INSECURE` daemon env was dead and was removed;
`run.sh --insecure-tls` only affects the bootstrap `curl -k` downloads). Four
valid configurations. Every hostname is served on `:8443`. SNI selects that
name's certificate. The Platform CA leaf stays bound as the catch-all.

| Path                          | Platform CA trust                                                                                                  | SAN requirement                                                                                                                                                                                                                                                                                                                                                                                                               | `GET /api/daemon/v1/instance/ca` |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Self-signed (self-hosted)** | Daemon trusts the downloaded **Platform CA** bundle (`TURBOPANEL_INSTANCE_CA` → `/etc/turbopanel/instance-ca.pem`, fetched from `GET /api/daemon/v1/instance/ca`). Instance material lives under `/var/lib/turbopanel/tls/` (`ca.crt` / `ca.key` / `ca-bundle.pem`) — not the replaceable checkout. Distinct from the **Organization CA** (`src/lib/tls/AGENTS.md`). | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname.                                                                                                                    | 200 PEM |
| **Uploaded cert**             | Publicly-valid when that certificate chains to a public root → **system trust**; otherwise bootstrap uses `-k`. `TURBOPANEL_TLS_PUBLIC` applies only when no Let's Encrypt sibling exists and the certificate was not checked on its own | The uploaded leaf **must** cover the hostname the daemon dials.                                                                                                                                                                                                                                                                                                                                                               | 404 for that name. 200 for a name that hits the Platform CA catch-all |
| **Let's Encrypt**             | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA` for that name)       | The real cert already covers the public hostname.                                                                                                                                                                                                                                                                                                                                                                             | 404 for that name. 200 for an unlisted name on the Platform CA catch-all |
| **Cloudflare tunnel / proxy** | Cloudflare's edge cert is publicly-valid → **system trust**                                                        | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. | 200 (origin still Platform CA) |

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does
not replace them), so configuring the **Platform CA** does not break validation
of publicly-trusted certs. The daemon re-reads `instance-ca.pem` on each
reconnect (mtime+size cache) and parks TLS chain/SAN/expiry failures as
`tls-trust` instead of looping every 30 s. Control-plane rotation appends the
outgoing **Platform CA** to the bundle, then fans `server.tls.trust.reconcile`
over the existing WSS session so the new anchor lands **before** the old one is
retired.

**Install command TLS** follows the dialed hostname's certificate source
(`src/features/install/install-tls.ts`), not the port and not “we are in
development”:

- `platform-ca`, or `uploaded` whose certificate does not chain to a
  public root → `curl -k` + `TURBOPANEL_INSECURE_TLS=1`, including on
  `:8443`. Trust is that certificate, not a sibling upload.
  `TURBOPANEL_TLS_PUBLIC` counts for an unchecked uploaded leaf only when no
  sibling is Let's Encrypt
- `lets-encrypt` → system trust; no `-k`
- The Deno CA route 404s when `TURBOPANEL_TLS_PUBLIC` is set and the dialed
  name presents a Let's Encrypt or uploaded leaf. An unlisted name on the
  `:8443` catch-all still receives the bundle
- No source: loopback, RFC1918, or reserved LAN TLDs → `-k`. An unlisted
  public name on the self-hosted `:8443` listener is the Platform CA
  catch-all and also needs `-k` when the leaf covers it. A public name the
  leaf does not cover is refused. A public name on another port (hosted
  control plane, tunnel edge) uses system trust
- Plaintext `http://` (dev overlay) → no TLS flags

Let’s Encrypt and uploaded certificates for a **control-plane hostname** are
per-name sources on **Admin → Access**. Every name is served at
`https://<host>:8443`. The Platform CA leaf stays bound as the catch-all. A
Cloudflare tunnel presents a publicly-trusted cert at the edge; the origin
can stay on the **Platform CA**.

Dev overlay install commands also set
`TURBOPANEL_DL_BASE=<origin>/downloads/daemon` so remote servers fetch the
compiled daemon from this instance, never `dl.trbp.nl`.

## Static UI

Caddy serves the exported web build from `TURBOPANEL_UI_ROOT` (default
`/opt/turbopanel/share/ui`). On co-located hosts, `TURBOPANEL_UI_MODE=static`
also disables `isDeveloperSurfaceEnabled()` (see `src/app/dev-mode.ts`) and stops
`turbopanel-ui.service` via the `instance-launch` role — while still loading the
**dev** overlay Caddyfile when `turbopanel_dev_user` is set (`https://<host>:8443`
remains available).

Build the static export locally or switch via the dev console **Switch to
production build** (runs `ui-build` → `instance-build` → `instance-launch`). For
a compiled instance binary, `deno task compile` in this repo produces
`dist/turbopanel-instance` from `src/deno.ts` with production `--allow-*` flags
baked in at compile time. Development source mode runs `src/deno-dev.ts`.

Manual export + Caddy (the dev overlay Caddyfile is the env-driven one; the
managed template has its values baked in at render time):

```bash
cd ../ui && pnpm export
cd ../turbopanel
TURBOPANEL_UI_ROOT=../ui/dist caddy run --config ../dev/orchestration/Caddyfile --adapter caddyfile
```

Caddy serves files from the UI export root (`/opt/turbopanel/share/ui` on a
managed install; `TURBOPANEL_UI_ROOT`, set to `../ui/dist` in the manual
example above, for the dev overlay) and falls back to `/index.html` for
client-side routes (SPA), matching the Cloudflare Workers asset routing in
`ui/wrangler.jsonc`.

Set `CADDY_TLS_CERT` / `CADDY_TLS_KEY` only when overriding the default server
leaf certificate paths.

