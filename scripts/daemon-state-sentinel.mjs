#!/usr/bin/env node
/**
 * A stand-in for the co-located daemon's state dir, for CI.
 *
 * A test run once overwrote a dev box's real daemon credentials (license id,
 * license token, server id) with ones from a throwaway database and took the
 * daemon offline. The writers now refuse a non-temp dir under `deno test`
 * (`src/client/authn/colocated-credentials-dir.ts`). This script is the proof
 * that the refusal holds for the whole suite: CI seeds the default state dir
 * (`/var/lib/turbopanel`, writable by the runner, so a write that slipped
 * past the guard would land) with fixed files, runs the Deno shards, then
 * checks that the dir still holds exactly those files with the same bytes.
 * Any write, removal or new entry fails the job.
 *
 *   node scripts/daemon-state-sentinel.mjs seed <dir>
 *   node scripts/daemon-state-sentinel.mjs verify <dir>
 *
 * `seed` refuses a dir that already holds anything other than the sentinel
 * files, and outside `/tmp` it runs only under GitHub Actions, so it can never
 * replace a real daemon's files on a dev box.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** File names the daemon keeps in its state dir, with fixed stand-in bytes. */
export const SENTINEL_FILES = Object.freeze({
  'license.id': 'sentinel-license-id-not-real\n',
  'license.token': 'sentinel-license-value-not-real\n',
  'server.id': 'sentinel-server-id-not-real\n',
  'server-key.json': '{"sentinel":"not-a-real-key"}\n',
  'server-key-id': 'sentinel-server-key-id-not-real\n',
})

/** Every entry under `dir` (relative, sorted), without following links. */
function listEntries(dir) {
  const out = []
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const child = rel ? `${rel}/${name}` : name
      out.push(child)
      if (fs.lstatSync(path.join(dir, child)).isDirectory()) walk(child)
    }
  }
  walk('')
  return out.sort()
}

/**
 * Differences between `dir` and the sentinel, one line each; empty when the
 * dir is exactly the sentinel.
 */
export function sentinelProblems(dir) {
  let stat
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return [`${dir} is missing`]
  }
  if (!stat.isDirectory()) return [`${dir} is not a plain directory`]
  const problems = []
  const expected = Object.keys(SENTINEL_FILES).sort()
  const actual = listEntries(dir)
  for (const name of actual) {
    if (!expected.includes(name)) problems.push(`new entry: ${name}`)
  }
  for (const name of expected) {
    const file = path.join(dir, name)
    if (!actual.includes(name)) {
      problems.push(`removed: ${name}`)
    } else if (!fs.lstatSync(file).isFile()) {
      problems.push(`not a plain file: ${name}`)
    } else if (fs.readFileSync(file, 'utf8') !== SENTINEL_FILES[name]) {
      problems.push(`changed: ${name}`)
    }
  }
  return problems
}

function isUnderTmp(dir) {
  const resolved = path.resolve(dir)
  return resolved.startsWith('/tmp/') || resolved.startsWith('/var/tmp/')
}

/** Write the sentinel files into `dir`. Throws instead of replacing real files. */
export function seedSentinel(dir, env = process.env) {
  if (!isUnderTmp(dir) && env.GITHUB_ACTIONS !== 'true') {
    throw new Error(`refusing to seed ${dir} outside /tmp when not running under GitHub Actions`)
  }
  fs.mkdirSync(dir, { recursive: true })
  const existing = listEntries(dir)
  if (existing.length > 0 && sentinelProblems(dir).length > 0) {
    throw new Error(`refusing to seed ${dir}: it already holds ${existing.join(', ')}`)
  }
  for (const [name, body] of Object.entries(SENTINEL_FILES)) {
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o640 })
  }
}

function main(argv) {
  const [verb, dir] = argv
  if ((verb !== 'seed' && verb !== 'verify') || !dir) {
    console.error('usage: daemon-state-sentinel.mjs seed|verify <dir>')
    return 2
  }
  if (verb === 'seed') {
    seedSentinel(dir)
    console.log(`daemon state sentinel seeded in ${dir}`)
    return 0
  }
  const problems = sentinelProblems(dir)
  if (problems.length === 0) {
    console.log(`daemon state sentinel unchanged in ${dir}`)
    return 0
  }
  console.error(`::error::a test run wrote the daemon state dir ${dir}`)
  for (const line of problems) console.error(`  ${line}`)
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
