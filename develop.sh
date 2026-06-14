#!/usr/bin/env bash
set -euo pipefail

cat <<EOF
develop.sh is no longer the entry point. Use the TurboPanel dev console instead.

  curl -fsSL https://develop.trbp.nl | sh
  cd turbopanel-dev
  ./console

EOF
