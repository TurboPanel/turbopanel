#!/usr/bin/env bash
# Pull the live Postgres schema into src/db/schema.ts (database-first dev workflow).
#
# 1. drizzle-kit introspect  → drizzle/schema.ts
# 2. copy into src/db/schema.ts
# 3. remove ephemeral drizzle/ artifacts
# 4. deno check src/db/schema.ts
#
# Credentials default from turbopanel-instance systemd env (dev TCP).
# Override: DATABASE_URL=postgresql://… ./introspect.sh
#
# See src/db/AGENTS.md for the full workflow (Drizzle Studio → introspect).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_SRC="$ROOT/src/db/schema.ts"
DRIZZLE_OUT="$ROOT/drizzle"
DRIZZLE_SCHEMA="$DRIZZLE_OUT/schema.ts"
DRIZZLE_KIT="$ROOT/node_modules/drizzle-kit/bin.cjs"
INSTANCE_UNIT="${TURBOPANEL_INSTANCE_SERVICE:-turbopanel-instance}"

NODE="${TURBOPANEL_NODE:-/opt/turbopanel/runtimes/node/current/bin/node}"
DENO="${TURBOPANEL_DENO:-/opt/turbopanel/runtimes/deno/current/deno}"

if [[ ! -f "$DRIZZLE_KIT" ]]; then
  echo "introspect.sh: missing $DRIZZLE_KIT — run pnpm install in $ROOT" >&2
  exit 1
fi

if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "introspect.sh: node not found (set TURBOPANEL_NODE)" >&2
  exit 1
fi

load_pg_env_from_unit() {
  if ! systemctl show "$INSTANCE_UNIT" -p Environment --value &>/dev/null; then
    echo "introspect.sh: systemd unit $INSTANCE_UNIT not found" >&2
    return 1
  fi
  # shellcheck disable=SC2046
  eval "$(
    systemctl show "$INSTANCE_UNIT" -p Environment --value \
      | tr ' ' '\n' \
      | grep -E '^TURBOPANEL_PG_(USER|PASSWORD|DB|HOST|PORT|SOCKET)=' \
      | sed 's/^/export /'
  )"
}

build_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    return 0
  fi
  load_pg_env_from_unit

  if [[ -z "${TURBOPANEL_PG_USER:-}" || -z "${TURBOPANEL_PG_PASSWORD:-}" || -z "${TURBOPANEL_PG_DB:-}" ]]; then
    echo "introspect.sh: missing TURBOPANEL_PG_USER/PASSWORD/DB on $INSTANCE_UNIT" >&2
    exit 1
  fi

  if [[ -n "${TURBOPANEL_PG_HOST:-}" ]]; then
    DATABASE_URL="$(
      python3 - <<'PY'
import os, urllib.parse
u = os.environ["TURBOPANEL_PG_USER"]
p = os.environ["TURBOPANEL_PG_PASSWORD"]
h = os.environ["TURBOPANEL_PG_HOST"]
port = os.environ.get("TURBOPANEL_PG_PORT", "5432")
d = os.environ["TURBOPANEL_PG_DB"]
print(f"postgresql://{urllib.parse.quote(u)}:{urllib.parse.quote(p)}@{h}:{port}/{d}")
PY
    )"
    export DATABASE_URL
    return 0
  fi

  if [[ -n "${TURBOPANEL_PG_SOCKET:-}" ]]; then
    echo "introspect.sh: instance uses Unix socket only; introspect needs TCP." >&2
    echo "  Set DATABASE_URL or run on a dev host with postgres_expose_port=true." >&2
    exit 1
  fi

  echo "introspect.sh: set DATABASE_URL or configure TURBOPANEL_PG_HOST on $INSTANCE_UNIT" >&2
  exit 1
}

cleanup_drizzle_out() {
  rm -f "$DRIZZLE_OUT/schema.ts" "$DRIZZLE_OUT/relations.ts" "$DRIZZLE_OUT"/*.sql 2>/dev/null || true
  rm -rf "$DRIZZLE_OUT/meta"
}

adopt_schema() {
  if [[ ! -f "$DRIZZLE_SCHEMA" ]]; then
    echo "introspect.sh: drizzle-kit did not write $DRIZZLE_SCHEMA" >&2
    exit 1
  fi

  {
    printf '%s\n' "/** Introspected from live dev DB (\`./introspect.sh\`). Review style before commit. */"
    printf '\n'
    # Drop drizzle-kit boilerplate imports of sql when unused.
    grep -v '^import { sql }' "$DRIZZLE_SCHEMA" | grep -v '^$' || true
  } > "$SCHEMA_SRC"

  # Trim duplicate blank lines at EOF
  sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$SCHEMA_SRC" 2>/dev/null || \
    sed -i '' -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$SCHEMA_SRC"
}

verify_schema() {
  if [[ -x "$DENO" ]]; then
    "$DENO" check "$SCHEMA_SRC"
  elif command -v deno >/dev/null 2>&1; then
    deno check "$SCHEMA_SRC"
  else
    echo "introspect.sh: deno not found — skipped typecheck (set TURBOPANEL_DENO)" >&2
  fi
}

main() {
  cd "$ROOT"
  build_database_url

  echo "introspect.sh: pulling schema from live database…"
  cleanup_drizzle_out
  DATABASE_URL="$DATABASE_URL" "$NODE" "$DRIZZLE_KIT" introspect

  echo "introspect.sh: adopting drizzle/schema.ts → src/db/schema.ts"
  adopt_schema
  cleanup_drizzle_out

  echo "introspect.sh: verifying…"
  verify_schema

  echo "introspect.sh: done — review $SCHEMA_SRC before commit"
}

main "$@"
