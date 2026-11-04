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
  and the co-located daemon's `daemonBuild` beside each channel manifest target,
  plus `development` (true only on a Deno development install, from
  `isExplicitDevelopmentMode()`; always false on Workers).
  `POST /instance/updates/now` is Update Now (superadmin through `rootOnly`,
  audited as `upgrade.start_now`, no step-up, like Pause / Resume): it runs
  the hourly check at once and starts the update through the coordinator
  (202 `{ ok, runId }`, 200 `{ ok, upToDate }`, 409 `run_active` / `paused` /
  `update_blocked`, 429 `check_too_soon` (once a minute), 503
  `release_unreachable`, 403 `development` on a development install; contract in
  `src/features/upgrades/AGENTS.md`). The old manual
  `POST /instance/updates/instance`, `/daemon` and the other start, retry and
  cancel routes stay retired and answer 410 `updates_automatic`. Development installs only:
  `GET /instance/updates/development` and
  `POST /instance/updates/development/push` (`{ force?: boolean }`, 202 with the
  job, 409 `job_running` while one is active), superadmin, audited as
  `upgrade.dev_push`, no step-up. They are Build and Push Daemon: rebuild the
  daemon overlay from the local checkout when it changed (or on `force`), then
  send `update` to every connected remote server in parallel. They live in
  `src/developer/development-updates-routes.ts` and are mounted only through
  `startDenoServer`'s `registerDevelopmentAdminRoutes` hook from
  `src/deno-dev.ts` while the developer surface is on, so they are absent (404)
  elsewhere and stay out of the admin spec; this file must never import
  `src/developer/*`. GET answers `{ ok, daemonBuild: { built: { commit,
  buildId, builtAt, source } | null, sourceFingerprint, sourceChanged },
  servers: [{ id, name, connected, daemonVersion, daemonCommit, onLatestBuild
  }], job: null | { id, state: building | pushing | done | failed, startedAt,
  endedAt, message, servers: [{ id, name, ok, skipped, error }] },
  pendingDaemonChanges, host }` (remote servers only; the job lives in memory and a
  restart forgets it). `host` is the co-located daemon's development host
  status (`dev-host-status`, feature `dev-host-v1`, kept in memory by
  `src/developer/dev-host-status.ts`) with the control plane part's
  `runningCommit` (this process's commit, captured at boot) and a top-level
  `migrate: { pending } | null` (`compareSchemaState` against the manifest on
  disk, cached 30 s) filled in by `src/developer/dev-host-view.ts`; null while
  that daemon is offline or never sent one.
  `POST /instance/updates/development/host/update` (Update and Restart) and
  `.../host/restart` (Restart Only), same gates, audited as
  `upgrade.dev_host_update` / `upgrade.dev_host_restart`, send
  `dev-host-action` to the co-located daemon and wait up to 8 s: 202
  `{ ok, job: { id, action } }`, 409 `job_running` (a host job or a Build and Push
  job is running; the push refuses the same way while a host job runs), 503
  `daemon_unavailable` (offline, no `dev-host-v1`, timeout, or the daemon
  refused, with `reason`). They live in `src/developer/dev-host-routes.ts`,
  which also mounts `GET /api/developer/v1/dev-host/status` and the two
  actions for the Developer Console behind the developer access middleware; `GET /instance/identity` is the Panel Identity read (public fingerprints of the control
  plane's current, next and sealing keys, the install address, and each server's pinned-by state,
  `none` until the server pin column exists); `PUT /instance/identity/next` sets or clears the next
  fingerprint (superadmin, self-hosted only, always behind `requireInstanceStepUp`, audited as
  `panel.identity_next.set|clear`, mails superadmins through `recordKeyEvent`);
  `GET /instance/identity/sealed-secrets` (superadmin) reports per server whether secrets still
  reach it in plaintext (feature, sealing key id, `plaintext_secrets_at`); the self-hosted
  tunnel-token write sits behind the same step-up and is audited as `instance.tunnel_token.set`;
  `GET /instance/platform-ca` and
  `POST /instance/platform-ca/trust-reconcile` are Deno-only Platform CA read
  and the existing `server.tls.trust.reconcile` fan-out; `GET /instance/trusted-proxies`
  is the read-only effective `TURBOPANEL_TRUSTED_PROXY_CIDRS` list; `POST /instance/tunnel-token`
  is self-hosted only (mounted from `src/platform/deno/ingress/` through the
  `registerPlatformAdminRoutes` hook, absent on Workers) and shares
  `handleTunnelTokenRequest` (`src/developer/tunnel-token-handler.ts`) with the developer route (write-only; empty
  token tears the tunnel down); `GET/PUT /settings/signup` toggles public sign-up via
  `IS_SIGNUP_ENABLED`; `GET/PUT /settings/email` and
  `GET/PUT /settings/auth-providers` (GitHub/Google OAuth client id/secret;
  env-wins `TURBOPANEL_AUTH_PROVIDERS__*`) persist system email and OAuth
  credentials; superadmin `POST /secrets/reencrypt` runs a bounded
  at-rest re-encrypt sweep onto the current data-encryption key version
  (`src/admin/reencrypt-secrets.ts` — resume via `cursor` until `completed`;
  durable `REENCRYPT_SWEEP_LOCK` setting lease across isolates; **409**
  `reencrypt_in_progress` when another sweep holds the lease).
