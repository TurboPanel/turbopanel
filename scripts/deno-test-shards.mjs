#!/usr/bin/env node
/**
 * Partition the Deno suites walked by scripts/test-coverage.sh into CI shards.
 *
 * The coverage script still walks `src/`, `mailer/`, and `scripts/` when
 * `DENO_SHARD` is unset, and that walk is what check-test-inventory.mjs
 * claims. CI sets `DENO_SHARD` and this script prints the subset, so every
 * suite still runs on every push without a second inventory list.
 *
 *   node scripts/deno-test-shards.mjs --shard hostfree
 *   node scripts/deno-test-shards.mjs --shard api-routes
 *   node scripts/deno-test-shards.mjs --shard db-1
 *   node scripts/deno-test-shards.mjs --shard db-2
 *
 * `api-routes` is src/daemon/api-routes.test.ts alone (the long Postgres
 * file). `hostfree` is every other suite whose filename contains `hostfree`
 * or `pure` (no database). The rest are greedy-packed into `db-1` and
 * `db-2` by measured seconds, heaviest first, so the known slow files do
 * not land on the same runner. Files without a measured weight count as
 * one second.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TEST_ROOTS = ['src', 'mailer', 'scripts']

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.git',
  '.local',
  '.cache',
])

/** Keep in step with the `--ignore=` file paths in scripts/test-coverage.sh. */
export const EXCLUDED = new Set([
  'scripts/billing-test-clock-harness.test.ts',
  'src/daemon/redis-cell.test.ts',
  'src/daemon/ws-handlers.test.ts',
])

export const API_ROUTES_FILE = 'src/daemon/api-routes.test.ts'

export const SHARD_NAMES = ['hostfree', 'api-routes', 'db-1', 'db-2']

/**
 * Wall seconds from the 2026-09-21 trunk log (run 35562075718) for the
 * slow Postgres-backed files that are not api-routes and not host-free.
 * Used only to balance db-1 against db-2.
 */
export const WEIGHTS = {
  'src/lib/sha512-crypt.test.ts': 35,
  'src/client/authn/credentials.test.ts': 33,
  'src/client/managed/routes.test.ts': 31,
  'src/developer/drizzle-studio-spawn.test.ts': 30,
  'src/client/authn/http-helpers.test.ts': 29,
}

const DEFAULT_WEIGHT = 1

export function isWorkersSuite(file) {
  return (
    file.endsWith('.workers.test.ts') ||
    file.endsWith('.workers-e2e.test.ts') ||
    file.endsWith('.entry.test.ts')
  )
}

export function isHostfreeName(file) {
  const base = path.posix.basename(file)
  return base.includes('hostfree') || base.includes('pure')
}

export function weight(file) {
  return WEIGHTS[file] ?? DEFAULT_WEIGHT
}

function collectTests(root, dir, out) {
  const abs = path.join(root, dir)
  if (!fs.existsSync(abs)) return out
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectTests(root, path.posix.join(dir, entry.name), out)
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(path.posix.join(dir, entry.name))
    }
  }
  return out
}

export function isDenoSuite(file) {
  if (EXCLUDED.has(file) || isWorkersSuite(file)) return false
  return TEST_ROOTS.some((root) => file.startsWith(`${root}/`))
}

export function denoSuites(root = ROOT) {
  const found = []
  for (const dir of TEST_ROOTS) collectTests(root, dir, found)
  return found.filter((file) => isDenoSuite(file)).sort((a, b) => a.localeCompare(b))
}

export function assignDbShards(files) {
  const bins = { 'db-1': [], 'db-2': [] }
  const load = { 'db-1': 0, 'db-2': 0 }
  const ranked = [...files].sort((a, b) => {
    const delta = weight(b) - weight(a)
    if (delta !== 0) return delta
    return a.localeCompare(b)
  })
  for (const file of ranked) {
    const dest = load['db-1'] <= load['db-2'] ? 'db-1' : 'db-2'
    bins[dest].push(file)
    load[dest] += weight(file)
  }
  bins['db-1'].sort((a, b) => a.localeCompare(b))
  bins['db-2'].sort((a, b) => a.localeCompare(b))
  return bins
}

export function partitionDenoShards(root = ROOT) {
  const hostfree = []
  const apiRoutes = []
  const db = []
  for (const file of denoSuites(root)) {
    if (file === API_ROUTES_FILE) apiRoutes.push(file)
    else if (isHostfreeName(file)) hostfree.push(file)
    else db.push(file)
  }
  const dbBins = assignDbShards(db)
  return {
    hostfree,
    'api-routes': apiRoutes,
    'db-1': dbBins['db-1'],
    'db-2': dbBins['db-2'],
  }
}

function main() {
  const flag = process.argv.indexOf('--shard')
  const shard = flag === -1 ? undefined : process.argv[flag + 1]
  if (!shard || !SHARD_NAMES.includes(shard)) {
    console.error(
      `usage: node scripts/deno-test-shards.mjs --shard <${SHARD_NAMES.join('|')}>`,
    )
    process.exit(1)
  }
  const files = partitionDenoShards()[shard]
  if (files.length === 0) {
    console.error(`shard ${shard} is empty`)
    process.exit(1)
  }
  process.stdout.write(`${files.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
