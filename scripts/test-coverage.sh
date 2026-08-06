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
# Usage: sh scripts/test-coverage.sh
# Output: coverage/lcov.info (Vitest + Deno merged for SonarCloud), plus
# coverage/vitest/lcov.info and coverage/deno.lcov for debugging.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf coverage
mkdir -p coverage

echo "==> Vitest (workers pool, Istanbul coverage)"
pnpm exec vitest run --config vitest.config.ts --coverage

if ! grep -q '^SF:' coverage/vitest/lcov.info; then
  echo "Vitest LCOV expected at least one SF: entry" >&2
  exit 1
fi

workspace="${GITHUB_WORKSPACE:-$ROOT}"
workspace="${workspace%/}"

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

echo "==> Deno coverage profile"
# Host-free Deno suites that feed Sonar LCOV (Vitest/workerd cannot emit V8
# coverage). Keep this list lean: pure unit suites + the existing hook set.
# CI uses -A so every suite shares one profile dir (mirrors the daemon repo's
# test:coverage grant).
deno test -A --coverage=coverage/deno-profile \
  --no-check \
  src/admin/reencrypt-secrets.test.ts \
  src/admin/routes.test.ts \
  src/client/authn/auth-rate-limit-http.test.ts \
  src/client/authn/auth-rate-limit.test.ts \
  src/client/authn/browser-write-protection.test.ts \
  src/client/authn/credentials-pam.test.ts \
  src/client/authn/crypto.test.ts \
  src/client/authn/data-encryption.deno.test.ts \
  src/client/authn/email-otp.deno.test.ts \
  src/client/authn/install-state.test.ts \
  src/client/authn/license-lifecycle.test.ts \
  src/client/authn/password.deno.test.ts \
  src/client/authn/secrets.deno.test.ts \
  src/client/authn/signup-validation.deno.test.ts \
  src/client/authn/verification-dev-logging.deno.test.ts \
  src/client/authn/workers-onboarding.test.ts \
  src/client/authz/ \
  src/client/display-name-uniqueness.test.ts \
  src/client/environments/deploy-prepare.test.ts \
  src/client/environments/tcp-udp-ingress.test.ts \
  src/client/environments/validate-docker-external-networks.test.ts \
  src/client/hierarchy-delete.test.ts \
  src/client/managed/allocate-managed-container.test.ts \
  src/client/managed/apply-prepare-pure.test.ts \
  src/client/vpns/apply-prepare-pure.test.ts \
  src/client/managed/backups.test.ts \
  src/client/managed/context.test.ts \
  src/client/managed/logs.test.ts \
  src/client/managed/options.test.ts \
  src/client/managed/serialize.test.ts \
  src/client/openapi/hostings.test.ts \
  src/client/openapi/servers.test.ts \
  src/client/openapi/system.test.ts \
  src/client/org-context-parse.test.ts \
  src/client/principals/assignments.test.ts \
  src/client/principals/serialize.test.ts \
  src/client/projects/catalog/catalog.test.ts \
  src/client/projects/catalog/scaffold.test.ts \
  src/client/projects/empty-setup.test.ts \
  src/client/servers/delete-guards.test.ts \
  src/client/servers/update-status.test.ts \
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
  src/daemon/deno-ws.test.ts \
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
  src/db.test.ts \
  src/deno-compile-permissions.test.ts \
  src/dev-mode.deno.test.ts \
  src/developer/database-routes-shared.test.ts \
  src/developer/dev-sync-archive.deno.test.ts \
  src/developer/drizzle-studio-bind.test.ts \
  src/developer/local-console-auth.test.ts \
  src/developer/system-routes.test.ts \
  src/drizzle-kit-config.test.ts \
  src/drizzle-studio-probe.test.ts \
  src/lib/amqp-default-url.test.ts \
  src/lib/commands/command-amqp-topology.test.ts \
  src/lib/commands/deno-amqp-queue.test.ts \
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

echo "==> Merge Vitest + Deno LCOV for SonarCloud"
python3 - <<'PY'
from __future__ import annotations

from collections import defaultdict
from pathlib import Path


def parse_records(path: Path) -> dict[str, list[str]]:
    records: dict[str, list[str]] = {}
    current_sf: str | None = None
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_sf, current_lines
        if current_sf is None:
            return
        records[current_sf] = current_lines
        current_sf = None
        current_lines = []

    for line in path.read_text().splitlines():
        if line.startswith("SF:"):
            flush()
            current_sf = line[3:]
            current_lines = [line]
        elif current_sf is not None:
            current_lines.append(line)
            if line == "end_of_record":
                flush()

    flush()
    return records


def line_hits(record_lines: list[str]) -> dict[int, int]:
    hits: dict[int, int] = {}
    for line in record_lines:
        if not line.startswith("DA:"):
            continue
        line_no, count = line[3:].split(",", 1)
        hits[int(line_no)] = max(hits.get(int(line_no), 0), int(count))
    return hits


def branch_hits(record_lines: list[str]) -> dict[str, int]:
    hits: dict[str, int] = {}
    for line in record_lines:
        if not line.startswith("BRDA:"):
            continue
        hits[line[5:]] = max(hits.get(line[5:], 0), int(line.rsplit(",", 1)[-1]))
    return hits


def merge_records(all_records: list[dict[str, list[str]]]) -> dict[str, list[str]]:
    merged_lines: dict[str, list[str]] = defaultdict(list)
    for records in all_records:
        for sf, lines in records.items():
            merged_lines[sf].append(lines)

    output: dict[str, list[str]] = {}
    for sf, record_groups in merged_lines.items():
        line_hits_merged: dict[int, int] = {}
        branch_hits_merged: dict[str, int] = {}
        for lines in record_groups:
            for line_no, count in line_hits(lines).items():
                line_hits_merged[line_no] = max(line_hits_merged.get(line_no, 0), count)
            for key, count in branch_hits(lines).items():
                branch_hits_merged[key] = max(branch_hits_merged.get(key, 0), count)

        body: list[str] = [f"SF:{sf}"]
        for line in record_groups[0]:
            if line.startswith(("SF:", "DA:", "LH:", "LF:", "BRDA:", "BRF:", "BRH:", "end_of_record")):
                continue
            body.append(line)

        for line_no in sorted(line_hits_merged):
            body.append(f"DA:{line_no},{line_hits_merged[line_no]}")
        body.append(f"LF:{len(line_hits_merged)}")
        body.append(f"LH:{sum(1 for count in line_hits_merged.values() if count > 0)}")

        if branch_hits_merged:
            for key in sorted(branch_hits_merged):
                body.append(f"BRDA:{key},{branch_hits_merged[key]}")
            body.append(f"BRF:{len(branch_hits_merged)}")
            body.append(
                f"BRH:{sum(1 for count in branch_hits_merged.values() if count > 0)}"
            )

        body.append("end_of_record")
        output[sf] = body

    return output


sources = [
    parse_records(Path("coverage/vitest/lcov.info")),
    parse_records(Path("coverage/deno.lcov")),
]
merged = merge_records(sources)
out_lines: list[str] = []
for sf in sorted(merged):
    out_lines.extend(merged[sf])
Path("coverage/lcov.info").write_text("\n".join(out_lines) + "\n")
PY

if ! grep -q '^SF:src/daemon/cell/do.ts' coverage/lcov.info; then
  echo "Merged LCOV expected SF:src/daemon/cell/do.ts" >&2
  exit 1
fi

if bad="$(grep -E '^SF:(/|file:)' coverage/lcov.info || true)" && [ -n "$bad" ]; then
  echo "Merged LCOV SF paths must be repo-relative" >&2
  printf '%s\n' "$bad" | head -n 20
  exit 1
fi

echo "Coverage LCOV ready: coverage/lcov.info (+ coverage/vitest/lcov.info, coverage/deno.lcov)"
