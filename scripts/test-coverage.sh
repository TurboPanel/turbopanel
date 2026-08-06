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
  src/client/authn/email-otp.deno.test.ts \
  src/client/authn/install-state.test.ts \
  src/client/authn/license-lifecycle.test.ts \
  src/client/authn/password.deno.test.ts \
  src/client/authn/secrets.deno.test.ts \
  src/client/authn/signup-validation.deno.test.ts \
  src/client/authn/workers-onboarding.test.ts \
  src/client/authz/ \
  src/client/display-name-uniqueness.test.ts \
  src/client/environments/tcp-udp-ingress.test.ts \
  src/client/environments/validate-docker-external-networks.test.ts \
  src/client/hierarchy-delete.test.ts \
  src/client/managed/apply-prepare-pure.test.ts \
  src/client/managed/backups.test.ts \
  src/client/managed/context.test.ts \
  src/client/managed/logs.test.ts \
  src/client/managed/options.test.ts \
  src/client/managed/serialize.test.ts \
  src/client/org-context-parse.test.ts \
  src/client/principals/assignments.test.ts \
  src/client/principals/serialize.test.ts \
  src/client/projects/catalog/catalog.test.ts \
  src/client/projects/catalog/scaffold.test.ts \
  src/client/projects/empty-setup.test.ts \
  src/client/servers/delete-guards.test.ts \
  src/client/shared.test.ts \
  src/client/storage/serialize.test.ts \
  src/client/system/hierarchy.test.ts \
  src/client/system/operate.test.ts \
  src/client/system/reconcile.test.ts \
  src/client/variables/resolve-inherited.test.ts \
  src/cors.test.ts \
  src/daemon/authn/challenge.test.ts \
  src/daemon/authn/daemon-jwt.test.ts \
  src/daemon/authn/daemon-jwt-keyring.test.ts \
  src/daemon/authn/daemon-state.test.ts \
  src/daemon/authn/server-key.test.ts \
  src/daemon/cell/contracts.test.ts \
  src/daemon/cell/control-plane-monitor.test.ts \
  src/daemon/cell/fleet-presence.test.ts \
  src/daemon/cell/location.test.ts \
  src/daemon/cell/offline-sweep.test.ts \
  src/daemon/cell/postgres-projection.test.ts \
  src/daemon/cell/protocol.test.ts \
  src/daemon/cell/redis/keys.test.ts \
  src/daemon/cell/redis/lua.test.ts \
  src/daemon/cell/socket-health.test.ts \
  src/daemon/cell/stateless-challenge.test.ts \
  src/daemon/metrics/analytics-engine/field-map.test.ts \
  src/daemon/metrics/analytics-engine/sql-api.test.ts \
  src/daemon/metrics/analytics-engine/store.test.ts \
  src/daemon/metrics/clickhouse/client.test.ts \
  src/daemon/metrics/clickhouse/schema.test.ts \
  src/daemon/metrics/clickhouse/store.test.ts \
  src/daemon/metrics/contract.test.ts \
  src/daemon/metrics/disabled-store.test.ts \
  src/daemon/metrics/metric-descriptors.test.ts \
  src/daemon/metrics/status-events.test.ts \
  src/daemon/metrics/query/cache.test.ts \
  src/daemon/metrics/query/resolution.test.ts \
  src/daemon/metrics/query/series-response.test.ts \
  src/daemon/metrics/query/uptime.test.ts \
  src/daemon/metrics/store-selection.test.ts \
  src/daemon/metrics/write-path-parity.test.ts \
  src/daemon/openapi/ca.test.ts \
  src/daemon/openapi/readiness.test.ts \
  src/daemon/openapi/version.test.ts \
  src/daemon/rate-limit/contracts.test.ts \
  src/daemon/rate-limit/inbound-window.test.ts \
  src/daemon/rate-limit/keys.test.ts \
  src/daemon/rate-limit/redis-rate-limiter.test.ts \
  src/db-timeout.test.ts \
  src/db-url.test.ts \
  src/deno-compile-permissions.test.ts \
  src/dev-mode.deno.test.ts \
  src/developer/database-routes-shared.test.ts \
  src/developer/dev-sync-archive.deno.test.ts \
  src/developer/drizzle-studio-bind.test.ts \
  src/developer/local-console-auth.test.ts \
  src/drizzle-kit-config.test.ts \
  src/drizzle-studio-probe.test.ts \
  src/lib/amqp-default-url.test.ts \
  src/lib/commands/command-amqp-topology.test.ts \
  src/lib/commands/deploy-validation.test.ts \
  src/lib/commands/hostname.test.ts \
  src/lib/commands/ids.test.ts \
  src/lib/commands/noop-command-queue.test.ts \
  src/lib/commands/queue.test.ts \
  src/lib/commands/schemas.test.ts \
  src/lib/commands/types.test.ts \
  src/lib/commands/wireguard.test.ts \
  src/lib/commands/workers-queue.test.ts \
  src/lib/compose/ \
  src/lib/datacenter-metadata.test.ts \
  src/lib/datacenter-name-suggestions.test.ts \
  src/lib/datacenter-options.test.ts \
  src/lib/daemon-install-command.deno.test.ts \
  src/lib/db/net-types.test.ts \
  src/lib/db/server-metadata.test.ts \
  src/lib/db/workspace-kind.test.ts \
  src/lib/docker-network-name.test.ts \
  src/lib/email/noop-queue.test.ts \
  src/lib/email/smtp/amqp-topology.test.ts \
  src/lib/email/smtp/smtp-resolve.test.ts \
  src/lib/email/templates.test.ts \
  src/lib/email/validate-address.test.ts \
  src/lib/geo/server-geo.test.ts \
  src/lib/hosting-options.test.ts \
  src/lib/hosting-web-env.test.ts \
  src/lib/ip-address.test.ts \
  src/lib/machine-key.test.ts \
  src/lib/managed/ \
  src/lib/net/vpn-address-allocator.pure.test.ts \
  src/lib/net/vpn-address-allocator.test.ts \
  src/lib/naming.test.ts \
  src/lib/organization-options.test.ts \
  src/lib/principal-options.test.ts \
  src/lib/project-options.test.ts \
  src/lib/resolve-public-base-url.test.ts \
  src/lib/resource-limits.test.ts \
  src/lib/server-capacity.test.ts \
  src/lib/service-options-instances.test.ts \
  src/lib/settings/email-settings.deno.test.ts \
  src/lib/settings/resolver.deno.test.ts \
  src/lib/timezones.test.ts \
  src/lib/tls/ \
  src/lib/update/manifest.test.ts \
  src/node-path.test.ts \
  src/query-cache/passthrough-query-cache.test.ts \
  src/query-cache/read-models/server-detail.test.ts \
  src/query-cache/read-models/servers-list.test.ts \
  src/query-cache/redis-query-cache.test.ts \
  src/runtime-paths.test.ts \
  src/scalar-html.test.ts \
  src/server-paths.deno.test.ts \
  src/server-registry-metadata.test.ts \
  src/server-registry.test.ts \
  src/surfaces.test.ts \
  src/wrangler-hyperdrive-bindings.test.ts

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
