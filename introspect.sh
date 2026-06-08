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
source "$ROOT/scripts/db-connect.sh"
db_connect_init introspect.sh

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
    cat "$DRIZZLE_SCHEMA" | grep -v '^$' || true
  } > "$SCHEMA_SRC"

  # drizzle-kit emits invalid JS for the `2fa` table name.
  sed -i 's/export const "2Fa"/export const twoFactor/' "$SCHEMA_SRC" 2>/dev/null || \
    sed -i '' 's/export const "2Fa"/export const twoFactor/' "$SCHEMA_SRC"

  sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$SCHEMA_SRC" 2>/dev/null || \
    sed -i '' -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$SCHEMA_SRC"
}

main() {
  cd "$ROOT"
  db_connect_build_database_url introspect.sh

  echo "introspect.sh: pulling schema from live database…"
  cleanup_drizzle_out
  DATABASE_URL="$DATABASE_URL" "$NODE" "$DRIZZLE_KIT" introspect

  echo "introspect.sh: adopting drizzle/schema.ts → src/db/schema.ts"
  adopt_schema
  cleanup_drizzle_out

  echo "introspect.sh: verifying…"
  db_connect_verify_schema introspect.sh "$SCHEMA_SRC"

  echo "introspect.sh: done — review $SCHEMA_SRC before commit"
}

main "$@"
