#!/usr/bin/env bash
# Standalone Drizzle Studio for turbopanel-dbstudio.service (deno + workers dev).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/db-connect.sh
source "$ROOT/scripts/db-connect.sh"
db_connect_init drizzle-studio-serve

STUDIO_PORT="${TURBOPANEL_DRIZZLE_STUDIO_PORT:-4983}"
STUDIO_HOST="${TURBOPANEL_DRIZZLE_STUDIO_HOST:-127.0.0.1}"
if [[ "$STUDIO_HOST" == localhost ]]; then
  STUDIO_HOST=127.0.0.1
fi
UI_MODE="$(printf '%s' "${TURBOPANEL_UI_MODE:-dev}" | tr '[:upper:]' '[:lower:]')"
CONFIG="$ROOT/.local/drizzle-studio.config.mjs"

if [[ "$UI_MODE" == static ]]; then
  echo "[TurboPanel] Drizzle Studio disabled (TURBOPANEL_UI_MODE=static)" >&2
  exit 0
fi

load_database_url() {
  if [[ -n "${TURBOPANEL_DATABASE_URL:-}" ]]; then
    return 0
  fi
  local runtime_env="${TURBOPANEL_INSTANCE_RUNTIME_ENV:-/etc/turbopanel/instance/runtime.env}"
  if [[ -f "$runtime_env" ]]; then
    local line
    line="$(grep -E '^TURBOPANEL_DATABASE_URL=' "$runtime_env" | tail -1 || true)"
    if [[ -n "$line" ]]; then
      export TURBOPANEL_DATABASE_URL="${line#TURBOPANEL_DATABASE_URL=}"
    fi
  fi
}

load_database_url
db_connect_build_database_url drizzle-studio-serve

"$NODE" "$ROOT/scripts/write-drizzle-studio-config.mjs" "$TURBOPANEL_DATABASE_URL" "$CONFIG"
echo "[TurboPanel] Drizzle Studio listening on http://${STUDIO_HOST}:${STUDIO_PORT}"
echo "[TurboPanel] Open https://local.drizzle.studio?host=localhost&port=${STUDIO_PORT}"

exec "$NODE" "$DRIZZLE_KIT" studio \
  --config "$CONFIG" \
  --host "$STUDIO_HOST" \
  --port "$STUDIO_PORT"
