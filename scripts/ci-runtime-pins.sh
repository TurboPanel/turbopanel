#!/bin/sh
# Read the Node or Deno runtime pin from a turbopaneld checkout.
#
# Those numbers live in the daemon role defaults, which the dev console and
# run.sh are tested against. Workflows call this instead of copying them.
#
#   scripts/ci-runtime-pins.sh <daemon-root> node
#   scripts/ci-runtime-pins.sh <daemon-root> deno
set -eu

root=${1:-}
key=${2:-}
case "$key" in
  node)
    file=$root/orchestration/roles/node-runtime/defaults/main.yml
    var=node_version
    ;;
  deno)
    file=$root/orchestration/roles/deno-runtime/defaults/main.yml
    var=deno_version
    ;;
  *)
    echo "ci-runtime-pins: usage: scripts/ci-runtime-pins.sh <daemon-root> node|deno" >&2
    exit 1
    ;;
esac

if [ ! -f "$file" ]; then
  echo "ci-runtime-pins: missing $file" >&2
  exit 1
fi

version=$(sed -n "s/^${var}: \"\\([0-9][0-9.]*\\)\".*/\\1/p" "$file" | head -n 1)
if [ -z "$version" ]; then
  echo "ci-runtime-pins: no ${var} in $file" >&2
  exit 1
fi
printf '%s\n' "$version"
