#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export HOME="${HOME:-/opt/turbopanel}"
export PATH="${HOME}/runtimes/deno/current:${HOME}/runtimes/caddy/current:${HOME}/runtimes/node/current/bin:/usr/local/bin:${PATH}"

PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup SIGINT SIGTERM EXIT

# Step 1 — Install Deno
if [[ ! -x "${HOME}/runtimes/deno/current/deno" ]]; then
  DENO_TMP="${HOME}/runtimes/deno/.install"
  rm -rf "$DENO_TMP"
  mkdir -p "$DENO_TMP"
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$DENO_TMP" sh
  VERSION="$("$DENO_TMP/bin/deno" --version | head -n1 | awk '{print $2}')"
  install -d -m 0755 "${HOME}/runtimes/deno/${VERSION}"
  mv "$DENO_TMP/bin/deno" "${HOME}/runtimes/deno/${VERSION}/deno"
  rm -rf "$DENO_TMP"
  ln -sfn "${HOME}/runtimes/deno/${VERSION}" "${HOME}/runtimes/deno/current"
  ln -sfn "${HOME}/runtimes/deno/current/deno" /usr/local/bin/deno
fi

# Step 2 — Install Caddy
echo "Note: Node.js is required for Caddy download (scripts/download-caddy.mjs)"
node scripts/download-caddy.mjs

# Step 3 — Clone or update the daemon repo
if [[ -d ../daemon/.git ]]; then
  git -C ../daemon fetch origin trunk
  git -C ../daemon reset --hard origin/trunk
else
  git clone --branch trunk https://github.com/turbopanel/turbopanel-daemon ../daemon
fi

# Step 4 — Socket directory setup
node scripts/ensure-socket-dir.mjs

# Step 5 — Generate TLS certificates
node scripts/generate-self-signed-cert.mjs

# Step 6 — Startup banner
CADDY_PORT=8443
SOCKET_PATH="/run/turbopanel/turbopanel.sock"

echo ""
echo "-----------------------------------------"
echo "Services:"
echo "  TurboPanel  @ https://localhost:${CADDY_PORT}  (Caddy)"
while IFS= read -r ip; do
  [[ -z "$ip" ]] && continue
  if [[ "$ip" == *:* ]]; then
    host="[$ip]"
  else
    host="$ip"
  fi
  echo "              @ https://${host}:${CADDY_PORT}  (LAN)"
done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -3)
echo "    /api/*, /ws  -> Deno     @ unix://${SOCKET_PATH}"
echo "    everything else -> static UI  @ ../ui/dist"
echo "  Daemon      @ (no port)"
echo ""
echo "Press Ctrl+C to stop all services"
echo "========================================="

# Step 7 — Start background processes and trap cleanup
CADDY_PORT=8443 TURBOPANEL_SOCKET_DIAL=run/turbopanel/turbopanel.sock TURBOPANEL_UI_MODE=static \
  caddy run --config Caddyfile --adapter caddyfile &
PIDS+=($!)

(cd ../daemon && deno run --allow-net --allow-sys=networkInterfaces,hostname --allow-read --allow-write --allow-run --allow-env --env-file=.env main.ts) &
PIDS+=($!)

# Instance omits TURBOPANEL_INSTANCE_SERVICE so POST /api/system/upgrade returns
# 503 (no managed restart under develop.sh; use git pull + Ctrl+C/restart instead).
deno run --allow-env --allow-sys=networkInterfaces --allow-read=/run/turbopanel,../daemon,./certs --allow-write=/run/turbopanel --allow-run=git src/deno.ts &
PIDS+=($!)
wait "${PIDS[-1]}"
