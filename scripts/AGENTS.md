# CI analysis & coverage (`scripts/`, SonarQube) — AGENTS.md

Moved from the root `AGENTS.md` (formerly **Documentation discipline → SonarQube**).
Covers the SonarCloud CI job, the Vitest+Deno LCOV merge in
`test-coverage.sh`, and the analysis-scope rules.

**When adding, renaming, or deleting a `*.test.ts`:** claim it in exactly one
runner via filename suffix, then run **`pnpm check:test-inventory`**. Deno
suites are `*.test.ts` / `*.hostfree.test.ts` / `*.deno.test.ts` under `src/`
or `scripts/` (`test-coverage.sh` walks those trees and ignores
Workers suffixes). Workers/DO suites are `*.workers.test.ts` /
`*.workers-e2e.test.ts` / `*.entry.test.ts` (`vitest.config.ts` `test.include`
suffix globs). Redis (etc.) suites go in `SERVICE_DEPENDENT` in
`check-test-inventory.mjs` with a reason. Full checklist: `src/AGENTS.md` →
**Adding tests (inventory)**.
The guard is wired into `pnpm test:hook`, **`pnpm verify:ci`**
(`scripts/verify-ci.sh` — the local serial mirror of `build.yml` minus Sonar), and
CI `build.yml`. Fleet-wide from the host `dev` checkout: `../dev/scripts/ci-verify.sh`.

CI does not run that script as one job. `build.yml` sets `TEST_PHASE` /
`DENO_SHARD` so Vitest, the host-free Deno shard, and three Postgres Deno
shards (`api-routes`, `db-1`, `db-2`) each get a runner. The job named
**SonarQube** merges their LCOV (`scripts/merge-lcov.py --parts`) and scans.
That name is the required check. Shard membership is automatic
(`scripts/deno-test-shards.mjs`): `src/daemon/api-routes.test.ts` alone,
filenames containing `hostfree` or `pure` on the host-free shard (run with
`deno test --parallel`), everything else packed into `db-1` / `db-2`. There
is no shard list to edit when a suite is added. Node and Deno versions are
not copied into the workflow: `scripts/ci-runtime-pins.sh` reads
`node_version` / `deno_version` from the daemon role defaults at the turbopaneld
commit SHA pinned in `.github/actions/setup-toolchain/action.yml` (bump it in a PR
to move Node or Deno).

**Reorg helpers** (do not glob tests; they rewrite inventories and layer
imports):

| Script | Purpose |
| --- | --- |
| `generate-test-lists.mjs` | Rebuild suffix-glob inventories (`test-coverage.sh` + `vitest.config.ts`) |
| `check-import-boundaries.mjs` | Kernel / feature / platform import graph (`pnpm check:import-boundaries`) |

- Analysis runs in GitHub Actions (`.github/workflows/build.yml` **SonarQube**
  job — SonarCloud wizard layout) with `SONAR_TOKEN` and
  `sonar-project.properties` (`sonar.projectKey=turbopanel_turbopanel`,
  `sonar.organization=turbopanel`). The **SonarQube** job is the fan-in: it
  merges the shard LCOV reports into a single **`coverage/lcov.info`**
  (`scripts/test-coverage.sh` still does that merge locally). It is Vitest
  Istanbul + Deno V8
  (`sonar.javascript.lcov.reportPaths=coverage/lcov.info` in
  `sonar-project.properties` — **not** comma-separated dual paths; SonarCloud
  effectively only imported Deno hits that way, so Workers/DO files showed 0%
  despite real Istanbul coverage). Merge pairs SF records **by covered-line
  count** (higher LH is primary). Secondary may only raise shared hits or add
  **executed** lines — never zero-hit transitive rows. When Vitest only imported
  a Deno-tested module (`LH:0`), Deno unit hits become primary so Sonar no
  longer reports false 0% on `db-url` / `allocate-containers` / similar.
  Dilution of healthy Workers/DO Istanbul reports (e.g. offline-sweep →
  `do-registry.ts`) is still avoided because Deno zero-hit extras never expand
  LF when Vitest has more covered lines. Vitest `SF:` paths are normalized
  repo-relative like Deno. The script asserts non-zero Vitest hits for
  `src/daemon/cell/do.ts`, `do-registry.ts`, and `workers-ws.ts` before merge,
  and re-checks those LH floors on the **merged** `coverage/lcov.info`.
  Intermediate reports remain at `coverage/vitest/lcov.info` and
  `coverage/deno.lcov` for debugging:
  - **Vitest** (`coverage/vitest/lcov.info`) — Workers-pool suites
    (`vitest.config.ts` `test.include` suffix globs), provider **`istanbul`**. The default
    `v8` provider cannot run inside workerd (no `node:inspector`), but
    `@cloudflare/vitest-pool-workers` bridges Istanbul counters back to Node, so
    `vitest run --coverage` is a real, non-zero report — **do not** assume
    Vitest coverage is unavailable. This is the _only_ LCOV source for
    Durable-Object / admin / other Workers-only code that no Deno suite imports
    (`src/daemon/cell/do.ts`, `src/daemon/workers-ws.ts`,
    `src/features/install/public-urls.ts`, …).
  - **Deno** (`coverage/deno.lcov`) — host-free Deno suites listed in
    `scripts/test-coverage.sh`, via `deno coverage --lcov` (native V8). On a
    pull request the scan then runs and waits for the quality gate
    (`sonar.qualitygate.wait=true`); a failed gate fails the job. On a trunk
    push the job only merges and uploads `instance-coverage-lcov`; the trunk
    analysis (the baseline PR new code is compared against) runs in
    `.github/workflows/sonar-trunk.yml` (**Sonar Trunk Analysis**) after Build
    completes, from that artifact, so Sonar never holds back the canary. The
    job is skipped (not failed) when a coverage shard did not succeed. **Coverage attribution (three independent traps — check all
    when Sonar shows 0% / low % while local Vitest is healthy):** (1) a new Deno
    `*.test.ts` file must use a Deno suffix (not `.workers.test.ts`) so
    `scripts/test-coverage.sh` picks it up — prefer host-free unit suites there;
    DB/Redis/integration suites stay out of LCOV. (2) a new Workers/DO test file
    must use `*.workers.test.ts` (or `*.workers-e2e.test.ts` / `*.entry.test.ts`)
    so the Vitest glob includes it; a Deno-only API file must not take that
    suffix. Traps (1) and (2) are
    now enforced by **`pnpm check:test-inventory`**
    (`scripts/check-test-inventory.mjs`, wired into `test:hook` and CI
    `build.yml`): it fails when any `*.test.ts` is claimed by neither runner, when
    a list entry names a file that no longer exists, or when a file is claimed
    by both. A suite that needs a service CI does not start (Redis, Stripe)
    goes in that script's `SERVICE_DEPENDENT` map **with a reason** — that map
    is the only sanctioned way to leave a suite out of both runners. (3) LCOV smart merge must
    stay in place — do not reintroduce full-record Vitest-wins (drops Deno hits
    for imported-but-untested modules) or naive Deno+Vitest line-union (dilutes
    Workers/DO with zero-hit transitive SF rows). Selective Workers/DO 0% with a
    healthy overall project coverage % is almost always an LCOV merge/path bug,
    not Automatic Analysis (AA being on fails the CI scanner entirely). (4) Co-located
    sibling imports (metrics `contract.ts` parity against `../turbopaneld`) can leak
    an absolute `SF:` path outside this repo. After prefix stripping,
    `test-coverage.sh` drops those out-of-repo LCOV records so SonarCloud does not
    discard the whole report.
- **`sonar.sources` / `sonar.tests` / `sonar.test.inclusions`** must stay set in
  `sonar-project.properties` (and mirrored in vestigial
  `.sonarcloud.properties`). Tests are co-located (`**/*.test.ts` under
  `src`); helpers that do not match the scanner's name heuristics
  (`src/test-fixtures/**`, `*-hostfree-doubles.ts`, `server-status-test-db.ts`,
  `fake-redis-cell-client.ts`, `workers-vitest.ts`, `vitest-env.d.ts`) belong in
  `test.inclusions` + `coverage.exclusions` so they are never main-code. Leaving
  `sonar.tests` unset only yields an INFO and heuristic classification that
  mis-labels those helpers.
- **Automatic Analysis must stay off** for `turbopanel_turbopanel` (SonarCloud →
  project **Administration → Analysis Method**). CI and Automatic Analysis
  cannot run together — Automatic Analysis enabled makes the CI scanner fail.
  There is no Sonar MCP `toggle_automatic_analysis` tool; change this only in
  the SonarCloud UI.
- Sonar-way **Coverage on New Code ≥ 80%** needs LCOV on CI. After switching
  from Automatic Analysis, reset **New Code** (Administration → New Code) so the
  baseline is not months of uncovered history, or the gate will fail even with
  fresh coverage reports.
- Drizzle-generated SQL under **`migrations/`** must stay excluded
  (`**/migrations/**`) — never “fix” smells in those files.
- Hand-authored OpenAPI under `src/client/openapi/**` and
  `src/daemon/openapi/**` is excluded from **duplication (CPD)** via
  `sonar.cpd.exclusions` (keep `sonar-project.properties` and the vestigial
  `.sonarcloud.properties` in sync). Schema/path blocks are intentionally
  repetitive across resources; refactor route/runtime code instead of twisting
  OpenAPI to please CPD.
- **SonarLint Connected Mode** does **not** honor
  `sonarlint.analysisExcludesStandalone` or local `.sonarcloud.properties` /
  `sonar-project.properties`. It only applies exclusions synced from the
  SonarCloud project **Administration → General Settings → Analysis Scope →
  Source File Exclusions**. Keep `**/migrations/**` there too (then SonarLint →
  Update binding / reconnect) or IDE will still raise `plsql:*` on drizzle-kit
  SQL.

### SonarQube (CI-based analysis)

`build.yml` ends in a `ci-ok` job that `needs:` every pull_request job (checks,
typecheck, vitest, deno-hostfree, deno-db, sonarqube, contract-twin) and fails unless all of them succeeded. It is the
one context the branch rulesets will require; a new PR-time job must be added
to its `needs:` or it never gates a merge. A red X must mean "this change is
broken", so: on a pull request a cancelled need still fails `ci-ok`; on a trunk
push (or manual run) a cancelled need skips `ci-ok` instead of failing it.
Trunk pushes are never cancelled by a newer merge: `build.yml` queues them
(workflow-level `queue: max`, `cancel-in-progress` only on pull requests) so
every merged commit is tested and gets a canary; `canary.yml` queues the same
way and never cancels. The `SonarQube` job needs only the coverage shards (vitest,
deno-hostfree, deno-db) and is skipped, not failed, when one of them did not
succeed — that failure is already red on its own job. Its quality gate blocks
pull requests only, and only pull requests are scanned in Build. On a trunk
push the job just merges and uploads the LCOV; `sonar-trunk.yml` (**Sonar
Trunk Analysis**, `workflow_run` on Build) uploads the trunk analysis from it
after Build completes, beside the canary rather than in front of it (a full
analysis takes ~12 minutes, ~10 of them in the JS/TS security engine).

The pre-commit hook (`.githooks/pre-commit`) runs the secret scan and then
`prettier --check` on the staged `.ts`/`.tsx`/`.mjs` files under `src/` and
`scripts/` — the same whole-file check CI's format step runs.
`TURBOPANEL_SKIP_HOOK_TESTS=1` does not skip it; `TURBOPANEL_SKIP_HOOK_FORMAT=1`
does (for a change whose whole-file reflow goes in its own commit). Without a
`node_modules` tree it skips with a message.

CI analysis config, the Vitest+Deno LCOV coverage merge, analysis-scope /
exclusion rules, and the coverage-attribution traps moved to
[`scripts/AGENTS.md`](./AGENTS.md). Read it before touching
`scripts/test-coverage.sh`, `sonar-project.properties`, the SonarQube CI job, or
when SonarCloud shows suspicious 0% coverage. Style rules Sonar enforces on
everyday code live in `src/AGENTS.md` (**TypeScript style**).


`scripts/scan-secrets.sh`, `scripts/scan-secrets.patterns` and `scripts/scan-secrets.selftest.sh` are byte-identical in turbopanel, turbopaneld, ui, website and dev: change all five together (each repo keeps a copy because the pre-commit hook runs it locally). The rules in the patterns file cover private key blocks, vendor tokens, JWTs, connection URLs with credentials, secret-looking assignments and forbidden file names (dotenv files, `*.pem`, `*.key`, daemon identity files, …); the scanner reports the rule id and location, never the matching text. `--all` scans the tree; `--range BASE..HEAD` scans every line the PR's commits added, so a secret added and removed inside a PR is still caught (CI runs it on PRs into trunk). Allowlist entries in `.secretscan-allowlist` are `path:full line text` (or `@path exact/file` for a forbidden file name), each needs a `# reason:` comment above it, and wildcards are rejected. The self-test builds its fixtures at run time from fragments; dev's `src/lib/scan-secrets.test.ts` runs it and, with the siblings checked out in dev CI, fails if any copy drifts.

#### `scripts/test-coverage.sh` is all-or-nothing without a local Postgres

The script runs under `set -eu`: if the Vitest workers-pool step fails to
even *start* (no `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
configured — `@cloudflare/vitest-pool-workers` refuses to boot the pool at
all, not just skip the tests that need it), the **Deno suites never run
either** — `pnpm test:coverage` exits non-zero having run nothing. Read
"test:coverage failed" literally: it does not mean the tests failed, it means
they never started. To get real Deno-suite results in an environment without
a configured Hyperdrive target, run the `deno task test:*` buckets directly
(see the `"tasks"` key in `deno.json`) instead of the combined script.

To actually run the Workers-pool suite (`pnpm test:do`, or the Vitest half of
`test:coverage`) with real Postgres instead of skipping it: point both
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` and
`..._HYPERDRIVE_CACHED` at a real, migrated Postgres connection string (`pnpm
migrate` against it first). Verified 2026-09-16 against a throwaway database —
all 18 Workers-pool files/337 tests passed, including a real (non-mocked)
`Db` end-to-end proof of the daemon → control-plane WebSocket dispatch path
in `src/daemon/acme-issuance-event.workers-e2e.test.ts`. Use a **dedicated
throwaway database**, not a shared one — several tests insert real rows and
none of them clean up after themselves (by design: they're meant to run
against throwaway testing databases. Only throwaway testing hosts are
disposable; the panel database is never reset (forward-only migrations).

## Contributor Guide Reference Check

`pnpm check:guide-references` (`check-guide-references.mjs`) fails when any
`AGENTS.md` or `docs/*.md` points at an in-repo file that does not exist, so
a guide split or move cannot leave stale pointers. It reads markdown links
(resolved from the guide) and backticked paths that start with `./` or `../` or
are repo-root `.md` paths (resolved from the guide or the repo root). Only
existence is checked, not headings. Paths into a sibling checkout
(`../turbopaneld/...`, `../dev/...`) are skipped when that checkout is absent,
as in CI, and checked when it is present. A path that is not a repo file (a
command run elsewhere, a generated file) goes in `ALLOWLIST` in the script
with a reason. Wired into `pnpm test:hook`, `pnpm verify:ci` and `build.yml`.
