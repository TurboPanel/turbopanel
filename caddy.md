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
restarting `turbopanel-caddy` when it changes. One template. `:8443` is always
the Platform CA recovery listener. `:8880` is always the HTTP-01 solver
(other paths redirect to `:8443`). Public `:443` for an `uploaded` or
`lets-encrypt` hostname is bound by this Caddy only when hosting Caddy is
not installed. On a combined host, hosting Caddy owns `:443` and
reverse-proxies the name here. `turbopanel_tls_mode` is a display-only derivation
of that hostname list. Ports, leaf paths, and the optional ACME contact are
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
(Expo proxy, plaintext `:8880`, optional wrangler upstream,
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
| `:8443` | yes | Platform CA leaf `platform-ca.crt` / `platform-ca.key`. Recovery address. Every `platform-ca` hostname is a SAN. Still minted when no hostname uses that source. `self-signed.{crt,key}` is a symlink to `platform-ca.*` for one release. |
| `:8880` (`http_port`) | yes | Built-in HTTP-01 solver owns `/.well-known/acme-challenge/*`. Every other path redirects to `https://{host}:8443`. |
| `:443` | only when hosting Caddy is absent | Explicit `<host>:443`. Let's Encrypt has no `tls` line (Caddy automatic HTTPS). An uploaded pair is `tls uploaded-<cert_id>.{crt,key}` (legacy empty `cert_id` uses `uploaded.{crt,key}`). The unit grants `CAP_NET_BIND_SERVICE` for either source. On a combined host this port is not bound here: Let's Encrypt listens on loopback `:8444` and hosting Caddy publishes `:443`. |
| `:80` | whoever owns the public edge | Let's Encrypt dials this port. See the three challenge routes below. |

`lets-encrypt` is managed-install only (the co-located dev overlay Caddyfile
wins over `turbopanel_caddyfile` and has no per-hostname sites).
`turbopanel_acme_email` is optional: the template emits the `email` directive
only when the address is non-empty, so an unset contact never renders an
invalid `email ` line. `TURBOPANEL_TLS_PUBLIC` is forced true when any hostname
is `lets-encrypt` (or the deprecated mode is `lets_encrypt`). Then
`GET /api/daemon/v1/instance/ca` 404s and install commands omit `--insecure-tls`.
The Platform CA is still minted. `:8443` still presents it.

**Why port 80 when the panel serves `:8443`.** Let's Encrypt HTTP-01 dials the
public hostname on port 80. The solver is pinned to `:8880` so `:80` can stay
with hosting Caddy. Three shapes deliver that request:

1. **Solver.** `:8880` always answers `/.well-known/acme-challenge/*`. Publishing `:8880` does not replace the port-80 check.
2. **Hosting Caddy on the same host.** The daemon writes the reserved site `00-instance-acme-http01.caddy` (`INSTANCE_ACME_HTTP01_SITE` in `turbopaneld/src/deploy/instance-acme-http01.ts`). For each control-plane Let's Encrypt hostname, `http://<host>` reverse-proxies only the challenge path to `127.0.0.1:8880`. After the leaf exists, that file also terminates public `:443` (the copy under `<state>/caddy/public-edge`) and reverse-proxies to loopback `:8444`. Uploaded names are served from their on-disk pair and reverse-proxied to `:8443`. Tenant teardown skips that file (`DAEMON_RESERVED_HOSTING_SITES`). The file is removed when no hostname is `lets-encrypt` or `uploaded`. `ensureHostingCaddyRuntime` calls `syncInstanceAcmeHttp01Site` after hosting Caddy starts.
3. **No hosting Caddy yet.** The sync is a no-op. An edge must forward public `:80` to `:8880`, or issuance waits until hosting Caddy is installed. This Caddy then binds explicit `:443` itself.

On a combined host, control-plane Caddy does not bind `:443`. Hosting Caddy
owns that port for tenant sites and for these control-plane names.
`instance-certs-apply` loads the candidate through `admin localhost:2019`
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
certificates. Saving one leaves the other unchanged. ACME storage is this
unit's `XDG_DATA_HOME` (`<state>/caddy/.local/share`), distinct from hosting
Caddy (`<state>/hosting-caddy`) and site Caddy (`<state>/site-caddy`).

- Entrypoint: `https://<host>:8443` always — binds all interfaces; use
  `localhost` or the machine's LAN IP. A Let's Encrypt or uploaded hostname
  is also `https://<hostname>/` on `:443` (hosting Caddy on a combined host,
  this Caddy when it is the only one).
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
  `TURBOPANEL_TLS_PUBLIC` is set (404 → system trust store). Trust the
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

On a managed host `:8880` is the solver and redirect, not a second copy of the
panel. The plaintext mirror of `:8443` lives only in the dev overlay Caddyfile,
and the instance accepts it only when `TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1`.

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
valid configurations. A Let's Encrypt or uploaded hostname uses that name's
certificate on `:443`. `:8443` remains the Platform CA path.

| Path                          | Platform CA trust                                                                                                  | SAN requirement                                                                                                                                                                                                                                                                                                                                                                                                               | `GET /api/daemon/v1/instance/ca` |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Self-signed (self-hosted)** | Daemon trusts the downloaded **Platform CA** bundle (`TURBOPANEL_INSTANCE_CA` → `/etc/turbopanel/instance-ca.pem`, fetched from `GET /api/daemon/v1/instance/ca`). Instance material lives under `/var/lib/turbopanel/tls/` (`ca.crt` / `ca.key` / `ca-bundle.pem`) — not the replaceable checkout. Distinct from the **Organization CA** (`src/lib/tls/AGENTS.md`). | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname.                                                                                                                    | 200 PEM |
| **Uploaded cert**             | Publicly-valid (when `turbopanel_tls_public`) → **system trust**; otherwise the Platform CA is still served          | The uploaded leaf **must** cover the hostname the daemon dials.                                                                                                                                                                                                                                                                                                                                                               | 200 unless `TURBOPANEL_TLS_PUBLIC` |
| **Let's Encrypt**             | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`)                     | The real cert already covers the public hostname.                                                                                                                                                                                                                                                                                                                                                                             | 404 (`TURBOPANEL_TLS_PUBLIC`) |
| **Cloudflare tunnel / proxy** | Cloudflare's edge cert is publicly-valid → **system trust**                                                        | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. | 200 (origin still Platform CA) |

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does
not replace them), so configuring the **Platform CA** does not break validation
of publicly-trusted certs. The daemon re-reads `instance-ca.pem` on each
reconnect (mtime+size cache) and parks TLS chain/SAN/expiry failures as
`tls-trust` instead of looping every 30 s. Control-plane rotation appends the
outgoing **Platform CA** to the bundle, then fans `server.tls.trust.reconcile`
over the existing WSS session so the new anchor lands **before** the old one is
retired.

**Install command TLS** follows the selected origin (`src/features/install/install-tls.ts`),
not “we are in development”:

- HTTPS on a non-443 port, loopback, RFC1918, or reserved LAN TLDs (`.lan` /
  `.local` / …) → `curl -k` + `TURBOPANEL_INSECURE_TLS=1` (Platform CA)
- HTTPS on port 443 for a public hostname (Cloudflare/ngrok tunnel, Let’s
  Encrypt, uploaded cert) → system trust; **no** `-k`
- `TURBOPANEL_TLS_PUBLIC=1` (`resolvePublicInstanceTls`) overrides the non-443
  port check, so an uploaded publicly-trusted cert on `:8443` also omits `-k`
  and the Deno CA route 404s (unlocking `run.sh`'s system-trust branch)
- Plaintext `http://` (dev `:8880`) → no TLS flags

Let’s Encrypt and uploaded certificates for a **control-plane hostname** are
per-name sources on **Admin → Access**. The `:8443` Platform CA listener stays
bound beside them. A Cloudflare tunnel presents a
publicly-trusted cert at the edge; the origin can stay on the **Platform CA**.

Dev overlay install commands also set
`TURBOPANEL_DL_BASE=<origin>/downloads/daemon` so remote servers fetch the
compiled daemon from this instance, never `dl.trbp.nl`.

## Static UI

Caddy serves the exported web build from `TURBOPANEL_UI_ROOT` (default
`/opt/turbopanel/share/ui`). On co-located hosts, `TURBOPANEL_UI_MODE=static`
also disables `isDeveloperSurfaceEnabled()` (see `src/app/dev-mode.ts`) and stops
`turbopanel-ui.service` via the `instance-launch` role — while still loading the
**dev** overlay Caddyfile when `turbopanel_dev_user` is set (plaintext `:8880`
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

