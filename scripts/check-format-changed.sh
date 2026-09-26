#!/bin/sh
# Prettier (.prettierrc) is the canonical formatter. Most of the tree predates
# the gate and is not Prettier-formatted yet, so CI checks only the source
# files a change adds or modifies, measured against <base-ref>.
#
#   sh scripts/check-format-changed.sh <base-ref>
set -eu

cd "$(dirname "$0")/.."

base="${1:-}"
if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then
  echo "check-format: no base ref; nothing to compare" >&2
  exit 0
fi

files=$(
  git diff --name-only --diff-filter=ACMR "$base"...HEAD |
    while IFS= read -r file; do
      [ -f "$file" ] || continue
      case "$file" in
        src/*.ts | src/*.tsx | scripts/*.ts | scripts/*.mjs) printf '%s\n' "$file" ;;
        *) ;;
      esac
    done
)

if [ -z "$files" ]; then
  echo "check-format: no changed source files"
  exit 0
fi

# shellcheck disable=SC2086
pnpm exec prettier --check $files
