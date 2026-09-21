#!/usr/bin/env node
/**
 * Test inventory check (CI guard).
 *
 * This repo runs its suites through two suffix-partitioned runners:
 *
 *   - `scripts/test-coverage.sh` -- Deno suites (V8 coverage). Walks `src/`,
 *     `mailer/`, and `scripts/` while ignoring Workers suffixes and
 *     `SERVICE_DEPENDENT` paths.
 *   - `vitest.config.ts` `test.include` -- suffix globs
 *     (`.workers.test.ts`, `.workers-e2e.test.ts`, `.entry.test.ts`) for
 *     Workers/Durable-Object suites under `@cloudflare/vitest-pool-workers`.
 *   - `SERVICE_DEPENDENT` below -- suites deliberately left out of both,
 *     because they need Redis / a live Stripe sandbox that CI does not start.
 *
 * A new `*.test.ts` that matches no runner never executes and never appears
 * in `coverage/lcov.info`. That is the failure this guard exists to make loud.
 *
 * Checks:
 *   1. every `*.test.ts` is claimed by exactly one bucket;
 *   2. no list entry points at a file that no longer exists (stale);
 *   3. no file is claimed by two buckets (double-run / split attribution).
 *   4. `SERVICE_DEPENDENT` stays an explicit path+reason map.

 * Companion guard to `scripts/check-workers-bundle.mjs` and
 * `scripts/check-vocabulary.mjs`.
 *
 * Usage:
 *   node scripts/check-test-inventory.mjs
 *   pnpm check:test-inventory
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Roots scanned for suites. Keep in step with `sonar.sources` /
// `sonar.tests` in sonar-project.properties.
const TEST_ROOTS = ['src', 'scripts']

// Directories that never hold runnable suites.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.git',
  '.local',
  '.cache',
])

/**
 * Suites intentionally excluded from both runners because they need a
 * backing service CI does not start. Each entry must say which service and
 * how to run it locally -- an undocumented entry here is indistinguishable
 * from the drift this guard is meant to catch.
 */
const SERVICE_DEPENDENT = new Map([
  [
    'src/daemon/redis-cell.test.ts',
    'Needs a live Redis. Run locally with `deno test -A src/daemon/redis-cell.test.ts` against a dev Redis.',
  ],
  [
    'src/daemon/ws-handlers.test.ts',
    'Needs a live Redis (cell registry fan-out). Run locally against a dev Redis.',
  ],
  [
    'scripts/billing-test-clock-harness.test.ts',
    'Needs a live Stripe sandbox with a test-mode key, test clocks, and a catalogue entered ' +
      'under Admin \u2192 Tiers (one active priced S3 and S5, both verifying). Run manually: ' +
      'TURBOPANEL_STRIPE_SECRET_KEY=sk_test_... TURBOPANEL_DATABASE_URL=... ' +
      'deno test -A scripts/billing-test-clock-harness.test.ts ' +
      '(or `deno task billing:test-clocks`).',
  ],
])

/** Recursively collect `*.test.ts` under `dir`, as repo-relative paths. */
function collectTests(dir, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectTests(path.join(dir, entry.name), out)
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

function hasLineContinuation(raw) {
  return raw.trimEnd().endsWith('\\')
}

function stripLineContinuation(raw) {
  const trimmed = raw.trimEnd()
  return (trimmed.endsWith('\\') ? trimmed.slice(0, -1) : trimmed).trim()
}

function splitWs(line) {
  const tokens = []
  let cur = ''
  for (const ch of line) {
    if (ch === ' ' || ch === '\t') {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) tokens.push(cur)
  return tokens
}

function quotedTestPaths(source) {
  const out = []
  let i = 0
  while (i < source.length) {
    const quote = source[i]
    if (quote !== "'" && quote !== '"') {
      i += 1
      continue
    }
    const end = source.indexOf(quote, i + 1)
    if (end === -1) break
    const token = source.slice(i + 1, end)
    if (token.endsWith('.test.ts') || token.includes('*')) out.push(token)
    i = end + 1
  }
  return out
}

/**
 * Parse the argument list of the `deno test` invocation in
 * `scripts/test-coverage.sh`. Only the backslash-continued block is read, so
 * paths inside the surrounding Python heredocs are never mistaken for
 * suites.
 */
function parseDenoList(shellSource) {
  const lines = shellSource.split('\n')
  const start = lines.findIndex((line) => line.trimStart().startsWith('deno test '))
  if (start === -1) {
    throw new Error('scripts/test-coverage.sh: could not find the `deno test` invocation')
  }
  const files = new Set()
  const dirs = new Set()
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i]
    const line = stripLineContinuation(raw)
    for (const token of splitWs(line)) {
      if (!TEST_ROOTS.some((root) => token.startsWith(`${root}/`))) continue
      if (token.endsWith('/')) dirs.add(token)
      else if (token.endsWith('.test.ts')) files.add(token)
    }
    if (!hasLineContinuation(raw)) break
  }
  return { files, dirs }
}

/** Parse the `test.include` array out of `vitest.config.ts`. */
function parseVitestInclude(configSource) {
  const testBlock = configSource.indexOf('test: {')
  if (testBlock === -1) throw new Error('vitest.config.ts: could not find the `test: {` block')
  const open = configSource.indexOf('include: [', testBlock)
  if (open === -1) throw new Error('vitest.config.ts: could not find `test.include`')
  const close = configSource.indexOf(']', open)
  const body = configSource.slice(open, close)
  return new Set(quotedTestPaths(body))
}

function isGlobPattern(entry) {
  return entry.includes('*')
}

function isWorkersSuite(file) {
  return (
    file.endsWith('.workers.test.ts') ||
    file.endsWith('.workers-e2e.test.ts') ||
    file.endsWith('.entry.test.ts')
  )
}

const shellSource = fs.readFileSync(path.join(ROOT, 'scripts/test-coverage.sh'), 'utf8')
const configSource = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8')

const deno = parseDenoList(shellSource)
const vitest = parseVitestInclude(configSource)
const globMode = [...vitest].some((entry) => isGlobPattern(entry))
const discovered = TEST_ROOTS.flatMap((root) => collectTests(root)).sort(
  (a, b) => a.localeCompare(b),
)

const problems = []

// (2) Stale entries -- a listed path that no longer exists. `deno test` and
// vitest both hard-fail on these, so they break the suite rather than
// silently skipping, but naming the file is faster than reading a stack.
for (const file of deno.files) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    problems.push(`stale entry in scripts/test-coverage.sh: ${file} (no such file)`)
  }
}
for (const dir of deno.dirs) {
  if (!fs.existsSync(path.join(ROOT, dir))) {
    problems.push(`stale entry in scripts/test-coverage.sh: ${dir} (no such directory)`)
  }
}
for (const file of vitest) {
  if (isGlobPattern(file)) continue
  if (!fs.existsSync(path.join(ROOT, file))) {
    problems.push(`stale entry in vitest.config.ts test.include: ${file} (no such file)`)
  }
}
for (const file of SERVICE_DEPENDENT.keys()) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    problems.push(
      `stale entry in SERVICE_DEPENDENT (scripts/check-test-inventory.mjs): ${file} (no such file)`,
    )
  }
}

const claimedByDeno = (file) => {
  if (SERVICE_DEPENDENT.has(file)) return false
  if (globMode && isWorkersSuite(file)) return false
  if (deno.files.has(file)) return true
  return [...deno.dirs].some((dir) => file.startsWith(dir))
}

const claimedByVitest = (file) => {
  if (globMode) return isWorkersSuite(file)
  return vitest.has(file)
}

// (1) + (3) Every discovered suite is claimed exactly once.
for (const file of discovered) {
  const buckets = []
  if (claimedByDeno(file)) buckets.push('scripts/test-coverage.sh (Deno)')
  if (claimedByVitest(file)) buckets.push('vitest.config.ts test.include (Workers)')
  if (SERVICE_DEPENDENT.has(file)) buckets.push('SERVICE_DEPENDENT')

  if (buckets.length === 0) {
    problems.push(
      `unclaimed suite: ${file}\n` +
        '    It runs in no CI path and contributes nothing to coverage/lcov.info.\n' +
        '    Name Deno suites `*.test.ts` / `*.hostfree.test.ts` / `*.deno.test.ts`.\n' +
        '    Name Workers/Durable-Object suites `*.workers.test.ts` (or\n' +
        '    `*.workers-e2e.test.ts` / `*.entry.test.ts`). If it needs a service\n' +
        '    CI does not start, add it to SERVICE_DEPENDENT in\n' +
        '    scripts/check-test-inventory.mjs with the reason.',
    )
  } else if (buckets.length > 1) {
    problems.push(
      `suite claimed by ${buckets.length} buckets: ${file}\n    ${buckets.join('\n    ')}`,
    )
  }
}

if (problems.length > 0) {
  console.error('Test inventory check failed:\n')
  for (const problem of problems) console.error(`  - ${problem}\n`)
  console.error(
    `${problems.length} problem(s). Every *.test.ts must be claimed by exactly one runner.`,
  )
  process.exit(1)
}

const workersCount = globMode
  ? discovered.filter((file) => isWorkersSuite(file)).length
  : vitest.size
const serviceCount = SERVICE_DEPENDENT.size
const denoCount = discovered.length - workersCount - serviceCount

console.log(
  `Test inventory OK: ${discovered.length} suites ` +
    `(${denoCount} Deno, ${workersCount} Workers, ${serviceCount} service-dependent).`,
)
