#!/usr/bin/env node
/**
 * Keep the committed version number current.
 *
 *   node scripts/set-version.mjs X.Y.Z          rewrite every version field
 *   node scripts/set-version.mjs --check X.Y.Z  change nothing; exit 1 when a
 *                                                file says something else
 *
 * The files: `deno.json` and `package.json` (`version`) and
 * `sonar-project.properties` (`sonar.projectVersion`). Only the one value is
 * replaced in place, so the rest of each file keeps its formatting.
 *
 * Who runs it: right after each release the release bot opens the
 * "chore: start X.Y.Z" pull request made with this script, and it merges
 * itself once its checks pass (Start Next Version does the same for a new
 * minor or major). The
 * canary build in `.github/workflows/release.yml` runs `--check` against the
 * version worked out from the tags and refuses to build when they disagree.
 *
 * Plain node, no dependencies. Exit codes: 0 ok, 1 a file disagrees (or a
 * version field is missing), 2 bad arguments.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/

// Two-space indent: the top-level key only, never a nested "version".
const JSON_VERSION = /^( {2}"version"\s*:\s*")([^"]*)(")/m
const SONAR_VERSION = /^(sonar\.projectVersion=)(.*)()$/m

/** Each committed file that holds the version, and how to find it. */
export const VERSION_FILES = [
  { path: 'deno.json', pattern: JSON_VERSION },
  { path: 'package.json', pattern: JSON_VERSION },
  { path: 'sonar-project.properties', pattern: SONAR_VERSION },
]

/** True for a plain X.Y.Z (no pre-release label, no leading `v`). */
export function isPlainVersion(value) {
  return typeof value === 'string' && PLAIN_VERSION.test(value)
}

/** The version a file's text holds, or null when the field is missing. */
export function readVersion(text, pattern) {
  const m = pattern.exec(text)
  return m ? m[2].trim() : null
}

/** The text with its version replaced, or null when the field is missing. */
export function writeVersion(text, pattern, version) {
  if (!pattern.test(text)) return null
  return text.replace(pattern, (_all, before, _old, after) => `${before}${version}${after}`)
}

/** The one-line refusal printed for a file that disagrees. */
export function disagreement(path, found, version) {
  return (
    `${path} says ${found}, the next version is ${version}: ` +
    `merge the "chore: start ${version}" PR ` +
    `(or run node scripts/set-version.mjs ${version} in a PR)`
  )
}

function parseArgs(argv) {
  const args = [...argv]
  const check = args[0] === '--check'
  if (check) args.shift()
  if (args.length !== 1) return null
  return { check, version: args[0] }
}

/**
 * Run the script against the repo at `root`. Returns the exit code; output
 * goes through `log` / `error` so tests can read it.
 */
export function run(argv, { root, log = console.log, error = console.error }) {
  const parsed = parseArgs(argv)
  if (!parsed) {
    error('usage: node scripts/set-version.mjs [--check] X.Y.Z')
    return 2
  }
  const { check, version } = parsed
  if (!isPlainVersion(version)) {
    error(`set-version: '${version}' is not a plain X.Y.Z version`)
    return 2
  }

  // Read everything first, so a missing field writes nothing at all.
  const files = VERSION_FILES.map(({ path, pattern }) => {
    const file = join(root, path)
    const text = readFileSync(file, 'utf8')
    return { path, pattern, file, text, found: readVersion(text, pattern) }
  })
  const missing = files.filter((f) => f.found === null)
  for (const { path } of missing) error(`${path}: no version field found`)
  if (missing.length > 0) return 1

  let disagrees = false
  for (const { path, pattern, file, text, found } of files) {
    if (found === version) continue
    if (check) {
      error(disagreement(path, found, version))
      disagrees = true
      continue
    }
    writeFileSync(file, writeVersion(text, pattern, version))
    log(`${path}: ${found} -> ${version}`)
  }
  if (disagrees) return 1
  if (check) log(`the committed version is ${version}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  process.exitCode = run(process.argv.slice(2), { root })
}
