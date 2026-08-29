#!/usr/bin/env bash
# Bootstrap co-located dev Postgres from versioned migrations in migrations/.
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
export CI=1

cd "$ROOT"
# `pnpm migrate` preflights the server first (scripts/check-postgres-compat.mjs):
# migrations require PostgreSQL 18+ / a working uuidv7() before drizzle-kit runs.
echo "bootstrap-dev-db: applying migrations"
pnpm migrate
echo "bootstrap-dev-db: done"
