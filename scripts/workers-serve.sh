#!/usr/bin/env bash
# Workers dev: wrangler dev (Drizzle Studio runs in turbopanel-dbstudio.service).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WRANGLER_PORT="${WRANGLER_DEV_PORT:-18787}"
RUNTIME_ENV="${TURBOPANEL_INSTANCE_RUNTIME_ENV:-/opt/turbopanel/platform/config/instance/runtime.env}"
RUNTIME_DEV_VARS="${TURBOPANEL_INSTANCE_RUNTIME_DEV_VARS:-/opt/turbopanel/platform/config/instance/runtime.dev-vars}"

link_wrangler_env_file() {
  local src="$1"
  local dest="$2"
  [[ -f "$src" ]] || return 0
  ln -sf "$src" "$dest"
}

# Wrangler dev reads checkout-root `.env` and `.dev.vars`; managed secrets live
# under platform config (runtime.env / runtime.dev-vars).
link_wrangler_env_file "$RUNTIME_ENV" "$ROOT/.env"
link_wrangler_env_file "$RUNTIME_DEV_VARS" "$ROOT/.dev.vars"

load_runtime_dev_vars() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    case "$line" in
      *=*) export "$line" ;;
    esac
  done < "$file"
}

load_runtime_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    case "$line" in
      *=*) export "$line" ;;
    esac
  done < "$file"
}

load_runtime_env "$RUNTIME_ENV"
load_runtime_dev_vars "$RUNTIME_DEV_VARS"

exec "$ROOT/node_modules/.bin/wrangler" dev --port "$WRANGLER_PORT" --ip 127.0.0.1
