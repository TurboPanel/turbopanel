# TurboPanel vendored runtime root (POSIX sh).
# Source before referencing managed node/deno/caddy paths.

TURBOPANEL_HOME="${TURBOPANEL_HOME:-/opt/turbopanel}"
TURBOPANEL_RUNTIMES_DIR="${TURBOPANEL_RUNTIMES_DIR:-${TURBOPANEL_HOME}/vendor}"
TURBOPANEL_NODE="${TURBOPANEL_NODE:-${TURBOPANEL_RUNTIMES_DIR}/node/current/bin/node}"
TURBOPANEL_DENO="${TURBOPANEL_DENO:-${TURBOPANEL_RUNTIMES_DIR}/deno/current/deno}"
