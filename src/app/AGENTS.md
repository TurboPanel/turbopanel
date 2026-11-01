# App, Surfaces and Versions (`src/app/`)

- **Versions on the wires** (`src/app/version.ts`, `src/lib/version-wire.ts`) —
  `INSTANCE_VERSION` is a JSON import of `deno.json`'s `version`, the one place
  the number is read (`package.json` and `sonar.projectVersion` mirror it;
  `src/app/version.test.ts` pins all three). Change it only with
  `node scripts/set-version.mjs X.Y.Z`, which rewrites all three; it is kept
  equal to the version the tags give (see **Automatic promotion** in `.github/AGENTS.md`), so a
  local build reports the version being worked on. It feeds the three OpenAPI
  `info.version`s, `/api/health`, and the `x-turbopanel-version` response header
  `createApp()` stamps on every response; a client that is not the bundled web
  export sends `x-turbopanel-client-version`, which the instance reads and does
  not enforce. Daemons report `daemonBuild.version` (turbopaneld
  `src/app/version.ts`); `resolveDaemonSupport` holds it against
  `MIN_SUPPORTED_DAEMON_VERSION`. An **unsupported** daemon keeps its
  connection (that is the update path) but the command consumer fails its
  commands with `daemon_unsupported`; a build reporting no version is
  **unknown** and passes — flag, not refusal, until the fleet is re-enrolled
  on tagged builds. The other direction lives on the daemon
  (`../turbopaneld/src/instance/version-wire.ts`): every daemon REST response
  (including non-OK and the 401 before a refresh) and the cell attach
  `{ type: "version", instanceVersion }` frame (`src/daemon/attach-version.ts`,
  sent from `deno-ws.ts` and the Durable Object upgrade) feed
  `MIN_SUPPORTED_INSTANCE_VERSION`. A response or frame that omits the version
  clears the daemon's last observation back to `unknown`. An unsupported
  control plane is flagged with the greppable `instance-version:` log and the
  daemon keeps reconnecting; `unknown` (no header and no field — an older
  instance) passes silently. Each floor tolerates every peer semver at or
  above the constant. Today both floors are **`0.1.0`** against package
  **`0.1.9`**, so a `0.1.x` peer is in window and a `0.0.x` peer is not. The
  window is allowed to trail the current release by several minor versions;
  it is not a same-version lock and it does not impose an upgrade order.
  Bump `MIN_SUPPORTED_DAEMON_VERSION` and `MIN_SUPPORTED_INSTANCE_VERSION`
  together, in the same change, and record why in this note and in
  `../turbopaneld/src/instance/AGENTS.md`. Never raise either floor silently.
  Dispatching `instance-update` does not gate on the daemon version (the
  daemon only runs the reconcile). The downgrade guard lives on the daemon:
  it refuses a target below its own `MIN_SUPPORTED_INSTANCE_VERSION`.
  `DAEMON_FEATURE_MIN_VERSIONS` (same map in both `version-wire.ts` files) is
  the peer-version feature gate, distinct from the metrics capability plan.
  A panel-visible admin feature that depends on a daemon-rendered artifact
  adds an entry here; the UI phase calls `resolveDaemonCapabilities` and does
  not re-implement semver comparison. An unknown peer version is **not**
  supported for a feature (the opposite default from the floor's `unknown`).
  The first entry is `instance-cert-sources-per-hostname` at daemon **`0.1.1`**,
  the release that renders per-hostname certificate sources in
  `turbopaneld/orchestration/roles/instance-launch/templates/Caddyfile.j2`.
  A release that introduces a new wire message leaves
  `MIN_SUPPORTED_DAEMON_VERSION` and `MIN_SUPPORTED_INSTANCE_VERSION` where
  they are. Each new message is feature-gated: the peer advertises support
  in `features[]` (`DAEMON_WIRE_FEATURES`, kept equal in both
  `version-wire.ts` files) and the daemon checks `instanceSupports()` before
  treating the peer as able to speak it. `php-site-modes-v1` gates a deploy
  field rather than a message: the daemon runs each PHP site in its `php.mode`
  (FastCGI or php-fpm, nginx and Apache). Deploy prepare refuses a mode other
  than php-fpm for a daemon that does not list it (`php_mode_unavailable`,
  reason `daemon_unsupported`) and stamps no mode on its sites. A deployment
  record without `phpModes` means the modes are unknown, not php-fpm.
  OpenLiteSpeed and Caddy sites ignore `php.mode` in the daemon for now (the
  OpenLiteSpeed lsphp work is turbopaneld#250). `update-progress`
  (`update-progress-v1`) is the worked example — fire-and-forget progress,
  ignored by a peer that does not list the feature. `managed-health-v1` is
  the worked example in the other direction, a control-plane-initiated
  correlated request (`managed-health-request` / `managed-health-result`): the
  control plane reads the daemon's stored `hello.features` and sends the
  request only to a daemon that lists it, otherwise it keeps the stored
  observation (`src/client/managed/health-probe.ts`).
  Both wires are expand-only by convention.

## Caddy (production)

The production Caddyfile is **not in this repo**: the daemon's
`instance-launch` role renders it on every converge from
`turbopaneld/orchestration/roles/instance-launch/templates/Caddyfile.j2` (one
template, the three TLS modes are its branches) into
`/etc/turbopanel/caddy/Caddyfile`. Full detail in [`caddy.md`](../../caddy.md)
(server addresses, certs/entrypoint, daemon TLS trust model, static UI). The
one rule that must not be missed:

**The catch-all is why the prefix list is load-bearing.** Caddy answers
`try_files {path} /index.html`, so a prefix the instance owns but Caddy does not
match is served the SPA shell with **HTTP 200** rather than a 404. For a Git
webhook that means the provider records a successful delivery and never retries
— silent, unrecoverable loss. The same trap exists on Workers
(`not_found_handling: "single-page-application"`); add the prefix to `routes` in
`wrangler.jsonc` at the same time. `src/app/surfaces.test.ts` pins the strings.

## API / WS surfaces (versioned)

Four versioned surfaces each have REST + WS namespaces (where applicable).
Prefixes live in `src/app/surfaces.ts`; `GET /api/health` is the single
deliberately-unversioned probe
(`{ ok, license: 'AGPL-3.0-only', revision:
{ commit, sourceUrl } }` —
`TURBOPANEL_REVISION` from systemd / `wrangler
deploy --var`, else `unknown`).
`/webhook/*` is a separate top-level traffic class rather than a versioned API —
see the last row.

| Surface                      | REST                              | WS                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client (end-user UI)         | `/api/client/v1/*`                | `/ws/client/v1`           | servers list/detail (+ ips/timeSync/docker/effective timezone, labels, effective sshPort/ntpDefaults), timezone/NTP commands, server labels (`GET`/`PUT /servers/:id/labels`), org record (`GET`/`PATCH /organizations/:id`), org default-timezone + temperature-unit + host-defaults + default-environment + project-settings + server-capacity + managed-defaults + TurboFabric (`GET`/`PUT`/`DELETE /organizations/:id/fabric`, `PATCH /organizations/:id/fabric/relays/:serverId`, `PATCH /organizations/:id/fabric/servers/:serverId`, `POST /organizations/:id/fabric/apply`) + `/timezones` |
| Install (self-hosted wizard) | `/api/install/v1/*`               | —                         | Deno only for POST endpoints; PAM-gated; no session/cookie on bootstrap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Developer (dev console)      | `/api/developer/v1/*`             | `/ws/developer/v1` (stub) | fleet, diagnostics, shell, addresses, `system/upgrade`, `instance/tunnel-token`, `daemon/(:id/)sync-dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Admin                        | `/api/admin/v1/*`                 | —                         | Mounted on both Deno and Workers; `superadmin` or `admin` role required; OpenAPI/Scalar at `/api/admin/v1/openapi.json` + `/reference` in development only                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Daemon                       | `/api/daemon/v1/*`                | `/ws/daemon/v1`           | `version`, `instance/ca`, `instance/uploaded-trust`; daemons connect on the WS path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Git webhooks                 | `/webhook/{github,gitlab}(/:ref)` | —                         | **Not an API.** The caller is GitHub or GitLab: no session, no daemon JWT, no `Origin`, and what arrives is an event rather than a call. Unversioned and outside every protected prefix by design. Self-hosted providers get the `:ref` suffix; hosted ones get the clean path. Every fronting layer must forward it — see `src/webhook/AGENTS.md`                                                                                                                                                                                                                                                 |

### Gates on mutating requests (client / admin / install / developer)

`createApp` (`src/app/app.ts`) runs three gates, in this order, on `POST` /
`PUT` / `PATCH` / `DELETE` under the four cookie-authenticated prefixes. `GET`,
`HEAD` and `OPTIONS` are never gated. `/api/daemon/v1`, `/ws/*`, `/webhook/*`,
`/api/health` and docs/static routes are outside all three (they have their own
bounded readers and limiters).

1. **CSRF** (`app/browser-write-protection.ts`). Exact-origin match on `Origin`,
   else `Referer`; neither present = non-browser client, allowed. `Sec-Fetch-Site`
   only tightens: `cross-site` is always `403`, and with no `Origin`/`Referer` a
   present value other than `same-origin` / `none` (so `same-site`) is `403`.
   `same-site` is **not** a pass on its own: customer sites can live on sibling
   subdomains of the panel host. A missing `Sec-Fetch-Site` stays allowed — the
   native apps, CLI, installer curl and Local-Console HMAC calls send none. Do
   not add a required custom header: store apps in the field would lock out.
2. **Body limit** (`app/body-limit.ts`). 1 MiB default, 4 MiB for compose-bearing
   routes (projects, environments, deploy, docker-run import); `413`
   `{ ok: false, error, code: 'request_body_too_large' }` before any handler
   parses the body, with or without `Content-Length`. Smaller per-route bounds
   (auth, 2-8 KiB) still apply inside handlers. Add a route to
   `CLIENT_LARGE_BODY_PATTERNS` only with a reason.
3. **Write rate limit** (`app/write-rate-limit.ts`). 120 writes / 60 s per
   verified session cookie (digest, no DB read), else per client IP; `429`
   `{ code: 'rate_limited' }` + `Retry-After: 60`. Backend is the `RateLimiter`
   seam: Workers binding `CLIENT_WRITE_RATE_LIMITER` (namespace ids 1010 / 2010 /
   3010 / 4010), Deno Redis (`TURBOPANEL_CLIENT_WRITE_RATE_LIMIT` /
   `_PERIOD`). It **fails open**: no binding, no limiter injected, an unresolvable
   IP, or a limiter error all let the write through (one warning per process).
   Unlike `authRateLimiter` it must never become an outage. Forged cookies are
   anonymous and keyed by IP.

- Route modules: `src/daemon/api-routes.ts`, `src/client/routes.ts`,
  `src/install/routes.ts` (registered from `deno.ts` only); Deno-only routes
  `src/developer/system-routes.ts`, `src/developer/dev-sync.ts`,
  `src/developer/tunnel-routes.ts`, and the version route are registered in
  `src/deno-dev.ts`. `src/admin/routes.ts` is mounted on both Deno and Workers
  (admin/superadmin session required). Self-hosted-only admin routes live under
  `src/platform/deno/ingress/` and are mounted through
  `registerAdminRoutes({ registerPlatformAdminRoutes })` from
  `src/platform/deno/server.ts` only; `check:import-boundaries` refuses any other
  importer, and `src/admin/platform-admin-routes.hostfree.test.ts` plus
  `src/workers.entry.test.ts` prove the Workers router has none of them.
  Workers-safe developer REST lives in
  `src/developer/routes-core.ts` (`workers.ts`); full Deno developer surface in
  `src/developer/routes.ts`. Client bindings (`src/client/bindings/`) expose
  `GET|POST|PATCH|DELETE /api/client/v1/bindings` — managed DB principal →
  compose service materialization of binding-owned `variable` rows (no new
  command type). List filters are mutually exclusive: `serviceId`, consumer
  `environmentId`, or managed-cluster `managedEnvironmentId`. Create returns
  `{ ok, id }`; patch returns `{ ok }`.
- The TurboPanel Development Environment calls developer routes via
  [`dev/src/lib/developer-client.ts`](../../../dev/src/lib/developer-client.ts)
  (Unix socket + HTTPS fallback).
- Hard cutover: daemon, UI, Caddy (`/ws/*`), and Workers routes
  (`wrangler.jsonc`) moved together. The external CDN node installer must fetch
  the CA from the new `/api/daemon/v1/instance/ca` path.

Per-feature client-surface behavior notes (timezone/NTP, host defaults, labels,
TurboFabric, compiled compose, org options, containers, datacenters / subnets /
addresses, …) moved to `src/client/AGENTS.md` → **Client surface feature
notes**.
