#!/usr/bin/env node
/**
 * Generate (or rewrite) the Deno / Vitest test inventories.
 *
 * Default (`--write`): suffix-glob inventories. Vitest `test.include` is
 * `.workers.test.ts` / `.workers-e2e.test.ts` / `.entry.test.ts`; Deno walks
 * `src/`, `mailer/`, `scripts/` with `--ignore` for those suffixes and
 * `SERVICE_DEPENDENT` paths.
 *
 * `--files`: rebuild an exhaustive Deno file list from current classification
 * (pre-glob mode). Do not use after phase 7.
 *
 * `scripts/check-test-inventory.mjs` remains the acceptance gate.
 *
 * Usage:
 *   node scripts/generate-test-lists.mjs --write
 *   node scripts/generate-test-lists.mjs --check
 *   node scripts/generate-test-lists.mjs --files --write
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const VITEST_GLOBS = [
  'src/**/*.workers.test.ts',
  'src/**/*.workers-e2e.test.ts',
  'src/**/*.entry.test.ts',
  'mailer/**/*.workers.test.ts',
]

const DENO_IGNORES = [
  '**/*.workers.test.ts',
  '**/*.workers-e2e.test.ts',
  '**/*.entry.test.ts',
]

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

function quotedStrings(source, accept) {
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
    if (accept(token)) out.push(token)
    i = end + 1
  }
  return out
}

function parseArgs(argv) {
  return {
    write: argv.includes('--write'),
    globs: !argv.includes('--files'),
    check: argv.includes('--check') || !argv.includes('--write'),
  }
}

function collectTests(dir, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectTests(path.join(dir, entry.name), out)
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(path.join(dir, entry.name).split(path.sep).join('/'))
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

function parseDenoList(shellSource) {
  const lines = shellSource.split('\n')
  const start = lines.findIndex((line) => line.trimStart().startsWith('deno test '))
  if (start === -1) {
    throw new Error('scripts/test-coverage.sh: could not find the `deno test` invocation')
  }
  const files = []
  let end = start
  for (let i = start; i < lines.length; i += 1) {
    end = i
    const raw = lines[i]
    const line = stripLineContinuation(raw)
    for (const token of splitWs(line)) {
      if (!TEST_ROOTS.some((root) => token.startsWith(`${root}/`))) continue
      if (token.endsWith('.test.ts') || token.endsWith('/')) files.push(token)
    }
    if (!hasLineContinuation(raw)) break
  }
  return { start, end, files }
}

function parseVitestInclude(configSource) {
  const testBlock = configSource.indexOf('test: {')
  if (testBlock === -1) throw new Error('vitest.config.ts: could not find the `test: {` block')
  const open = configSource.indexOf('include: [', testBlock)
  if (open === -1) throw new Error('vitest.config.ts: could not find `test.include`')
  const close = configSource.indexOf(']', open)
  const body = configSource.slice(open, close)
  // Only quoted src/ / mailer/ suite paths — comments like "workerd's"
  // contain apostrophes that would otherwise truncate the list.
  return {
    open,
    close,
    files: quotedStrings(body, (token) => {
      if (!token.endsWith('.test.ts')) return false
      return token.startsWith('src/') || token.startsWith('mailer/')
    }),
  }
}

function loadServiceDependent() {
  const inventoryPath = path.join(ROOT, 'scripts/check-test-inventory.mjs')
  const source = fs.readFileSync(inventoryPath, 'utf8')
  const files = quotedStrings(source, (token) => token.endsWith('.test.ts'))
  return new Set(files)
}

function formatDenoArgs(files) {
  const lines = files.map((file, i) => {
    const suffix = i === files.length - 1 ? '' : ' \\'
    return `  ${file}${suffix}`
  })
  return lines.join('\n')
}

function replaceDenoInvocation(shellSource, argLines) {
  const parsed = parseDenoList(shellSource)
  const lines = shellSource.split('\n')
  const rebuilt =
    `deno test -A --coverage=coverage/deno-profile \\\n  --no-check \\\n${argLines}`
  return [...lines.slice(0, parsed.start), rebuilt, ...lines.slice(parsed.end + 1)].join(
    '\n',
  )
}

function replaceVitestInclude(configSource, entries) {
  const parsed = parseVitestInclude(configSource)
  const indent = '      '
  const body = entries.map((entry, i) => {
    const comma = i === entries.length - 1 ? '' : ','
    return `${indent}'${entry}'${comma}`
  }).join('\n')
  return `${configSource.slice(0, parsed.open)}include: [\n${body}\n    ${
    configSource.slice(parsed.close)
  }`
}

function replaceDenoGlobInvocation(shellSource, serviceDependent) {
  const parsed = parseDenoList(shellSource)
  const lines = shellSource.split('\n')
  const ignores = [
    ...DENO_IGNORES.map((g) => `--ignore=${g}`),
    ...[...serviceDependent].sort((a, b) => a.localeCompare(b)).map(
      (file) => `--ignore=${file}`,
    ),
  ]
  const args = [
    'deno test -A --coverage=coverage/deno-profile \\',
    '  --no-check \\',
    ...ignores.map((flag) => `  ${flag} \\`),
    '  src/ \\',
    '  mailer/ \\',
    '  scripts/',
  ]
  // Fix last ignore/path backslash: last line is scripts/ with no backslash.
  const rebuilt = args.join('\n')
  return [...lines.slice(0, parsed.start), rebuilt, ...lines.slice(parsed.end + 1)].join(
    '\n',
  )
}

function nextInventories(args, shellSource, vitestSource, serviceDependent, discovered, vitestSet) {
  if (args.globs) {
    return {
      nextShell: replaceDenoGlobInvocation(shellSource, serviceDependent),
      nextVitest: replaceVitestInclude(vitestSource, VITEST_GLOBS),
    }
  }
  const denoFiles = discovered.filter((file) => {
    if (serviceDependent.has(file)) return false
    if (vitestSet.has(file)) return false
    return true
  })
  return {
    nextShell: replaceDenoInvocation(shellSource, formatDenoArgs(denoFiles)),
    nextVitest: vitestSource,
  }
}

function writeOrCheck(args, shellPath, vitestPath, shellSource, vitestSource, nextShell, nextVitest) {
  if (args.write) {
    if (nextShell !== shellSource) fs.writeFileSync(shellPath, nextShell)
    if (nextVitest !== vitestSource) fs.writeFileSync(vitestPath, nextVitest)
    console.log(
      args.globs
        ? 'generate-test-lists: wrote suffix globs into test-coverage.sh and vitest.config.ts'
        : 'generate-test-lists: rewrote the Deno inventory from current classification',
    )
    return
  }

  if (nextShell === shellSource && nextVitest === vitestSource) {
    console.log('generate-test-lists: inventories already match')
    return
  }
  console.error('generate-test-lists: inventories are stale (run with --write)')
  process.exit(1)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const shellPath = path.join(ROOT, 'scripts/test-coverage.sh')
  const vitestPath = path.join(ROOT, 'vitest.config.ts')
  const shellSource = fs.readFileSync(shellPath, 'utf8')
  const vitestSource = fs.readFileSync(vitestPath, 'utf8')
  const serviceDependent = loadServiceDependent()
  const discovered = TEST_ROOTS.flatMap((root) => collectTests(root)).sort((a, b) =>
    a.localeCompare(b)
  )
  const vitest = parseVitestInclude(vitestSource)
  const vitestSet = new Set(vitest.files.filter((f) => f.endsWith('.test.ts')))
  const { nextShell, nextVitest } = nextInventories(
    args,
    shellSource,
    vitestSource,
    serviceDependent,
    discovered,
    vitestSet,
  )
  writeOrCheck(args, shellPath, vitestPath, shellSource, vitestSource, nextShell, nextVitest)
}

main()
