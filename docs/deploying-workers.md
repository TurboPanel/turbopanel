# Deploying to Cloudflare Workers

- **`pnpm deploy`** — applies pending migrations (`TURBOPANEL_DATABASE_URL` or
  `DATABASE_URL` required for tooling) then deploys to Cloudflare Workers
  (`CLOUDFLARE_ENV` required, e.g. `live` or `testing`). Works from any
  environment with internet access to the database — self-hosted dev, CI, or
  production. Requires **Node** only (`pnpm migrate` runs `drizzle-kit migrate`;
  no Deno prerequisite). `scripts/deploy-workers.mjs` runs `pnpm migrate`
  then `wrangler deploy --env $CLOUDFLARE_ENV --minify --var
  TURBOPANEL_REVISION:<sha>`; the SHA is Workers Builds' `WORKERS_CI_COMMIT_SHA`,
  else `git rev-parse HEAD`, and a deploy that cannot name a 40-hex commit is
  refused (so `/api/health` never reports `revision: unknown`). A failed
  migrate stops before wrangler runs.
  `scripts/migrate-locked.mjs` takes a database backup first when anything is
  pending (`scripts/migrate-backup.mjs`):
  - `TURBOPANEL_MIGRATE_BACKUP_COMMAND` is a shell command that reads
    `TURBOPANEL_DATABASE_URL` from its environment. It runs under the migration
    lock; a non-zero exit, a spawn error or a timeout refuses the migration.
    `TURBOPANEL_MIGRATE_BACKUP_TIMEOUT_SECONDS` (default 900) bounds it; the
    command is killed on timeout and the lock is released.
  - The command should write to a temporary file and rename it when done, so a
    half dump never looks finished. Example:
    `sh -c 'pg_dump -Fc "$TURBOPANEL_DATABASE_URL" -f /backups/panel.part && mv /backups/panel.part /backups/panel-$(date -u +%Y%m%dT%H%M%SZ).dump'`.
  - Set it as a build variable in the Workers Builds dashboard (or the shell
    that runs `pnpm migrate`); `wrangler.jsonc` vars are not read for it. The
    build image may not ship `pg_dump`, so the command must fetch or run it
    (for example over SSH on the database host). The method is the owner's
    choice (see the local report "Panel database backup and restore plan").
  - Without a command, every environment (live, production, testing, a typo,
    anything) prints one clear warning and the migration goes on. The warning
    says that no backup command ran, that the database provider's managed
    backups (point-in-time rollback within a window) are relied on, and to check
    that the restore window covers the moment before this migration. Production
    sets no command. `TURBOPANEL_MIGRATE_BACKUP_ACK=1` is still accepted but
    only changes the wording of the warning.
  - The command's output is printed with the database URL, its password and the
    values (8+ characters) of env vars named like TOKEN, SECRET, KEY or PASSWORD
    blanked. That is a best effort: a secret fetched from elsewhere or printed
    re-encoded is not caught, so the command should print no secrets.
- **Database role grants (owner-run, not a migration).** The hosted panel
  connects as a runtime role (and a cached read role) that the migrate role
  does not create. Their grants live in
  `scripts/ops/grant-database-roles.mjs`, never in `migrations/`. After any
  schema drop-and-recreate, and again after the migration for the cached role,
  the owner runs it as the migrate role (the table owner):
  `TURBOPANEL_DATABASE_URL=<migrate url> TURBOPANEL_RUNTIME_DB_ROLE=<role>
  TURBOPANEL_CACHED_DB_ROLE=<role> node scripts/ops/grant-database-roles.mjs --confirm`
  (`--check-only` just reports; no flag refuses). It sets the schema grants and
  default privileges so new tables inherit them, grants the cached role SELECT
  on `CACHED_READ_TABLES` only (add a table there when a cached read model
  gains one), is safe to repeat, and exits non-zero naming any missing grant.
  If a runtime role lacks grants, `/api/daemon/v1/readiness` and
  `/api/client/v1/status` answer 503 `database roles lack grants` (the role and
  object go to the server log only), instead of a bare "database unavailable". Agents
  never run it against live, staging or testing.
- **STAGING and LIVE use the same Workers Builds setup**, one Worker per
  environment: `staging-instance` (branch `staging`, deploy command
  `pnpm run deploy:staging`) and `instance` (branch `live`, deploy command
  `pnpm run deploy:live`). Each needs its own build variables
  (`TURBOPANEL_DATABASE_URL`, `TURBOPANEL_DEPLOY_CHECK_API_TOKEN`) pointing at
  that environment's own database and Hyperdrive; a database URL that is not
  the env's Hyperdrive origin is refused before anything migrates (`pnpm run
  migrate` calls `check-deploy-env.mjs` for every env). By hand,
  `deploy:staging` / `deploy:live` ask first: type the env name on a terminal,
  or pass `--yes` without one. Workers Builds (it sets `WORKERS_CI_COMMIT_SHA`
  and `WORKERS_CI`; either one skips the ask) and `deploy:testing` are never
  asked. The ask covers deploys only, not a hand-run `pnpm run migrate`. The
  queue (`staging-daemon-commands` / `daemon-commands`) with its `-dlq`
  dead-letter queue and the R2 bucket must exist before the first deploy; the
  Durable Object namespace and rate limiters come from `wrangler.jsonc`.
  Hosted sign-up is off on both until `TURBOPANEL_IS_SIGNUP_ENABLED` says
  otherwise, and `TURBOPANEL_AUTO_FAILOVER` is `off`. **Monitor
  `GET /api/daemon/v1/readiness`, not `/api/health`:** `/api/health` is a
  static identity page and answers 200 with the database gone; readiness reads
  the database and answers 503 `database unavailable` when it cannot.
- **TESTING deploys from `trunk` via Cloudflare Workers Builds** on the
  `testing-instance` worker (branch-based, like staging/live — not an Actions
  API-token deploy). Deploy command `pnpm run deploy:testing` (sets
  `CLOUDFLARE_ENV=testing`). Build variables (build-only, never runtime):
  `TURBOPANEL_DATABASE_URL` — secret, the testing database's direct TCP URL
  for the migrate role (Hyperdrive is not reachable from the build
  container), and `TURBOPANEL_DEPLOY_CHECK_API_TOKEN` — secret, a token with
  Hyperdrive Read so `check-deploy-env.mjs` can confirm the URL is testing's
  Hyperdrive origin (it fails closed without it).
  Testing applies pending migrations on top of the existing database; any reset
  is a named testing-only script that refuses on staging and live.
  `/api/client/v1/status` answers **503**
  `{ code: "database_error" }` (not a bare 500) when the settings read fails
  — the symptom of an unmigrated or unreachable database.
  A testing or staging database that sits behind the managed database listener
  (a pooling proxy) refuses the session advisory lock the migrate script takes
  ("Feature not supported"); set the build variable
  `TURBOPANEL_MIGRATE_NO_LOCK=1` there (`wrangler.jsonc` sets it in the
  `testing` and `staging` `vars`, which the script reads, so no dashboard build
  variable is needed). The script refuses it for any other
  `CLOUDFLARE_ENV` (live keeps the lock), and with it set two migrations must
  not run at once.
  Do not commit `TURBOPANEL_REVISION` in `wrangler.jsonc` — that would freeze a
  SHA. Self-hosted instance-launch writes it into `runtime.env` /
  `runtime.dev-vars` from `git rev-parse HEAD` in the instance checkout.
  `GET /api/health` reports `{ license, version, revision: { commit, sourceUrl },
  channel, build, environment }` (`src/app/build-info.ts`) so a network user can
  identify Corresponding Source. `channel` is the resolved
  `TURBOPANEL_UPDATE_CHANNEL` (default `release`); `build` is the installed
  package's full label from `TURBOPANEL_BUILD_LABEL` (e.g.
  `0.1.1-canary.<buildId>`, `0.1.1-rc.1`) or null — never baked into the
  binary, because promotion reuses the canary bytes for rc and release, so the
  installer that knows which manifest it installed has to supply it;
  `environment` is `TURBOPANEL_ENVIRONMENT` (`testing` / `staging` / `live`,
  set per env in wrangler.jsonc; null for local dev and self-hosted).
  **Commit on a plain `wrangler deploy`:** wrangler.jsonc's `build.command`
  runs `scripts/stamp-build-commit.mjs` before bundling whenever
  `WORKERS_CI_COMMIT_SHA` is set (Workers Builds only), stamping
  `BUILD_INFO.commit` in the throwaway build checkout — so the owner's own
  deploy command (`pnpm migrate && pnpm wrangler deploy`) reports the commit
  without `deploy:testing`. `TURBOPANEL_REVISION` still wins when set.

## Panel identity key (owner step, per environment)

The panel signs its identity document and, later, its messages to daemons with
an Ed25519 key. Workers take the key from the secret binding
`TURBOPANEL_IDENTITY_KEYS`. It is never derived from `TURBOPANEL_SECRET`, and
`testing`, `staging` and `live` each get their own key. With no binding the
feature is off: the panel runs and `GET /api/daemon/v1/instance/identity`
answers 404. A malformed binding stops the worker at start, so a typo is
loud.

Run once per environment on a trusted machine, never against a server:

```sh
node scripts/generate-identity-key.mjs > identity-keys.json   # fingerprints print on stderr
pnpm wrangler secret put TURBOPANEL_IDENTITY_KEYS --env testing < identity-keys.json
rm identity-keys.json
```

Record the current fingerprint (43 characters, public) where the owner keeps
deploy records, not in git. The offline `next` key: run
`node scripts/generate-identity-key.mjs --next-only`, keep the printed seed
offline, and re-run the first command with `--next <fingerprint>` to publish
only its fingerprint. Self-hosted panels generate their key on first start and
store it sealed under the data-encryption key (setting `PANEL_IDENTITY_KEYS`).
