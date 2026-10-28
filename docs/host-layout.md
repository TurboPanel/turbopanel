# Host Layout, Users, Systemd and Sockets

## Users, group & socket permissions

**Development (co-located):** a **single dev user** runs everything — no `tp`,
`tpctrl`, or `tpcache` service accounts are created. Source repos live under
`$HOME` (`~/turbopaneld`, `~/turbopanel`, `~/ui`, `~/website`) and are owned by
the dev user. Mutable data (`/etc/turbopanel`, `/var/lib/turbopanel`,
`/var/log/turbopanel`, `/run/turbopanel`) is dev-user-owned. Per-service runtime
state may still live in gitignored checkout dirs (`instance/.local`,
`ui/.local`, `ui/.expo`, `.config` trees). `/run/turbopanel` is owned by the dev
user; the instance hardens its socket to **`0660`** owned by the dev user so the
co-located daemon can connect.

**Production:** dedicated service users — `tp` (daemon + Ansible), `tpctrl`
(instance, UI, website, dbstudio), `tpcache` (Redis), `tpdata`
(Postgres), `tpqueue` (RabbitMQ), `tpcaddy` (control-plane Caddy). See
`../turbopaneld/src/paths/AGENTS.md` (Filesystem layout), the allocation table below, and
the systemd table for ownership, ACLs, and `/run/turbopanel` **`2770 tp:tp`**
(setgid).

### Production UID/GID allocation

| User / group | UID/GID | Runs                                                           |
| ------------ | ------- | -------------------------------------------------------------- |
| `tp`         | 9999    | daemon (`turbopaneld`) + Ansible + shared group everyone joins |
| `tpctrl`     | 9998    | instance, UI, website, dbstudio                                |
| `tpcache`    | 9997    | Redis (+ `redis.sock` access group)                            |
| `tpdata`     | 9996    | Postgres                                                       |
| `tpqueue`    | 9995    | RabbitMQ                                                       |
| `tpcaddy`    | 9993    | control-plane Caddy                                            |
| `tpnginx`    | 9992    | nginx (optional, `web-service-user`)                           |
| `tpapache`   | 9991    | Apache (optional)                                              |
| `tpols`      | 9990    | OpenLiteSpeed (optional)                                       |
| `tplsws`     | 9989    | LiteSpeed Enterprise (reserved)                                |

Tenant principals: **15001–60000** (host-picked from that band, or an operator override inside it; 61184–65519 above it is systemd's throwaway build users).

There are **no per-version runtime groups**. Every PHP, Node and Deno version
installed on a server may be run by every site owner's Linux user: the vendored
trees are root-owned, readable and executable by everyone, never writable, and
the daemon sends no per-version list. Principals are still never added to
`tp`.

**Application logins are unchanged** — `postgres_user`/`postgres_db` =
`turbopanel`, RabbitMQ user = `turbopanel`, Docker network/volumes =
`turbopanel*`.


### Systemd (dev services run as the dev user; production uses dedicated users)

Installed and managed by the daemon via the `instance-launch` Ansible role:

| Unit                          | User (dev)       | User (production) | Notes                                                            |
| ----------------------------- | ---------------- | ----------------- | ---------------------------------------------------------------- |
| `turbopanel-instance.service` | current dev user | `tpctrl:tp`       | Deno instance on the Unix socket                                 |
| `turbopanel-caddy.service`    | current dev user | `tpcaddy:tp`      | TLS + reverse proxy. `:8443` is the only listener; the certificate is chosen by hostname. Let's Encrypt runs in the short-lived `turbopanel-instance-acme` unit. |
| `turbopanel-ui.service`       | current dev user | `tpctrl:tp`       | Expo web dev server (`:8081`, dev only)                          |
| `turbopaneld.service`         | current dev user | `tp:tp`           | runs Ansible; has sudo (production only)                         |

- `systemd/turbopanel-instance.service` was removed — the canonical unit is
  templated by the `instance-launch` role in `../turbopaneld`.
- Logs:
  `journalctl -u turbopanel-instance -u turbopanel-caddy -u turbopanel-ui -f`
- Co-located daemon: `../turbopaneld/scripts/install-daemon-systemd.sh`
- **Production instance hardening** (compiled `tpctrl` unit only; co-located dev
  is unsandboxed because its source checkout lives in `$HOME`). Systemd:
  `ProtectSystem=strict` with a `ReadWritePaths` list, `ProtectHome`,
  `PrivateTmp`/`PrivateDevices`, `ProtectKernel*`, `RestrictAddressFamilies`
  (`AF_UNIX AF_INET AF_INET6 AF_NETLINK`), a deny-list `CapabilityBoundingSet`.
  `NoNewPrivileges` stays **off** while the instance runs `sudo` (host-credential
  `pamtester`, upgrade `systemctl restart`); move those behind the daemon before
  enabling it. Pinned by `../turbopaneld/src/orchestration/instance-unit-sandbox.test.ts`.
  Deno: `--deny-net` carves the cloud-metadata endpoints out of the open
  `--allow-net` (same list as the daemon). `--allow-env` is a list
  (`TURBOPANEL_*`, `HOME`, `PATH`, `LANG`, `CADDY_TLS_CERT`, `SMTP_PORT`) plus a
  bare `--ignore-env`: unlisted names read as unset, and `Deno.env.toObject()` /
  ioredis's `debug` enumeration of `process.env` return just the allowed names
  instead of failing. `src/deno-env-allowlist.test.ts` fails on a source read the
  list misses — extend the list, never go back to a bare `--allow-env`. `SIGTERM` exits
  in about a second (`src/platform/deno/instance-shutdown.ts`): without it the
  idle Postgres pool kept the process until systemd's SIGKILL.

## Unix domain sockets

In Deno mode (development and production), the Hono instance listens on a **Unix
domain socket** instead of a TCP port. Caddy terminates TLS and proxies `/api/*`
and `/ws/*` to that socket.


### Directory layout

All TurboPanel runtime sockets live under **`/run/turbopanel/`** (on Linux,
`/var/run` symlinks to `/run`). In **development** the directory is owned by the
dev user. In **production** it is **`2770 tp:tp`** (setgid) so the
`tpctrl`/`tpcaddy` users (in group `tp`) can bind:

| Socket file                              | Service                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `/run/turbopanel/instance.sock`          | Hono instance (dev: mode `0660`, dev user; prod: mode `0660`, group `tp`) |
| `/run/turbopanel/postgres/.s.PGSQL.5432` | PostgreSQL 18 (Docker bind-mount)                                         |
| `/run/turbopanel/<name>.sock`            | Reserved for future services                                              |

### Environment variables

| Variable                         | Default                                 | Purpose                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TURBOPANEL_SOCKET`              | —                                       | Full socket path override                                                                                                                                                                                                                                                                                                                        |
| `TURBOPANEL_SOCKET_DIR`          | `/run/turbopanel`                       | Directory when using the default filename                                                                                                                                                                                                                                                                                                        |
| `TURBOPANEL_RUN_DIR`             | `/run/turbopanel`                       | Runtime dir holding `instance.sock`; Caddy derives its upstream as `unix/{$TURBOPANEL_RUN_DIR}/instance.sock` (no separate dial variable)                                                                                                                                                                                                       |
| `TURBOPANEL_UI_MODE`             | `static`                                | UI serving mode only: `dev` proxies Caddy to the Expo unit, `static` serves the exported build. Not an application dev-mode signal — the developer surface, ephemeral secrets, and PAM bypass key off `TURBOPANEL_DEV_SURFACE=1` alone                                                                                                          |
| `TURBOPANEL_UI_ROOT`             | `/opt/turbopanel/share/ui`              | Directory of `expo export --platform web` output (local manual dev typically sets `../ui/dist`)                                                                                                                                                                                                                                                  |
| `TURBOPANEL_DEV_SURFACE`         | —                                       | `1` enables the developer surface + dev-only auth relaxations. Written only by the daemon's `turbopanel-instance.service.j2` for co-located Deno source-mode dev with `TURBOPANEL_UI_MODE=dev`; never on managed hosts                                                                                                                         |
| `TURBOPANEL_INSTANCE_SERVICE`    | `turbopanel-instance`                   | systemd unit the developer surface restarts after Upgrade System; set it only for a non-standard unit name                                                                                                                                                                                                                                       |
| `CADDY_PORT`                     | `8443`                                  | The only control-plane HTTPS listener. Every hostname is served here; the certificate is chosen by the name. The dev overlay unit reads this value. The managed Caddyfile binds literal `:8443`. Stored self-hosted hostnames use that listener port and do not follow this variable. Hosted and externally forwarded origins (`TURBOPANEL_BASE_URL`, `x-forwarded-host`, the request origin) keep their HTTPS port, including implicit 443.                                                                                                         |
| `CADDY_TLS_CERT`                 | `./certs/self-signed.crt`               | Leaf path the **development** Caddyfile reads. A managed Caddyfile bakes `platform-ca.*` (and `self-signed.*` linked to it) plus per-hostname files at render time.                                                                                                                                                                           |
| `CADDY_TLS_KEY`                  | `./certs/self-signed.key`               | Leaf key path the **development** Caddyfile reads. The managed template bakes the key path beside `CADDY_TLS_CERT`.                                                                                                                                                                                                                            |
| `TURBOPANEL_TLS_PUBLIC`          | —                                       | When `1` / `true`, `GET /api/daemon/v1/instance/ca` 404s for a hostname that presents a Let's Encrypt or uploaded leaf. An unlisted name on the self-hosted `:8443` listener still receives the bundle, because that request hits the Platform CA catch-all. Set by `instance-launch` when any hostname is `lets-encrypt` or `turbopanel_tls_public` is true. Aggregate compatibility only: it marks an uploaded leaf public when no Let's Encrypt sibling exists and that certificate was not checked on its own. It is not proof for one upload among several. Install `curl -k` follows the dialed hostname. Let's Encrypt uses system trust. An uploaded leaf uses system trust when that certificate chains to a public root. A private upload is refused until its PEM contains the issuer that signed the leaf; the installer stores that issuer separately (`GET /api/daemon/v1/instance/uploaded-trust`) and runtime TLS still verifies the chain and hostname. Bootstrap `-k` is not that trust. A Platform CA hostname, and a covered unlisted name on `:8443`, still need `-k`. An unlisted public name the catch-all leaf does not cover is refused before an install command is emitted. Hosted Workers already 404 without `TURBOPANEL_TLS_CA_PEM_B64`. |
| `TURBOPANEL_TLS_CA`              | `/var/lib/turbopanel/tls/ca.crt`        | Durable **Platform CA** (override; default is `${TURBOPANEL_STATE_DIR}/tls/ca.crt`)                                                                                                                                                                                                                                                              |
| `TURBOPANEL_TLS_CA_KEY`          | `/var/lib/turbopanel/tls/ca.key`        | Durable **Platform CA** private key                                                                                                                                                                                                                                                                                                              |
| `TURBOPANEL_TLS_CA_BUNDLE`       | `/var/lib/turbopanel/tls/ca-bundle.pem` | Current+retired **Platform CA** PEM bundle served at `GET /api/daemon/v1/instance/ca`                                                                                                                                                                                                                                                            |
| `TURBOPANEL_TLS_EXTRA_SANS`      | —                                       | Comma-separated DNS names for the server cert (e.g. `turbopanel.lan`)                                                                                                                                                                                                                                                                            |
| `TURBOPANEL_TRUSTED_PROXY_CIDRS` | `127.0.0.0/8,::1/128`                   | Peer addresses whose `CF-Connecting-IP` / `X-Forwarded-For` the instance believes. Set it when a Cloudflare Tunnel connector or other reverse proxy runs on a **different host** than the instance. **Replaces** the loopback default — include loopback explicitly if Caddy is still co-located. See **Caddy (production) → Server addresses**. |
| `TURBOPANEL_PUBLIC_URLS`         | —                                       | Flat projection of the `platform-ca` hostnames (e.g. `https://panel.example.com:8443,huey.lan:8443`). The admin API persists hostname rows on `origin`; this `setting` key stays in sync so cert SAN generation and webhook reachability keep calling `getPublicUrls` / `setPublicUrls`. **Admin → Access → Hostnames** is the editor. |
| `TURBOPANEL_INSTANCE_ACME__CONTACT_EMAIL` | unset                            | Contact email for this control plane's Let's Encrypt account. Env wins over **Admin → Access → Certificates** and is read-only there. Independent of every organization's Let's Encrypt opt-in. |
| `TURBOPANEL_INSTANCE_ACME__TOS_ACCEPTED` | `false`                            | Terms acceptance for that account. Same env-wins rule. The server's answer is `tosAccepted` on `GET /instance/hostnames` and `GET/PUT /instance/acme`; every admin route (including apply) resolves env through `resolvePlatformEnv(c, …)`. While it is false, `PUT /instance/hostnames` refuses a `lets-encrypt` row and apply refuses, both 422 with `code: "acme_terms_not_accepted"` beside the sentence. |
| `TURBOPANEL_INSTANCE_ACME__DIRECTORY_URL` | Let's Encrypt production directory | ACME directory URL. Same env-wins rule. |
| `TURBOPANEL_INSTANCE_ACME__USE_STAGING` | `false`                             | `true` selects the Let's Encrypt staging directory. Same env-wins rule. |

Path resolution lives in `src/platform/deno/server-paths.ts`. It ships **FHS defaults** —
config `/etc/turbopanel`, state `/var/lib/turbopanel`, logs
`/var/log/turbopanel`, runtime `/run/turbopanel`, static UI
`/opt/turbopanel/share/ui` — and every path is env-overridable
(`TURBOPANEL_CONFIG_DIR`, `TURBOPANEL_STATE_DIR`, `TURBOPANEL_LOG_DIR`,
`TURBOPANEL_RUN_DIR`, `TURBOPANEL_UI_ROOT`, `TURBOPANEL_SOCKET(_DIR)`,
`TURBOPANEL_TLS_CA`, `TURBOPANEL_TLS_CA_KEY`, `TURBOPANEL_TLS_CA_BUNDLE`).
Co-located dev uses the same FHS mutable paths by default, all
**dev-user-owned**; source repos live under `$HOME` (`~/turbopaneld`,
`~/turbopanel`, `~/ui`, `~/website`). The module has no separate dev-mode branch
— Ansible (`instance-launch`) and manual commands may override individual paths
via env when needed. `resolveInstanceRuntimeConfigPaths` composes
`<configDir>/instance/runtime.env` (+ `runtime.dev-vars`). Managed production
installs also run the daemon as **`turbopaneld.service`** — native
`/opt/turbopanel/bin/turbopaneld`, or `turbopaneld.js` via vendored Deno on
hosts where that binary cannot load (see `../turbopaneld/src/paths/AGENTS.md` → Filesystem
layout & path model). Defaults and overrides are pinned by
`src/platform/deno/server-paths.deno.test.ts` (`deno task test:paths`).


### Caddy dial format

Caddy's Unix-socket upstream is `unix/` followed by the **absolute** socket
path, so the default renders as:

```caddyfile
reverse_proxy unix//run/turbopanel/instance.sock
```

The managed-install template (turbopaneld
`roles/instance-launch/templates/Caddyfile.j2`) renders it from
`turbopanel_run_dir`; the dev overlay spells it
`unix/{$TURBOPANEL_RUN_DIR:/run/turbopanel}/instance.sock` — both derived from
the same run-dir + filename contract as `resolveInstanceSocket` in
`src/platform/deno/server-paths.ts` (`caddyInstanceUpstream` mirrors it). The only socket
path inputs are `TURBOPANEL_RUN_DIR`, `TURBOPANEL_SOCKET_DIR`, and
`TURBOPANEL_SOCKET`; there is no operator-set dial variable. Caddy reads only
the run dir (the managed units set `TURBOPANEL_RUN_DIR` and the role renders
the same value) — `TURBOPANEL_SOCKET_DIR` and `TURBOPANEL_SOCKET` are honored
on the instance side, so relocating the socket for Caddy means setting
`TURBOPANEL_RUN_DIR`.

### Development

The daemon's `runtime-sockets` role (and `scripts/ensure-socket-dir.mjs` for
manual runs) ensures `/run/turbopanel` exists and is owned by the dev user in
development (**`2770 tp:tp`** in production), using passwordless `sudo` when
needed. After bind, the instance hardens the socket file to `0660` (owner+group
only) so the daemon can connect.

The instance Deno process runs with scoped permissions (see the
`instance-launch` unit template):
`--allow-env --allow-sys=networkInterfaces --allow-read=/run/turbopanel,<daemon dir>,<instance dir> --allow-write=/run/turbopanel --allow-run=git,systemctl,tar`
(`tar` is needed for the dev-sync tarball). TCP listeners and Unix-domain
connects (Postgres `.s.PGSQL.5432`, Redis `redis.sock`, instance listen sock) go
on `--allow-net` — Deno 2.9+ treats Unix-socket connect as net, not read — but a
`node:net` connect (postgres.js) additionally needs `--allow-read` **and**
`--allow-write` on the socket path, so `/var/run/turbopanel` sits on both lists
in the compile tasks and the unit (`postgres_socket_dir`); without it the
compiled binary's first `migrate` on a clean host fails `NotCapable`. **Outbound
network is unrestricted on self-hosted (decided 2026-09-18):** the `compile` /
`compile:dev` tasks and both source-mode `ExecStart` lines carry a bare
`--allow-net` with no host list, because a self-hosted control plane reaches
whatever its operator configures — alert webhooks, chat integrations, push
relays, a GitHub Enterprise or self-managed GitLab origin — and a list baked at
compile time made every one of those a `PermissionDenied` at runtime. The host
firewall is the egress boundary — and TurboPanel's own: the daemon installer
removes ufw/firewalld/iptables-persistent on every host (decided 2026-09-20),
and the managed ruleset (inbound derived from what the panel deploys, outbound
left open) lands through the first 0.1.x pushes; neither reverses this.
`src/deno-compile-permissions.test.ts` refuses a
reintroduced `--allow-net=<hosts>` list. The bare flag must stay: without it the
Unix-socket connects above are refused.

### Production

The daemon's orchestration bootstrap runs the `socket-dirs-setup` Ansible
playbook, which installs `/etc/tmpfiles.d/turbopanel.conf` and applies it with
`systemd-tmpfiles --create`. The directory is recreated on boot automatically.
