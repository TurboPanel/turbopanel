#!/usr/bin/env node
/**
 * Stamp the deploying commit into `BUILD_INFO.commit` (src/app/build-info.ts)
 * inside Cloudflare Workers Builds, so `GET /api/health` names the commit even
 * when the deploy command is a plain `wrangler deploy` that passes no
 * `--var TURBOPANEL_REVISION`.
 *
 * Wired as wrangler.jsonc `build.command`, which wrangler runs before it
 * bundles on every `deploy` / `versions upload` / `dev`. Workers Builds exposes
 * the commit as `WORKERS_CI_COMMIT_SHA` in the build container only; anywhere
 * that variable is absent (local `wrangler dev`, CI, a developer's deploy) the
 * command in wrangler.jsonc skips this script entirely, so the tracked source
 * never changes outside the throwaway build checkout.
 *
 * A malformed value is reported and skipped rather than failing the deploy:
 * the worst case is `revision.commit: "unknown"`, which is what a deploy
 * without this script reports anyway. `TURBOPANEL_REVISION` still wins at
 * runtime (see `resolveInstanceRevision`).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_INFO_COMMIT =
  /(export const BUILD_INFO: InstanceRevision = \{\n\s*commit: )'[0-9a-f]*',/

/** Returns the stamped source, or null when the stamp site is missing. */
export function stampBuildCommit(source, commit) {
  if (!BUILD_INFO_COMMIT.test(source)) return null
  return source.replace(BUILD_INFO_COMMIT, `$1'${commit}',`)
}

/** A full 40-hex git commit, lower-cased; anything else is null. */
export function normalizeCommit(value) {
  const sha = (value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

function main() {
  const commit = normalizeCommit(process.env.WORKERS_CI_COMMIT_SHA)
  if (!commit) {
    console.warn('stamp-build-commit: WORKERS_CI_COMMIT_SHA is not a 40-hex commit; not stamping')
    return
  }
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'build-info.ts')
  const stamped = stampBuildCommit(readFileSync(file, 'utf8'), commit)
  if (stamped === null) {
    console.warn(
      'stamp-build-commit: BUILD_INFO.commit not found in src/app/build-info.ts; not stamping'
    )
    return
  }
  writeFileSync(file, stamped)
  console.log(`stamp-build-commit: BUILD_INFO.commit = ${commit}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
