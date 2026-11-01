# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and
**Deno**. This is the TurboPanel control plane ("instance" internally).

This root file holds what applies everywhere. Directory-specific rules live in
the `AGENTS.md` next to the code (nearest file wins); long runbooks live in
[`docs/`](./docs). The index at the end says which guide to open for what.

## Commands

Run suites inside the Vagrant guest, not on the host (see **Where to run
tests**). Package manager is pnpm; Deno tasks are in `deno.json`.

- Fast gate: `pnpm test:hook` (types, Durable Object hibernation, Workers
  bundle, notices, boundaries, inventory). CI parity: `pnpm verify:ci`.
- Tests: `pnpm test:do` (Workers pool), `deno task test:*` (Deno buckets),
  `pnpm test:coverage` (all of it plus the LCOV merge).
- Types: `deno task check:types`, `pnpm check:workers-types`,
  `pnpm check:workers-bundle`.
- Guards: `pnpm check:test-inventory`, `check:import-boundaries`,
  `check:vocabulary`, `check:ca-boundary`, `check:instance-acme-boundary`,
  `check:contract-drift`, `check:migration-*`, `check:metrics-boundaries`,
  `check:query-cache-boundaries`, `notices:check`.
- Guide pointers: `pnpm check:guide-references` (paths named in `AGENTS.md` and `docs/*.md` must exist).
- Database: `pnpm generate` (new migration), `pnpm migrate`.
- Format: `pnpm exec prettier --write <changed files>` then `--check`; the
  pre-commit hook (`.githooks/pre-commit`) runs the secret scan and the same
  check on staged `.ts`/`.tsx`/`.mjs` under `src/` and `scripts/`.
- Setup, env vars and every `pnpm` task in detail: [`docs/setup.md`](./docs/setup.md).

## Hard Rules (Cross-Cutting)

- **Workers: one Hyperdrive/postgres.js client per request, never cached
  across requests**, and always closed when the invocation ends. Violating it
  took production down. Detail: `src/platform/workers/AGENTS.md`.
- **No database wipes.** Every schema or data change is a forward-only
  migration, additive first, tested as an upgrade, with a backup before it
  runs. Details: `src/db/AGENTS.md`. Database role grants are owner-run and
  never run against live, staging or testing (`docs/deploying-workers.md`).
- **Format every changed file before committing** (`prettier`); CI fails an
  unformatted file.
- **Workers-reachable code** (anything imported from `src/workers.ts`) must
  bundle under Wrangler: no Deno-only specifiers, no I/O at module load. See
  `src/AGENTS.md`.
- **Every new `*.test.ts` is claimed by exactly one runner** via its filename
  suffix; run `pnpm check:test-inventory`. See `src/AGENTS.md`.
- **Never commit secrets.** Tests use fixtures from `src/test-fixtures/`; the
  secret scanner allowlist takes exact lines only. See
  `src/test-fixtures/AGENTS.md` and `scripts/AGENTS.md`.
- **Do not widen `require-await`, `--allow-net` or `--allow-ffi`** to make
  something pass; the reasons are in `src/AGENTS.md` and
  `src/platform/deno/AGENTS.md`.
- **A prefix the instance owns must also be in Caddy and `wrangler.jsonc`
  `routes`**, or the SPA shell answers 200 for it. See `src/app/AGENTS.md`.
- **Bump `MIN_SUPPORTED_DAEMON_VERSION` and `MIN_SUPPORTED_INSTANCE_VERSION`
  together** and never silently; wire changes are expand-only. See
  `src/app/AGENTS.md`.

## Project metadata / public naming

| Public name              | GitHub                                                            | Internal term (this repo)              |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------- |
| TurboPanel Control Plane | [TurboPanel/turbopanel](https://github.com/TurboPanel/turbopanel) | `instance` (runtime/architecture only) |

- **License:** AGPL-3.0-only (details, notices and the open-source story:
  [`docs/licensing-and-metadata.md`](./docs/licensing-and-metadata.md)).
- **Maturity label:** **Private alpha** (README, roadmap, site banner — keep
  identical).
- **README** is product-facing; **AGENTS.md** is maintainer-facing. Do not use
  `turbopanel/instance` as a public repo slug.

## Speed doctrine (turbo)

TurboPanel is named for speed; keep it fast on every path.

- **Cache runtimes & deps.** Deno/Node/Caddy live under
  `/opt/turbopanel/vendor/<tool>/current`; install only when the pinned version
  is missing. Don't re-download or re-`pnpm install` when nothing changed. Caddy
  follows the same `vendor/caddy/<version>/caddy` + `current` layout (no
  `versions/` subdir); `scripts/download-caddy.mjs` (pinned **2.11.4**, SHA-256
  verified) and the `caddy` Ansible role are aligned.
- **Idempotent fast-paths.** Bootstrap/install steps must short-circuit when
  already satisfied (the Ansible roles do; mirror that in scripts).
- **Avoid redundant work.** No polling loops or periodic git/`systemctl` forks
  unless essential (the version watcher and auto-update poll were removed for
  this reason).
- **Parallelize** independent I/O (e.g. `Promise.all` for per-daemon fan-out, as
  in the admin routes).
- **Push, don't poll** for cross-process signals where practical (WS messages
  over fallback timers).

## Platform model: Ansible owns installs

The **daemon is the constant** installed on every TurboPanel-managed host and is
the only party that runs Ansible to install/update everything else (runtimes,
users, the instance, UI, Caddy). The instance does not install itself. In
co-located dev the daemon runs the `instance-dev-install` playbook (see
`../turbopaneld/orchestration/AGENTS.md`) when `TURBOPANEL_DEV_INSTANCE=1`. Updates are
**managed upgrades** (`src/features/upgrades/`): the maintenance tick resolves
the channel manifests, records the latest available build, and drives
fleet-aware upgrade runs. Updates are always automatic on both runtimes: each
install checks once an hour at its own minute; nobody starts one by hand, and
the only control is Pause all updates in Admin > Updates. Order is
co-located daemon → control plane → fleet, with the fleet phase hard-gated on
both being on target; Workers runs fleet-only (the control plane is
deploy-managed). See `src/features/upgrades/AGENTS.md`.

## Releases

How changes ship: squash-merge into `trunk`, then two bot-opened pull requests (`trunk` to `staging`, `staging` to `live`) that a maintainer merges with merge commits. Hotfixes land on `trunk` first, and the daemon ships before the control plane. See [How changes ship](https://github.com/TurboPanel/.github/blob/trunk/CONTRIBUTING.md#how-changes-ship) and [How to ship](https://turbopanel.io/docs/development/how-to-ship).

**Promotion, break-glass (`.github/workflows/promote.yml`):** the manual form of
the automatic promotion, used only when the automatic path cannot run. It
re-uses the canary bytes (no rebuild), verifies the source manifest signature
first, and `to=release` needs the Release App secrets. Full contract:
`.github/AGENTS.md`.

## Documentation discipline

**Keep this file current.** When you learn something durable about how
TurboPanel works — architecture, env vars, gotchas, cross-repo contracts,
operational steps — add or update a note here in the same PR/session as the code
change. Future agents read `AGENTS.md` first.

- Prefer extending an existing section over appending orphan bullets.
- Record **why** when the reason is non-obvious (e.g. a missing Debian package
  that breaks Ansible).
- If a fact belongs in another repo (`daemon`, `ui`), put the canonical detail
  there and add a short cross-reference here when the instance is involved.
- Do not record secrets, tokens, or machine-specific credentials.
- Remove or correct notes that prove wrong.

### Ansible style (SonarQube)

- Prefer **`mode: "0640"`** / **`0750"`** with explicit **`owner`** /
  **`group`** over world-readable modes (`ansible:S2612`).

`README.md` is for humans getting started; `AGENTS.md` is for agents maintaining
the system.

**Where to run tests:** host VirtFS checkouts lack a usable Node/pnpm/Deno tree.
Run suites **inside the Vagrant guest** from the host `dev` checkout
(`../dev/AGENTS.md` → Testing). Do not run `pnpm test` / `pnpm test:do` /
`deno task test` on the host:

```bash
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopanel && pnpm test:do'
# CI-parity (inventory + workers bundle + LCOV merge). Needs TURBOPANEL_DATABASE_URL
# for migrate + postgres suites — `../dev/scripts/ci-verify.sh` loads it in-guest.
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopanel && pnpm verify:ci'
```

A new `*.test.ts` is not done until `pnpm check:test-inventory` passes (see
**Adding tests** in `src/AGENTS.md`). `pnpm test:hook` and `pnpm verify:ci` include that
guard; `pnpm test:do` alone does not.

## Guide Index

Open the matching guide before editing that area. Each is a plain Markdown file
next to the code it governs.

| Area                        | Guide                                                                                         | Open it when                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Source tree rules           | `src/AGENTS.md`                                                                               | any `src/` work: type-check, lint, TypeScript style, tests inventory, Workers-reachable imports                              |
| Source layout map           | `docs/source-layout.md`                                                                       | looking for where something lives                                                                                            |
| App, surfaces, versions     | `src/app/AGENTS.md`                                                                           | API/WS prefixes, mutating-request gates, Caddy catch-all, version floors                                                     |
| Database and schema         | `src/db/AGENTS.md`                                                                            | schema, migrations, tables                                                                                                   |
| Workers and Hyperdrive      | `src/platform/workers/AGENTS.md`                                                              | DB clients on Workers (hard rule), bindings                                                                                  |
| Platform ports and storage  | `src/platform/AGENTS.md`                                                                      | choosing where data is stored                                                                                                |
| Deno platform and DuckDB    | `src/platform/deno/AGENTS.md`                                                                 | `deno compile`, native addon, permissions                                                                                    |
| Instance binary verbs       | `src/cli/AGENTS.md`                                                                           | `migrate`, `generate-secret`, in-process mailer                                                                              |
| Release workflows           | `.github/AGENTS.md`                                                                           | `release.yml`, promotion, signing                                                                                            |
| CI analysis and coverage    | `scripts/AGENTS.md`                                                                           | Sonar job, LCOV merge, secret scanner                                                                                        |
| Test fixtures               | `src/test-fixtures/AGENTS.md`                                                                 | fixture secrets, sealed envelopes                                                                                            |
| Daemon protocol             | `src/daemon/AGENTS.md`, `src/daemon/cell/AGENTS.md`                                           | cell, presence, transport, Durable Object cost                                                                               |
| Server metrics              | `src/daemon/metrics/AGENTS.md`                                                                | metrics ingestion and storage                                                                                                |
| Client API                  | `src/client/AGENTS.md`                                                                        | `/api/client/v1/*` permission contract                                                                                       |
| Authentication              | `src/client/authn/AGENTS.md`                                                                  | sessions, keyring, install gate                                                                                              |
| Authorization               | `src/client/authz/AGENTS.md`                                                                  | permission keys, system-owned guards                                                                                         |
| Servers, system, OpenAPI    | `src/client/servers/AGENTS.md`, `src/client/system/AGENTS.md`, `src/client/openapi/AGENTS.md` | server routes, component inventory, specs                                                                                    |
| Admin surface               | `src/admin/AGENTS.md`                                                                         | `/api/admin/v1/*` routes                                                                                                     |
| Webhooks                    | `src/webhook/AGENTS.md`                                                                       | inbound provider webhooks                                                                                                    |
| Instance hostnames and ACME | `src/features/install/AGENTS.md`                                                              | the control plane's own certificates                                                                                         |
| Hosting options             | `src/features/hostings/AGENTS.md`                                                             | tenant values written into root-run configs                                                                                  |
| Update manifests            | `src/features/update/AGENTS.md`                                                               | channel manifest resolver                                                                                                    |
| Features                    | `src/features/<name>/AGENTS.md`                                                               | `billing`, `commands`, `compose`, `docker-run`, `email`, `execution-logs`, `managed`, `notifications`, `upgrades`, `backups` |
| Query cache, TLS            | `src/query-cache/AGENTS.md`, `src/lib/tls/AGENTS.md`                                          | cached reads; Platform CA vs Organization CA                                                                                 |
| Panel identity key          | `src/lib/panel-identity/AGENTS.md`                                                            | identity key storage, fingerprint rule, signed identity document                                                             |
| Host layout and users       | `docs/host-layout.md`                                                                         | UIDs, systemd units, sockets, env vars, Caddy dial                                                                           |
| Setup and tasks             | `docs/setup.md`                                                                               | local setup, secrets files, `pnpm` tasks                                                                                     |
| Deploying Workers           | `docs/deploying-workers.md`                                                                   | staging, live, testing deploys, migrate backups                                                                              |
| Licensing                   | `docs/licensing-and-metadata.md`                                                              | license, notices, health revision                                                                                            |
| Full subsystem table        | `docs/subsystem-guides.md`                                                                    | one-paragraph summary of every guide                                                                                         |
| Production Caddyfile        | `caddy.md`                                                                                    | server addresses, certs, daemon TLS trust                                                                                    |
