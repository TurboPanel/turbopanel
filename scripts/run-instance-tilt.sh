#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/opt/turbopanel}"
export PATH="/usr/local/bin:${HOME}/runtimes/node/current/bin:${HOME}/runtimes/deno/current:${HOME}/runtimes/caddy/current:${PATH}"

cd /opt/turbopanel/platform/turbopanel
exec tilt up deno --stream
