#!/usr/bin/env bash
# Bootstrap co-located dev Postgres from versioned migrations in migrations/.
#
# Empty databases run pnpm migrate (0000_initial_schema.sql). Legacy dev DBs
# created via sync.sh without migration history fall back to seed-catalog only.
#
# Usage (from instance repo root):
#   ./scripts/bootstrap-dev-db.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/db-connect.sh
source "$ROOT/scripts/db-connect.sh"

db_connect_init bootstrap-dev-db
db_connect_build_database_url bootstrap-dev-db

export TURBOPANEL_DATABASE_URL

POSTGRES_CONTAINER="${TURBOPANEL_POSTGRES_CONTAINER:-turbopaneldb}"
POSTGRES_USER="${TURBOPANEL_POSTGRES_USER:-turbopanel}"
POSTGRES_DB="${TURBOPANEL_POSTGRES_DB:-turbopanel}"

organization_table_exists() {
  docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "SELECT to_regclass('public.organization') IS NOT NULL" 2>/dev/null | grep -qx t
}

migrations_recorded() {
  docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "SELECT EXISTS (SELECT 1 FROM public.migration LIMIT 1)" 2>/dev/null | grep -qx t
}

cd "$ROOT"

if organization_table_exists; then
  if migrations_recorded; then
    echo "bootstrap-dev-db: organization table present — running migrate + seed-catalog"
    pnpm migrate
  else
    echo "bootstrap-dev-db: schema present without migration history — repairing resource registry"
    pnpm run seed-catalog
  fi
else
  echo "bootstrap-dev-db: empty database — running migrate + seed-catalog"
  pnpm migrate
fi

echo "bootstrap-dev-db: done"
