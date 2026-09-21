#!/usr/bin/env node
/**
 * Import-boundary lint (CI guard). Rules enable as the destination
 * directories appear — a missing folder is not a failure.
 *
 *   - `src/lib/**` imports only `lib/`, `db/` types (not `db/connection.ts`),
 *     and `contracts/`. No surfaces, no `features/`, no `platform/` drivers,
 *     no `getDb`.
 *   - `src/features/**` and `src/lib/**` never import a surface
 *     (`client/`, `admin/`, `developer/`, `webhook/`, `daemon/`, `install/`,
 *     `app/`, `cli/`).
 *   - `src/platform/deno/**` is unreachable from `src/workers.ts`.
 *   - `src/platform/workers/**` is unreachable from `src/deno.ts`.
 *
 * Usage:
 *   node scripts/check-import-boundaries.mjs
 *   pnpm check:import-boundaries
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.turbo',
  '.local',
  '.cache',
])

const SURFACES = new Set([
  'client',
  'admin',
  'developer',
  'webhook',
  'daemon',
  'install',
  'app',
  'cli',
])

function existsDir(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

function walkTs(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      walkTs(abs, out)
    } else if (
      entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
    ) {
      out.push(abs)
    }
  }
  return out
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function posixRel(abs) {
  return toPosix(path.relative(ROOT, abs))
}

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveSpecifier(fromRel, spec) {
  const fromDir = path.posix.dirname(fromRel)
  const joined = path.posix.normalize(path.posix.join(fromDir, spec))
  const cleaned = stripTrailingSlash(joined)
  const candidates = [
    cleaned,
    `${cleaned}.ts`,
    `${cleaned}.tsx`,
    `${cleaned}/index.ts`,
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(ROOT, candidate))) return candidate
  }
  return cleaned
}

function isWordChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') || ch === '_'
}

function skipSpaceAndOpenParen(text, start) {
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '(') {
      i += 1
      continue
    }
    break
  }
  return i
}

function collectQuotedAfter(text, keyword) {
  const specs = []
  let search = 0
  while (search < text.length) {
    const idx = text.indexOf(keyword, search)
    if (idx === -1) break
    const before = idx === 0 ? '' : text[idx - 1]
    if (before && isWordChar(before)) {
      search = idx + keyword.length
      continue
    }
    const j = skipSpaceAndOpenParen(text, idx + keyword.length)
    const quote = text[j]
    if (quote !== "'" && quote !== '"') {
      search = idx + keyword.length
      continue
    }
    const end = text.indexOf(quote, j + 1)
    if (end === -1) break
    const spec = text.slice(j + 1, end)
    if (spec.startsWith('.')) specs.push(spec)
    search = end + 1
  }
  return specs
}

function hasWord(text, word) {
  let search = 0
  while (search <= text.length - word.length) {
    const idx = text.indexOf(word, search)
    if (idx === -1) return false
    const before = idx === 0 ? '' : text[idx - 1]
    const afterIdx = idx + word.length
    const after = afterIdx < text.length ? text[afterIdx] : ''
    if (!isWordChar(before) && !isWordChar(after)) return true
    search = idx + word.length
  }
  return false
}

function importsOf(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  return [...collectQuotedAfter(text, 'from'), ...collectQuotedAfter(text, 'import')]
}

function reachableFrom(entryRel) {
  const seen = new Set()
  const stack = [entryRel]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current?.startsWith('src/') || seen.has(current)) continue
    if (!fs.existsSync(path.join(ROOT, current))) continue
    if (current.endsWith('.test.ts') || current.endsWith('.test.tsx')) continue
    seen.add(current)
    for (const spec of importsOf(current)) {
      if (!spec.startsWith('.')) continue
      stack.push(resolveSpecifier(current, spec))
    }
  }
  return seen
}

function under(rel, prefix) {
  return rel === prefix || rel.startsWith(`${prefix}/`)
}

function isAdmittedKernel(rel) {
  if (!under(rel, 'src/lib')) return false
  if (under(rel, 'src/lib/db')) return false
  const rest = rel.slice('src/lib/'.length)
  const first = rest.split('/')[0]
  if (!rest.includes('/')) return true
  return first === 'http' || first === 'tls' || first === 'secrets'
}

function lintLibImport(rel, spec, failures) {
  if (!spec.startsWith('.')) return
  const target = resolveSpecifier(rel, spec)
  if (!target.startsWith('src/')) return
  const top = target.slice('src/'.length).split('/')[0]
  if (SURFACES.has(top)) {
    failures.add(`${rel} (lib) imports surface ${target}`)
  }
  if (top === 'features') {
    failures.add(`${rel} (lib) imports feature ${target}`)
  }
  if (top === 'platform') {
    failures.add(`${rel} (lib) imports platform driver ${target}`)
  }
  if (target === 'src/db/connection.ts') {
    failures.add(`${rel} (lib) imports db connection ${target}`)
  }
}

function lintLibKernel(srcFiles, failures) {
  for (const rel of srcFiles.filter((f) => isAdmittedKernel(f))) {
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    if (hasWord(text, 'getDb')) {
      failures.add(`${rel} (lib) references getDb`)
    }
    for (const spec of importsOf(rel)) {
      lintLibImport(rel, spec, failures)
    }
  }
}

function lintFeatureSurfaces(srcFiles, failures) {
  for (const rel of srcFiles.filter((f) => under(f, 'src/features'))) {
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue
    for (const spec of importsOf(rel)) {
      if (!spec.startsWith('.')) continue
      const target = resolveSpecifier(rel, spec)
      if (!target.startsWith('src/')) continue
      const top = target.slice('src/'.length).split('/')[0]
      if (SURFACES.has(top)) {
        failures.add(`${rel} (feature) imports surface ${target}`)
      }
    }
  }
}

function lintPlatformReachability(failures) {
  const platformDenoExists = existsDir('src/platform/deno')
  const platformWorkersExists = existsDir('src/platform/workers')
  if (platformDenoExists && fs.existsSync(path.join(ROOT, 'src/workers.ts'))) {
    for (const rel of reachableFrom('src/workers.ts')) {
      if (under(rel, 'src/platform/deno')) {
        failures.add(`src/workers.ts reaches platform/deno via ${rel}`)
      }
    }
  }
  if (platformWorkersExists && fs.existsSync(path.join(ROOT, 'src/deno.ts'))) {
    for (const rel of reachableFrom('src/deno.ts')) {
      if (under(rel, 'src/platform/workers')) {
        failures.add(`src/deno.ts reaches platform/workers via ${rel}`)
      }
    }
  }
}

function main() {
  const failures = new Set()
  const srcFiles = walkTs(SRC).map(posixRel)

  const libKernelRuleOn = existsDir('src/lib/secrets')
  // Feature→surface waits until consumer helpers move with the consumer
  // (phase 3). `src/features/` exists from phase 1 (server-registry) while
  // that file still imports client/daemon helpers.
  const featuresSurfaceRuleOn = existsDir('src/features/commands')

  // Kernel admission turns on once secrets live in lib/ (phase 2). Until
  // phase 3, compose/commands/email/… still sit under src/lib — only the
  // admitted kernel (loose files + http/tls/secrets) is gated.
  if (libKernelRuleOn) lintLibKernel(srcFiles, failures)
  if (featuresSurfaceRuleOn) lintFeatureSurfaces(srcFiles, failures)
  lintPlatformReachability(failures)

  if (failures.size > 0) {
    console.error('Import boundary check failed:\n')
    for (const failure of [...failures].sort((a, b) => a.localeCompare(b))) {
      console.error(`  ✗ ${failure}`)
    }
    console.error(
      `\n${failures.size} problem(s). Kernel/feature/platform layers must not cross ` +
        'surfaces or each other. See AGENTS.md (Layout) and scripts/check-import-boundaries.mjs.',
    )
    process.exit(1)
  }

  console.log('check-import-boundaries: layer imports stay within the admitted graph.')
}

main()
