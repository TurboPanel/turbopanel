#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

UNIT_SRC="/opt/turbopanel/platform/turbopanel/systemd/turbopanel-instance.service"
UNIT_DEST="/etc/systemd/system/turbopanel-instance.service"

chmod 0755 "/opt/turbopanel/platform/turbopanel/scripts/run-instance-tilt.sh"
install -m 0644 "$UNIT_SRC" "$UNIT_DEST"

systemctl daemon-reload
systemctl enable --now turbopanel-instance

echo "turbopanel-instance service installed and started"
echo "status: sudo systemctl status turbopanel-instance"
echo "logs:   sudo journalctl -u turbopanel-instance -f"
