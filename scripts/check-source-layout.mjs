#!/usr/bin/env node
/**
 * Source layout lint with a ratchet baseline (CI guard).
 *
 * Rules, all over `src/**`:
 *   - `runtime`: no use of the `Deno` global (calls, `typeof Deno`,
 *     `globalThis.Deno?.`, type positions too) and no Workers
 *     binding (`cloudflare:` imports in any form, `DurableObject*`,
 *     `KVNamespace`, `R2Bucket`, `D1Database`, `Hyperdrive`, `Fetcher`,
 *     `Queue`) in a non-test source file outside the runtime folders
 *     (`src/platform/`, `src/cli/`, `src/test-fixtures/`, `src/app/deno/`,
 *     `src/app/workers/`, `src/features/<name>/deno|workers/`) and the entry
 *     files (`src/deno.ts`, `src/deno-dev.ts`, `src/workers.ts`,
 *     `src/workers-vitest.ts`). Comments and string contents are ignored.
 *   - `size`: a non-test source file has at most MAX_LINES lines.
 *   - `barrel`: `index.ts` / `index.tsx` files are barrels; none may be added.
 *   - `test-name`: a test file is `<name>.<kind>.ts` with `<name>` free of
 *     dots and `<kind>` one of the claimed suffixes below.
 *
 * Every violation that exists today is listed in
 * `scripts/source-layout-baseline.json`. The check fails on a violation that
 * is not listed (or an oversized file that grew), and on a listed entry that
 * is fixed, and on an oversized file whose size is below its recorded count,
 * so the baseline only shrinks. Run `node scripts/check-source-layout.mjs
 * --prune` to drop fixed entries and lower recorded counts; it never adds
 * one.
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
// Runtime places that exist today: platform/, cli/, test-fixtures/, app/deno,
// app/workers and features/<name>/deno|workers (REPORT target layout).
const RUNTIME_DIRS = [
  'src/platform/',
  'src/cli/',
  'src/test-fixtures/',
  'src/app/deno/',
  'src/app/workers/',
]
const RUNTIME_DIR_PATTERN = /^src\/features\/[^/]+\/(?:deno|workers)\//
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
const CLOUDFLARE_IMPORT = /\b(?:from|import)\s*\(?\s*['"]cloudflare:/
const BINDING_PATTERN =
  /(?<![.\w])(?:DurableObject\w*|KVNamespace|R2Bucket|D1Database|Hyperdrive|Fetcher|Queue)\b(?=\s*[<,;)>=|\s])/g
const DECLARATION_BEFORE = /\b(?:class|interface|type|function|const|let|var|enum)\s+$/
// A `/` starts a regex literal after these (or after a keyword such as `return`, `typeof`, `case`, `in`, `of`, `throw`, `await`, `yield`).
const REGEX_PRECEDER =
  /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|throw|await|yield))\s*$/

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

/** Index just past the regex literal starting at `start`, or -1 if none. */
function regexEnd(text, start) {
  let j = start + 1
  let inClass = false
  while (j < text.length && text[j] !== '\n') {
    const c = text[j]
    if (c === '\\') j++
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      j++
      while (/[a-z]/i.test(text[j] ?? '')) j++
      return j
    }
    j++
  }
  return -1
}

/**
 * Single pass over source text. Returns the text with comments removed
 * (`code`, strings intact, used for module specifiers) and with comments
 * removed and string / template literal contents blanked (`bare`, used for
 * identifier matches). `${...}` inside a template stays code.
 */
export function scan(text) {
  let code = ''
  let bare = ''
  const templates = [] // brace depth at each open `${`
  let depth = 0
  let i = 0
  const emit = (c, b) => {
    code += c
    bare += b
  }
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (ch === '/' && REGEX_PRECEDER.test(bare.slice(Math.max(0, bare.length - 12)))) {
      const end = regexEnd(text, i)
      if (end === -1) {
        emit(ch, ch)
        i++
      } else {
        emit(text.slice(i, end), '/r/')
        i = end
      }
    } else if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      emit(text.slice(i, j + 1), ch + ch)
      i = j + 1
    } else if (ch === '`' || (ch === '}' && templates.at(-1) === depth)) {
      if (ch === '}') templates.pop()
      let j = i + 1
      let raw = ch
      while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) {
        raw += text.slice(j, j + (text[j] === '\\' ? 2 : 1))
        j += text[j] === '\\' ? 2 : 1
      }
      if (text[j] === '$') {
        templates.push(depth)
        emit(raw + '${', ch === '`' ? '`${' : '${')
        j += 2
      } else {
        emit(raw + '`', ch === '`' ? '``' : '`')
        j += 1
      }
      i = j
    } else {
      if (ch === '{') depth++
      else if (ch === '}') depth--
      emit(ch, ch)
      i++
    }
  }
  return { code, bare }
}

function usesDeno(bare) {
  return /\bDeno\b/.test(bare)
}

function usesWorkersBinding({ code, bare }) {
  if (CLOUDFLARE_IMPORT.test(code)) return true
  for (const m of bare.matchAll(BINDING_PATTERN)) {
    if (!DECLARATION_BEFORE.test(bare.slice(0, m.index))) return true
  }
  return false
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
    const inRuntimeArea =
      RUNTIME_FILES.has(rel) ||
      RUNTIME_DIRS.some((d) => rel.startsWith(d)) ||
      RUNTIME_DIR_PATTERN.test(rel)
    if (inRuntimeArea) continue
    const scanned = scan(text)
    if (usesDeno(scanned.bare) || usesWorkersBinding(scanned)) found.runtime.push(rel)
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
        } else if (lines < allowed) {
          errors.push(
            `size: ${file} shrank to ${lines} lines (baseline ${allowed}); run --prune to lower the baseline.`
          )
          prunable.size[file] = lines
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
