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
  src/admin/reencrypt-secrets.test.ts \
  src/admin/routes.test.ts \
  src/client/authn/browser-write-protection.test.ts \
  src/client/authn/crypto.test.ts \
  src/client/authn/data-encryption.deno.test.ts \
  src/client/authn/install-state.test.ts \
  src/client/authn/password.deno.test.ts \
  src/client/authn/secrets.deno.test.ts \
  src/client/authn/workers-onboarding.test.ts \
  src/client/authz/ \
  src/client/display-name-uniqueness.test.ts \
  src/client/environments/validate-docker-external-networks.test.ts \
  src/client/managed/backups.test.ts \
  src/client/principals/assignments.test.ts \
  src/client/principals/serialize.test.ts \
  src/client/projects/catalog/catalog.test.ts \
  src/client/projects/catalog/scaffold.test.ts \
  src/client/projects/empty-setup.test.ts \
  src/client/system/hierarchy.test.ts \
  src/client/variables/resolve-inherited.test.ts \
  src/daemon/authn/daemon-jwt.test.ts \
  src/daemon/authn/daemon-state.test.ts \
  src/daemon/authn/server-key.test.ts \
  src/daemon/cell/contracts.test.ts \
  src/daemon/cell/control-plane-monitor.test.ts \
  src/daemon/cell/fleet-presence.test.ts \
  src/daemon/cell/offline-sweep.test.ts \
  src/daemon/cell/postgres-projection.test.ts \
  src/daemon/cell/protocol.test.ts \
  src/daemon/cell/socket-health.test.ts \
  src/daemon/cell/stateless-challenge.test.ts \
  src/daemon/metrics/analytics-engine/field-map.test.ts \
  src/daemon/metrics/analytics-engine/store.test.ts \
  src/daemon/metrics/clickhouse/schema.test.ts \
  src/daemon/metrics/contract.test.ts \
  src/daemon/metrics/disabled-store.test.ts \
  src/daemon/metrics/query/cache.test.ts \
  src/daemon/metrics/query/resolution.test.ts \
  src/daemon/metrics/query/series-response.test.ts \
  src/daemon/metrics/query/uptime.test.ts \
  src/daemon/metrics/store-selection.test.ts \
  src/daemon/metrics/write-path-parity.test.ts \
  src/daemon/rate-limit/contracts.test.ts \
  src/daemon/rate-limit/inbound-window.test.ts \
  src/daemon/rate-limit/keys.test.ts \
  src/db-timeout.test.ts \
  src/deno-compile-permissions.test.ts \
  src/dev-mode.deno.test.ts \
  src/developer/drizzle-studio-bind.test.ts \
  src/developer/local-console-auth.test.ts \
  src/lib/amqp-default-url.test.ts \
  src/lib/commands/command-amqp-topology.test.ts \
  src/lib/commands/deploy-validation.test.ts \
  src/lib/commands/hostname.test.ts \
  src/lib/commands/ids.test.ts \
  src/lib/commands/schemas.test.ts \
  src/lib/commands/wireguard.test.ts \
  src/lib/compose/ \
  src/lib/datacenter-name-suggestions.test.ts \
  src/lib/datacenter-options.test.ts \
  src/lib/db/server-metadata.test.ts \
  src/lib/docker-network-name.test.ts \
  src/lib/email/smtp/amqp-topology.test.ts \
  src/lib/email/smtp/smtp-resolve.test.ts \
  src/lib/email/validate-address.test.ts \
  src/lib/geo/server-geo.test.ts \
  src/lib/hosting-options.test.ts \
  src/lib/hosting-web-env.test.ts \
  src/lib/ip-address.test.ts \
  src/lib/machine-key.test.ts \
  src/lib/managed/ \
  src/lib/net/vpn-address-allocator.test.ts \
  src/lib/naming.test.ts \
  src/lib/organization-options.test.ts \
  src/lib/principal-options.test.ts \
  src/lib/project-options.test.ts \
  src/lib/server-capacity.test.ts \
  src/lib/service-options-instances.test.ts \
  src/lib/tls/ \
  src/lib/update/manifest.test.ts \
  src/query-cache/passthrough-query-cache.test.ts \
  src/server-paths.deno.test.ts \
  src/server-registry-metadata.test.ts \
  src/server-registry.test.ts

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
