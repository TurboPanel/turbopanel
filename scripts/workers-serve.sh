#!/usr/bin/env bash
# Workers dev: wrangler dev (Drizzle Studio runs in turbopanel-dbstudio.service).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WRANGLER_PORT="${WRANGLER_DEV_PORT:-18787}"

exec "$ROOT/node_modules/.bin/wrangler" dev --port "$WRANGLER_PORT" --ip 127.0.0.1
