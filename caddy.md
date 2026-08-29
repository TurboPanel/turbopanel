# Caddy (production) — reference

Referenced from `AGENTS.md` (**Caddy**). Covers the production `Caddyfile`:
server addresses, certs and entrypoint, the daemon TLS trust model, and the
static UI catch-all. Read before editing `Caddyfile` or
`scripts/download-caddy.mjs`.

This repo's `Caddyfile` is **production-only**. Caddy terminates TLS and routes:

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
`wrangler.jsonc` at the same time. `src/surfaces.test.ts` pins the strings.

`reverse_proxy` to the Unix socket sets `X-Real-IP {remote_host}` on all three.
The instance uses that header to deduplicate daemon WebSocket reconnects
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

Caddy/cert installs are handled by the daemon's `caddy` and `instance-certs`
Ansible roles; `turbopanel-caddy.service` runs as `tpcaddy:tp` in production.

- Entrypoint: `https://<host>:8443` (this `Caddyfile`) — binds all interfaces;
  use `localhost` or the machine's LAN IP.
- Self-hosted TLS uses a **Platform CA** stored in the durable state tree
  (`/var/lib/turbopanel/tls/ca.crt` + `ca.key`, plus `ca-bundle.pem` for
  current+retired overlap). The Caddy **leaf** stays under the instance
  `certs/` dir (`self-signed.crt` + `.key`). **`auto_https off` is mandatory
  and must never be removed.** Caddy must never auto-provision certs via ACME or
  on-demand TLS. All cert issuance goes through
  `scripts/generate-self-signed-cert.mjs` (self-hosted, **Platform CA**) or an
  explicitly-configured publicly-trusted cert. The `instance-certs-apply.yml`
  playbook is the runtime **leaf-only** cert-regen path triggered by the admin
  public-URL apply action — it never passes `TURBOPANEL_TLS_CA_ROTATE`.
  `ensureCa()` validates readable existing durable **Platform CA** files,
  rotates when requested, or mints a new durable root — and refuses to mint
  over an unreadable existing **Platform CA**. Rotation is opt-in
  (`TURBOPANEL_TLS_CA_ROTATE=1`) and keeps the outgoing **Platform CA** root in
  the bundle until daemons ack `server.tls.trust.reconcile`. Daemons fetch the
  bundle from `GET /api/daemon/v1/instance/ca`. Trust the **Platform CA** in
  browsers/OS to avoid warnings. The **Organization CA** and org TLS library
  (`/api/client/v1/tls`, `/tls/ca`) are a separate per-organization store for
  managed-database / ProxySQL / replication leaves and must never write
  **Platform CA** paths — see `src/lib/tls/AGENTS.md`. **Future:** tenant
  **hosting** leaves (Caddy-fronted web services) remain operator-pinned library
  certificates or Caddy `tls internal`. They are never issued by the
  Organization CA.
- Override the resolved binary with `TURBOPANEL_CADDY` (and `TURBOPANEL_DENO`
  for Deno).

There is **no** plaintext HTTP listener in the production Caddyfile. Co-located
`:8880` lives only in the dev overlay Caddyfile.

## Daemon TLS trust model (3 paths)

The daemon validates the instance server cert on **every** connect — both chain
trust **and** hostname (SAN). There is **no** insecure/skip-verification mode at
runtime (the old `TURBOPANEL_TLS_INSECURE` daemon env was dead and was removed;
`run.sh --insecure-tls` only affects the bootstrap `curl -k` downloads). Three
valid configurations:

| Path                          | Platform CA trust                                                                                                  | SAN requirement                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-signed (self-hosted)** | Daemon trusts the downloaded **Platform CA** bundle (`TURBOPANEL_INSTANCE_CA` → `/etc/turbopanel/instance-ca.pem`, fetched from `GET /api/daemon/v1/instance/ca`). Instance material lives under `/var/lib/turbopanel/tls/` (`ca.crt` / `ca.key` / `ca-bundle.pem`) — not the replaceable checkout. Distinct from the **Organization CA** (`src/lib/tls/AGENTS.md`). | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname.                                                                                                                    |
| **Let's Encrypt**             | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`)                     | The real cert already covers the public hostname.                                                                                                                                                                                                                                                                                                                                                                             |
| **Cloudflare tunnel / proxy** | Cloudflare's edge cert is publicly-valid → **system trust**                                                        | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. |

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does
not replace them), so configuring the **Platform CA** does not break validation
of publicly-trusted certs. The daemon re-reads `instance-ca.pem` on each
reconnect (mtime+size cache) and parks TLS chain/SAN/expiry failures as
`tls-trust` instead of looping every 30 s. Control-plane rotation appends the
outgoing **Platform CA** to the bundle, then fans `server.tls.trust.reconcile`
over the existing WSS session so the new anchor lands **before** the old one is
retired.

**Install command TLS** follows the selected origin (`src/lib/install-tls.ts`),
not “we are in development”:

- HTTPS on a non-443 port, loopback, RFC1918, or reserved LAN TLDs (`.lan` /
  `.local` / …) → `curl -k` + `TURBOPANEL_INSECURE_TLS=1` (Platform CA)
- HTTPS on port 443 for a public hostname (Cloudflare/ngrok tunnel, opt-in Let’s
  Encrypt, uploaded cert) → system trust; **no** `-k`
- Plaintext `http://` (dev `:8880`) → no TLS flags

Let’s Encrypt and uploaded certificates for the **control-plane origin** are
operator opt-in. Caddy keeps `auto_https off` — the platform never obtains a
public certificate unless the operator explicitly requests it. A Cloudflare
tunnel presents a publicly-trusted cert at the edge; the origin can stay on the
**Platform CA**.

Dev overlay install commands also set
`TURBOPANEL_DL_BASE=<origin>/downloads/daemon` so remote servers fetch the
compiled daemon from this instance, never `dl.trbp.nl`.

## Static UI

Caddy serves the exported web build from `TURBOPANEL_UI_ROOT` (default
`/opt/turbopanel/share/ui`). On co-located hosts, `TURBOPANEL_UI_MODE=static`
also disables `isDeveloperSurfaceEnabled()` (see `src/dev-mode.ts`) and stops
`turbopanel-ui.service` via the `instance-launch` role — while still loading the
**dev** overlay Caddyfile when `turbopanel_dev_user` is set (plaintext `:8880`
remains available).

Build the static export locally or switch via the dev console **Switch to
production build** (runs `ui-build` → `instance-build` → `instance-launch`). For
a compiled instance binary, `deno task compile` in this repo produces
`dist/turbopanel-instance` from `src/deno.ts` with production `--allow-*` flags
baked in at compile time. Development source mode runs `src/deno-dev.ts`.

Manual export + Caddy:

```bash
cd ../ui && pnpm export
cd ../turbopanel
TURBOPANEL_UI_ROOT=../ui/dist caddy run --config Caddyfile --adapter caddyfile
```

Caddy serves files from `TURBOPANEL_UI_ROOT` (default
`/opt/turbopanel/share/ui`; the local manual example above sets `../ui/dist`)
and falls back to `/index.html` for client-side routes (SPA), matching the
Cloudflare Workers asset routing in `ui/wrangler.jsonc`.

Set `CADDY_TLS_CERT` / `CADDY_TLS_KEY` only when overriding the default server
leaf certificate paths.

