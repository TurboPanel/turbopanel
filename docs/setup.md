# Setup, Environment and Check Commands

## Setup

- **Deno** — <https://docs.deno.com/runtime/getting_started/installation/>
- **pnpm** — <https://pnpm.io/installation>
- **Node.js** and **openssl** — required for cert generation (`scripts/*.mjs`);
  Node.js also used for Caddy download
- Run `./console` from the
  [TurboPanel Development Environment](https://github.com/TurboPanel/dev)
  checkout. The console installs Deno, clones the daemon, and drives the full
  dev stack via `scripts/bootstrap-orchestration.ts` +
  `scripts/install-daemon-systemd.sh` (shared orchestration under
  `/opt/turbopanel/vendor/` — not `orchestration/runtime/venv`).
- Managed/co-located installs: secret-bearing runtime env lives in the instance
  config dir (`runtime.env`, `runtime.dev-vars`) — **never** in the git checkout
  root. Beside those env files, Ansible holds `.instance_secrets` (versioned
  keyring, `root:<turbopanel_group>` `0640`, ordered `<version>:<value>`, first
  entry current); it is injected into `runtime.dev-vars` as `TURBOPANEL_SECRETS`
  (the optional rotation keyring; `TURBOPANEL_SECRET` is the normal single
  secret), and rotation is gated by the `turbopanel_instance_secret_rotate`
  extra-var. Semantics: `src/client/authn/AGENTS.md`. Standalone scripts
  (`scripts/generate-self-signed-cert.mjs`, `scripts/workers-serve.sh`,
  `scripts/drizzle-studio-serve.sh`) default to the FHS location
  **`/etc/turbopanel/instance/runtime.env`** when
  `TURBOPANEL_INSTANCE_RUNTIME_ENV` is unset. Both managed and co-located dev
  use **`/etc/turbopanel/instance/`** (dev-user-owned in development). The unit
  injects `TURBOPANEL_INSTANCE_RUNTIME_ENV` accordingly.
  `scripts/generate-self-signed-cert.mjs` and daemon `public-urls-apply`
  read/write `runtime.env` there. Never generate copies of checkout-root `.env` /
  `.dev.vars`; the script symlinks them.
- `pnpm install` — installs Hono and Wrangler into `node_modules/` for Workers
  bundling
- Local Wrangler secrets come from Ansible-generated
  `/etc/turbopanel/instance/runtime.dev-vars` (`TURBOPANEL_SECRETS`), symlinked
  into the checkout as `.dev.vars` by `scripts/workers-serve.sh`; that path is
  separate from managed Ansible installs above. Hosted OAuth sign-in is
  env-only: bind
  `TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_ID` /
  `TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_SECRET` /
  `TURBOPANEL_AUTH_PROVIDERS__GOOGLE_CLIENT_ID` /
  `TURBOPANEL_AUTH_PROVIDERS__GOOGLE_CLIENT_SECRET` as Wrangler secrets
  (`wrangler secret put`). Env always wins over the `SYSTEM_AUTH_PROVIDERS`
  `setting` row (same env-wins story as `TURBOPANEL_SYSTEM_EMAIL__*`);
  superadmin `GET`/`PUT /api/admin/v1/settings/auth-providers` is mounted on
  both runtimes, but hosted typically leaves the DB row empty.
- `pnpm dev` (wrangler) still runs the **Cloudflare Workers** path for
  full-stack testing — unchanged. **`wrangler.jsonc` `dev.ip` is `0.0.0.0`** so
  Docker Caddy (`host.docker.internal`) can reach the dev server; default
  localhost-only bind causes Caddy **502**s.

- **`pnpm notices:generate` / `notices:check`** — `THIRD_PARTY_NOTICES.md` from
  `pnpm-lock.yaml` plus the JSR/npm graph in `deno.lock`. Wired into `test:hook`
  and CI `build.yml`.
- **`pnpm check:workers-bundle`** — `wrangler deploy --dry-run` of
  `src/workers.ts` (no upload). Catches unresolved imports the Workers bundler
  cannot resolve (e.g. `@std/*` / `jsr:`). Wired into `.githooks/pre-commit`.
  **`pnpm test:do` is not enough** — vitest bundles `src/workers-vitest.ts` with
  a narrow include list and can tree-shake away modules only the full deploy
  graph pulls in.
- **`pnpm check:ca-boundary`** — Organization CA sources (`src/lib/tls/`,
  `src/client/tls/`, `src/features/tls/`) must not reference Platform CA paths. See
  `src/lib/tls/AGENTS.md`. Wired into `test:hook` and CI `build.yml`.
- **`pnpm check:instance-acme-boundary`** — instance ACME
  (`src/features/install/instance-acme-settings.ts`, `instance-hostnames.ts`,
  `instance-certificates.ts`) must not reference an organization's ACME opt-in,
  and organization code must not reference instance ACME settings or the
  `origin` / `certificate` tables. Wired into `test:hook` and CI `build.yml`
  immediately after `check:ca-boundary`. See **Instance hostnames and instance
  ACME** in `src/features/install/AGENTS.md`.
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts`. Keep the
  `Cloudflare.Env` / global `Env` aliases that extend `CloudflareBindings`
  (vitest `cloudflare:test` `env` is typed as `Cloudflare.Env`, not the retired
  `ProvidedEnv`).
- The Ansible `instance-certs` / `caddy` / `node-runtime` roles supersede the
  standalone `pnpm cert:generate` / `pnpm caddy:install` scripts for managed
  hosts (the scripts remain for manual use).
