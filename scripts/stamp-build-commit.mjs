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
 *
 * It also stamps the release version into `deno.json` and `package.json`
 * (what `src/app/version.ts` reads). The committed number is frozen: releases
 * are numbered from tags, and release.yml stamps them only for the Deno
 * binaries. Like release.yml it writes the plain X.Y.Z, never `-rc.N`:
 *
 * - `staging` / `live` (`WORKERS_CI_BRANCH`): from the promotion merge
 *   commit, whose message carries the PR title ("Release Candidate
 *   0.1.9-rc.2", "Release 0.1.9"). The release tag is only created after
 *   the merge, so this build cannot read it yet.
 * - anything else (trunk → testing), or no such title: the nearest version
 *   tag. An rc tag gives its base; a release tag gives the next patch unless
 *   HEAD is the tagged commit.
 *
 * When neither yields a version, the committed number stays.
 */

import { execFileSync } from 'node:child_process'
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

const PROMOTION_TITLE = /^Release(?: Candidate)? (\d+\.\d+\.\d+)(?:-rc\.\d+)?$/m

/** The X.Y.Z a staging / live promotion merge commit names, or null. */
export function versionFromPromotionMessage(message) {
  return PROMOTION_TITLE.exec(message ?? '')?.[1] ?? null
}

const DESCRIBED_TAG = /^v(\d+)\.(\d+)\.(\d+)(-rc\.\d+)?(-\d+-g[0-9a-f]+)?$/

/**
 * The X.Y.Z trunk is building, from `git describe --tags` output
 * (`v0.1.9-rc.1`, `v0.1.8-4-gabc1234`, `v0.1.8`), or null.
 */
export function versionFromDescribe(described) {
  const m = DESCRIBED_TAG.exec((described ?? '').trim())
  if (!m) return null
  const [, major, minor, patch, rc, distance] = m
  if (rc || !distance) return `${major}.${minor}.${patch}`
  return `${major}.${minor}.${Number(patch) + 1}`
}

const VERSION_FIELD = /("version":\s*)"[^"]*"/

/** Returns the JSON source with its first `"version"` replaced, or null. */
export function stampVersion(source, version) {
  if (!VERSION_FIELD.test(source)) return null
  return source.replace(VERSION_FIELD, `$1"${version}"`)
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** The X.Y.Z this build is, or null; `git` runs one git command, throwing on failure. */
export function resolveBuildVersion(branch, git = runGit) {
  if (branch === 'staging' || branch === 'live') {
    try {
      const version = versionFromPromotionMessage(git(['log', '-1', '--format=%B']))
      if (version) return version
    } catch {
      // No readable HEAD message: the tags below are the fallback.
    }
  }
  try {
    return versionFromDescribe(git(['describe', '--tags', '--match', 'v[0-9]*', 'HEAD']))
  } catch {
    return null
  }
}

function stampVersionFiles(root) {
  const version = resolveBuildVersion(process.env.WORKERS_CI_BRANCH)
  if (!version) {
    console.warn('stamp-build-commit: no release version found; deno.json keeps its number')
    return
  }
  for (const name of ['deno.json', 'package.json']) {
    const file = join(root, name)
    const stamped = stampVersion(readFileSync(file, 'utf8'), version)
    if (stamped === null) {
      console.warn(`stamp-build-commit: no version field in ${name}; not stamping it`)
      continue
    }
    writeFileSync(file, stamped)
  }
  console.log(`stamp-build-commit: version = ${version}`)
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    stampVersionFiles(root)
  } catch (error) {
    console.warn(`stamp-build-commit: version not stamped (${error?.message ?? error})`)
  }
  const commit = normalizeCommit(process.env.WORKERS_CI_COMMIT_SHA)
  if (!commit) {
    console.warn('stamp-build-commit: WORKERS_CI_COMMIT_SHA is not a 40-hex commit; not stamping')
    return
  }
  const file = join(root, 'src', 'app', 'build-info.ts')
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
