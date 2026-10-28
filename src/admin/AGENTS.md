# Admin Surface (`src/admin/`)

- `src/admin/routes.ts` — admin surface (`/api/admin/v1`); **now mounted** on
  both runtimes; gated to `superadmin` or `admin` via
  `createAdminAccessMiddleware`; dev-only OpenAPI/Scalar;
  `GET/PUT /instance/public-urls` persists the flat public-URL projection;
  `GET/PUT /instance/hostnames`, `GET/POST /instance/certificates`,
  `PATCH /instance/certificates/:id/hostnames`, and `GET/PUT /instance/acme`
  manage per-name certificate source and instance ACME settings (independent
  of any organization's ACME opt-in); the reads stay admin-gated but the
  writes (PUT hostnames, POST certificates, PATCH certificate hostnames, PUT
  acme) sit behind `createRootOnlyMiddleware` like public URLs and apply; `GET /instance/daemon` reports the
  co-located daemon's `resolveDaemonCapabilities` snapshot (`{ applicable: false }`
  on Workers, and it must not wake a cell); `GET /instance/updates` reports the
  installed control-plane version (`INSTANCE_VERSION` plus `resolveInstanceRevision`)
  and the co-located daemon's `daemonBuild` beside each channel manifest target;
  `POST /instance/updates/instance` enqueues `instance-update` (202, Deno only —
  Workers 422, a channel other than canary/rc/release 422, no connected daemon
  503) and `POST /instance/updates/daemon` enqueues the existing `update` cell
  message for the co-located host (the per-server update route refuses that
  host); `GET /instance/platform-ca` and
  `POST /instance/platform-ca/trust-reconcile` are Deno-only Platform CA read
  and the existing `server.tls.trust.reconcile` fan-out; `GET /instance/trusted-proxies`
  is the read-only effective `TURBOPANEL_TRUSTED_PROXY_CIDRS` list; `POST /instance/tunnel-token`
  shares `dispatchInstanceTunnelToken` with the developer route (write-only;
  empty token tears the tunnel down); `GET/PUT /settings/signup` toggles public sign-up via
  `IS_SIGNUP_ENABLED`; `GET/PUT /settings/email` and
  `GET/PUT /settings/auth-providers` (GitHub/Google OAuth client id/secret;
  env-wins `TURBOPANEL_AUTH_PROVIDERS__*`) persist system email and OAuth
  credentials; superadmin `POST /secrets/reencrypt` runs a bounded
  at-rest re-encrypt sweep onto the current data-encryption key version
  (`src/admin/reencrypt-secrets.ts` — resume via `cursor` until `completed`;
  durable `REENCRYPT_SWEEP_LOCK` setting lease across isolates; **409**
  `reencrypt_in_progress` when another sweep holds the lease).
