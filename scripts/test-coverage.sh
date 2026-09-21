#!/bin/sh
# Run Vitest (workers pool, Istanbul coverage) + Deno suites (V8 coverage),
# then merge into coverage/lcov.info for SonarCloud.
#
# Vitest runs under @cloudflare/vitest-pool-workers, which has no
# `node:inspector` (so the default `v8` coverage provider cannot run inside
# workerd) — but the pool *does* bridge Istanbul's instrumented counters back
# out to the Node.js process (see `test.coverage` in vitest.config.ts), so
# `--coverage` there produces a real, non-zero LCOV report for the
# Durable-Object / Workers-only code that only these suites exercise (daemon
# cell, admin routes, etc). That report is entirely separate from — and
# covers largely different files than — the Deno LCOV below, so both paths
# are merged into coverage/lcov.info for `sonar.javascript.lcov.reportPaths` in
# sonar-project.properties (single repo-relative report — SonarCloud was only
# reflecting Deno hits when two comma-separated paths were used).
#
# Merge rule (smart): per SF, the report with more covered lines (LH) is
# primary. Secondary may only max shared hits or add *executed* lines — never
# zero-hit V8 transitive rows that dilute Workers/DO Istanbul. Previously a
# hard Vitest-wins drop discarded real Deno unit hits for modules Vitest only
# imported (false 0% on db-url, allocate-containers, …).
#
# Usage:
#   sh scripts/test-coverage.sh
#   TEST_PHASE=vitest sh scripts/test-coverage.sh
#   TEST_PHASE=deno DENO_SHARD=hostfree sh scripts/test-coverage.sh
#
# TEST_PHASE=all (default) runs Vitest and every Deno suite, then merges.
# That is the local and verify-ci path. CI build.yml sets TEST_PHASE so each
# job runs one slice and the SonarQube job merges the LCOV artifacts.
# DENO_SHARD is hostfree, api-routes, db-1, or db-2 (see deno-test-shards.mjs).
#
# Output: coverage/lcov.info (Vitest + Deno merged for SonarCloud) when
# TEST_PHASE=all, plus coverage/vitest/lcov.info and coverage/deno.lcov.
# A single phase leaves only its own report; CI merges those in the fan-in.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Wrangler/vitest-pool-workers writes under $XDG_CONFIG_HOME/.wrangler.
# Guest `/home/vagrant/.config` is root-owned; isolate so coverage fails on
# tests, not mkdir EACCES.
if [ -z "${XDG_CONFIG_HOME:-}" ]; then
  XDG_CONFIG_HOME=$(mktemp -d "${TMPDIR:-/tmp}/tp-wrangler-xdg.XXXXXX")
  export XDG_CONFIG_HOME
  trap 'rm -rf "$XDG_CONFIG_HOME"' EXIT
fi

rm -rf coverage
mkdir -p coverage

phase="${TEST_PHASE:-all}"
case "$phase" in
  all|vitest|deno) ;;
  *)
    echo "test-coverage: unknown TEST_PHASE=${phase}" >&2
    exit 1
    ;;
esac

echo "==> test-coverage phase=${phase} shard=${DENO_SHARD:-all}"

workspace="${GITHUB_WORKSPACE:-$ROOT}"
workspace="${workspace%/}"

if [ "$phase" != "deno" ]; then
echo "==> Vitest (workers pool, Istanbul coverage)"
pnpm exec vitest run --config vitest.config.ts --coverage

if ! grep -q '^SF:' coverage/vitest/lcov.info; then
  echo "Vitest LCOV expected at least one SF: entry" >&2
  exit 1
fi

echo "==> Normalize Vitest LCOV SF paths"
export LCOV_FILE=coverage/vitest/lcov.info
export LCOV_WORKSPACE="$workspace"
python3 - <<'PY'
from pathlib import Path
import os

path = Path(os.environ["LCOV_FILE"])
text = path.read_text()
workspace = os.environ["LCOV_WORKSPACE"].rstrip("/")
for prefix in (f"file://{workspace}/", f"{workspace}/"):
    text = text.replace(f"SF:{prefix}", "SF:")
path.write_text(text)
PY

if bad="$(grep -E '^SF:(/|file:)' coverage/vitest/lcov.info || true)" && [ -n "$bad" ]; then
  echo "Vitest LCOV SF paths must be repo-relative after normalization" >&2
  printf '%s\n' "$bad" | head -n 20
  exit 1
fi

echo "==> Assert Workers/DO coverage in Vitest LCOV"
python3 - <<'PY'
import re
import sys
from pathlib import Path

text = Path("coverage/vitest/lcov.info").read_text()
checks = (
    (r"SF:src/daemon/cell/do\.ts\n(?:.*\n)*?LH:(\d+)", 50, "do.ts"),
    (r"SF:src/daemon/cell/do-registry\.ts\n(?:.*\n)*?LH:(\d+)", 80, "do-registry.ts"),
    (r"SF:src/daemon/workers-ws\.ts\n(?:.*\n)*?LH:(\d+)", 10, "workers-ws.ts"),
)
for pattern, minimum, label in checks:
    match = re.search(pattern, text)
    hits = int(match.group(1)) if match else 0
    if hits < minimum:
        print(
            f"Vitest LCOV missing expected {label} coverage (LH:{hits}, need >={minimum})",
            file=sys.stderr,
        )
        sys.exit(1)
PY
fi

if [ "$phase" = "vitest" ]; then
  echo "Vitest LCOV ready: coverage/vitest/lcov.info"
  exit 0
fi

# Inventory parsers (check-test-inventory.mjs, generate-test-lists.mjs) read
# the first line that starts with "deno test ". The shard branch calls
# "command deno test" so it is not that line. Keep the unsharded block in
# the suffix-glob shape generate-test-lists.mjs --write emits.
run_deno_shard() {
  shard_files=$(node scripts/deno-test-shards.mjs --shard "$DENO_SHARD")
  set -f
  # Repo-relative paths have no spaces; command substitution already dropped
  # the trailing newline. set -f so a future filename cannot glob.
  # shellcheck disable=SC2086
  set -- $shard_files
  set +f
  echo "==> Deno shard ${DENO_SHARD} ($# files)"
  if [ "$DENO_SHARD" = "hostfree" ]; then
    # No database on this shard. ubuntu-latest is 2 vCPU, so two threads is
    # the hosted-runner ceiling. Postgres shards stay one file at a time.
    DENO_JOBS="${DENO_JOBS:-2}"
    export DENO_JOBS
    command deno test -A --coverage=coverage/deno-profile --no-check --parallel "$@"
  else
    command deno test -A --coverage=coverage/deno-profile --no-check "$@"
  fi
}

# Deno V8 coverage for Sonar LCOV (Vitest/workerd covers Workers/DO-only code).
# Two tiers:
#   - Host-free unit suites (always run; no Postgres/Redis).
#   - Postgres integration suites (need TURBOPANEL_DATABASE_URL; skip gracefully
#     when unset locally — CI build.yml starts Postgres and sets the URL).
# Omit: redis-cell / ws-handlers (Redis),
# Vitest-only Workers suites (workers-ws, durable-object, routes-core, …).
# CI uses -A so every suite shares one profile dir (mirrors the daemon repo's
# test:coverage grant). A set DENO_SHARD runs that subset instead of the walk.
echo "==> Deno coverage profile"
if [ -n "${DENO_SHARD:-}" ]; then
  run_deno_shard
else
deno test -A --coverage=coverage/deno-profile \
  --no-check \
  --ignore=**/*.workers.test.ts \
  --ignore=**/*.workers-e2e.test.ts \
  --ignore=**/*.entry.test.ts \
  --ignore=scripts/billing-test-clock-harness.test.ts \
  --ignore=src/daemon/redis-cell.test.ts \
  --ignore=src/daemon/ws-handlers.test.ts \
  src/ \
  mailer/ \
  scripts/
fi

echo "==> Deno LCOV"
deno coverage coverage/deno-profile --lcov --output=coverage/deno.lcov

# Deno on Linux CI often emits absolute SF: paths; Sonar needs repo-relative.
# Co-located suites can dynamically import a sibling checkout (e.g.
# ../turbopaneld/src/metrics/contract.ts); Deno coverage then emits that file as
# an absolute SF: outside this repo. Drop those records — they are not this
# project's sources, and leaving them would make SonarCloud drop the report.
echo "==> Normalize Deno LCOV SF paths"
export LCOV_FILE=coverage/deno.lcov
export LCOV_WORKSPACE="$workspace"
python3 - <<'PY'
from pathlib import Path
import os

path = Path(os.environ["LCOV_FILE"])
text = path.read_text()
workspace = os.environ["LCOV_WORKSPACE"].rstrip("/")
for prefix in (f"file://{workspace}/", f"{workspace}/"):
    text = text.replace(f"SF:{prefix}", "SF:")

parts = text.split("end_of_record")
kept = []
dropped = 0
for part in parts:
    sf = next((line[3:] for line in part.split("\n") if line.startswith("SF:")), None)
    if sf is not None and (sf.startswith("/") or sf.startswith("file:")):
        dropped += 1
        continue
    kept.append(part)
text = "end_of_record".join(kept)
if dropped:
    print(f"Dropped {dropped} out-of-repo SF record(s) from {path}")
path.write_text(text)
PY

if ! grep -q '^SF:src/' coverage/deno.lcov; then
  echo "Deno LCOV expected at least one SF:src/ entry" >&2
  exit 1
fi

if bad="$(grep -E '^SF:(/|file:)' coverage/deno.lcov || true)" && [ -n "$bad" ]; then
  echo "Deno LCOV SF paths must be repo-relative after normalization" >&2
  printf '%s\n' "$bad" | head -n 20
  exit 1
fi

if [ "$phase" = "deno" ]; then
  echo "Deno LCOV ready: coverage/deno.lcov"
  exit 0
fi

# Merge lives in scripts/merge-lcov.py (not an embedded heredoc) so concurrent
# edits to this file's Deno test list cannot tear the merge Python mid-run.
echo "==> Merge Vitest + Deno LCOV for SonarCloud"
python3 scripts/merge-lcov.py \
  --vitest coverage/vitest/lcov.info \
  --deno coverage/deno.lcov \
  --out coverage/lcov.info

if ! grep -q '^SF:src/daemon/cell/do.ts' coverage/lcov.info; then
  echo "Merged LCOV expected SF:src/daemon/cell/do.ts" >&2
  exit 1
fi

# Smart merge: Workers/DO floors must still clear after Deno hits are folded in
# (guards against reintroducing zero-hit dilution for files Istanbul measured).
echo "==> Assert Workers/DO coverage in merged LCOV"
python3 - <<'PY'
import re
import sys
from pathlib import Path

text = Path("coverage/lcov.info").read_text()
checks = (
    (r"SF:src/daemon/cell/do\.ts\n(?:.*\n)*?LH:(\d+)", 50, "do.ts"),
    (r"SF:src/daemon/cell/do-registry\.ts\n(?:.*\n)*?LH:(\d+)", 80, "do-registry.ts"),
    (r"SF:src/daemon/workers-ws\.ts\n(?:.*\n)*?LH:(\d+)", 10, "workers-ws.ts"),
)
for pattern, minimum, label in checks:
    match = re.search(pattern, text)
    hits = int(match.group(1)) if match else 0
    if hits < minimum:
        print(
            f"Merged LCOV missing expected {label} coverage (LH:{hits}, need >={minimum})",
            file=sys.stderr,
        )
        sys.exit(1)
PY

if bad="$(grep -E '^SF:(/|file:)' coverage/lcov.info || true)" && [ -n "$bad" ]; then
  echo "Merged LCOV SF paths must be repo-relative" >&2
  printf '%s\n' "$bad" | head -n 20
  exit 1
fi

echo "Coverage LCOV ready: coverage/lcov.info (+ coverage/vitest/lcov.info, coverage/deno.lcov)"
