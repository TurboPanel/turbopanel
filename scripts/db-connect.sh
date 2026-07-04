# Shared Postgres connection helpers for drizzle-kit scripts.
# Source from repo root: source "$(dirname …)/scripts/db-connect.sh"
#
# Sets: TURBOPANEL_DATABASE_URL (from env or turbopanel-instance unit), NODE, DRIZZLE_KIT, DENO, ROOT
db_connect_init() {
  local caller="${1:-db-connect}"
  # shellcheck source=scripts/runtime-paths.sh
  source "$(dirname "${BASH_SOURCE[0]}")/runtime-paths.sh"
  # Caller (introspect.sh / sync.sh) lives at repo root; workers-serve.sh sets ROOT first.
  if [[ -z "${ROOT:-}" ]]; then
    ROOT="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  fi
  DRIZZLE_KIT="$ROOT/node_modules/drizzle-kit/bin.cjs"
  INSTANCE_UNIT="${TURBOPANEL_INSTANCE_SERVICE:-turbopanel-instance}"
  NODE="${TURBOPANEL_NODE}"
  DENO="${TURBOPANEL_DENO}"

  if [[ ! -f "$DRIZZLE_KIT" ]]; then
    echo "$caller: missing $DRIZZLE_KIT — run pnpm install in $ROOT" >&2
    return 1
  fi

  if [[ ! -x "$NODE" ]]; then
    NODE="$(command -v node || true)"
  fi
  if [[ ! -x "$DENO" ]]; then
    DENO="$(command -v deno || true)"
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
  local url
  # systemd quotes Environment values that contain special characters (@, ?, etc.).
  url="$(
    systemctl show "$INSTANCE_UNIT" -p Environment --value \
      | sed -n 's/.*TURBOPANEL_DATABASE_URL=\([^"]*\).*/\1/p'
  )"
  if [[ -n "$url" ]]; then
    export TURBOPANEL_DATABASE_URL="$url"
    return 0
  fi
  return 1
}

db_connect_load_from_runtime_env() {
  local caller="${1:-db-connect}"
  if [[ -n "${TURBOPANEL_DATABASE_URL:-}" ]]; then
    return 0
  fi
  # shellcheck source=scripts/runtime-env-paths.sh
  source "$(dirname "${BASH_SOURCE[0]}")/runtime-env-paths.sh"
  local runtime_env
  runtime_env="$(runtime_env_path)"
  if [[ ! -f "$runtime_env" ]]; then
    return 1
  fi
  local line
  line="$(grep -E '^TURBOPANEL_DATABASE_URL=' "$runtime_env" | tail -1 || true)"
  if [[ -n "$line" ]]; then
    export TURBOPANEL_DATABASE_URL="${line#TURBOPANEL_DATABASE_URL=}"
    return 0
  fi
  return 1
}

db_connect_build_database_url() {
  local caller="${1:-db-connect}"
  if [[ -n "${TURBOPANEL_DATABASE_URL:-}" ]]; then
    export TURBOPANEL_DATABASE_URL
    return 0
  fi
  db_connect_load_from_runtime_env "$caller" || true
  if [[ -n "${TURBOPANEL_DATABASE_URL:-}" ]]; then
    export TURBOPANEL_DATABASE_URL
    return 0
  fi
  db_connect_load_pg_env_from_unit "$caller"

  if [[ -n "${TURBOPANEL_DATABASE_URL:-}" ]]; then
    export TURBOPANEL_DATABASE_URL
    return 0
  fi

  echo "$caller: missing TURBOPANEL_DATABASE_URL (set env or configure on $INSTANCE_UNIT)" >&2
  return 1
}

db_connect_verify_schema() {
  local caller="${1:-db-connect}"
  local schema_file="${2:-$ROOT/src/lib/db/schema.ts}"
  if [[ -x "$DENO" ]]; then
    "$DENO" check "$schema_file"
  elif command -v deno >/dev/null 2>&1; then
    deno check "$schema_file"
  else
    echo "$caller: deno not found — skipped typecheck (set TURBOPANEL_DENO)" >&2
  fi
}
