/**
 * Shared file-selection rules for the dev-sync source archive.
 *
 * Pure data + helpers (no Deno/Hono imports) so the rules can be unit-tested in
 * the Workers vitest pool without spawning `tar`.
 */

/**
 * Explicit source allowlist for the dev-sync tarball.
 *
 * This mirrors the source artifact that `run.sh` / the `publish-daemon-trunk`
 * workflow ship (`main.ts deno.json deno.lock embedded-orchestration.ts src
 * orchestration scripts`) so an attached daemon receives exactly the same files
 * an official source install would — including the checked-in
 * `orchestration/roles` tree (a subtree of `orchestration`).
 *
 * Building from an allowlist (rather than `.` minus a denylist) guarantees
 * host-local / runtime files such as `.env` are never copied to other nodes.
 */
export const DEV_SYNC_SOURCE_ALLOWLIST = [
  'main.ts',
  'deno.json',
  'deno.lock',
  'embedded-orchestration.ts',
  'src',
  'orchestration',
  'scripts',
] as const

/**
 * Runtime-local / host-specific paths that must never be shipped to another
 * node even if they happen to appear inside an allowlisted directory. Kept as
 * explicit `tar --exclude` patterns so the intent (notably: never ship `.env`)
 * is self-documenting and regression-testable.
 *
 * `orchestration/roles` is intentionally NOT excluded — the checked-in roles
 * tree is part of the source build.
 */
export const DEV_SYNC_RUNTIME_LOCAL_EXCLUDES = [
  '.env',
  '.git',
  'node_modules',
  'logs',
  '.cache',
  'state',
  'cloudflared',
] as const

/**
 * Build the `tar` argument list for a gzipped dev-sync archive of `repo` written
 * to `output`. Excludes come before the positional allowlist entries so they
 * apply to nested matches.
 */
export function buildDevSyncTarArgs(repo: string, output: string): string[] {
  return [
    '-czf',
    output,
    '-C',
    repo,
    ...DEV_SYNC_RUNTIME_LOCAL_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    ...DEV_SYNC_SOURCE_ALLOWLIST,
  ]
}
