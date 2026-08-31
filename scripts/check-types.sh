#!/bin/sh
# Type-check the Deno surface, including the test files.
#
# `deno task test:*` runs with `--no-check`, so nothing else typechecks the
# tests — that is how ~150 errors accumulated there unnoticed. This closes it.
#
# Two kinds of file are excluded, both because they belong to the Workers
# toolchain (`pnpm test:do`) rather than to `deno check`:
#   - anything importing `vitest` or `cloudflare:test`;
#   - anything tagged `@needs-workers-globals`, i.e. reaching a module typed
#     against Workers ambient globals (`CloudflareBindings`, `DurableObjectStub`).
# Those globals cannot be supplied to Deno: `@cloudflare/workers-types`
# redeclares `Request` / `Response` / `fetch` and collides with `lib.deno.ns`,
# and hand-declaring the names instead collides with the real workers-types in
# the editor (they are declared there as a type alias and a class, so neither
# merges with a local interface).
set -eu

cd "$(dirname "$0")/.."

deno check src/deno.ts src/app.ts

# Enumerate from the worktree, not from the index alone: `--others` picks up
# test files that are new and not yet staged, and the `-f` guard drops paths
# still recorded in the index whose file has been deleted or moved. Either skew
# used to be silent — a missing file aborted the whole check, a new one was
# never checked at all.
tests=$(
  git ls-files --cached --others --exclude-standard 'src/*.test.ts' 'src/**/*.test.ts' |
    while IFS= read -r file; do
      [ -f "$file" ] || continue
      grep -qE "from ['\"](vitest|cloudflare:test)['\"]|@needs-workers-globals" "$file" ||
        printf '%s\n' "$file"
    done
)

if [ -z "$tests" ]; then
  echo "check-types: no Deno test files found" >&2
  exit 1
fi

# shellcheck disable=SC2086
deno check $tests
