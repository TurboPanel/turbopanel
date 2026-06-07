#!/usr/bin/env bash
# Push src/db/schema.ts to the live dev database (no migration files).
#
# Uses drizzle-kit push — applies DDL directly. Does not write drizzle/*.sql.
#
# Credentials default from turbopanel-instance systemd env (dev TCP).
# Override: DATABASE_URL=postgresql://… ./sync.sh
#
# Flags (passed to drizzle-kit push):
#   --force    auto-approve data-loss statements (destructive — dev only)
#   --verbose  print each SQL statement
#
# See src/db/AGENTS.md (schema-first → sync).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_SRC="$ROOT/src/db/schema.ts"
source "$ROOT/scripts/db-connect.sh"
db_connect_init sync.sh

PUSH_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|--verbose)
      PUSH_ARGS+=("$1")
      shift
      ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "sync.sh: unknown option $1 (supported: --force, --verbose)" >&2
      exit 1
      ;;
  esac
done

# Confirm destructive pushes when interactive; drizzle-kit needs a TTY for --strict prompts.
if [[ " ${PUSH_ARGS[*]} " != *" --force "* ]] && [[ -t 0 ]]; then
  PUSH_ARGS+=(--strict)
fi

main() {
  cd "$ROOT"

  if [[ ! -f "$SCHEMA_SRC" ]]; then
    echo "sync.sh: missing $SCHEMA_SRC" >&2
    exit 1
  fi

  db_connect_build_database_url sync.sh

  echo "sync.sh: checking $SCHEMA_SRC…"
  db_connect_verify_schema sync.sh "$SCHEMA_SRC"

  echo "sync.sh: pushing schema to live database (no migration files)…"
  DATABASE_URL="$DATABASE_URL" "$NODE" "$DRIZZLE_KIT" push "${PUSH_ARGS[@]}"

  echo "sync.sh: done — database should match src/db/schema.ts"
}

main "$@"
