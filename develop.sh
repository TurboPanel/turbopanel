#!/usr/bin/env bash
# TurboPanel development launcher.
#
# Ansible — run by the always-installed daemon — owns ALL installs and updates.
# This script only bootstraps the daemon enough to take over, switches it into
# co-located dev-instance mode, and then tails the journals.
#
# Everything runs under systemd, each service as its dedicated user:
#
#   turbopanel-daemon     turbopanel:turbopanel  (UID 9999, has sudo; runs ansible)
#   turbopanel-instance   instance:turbopanel    (UID 9998, no sudo)
#   turbopanel-caddy      instance:turbopanel    https://<host>:8443
#   turbopanel-ui         instance:turbopanel    Expo web dev server :8081
#
# On startup the daemon runs the instance-dev-install playbook, which installs
# the instance, Caddy, and UI services. To test the Cloudflare Workers path
# instead, run `pnpm dev` (wrangler) in this repo separately.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$(cd "$SCRIPT_DIR/../daemon" && pwd)"
DAEMON_ENV="$DAEMON_DIR/.env"

if [[ ! -d "$DAEMON_DIR" ]]; then
  echo "develop.sh: expected the daemon checkout at $DAEMON_DIR" >&2
  exit 1
fi

# Step 1 — Bootstrap the daemon orchestration runtime (uv -> Python -> ansible).
# This is what lets the daemon run every other install via Ansible.
"$DAEMON_DIR/scripts/bootstrap-orchestration.sh"

# Step 2 — Put the daemon into co-located dev-instance mode. The flag persists
# in the daemon .env so systemd picks it up on every (re)start.
touch "$DAEMON_ENV"
if ! grep -q '^TURBOPANEL_DEV_INSTANCE=' "$DAEMON_ENV"; then
  echo 'TURBOPANEL_DEV_INSTANCE=1' >> "$DAEMON_ENV"
fi
if ! grep -q '^TURBOPANEL_TRUNK_BRANCH=' "$DAEMON_ENV"; then
  echo 'TURBOPANEL_TRUNK_BRANCH=trunk' >> "$DAEMON_ENV"
fi

# Step 3 — Install + start the daemon systemd unit (creates the turbopanel
# user, installs Deno, and reconciles the unit). The daemon then installs the
# instance/Caddy/UI stack via Ansible on startup.
sudo "$DAEMON_DIR/scripts/install-daemon-systemd.sh"

# Step 4 — Startup banner.
CADDY_PORT=8443
cat <<BANNER

-----------------------------------------
TurboPanel dev stack (systemd-managed):
  TurboPanel   @ https://localhost:${CADDY_PORT}  (Caddy, user: instance)
  Instance     @ unix:///run/turbopanel/instance.sock  (user: instance)
  UI (Expo)    @ http://127.0.0.1:8081  (user: instance)
  Daemon       @ (no port, user: turbopanel)

The daemon installs/updates everything via Ansible. Use the admin "Upgrade
System" button (or sync-dev) to update; nothing auto-updates.
=========================================

BANNER

# Step 5 — Follow the journals for all dev services.
exec journalctl -f \
  -u turbopanel-daemon \
  -u turbopanel-instance \
  -u turbopanel-caddy \
  -u turbopanel-ui
