#!/usr/bin/env bash
# Workers dev: start Drizzle Studio (dev UI mode) then wrangler dev — mirrors deno.ts ensureDrizzleStudioInDev.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/db-connect.sh
source "$ROOT/scripts/db-connect.sh"
db_connect_init workers-serve

STUDIO_PORT="${TURBOPANEL_DRIZZLE_STUDIO_PORT:-4983}"
STUDIO_HOST="${TURBOPANEL_DRIZZLE_STUDIO_HOST:-127.0.0.1}"
if [[ "$STUDIO_HOST" == localhost ]]; then
  STUDIO_HOST=127.0.0.1
fi
WRANGLER_PORT="${WRANGLER_DEV_PORT:-18787}"
UI_MODE="$(printf '%s' "${TURBOPANEL_UI_MODE:-dev}" | tr '[:upper:]' '[:lower:]')"
CONFIG="$ROOT/.local/drizzle-studio.config.mjs"
STUDIO_PID=""

cleanup() {
  if [[ -n "$STUDIO_PID" ]] && kill -0 "$STUDIO_PID" 2>/dev/null; then
    kill "$STUDIO_PID" 2>/dev/null || true
    wait "$STUDIO_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

load_workers_database_url() {
  if [[ -f "$ROOT/.env" ]]; then
    local line
    line="$(grep -E '^TURBOPANEL_DATABASE_URL=' "$ROOT/.env" | tail -1 || true)"
    if [[ -n "$line" ]]; then
      export TURBOPANEL_DATABASE_URL="${line#TURBOPANEL_DATABASE_URL=}"
    fi
  fi
}

studio_listening() {
  local code
  code="$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' "http://${STUDIO_HOST}:${STUDIO_PORT}/" 2>/dev/null || echo "000")"
  [[ "$code" != "000" && "$code" -lt 500 ]]
}

wait_for_studio() {
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if studio_listening; then
      return 0
    fi
    if [[ -n "$STUDIO_PID" ]] && ! kill -0 "$STUDIO_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.2
  done
  return 1
}

start_studio_if_dev() {
  if [[ "$UI_MODE" == static ]]; then
    return 0
  fi

  if studio_listening; then
    echo "[TurboPanel] Drizzle Studio already listening on ${STUDIO_PORT}"
    return 0
  fi

  load_workers_database_url
  db_connect_build_database_url workers-serve

  "$NODE" "$ROOT/scripts/write-drizzle-studio-config.mjs" "$DATABASE_URL" "$CONFIG"
  "$NODE" "$DRIZZLE_KIT" studio \
    --config "$CONFIG" \
    --host "$STUDIO_HOST" \
    --port "$STUDIO_PORT" \
    >>"${TURBOPANEL_INSTANCE_LOG:-/opt/turbopanel/platform/instance/logs/instance.log}" 2>&1 &
  STUDIO_PID=$!

  if ! wait_for_studio; then
    echo "[TurboPanel] Drizzle Studio failed to start on port ${STUDIO_PORT}" >&2
    exit 1
  fi

  echo "[TurboPanel] Drizzle Studio ready at https://local.drizzle.studio?host=localhost&port=${STUDIO_PORT}"
}

start_studio_if_dev

exec "$ROOT/node_modules/.bin/wrangler" dev --port "$WRANGLER_PORT" --ip 127.0.0.1
