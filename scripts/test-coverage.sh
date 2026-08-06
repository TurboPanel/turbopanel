#!/bin/sh
# Run Vitest (no coverage — workers pool has no V8 inspector) + Deno suites with
# coverage, then write LCOV for SonarCloud.
# Usage: sh scripts/test-coverage.sh
# Output: coverage/deno.lcov
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf coverage
mkdir -p coverage

echo "==> Vitest (workers pool — coverage unsupported)"
pnpm exec vitest run --config vitest.config.ts

echo "==> Deno coverage profile"
# Host-free Deno suites that feed Sonar LCOV (Vitest/workerd cannot emit V8
# coverage). Keep this list lean: pure unit suites + the existing hook set.
# CI uses -A so every suite shares one profile dir (mirrors the daemon repo's
# test:coverage grant).
deno test -A --coverage=coverage/deno-profile \
  --no-check \
  src/client/authn/workers-onboarding.test.ts \
  src/client/authn/install-state.test.ts \
  src/client/authn/browser-write-protection.test.ts \
  src/deno-compile-permissions.test.ts \
  src/client/authz/ \
  src/client/principals/serialize.test.ts \
  src/server-paths.deno.test.ts \
  src/lib/compose/ \
  src/lib/managed/ \
  src/lib/tls/ \
  src/lib/amqp-default-url.test.ts \
  src/lib/machine-key.test.ts \
  src/lib/datacenter-options.test.ts \
  src/lib/db/server-metadata.test.ts \
  src/lib/commands/schemas.test.ts \
  src/lib/commands/ids.test.ts \
  src/lib/commands/command-amqp-topology.test.ts \
  src/lib/email/validate-address.test.ts \
  src/lib/email/smtp/amqp-topology.test.ts \
  src/lib/email/smtp/smtp-resolve.test.ts \
  src/query-cache/passthrough-query-cache.test.ts \
  src/daemon/authn/daemon-jwt.test.ts \
  src/daemon/authn/server-key.test.ts \
  src/daemon/authn/daemon-state.test.ts \
  src/daemon/cell/contracts.test.ts \
  src/daemon/cell/socket-health.test.ts \
  src/daemon/cell/stateless-challenge.test.ts \
  src/daemon/rate-limit/inbound-window.test.ts \
  src/daemon/rate-limit/keys.test.ts \
  src/daemon/metrics/store-selection.test.ts \
  src/daemon/metrics/query/uptime.test.ts \
  src/admin/reencrypt-secrets.test.ts \
  src/admin/routes.test.ts

echo "==> Deno LCOV"
deno coverage coverage/deno-profile --lcov --output=coverage/deno.lcov

# Deno on Linux CI often emits absolute SF: paths; Sonar needs repo-relative.
workspace="${GITHUB_WORKSPACE:-$ROOT}"
workspace="${workspace%/}"
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
path.write_text(text)
PY

if ! grep -q '^SF:src/' coverage/deno.lcov; then
  echo "Deno LCOV expected at least one SF:src/ entry" >&2
  exit 1
fi

echo "Coverage LCOV ready: coverage/deno.lcov"
