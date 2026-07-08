#!/bin/sh
# Create (or print) the testing cached Hyperdrive config for wrangler.jsonc env.testing.
# Requires: CLOUDFLARE_API_TOKEN or `wrangler login`.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN="${TURBOPANEL_NODE:-/opt/turbopanel/vendor/node/current/bin/node}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ]; then
  echo "node is required to run ensure-testing-hyperdrive-cached.mjs" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/ensure-testing-hyperdrive-cached.mjs" "$@"
