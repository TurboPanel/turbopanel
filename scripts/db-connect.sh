# Shared Postgres connection helpers for drizzle-kit scripts.
# Source from repo root: source "$(dirname …)/scripts/db-connect.sh"
#
# Sets: DATABASE_URL (unless already set), NODE, DRIZZLE_KIT, DENO, ROOT
db_connect_init() {
  local caller="${1:-db-connect}"
  # Caller (introspect.sh / sync.sh) lives at repo root; this file is scripts/db-connect.sh.
  ROOT="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  DRIZZLE_KIT="$ROOT/node_modules/drizzle-kit/bin.cjs"
  INSTANCE_UNIT="${TURBOPANEL_INSTANCE_SERVICE:-turbopanel-instance}"
  NODE="${TURBOPANEL_NODE:-/opt/turbopanel/runtimes/node/current/bin/node}"
  DENO="${TURBOPANEL_DENO:-/opt/turbopanel/runtimes/deno/current/deno}"

  if [[ ! -f "$DRIZZLE_KIT" ]]; then
    echo "$caller: missing $DRIZZLE_KIT — run pnpm install in $ROOT" >&2
    return 1
  fi

  if [[ ! -x "$NODE" ]]; then
    NODE="$(command -v node || true)"
  fi
  if [[ -z "$NODE" ]]; then
    echo "$caller: node not found (set TURBOPANEL_NODE)" >&2
    return 1
  fi
}

db_connect_load_pg_env_from_unit() {
  local caller="${1:-db-connect}"
  if ! systemctl show "$INSTANCE_UNIT" -p Environment --value &>/dev/null; then
    echo "$caller: systemd unit $INSTANCE_UNIT not found" >&2
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

db_connect_build_database_url() {
  local caller="${1:-db-connect}"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    return 0
  fi
  db_connect_load_pg_env_from_unit "$caller"

  if [[ -z "${TURBOPANEL_PG_USER:-}" || -z "${TURBOPANEL_PG_PASSWORD:-}" || -z "${TURBOPANEL_PG_DB:-}" ]]; then
    echo "$caller: missing TURBOPANEL_PG_USER/PASSWORD/DB on $INSTANCE_UNIT" >&2
    return 1
  fi

  if [[ -n "${TURBOPANEL_PG_SOCKET:-}" ]]; then
    # drizzle.config.ts uses object credentials for socket mode.
    return 0
  fi

  if [[ -z "${TURBOPANEL_PG_HOST:-}" ]]; then
    echo "$caller: set DATABASE_URL or configure TURBOPANEL_PG_SOCKET/HOST on $INSTANCE_UNIT" >&2
    return 1
  fi

  DATABASE_URL="$(
    python3 - <<'PY'
import os, urllib.parse
u = os.environ["TURBOPANEL_PG_USER"]
p = os.environ["TURBOPANEL_PG_PASSWORD"]
port = os.environ.get("TURBOPANEL_PG_PORT", "5432")
d = os.environ["TURBOPANEL_PG_DB"]
host = os.environ["TURBOPANEL_PG_HOST"].strip()
print(f"postgresql://{urllib.parse.quote(u)}:{urllib.parse.quote(p)}@{host}:{port}/{d}")
PY
  )"
  export DATABASE_URL
  return 0
}

db_connect_verify_schema() {
  local caller="${1:-db-connect}"
  local schema_file="${2:-$ROOT/src/db/schema.ts}"
  if [[ -x "$DENO" ]]; then
    "$DENO" check "$schema_file"
  elif command -v deno >/dev/null 2>&1; then
    deno check "$schema_file"
  else
    echo "$caller: deno not found — skipped typecheck (set TURBOPANEL_DENO)" >&2
  fi
}
