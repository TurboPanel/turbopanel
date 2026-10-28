# AGENTS.md

Minimal Hono app with dual runtimes: **Cloudflare Workers** (Wrangler) and
**Deno**.

## Project metadata / public naming

| Public name              | GitHub                                                            | Internal term (this repo)              |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------- |
| TurboPanel Control Plane | [TurboPanel/turbopanel](https://github.com/TurboPanel/turbopanel) | `instance` (runtime/architecture only) |

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
`../turbopaneld/AGENTS.md`) when `TURBOPANEL_DEV_INSTANCE=1`. Updates are
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
**Adding tests** above). `pnpm test:hook` and `pnpm verify:ci` include that
guard; `pnpm test:do` alone does not.

