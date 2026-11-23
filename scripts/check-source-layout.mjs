#!/usr/bin/env node
/**
 * Source layout lint with a ratchet baseline (CI guard).
 *
 * Rules, all over `src/**`:
 *   - `runtime`: no `Deno.*` use and no Workers binding (`cloudflare:*`
 *     imports, `DurableObject*`, `KVNamespace`, `R2Bucket`, `D1Database`,
 *     `Hyperdrive`, `Fetcher`, `Queue`) in a non-test source file outside the
 *     runtime folders (`src/platform/`, `src/developer/`, `src/cli/`,
 *     `src/test-fixtures/`) and the entry files (`src/deno.ts`,
 *     `src/deno-dev.ts`, `src/workers.ts`, `src/workers-vitest.ts`).
 *   - `size`: a non-test source file has at most MAX_LINES lines.
 *   - `barrel`: `index.ts` / `index.tsx` files are barrels; none may be added.
 *   - `test-name`: a test file is `<name>.<kind>.ts` with `<name>` free of
 *     dots and `<kind>` one of the claimed suffixes below.
 *
 * Every violation that exists today is listed in
 * `scripts/source-layout-baseline.json`. The check fails on a violation that
 * is not listed (or an oversized file that grew), and on a listed entry that
 * is fixed, so the baseline only shrinks. Run
 * `node scripts/check-source-layout.mjs --prune` to drop fixed entries; it
 * never adds one.
 *
 * Usage:
 *   node scripts/check-source-layout.mjs
 *   pnpm check:source-layout
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const BASELINE = path.join(ROOT, 'scripts/source-layout-baseline.json')

const MAX_LINES = 1500
const RUNTIME_DIRS = ['src/platform/', 'src/developer/', 'src/cli/', 'src/test-fixtures/']
const RUNTIME_FILES = new Set([
  'src/deno.ts',
  'src/deno-dev.ts',
  'src/workers.ts',
  'src/workers-vitest.ts',
])
const TEST_KINDS = [
  'hostfree.test',
  'deno.test',
  'workers.test',
  'workers-e2e.test',
  'entry.test',
  'test.support',
  'test',
]
const RULES = ['runtime', 'size', 'barrel', 'test-name']
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.wrangler', '.local'])
const RUNTIME_PATTERN =
  /\bDeno\.|from\s+['"]cloudflare:|\b(?:DurableObject\w*|KVNamespace|R2Bucket|D1Database|Hyperdrive|Fetcher|Queue)\b(?=\s*[<,;)>=|\s])/

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(entry.name)) walk(abs, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(abs)
    }
  }
  return out
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function testKind(name) {
  const base = name.replace(/\.tsx?$/, '')
  for (const kind of TEST_KINDS) {
    if (base.endsWith(`.${kind}`)) return { kind, stem: base.slice(0, -kind.length - 1) }
  }
  return null
}

/** @returns {{runtime: string[], size: Record<string, number>, barrel: string[], 'test-name': string[]}} */
export function collectViolations(root = ROOT) {
  const found = { runtime: [], size: {}, barrel: [], 'test-name': [] }
  for (const abs of walk(path.join(root, 'src')).sort()) {
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const name = path.basename(rel)
    if (name.endsWith('.d.ts')) continue
    const parsed = testKind(name)
    const isTest = parsed !== null || /\.(test|spec)\./.test(name)
    if (isTest) {
      if (!parsed || parsed.stem.includes('.') || /\.spec\./.test(name))
        found['test-name'].push(rel)
      continue
    }
    if (/^index\.tsx?$/.test(name)) found.barrel.push(rel)
    const text = fs.readFileSync(abs, 'utf8')
    const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
    if (lines > MAX_LINES) found.size[rel] = lines
    const inRuntimeArea = RUNTIME_FILES.has(rel) || RUNTIME_DIRS.some((d) => rel.startsWith(d))
    if (!inRuntimeArea && RUNTIME_PATTERN.test(stripComments(text))) found.runtime.push(rel)
  }
  return found
}

function readBaseline() {
  const empty = { runtime: [], size: {}, barrel: [], 'test-name': [] }
  if (!fs.existsSync(BASELINE)) return empty
  return { ...empty, ...JSON.parse(fs.readFileSync(BASELINE, 'utf8')) }
}

export function compare(found, base) {
  const errors = []
  const prunable = { runtime: [], size: {}, barrel: [], 'test-name': [] }
  for (const rule of RULES) {
    if (rule === 'size') {
      for (const [file, lines] of Object.entries(found.size)) {
        const allowed = base.size[file]
        if (allowed === undefined) {
          errors.push(`size: ${file} has ${lines} lines (max ${MAX_LINES}); split it.`)
        } else if (lines > allowed) {
          errors.push(
            `size: ${file} grew to ${lines} lines (baseline ${allowed}); it may only shrink.`
          )
        } else {
          prunable.size[file] = lines
        }
      }
      for (const file of Object.keys(base.size)) {
        if (!(file in found.size)) {
          errors.push(
            `size: ${file} is under ${MAX_LINES} lines or gone but still baselined; remove it from the baseline.`
          )
        }
      }
      continue
    }
    const listed = new Set(base[rule])
    const current = new Set(found[rule])
    for (const file of current) {
      if (listed.has(file)) prunable[rule].push(file)
      else errors.push(`${rule}: ${file} is a new violation.`)
    }
    for (const file of listed) {
      if (!current.has(file)) {
        errors.push(
          `${rule}: ${file} is fixed or gone but still baselined; remove it from the baseline.`
        )
      }
    }
  }
  return { errors, prunable }
}

export function serialize(data) {
  const sorted = {
    runtime: [...data.runtime].sort(),
    size: Object.fromEntries(Object.entries(data.size).sort(([a], [b]) => a.localeCompare(b))),
    barrel: [...data.barrel].sort(),
    'test-name': [...data['test-name']].sort(),
  }
  return JSON.stringify(sorted, null, 2) + '\n'
}

function main() {
  const { errors, prunable } = compare(collectViolations(), readBaseline())
  if (process.argv.includes('--prune')) {
    fs.writeFileSync(BASELINE, serialize(prunable))
    const remaining = errors.filter((e) => /new violation|grew to|has \d+ lines/.test(e))
    for (const e of remaining) console.error(e)
    console.log('check-source-layout: baseline pruned.')
    process.exit(remaining.length > 0 ? 1 : 0)
  }
  if (errors.length > 0) {
    console.error('check-source-layout: layout violations')
    for (const e of errors) console.error(`  ${e}`)
    console.error(
      'Fix new violations. Remove fixed entries with `node scripts/check-source-layout.mjs --prune`. See docs/source-layout.md.'
    )
    process.exit(1)
  }
  console.log('check-source-layout: no new layout violations; the baseline matches the tree.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
