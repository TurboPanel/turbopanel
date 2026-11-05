#!/usr/bin/env node
/**
 * Workers ACME boundary check (CI guard).
 *
 * The High Availability control plane (the Workers build, entry
 * `src/workers.ts`) never talks to Let's Encrypt: only the daemon on a
 * serving server orders organization certificates, and only the self-hosted
 * control plane orders its own. This guard keeps the ACME client out of the
 * Workers build. Not to be confused with the instance ACME boundary
 * (`check-instance-acme-boundary.mjs`), which keeps instance and
 * organization certificate settings apart.
 *
 *   1. `src/lib/acme/**` is imported only from self-hosted-only code
 *      (`src/platform/deno/**`, `src/deno.ts`, `src/deno-dev.ts`) or from
 *      itself. Test files and `*.test.support.ts` never ship and are left out.
 *   2. Walking the code imports of `src/workers.ts`, no edge reaches
 *      `src/lib/acme/**`.
 *   3. No file reachable from `src/workers.ts` contains a Let's Encrypt ACME
 *      directory host name (production or staging).
 *
 * Only code imports count: `import type` and `export type` are erased before
 * bundling and cannot carry code or an address into the build.
 *
 * `FROZEN_ACME_IMPORTERS` names the shared files that still import the client
 * while the work that removes them lands. The list may only shrink: an entry
 * that no longer imports `src/lib/acme` fails until it is taken off, and the
 * fixture test pins the list so a new entry fails CI. `WORKERS_REACHABLE`
 * is the part of it that the Workers build may still reach.
 *
 * Usage:
 *   node scripts/check-workers-acme-boundary.mjs
 *   pnpm check:workers-acme-boundary
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ACME_DIR = 'src/lib/acme'
const WORKERS_ENTRY = 'src/workers.ts'
const SELF_HOSTED_ONLY = ['src/platform/deno', 'src/deno.ts', 'src/deno-dev.ts', ACME_DIR]

/** Shared files that still import the ACME client. Shrink only. */
export const FROZEN_ACME_IMPORTERS = Object.freeze([
  'src/features/organizations/acme-terms.ts',
  'src/features/tls/dns-certificates/account.ts',
  'src/features/tls/dns-certificates/issuance.ts',
  'src/features/tls/dns-certificates/messages.ts',
  'src/features/tls/dns-certificates/steps.ts',
  'src/features/tls/dns-certificates/timing.ts',
])

/** The frozen entries the Workers build may still reach. Shrink only. */
export const WORKERS_REACHABLE = Object.freeze(['src/features/organizations/acme-terms.ts'])

/** The Let's Encrypt ACME directory hosts, production and staging. */
export const DIRECTORY_HOST = /\bacme(?:-staging)?-v02\.api\.letsencrypt\.org\b/

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

/** Where an `import` or `export` keyword starts a statement. */
const STATEMENT_KEYWORD = /(?:^|[\s;])(?:import|export)\b/g
const DYNAMIC_IMPORT = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g

/**
 * The relative specifier a static `import`/`export` statement starting at
 * `from` names, or null for a type-only one or a statement with no module
 * (`export const x = '...'`). A plain scan instead of one large pattern.
 */
function staticSpecifierAt(text, from) {
  let quote = from
  while (quote < text.length && text[quote] !== "'" && text[quote] !== '"') quote += 1
  if (quote >= text.length) return null
  const head = text.slice(from, quote).trim()
  if (head.includes(';') || head.includes('(') || head.includes('=')) return null
  // A later keyword starts its own statement (a comment that says "import").
  if (/\b(?:import|export)\b/.test(head)) return null
  if (head !== '' && !/\bfrom$/.test(head)) return null
  if (/^type\b/.test(head)) return null
  const end = text.indexOf(text[quote], quote + 1)
  if (end === -1) return null
  const spec = text.slice(quote + 1, end)
  return spec.startsWith('./') || spec.startsWith('../') ? spec : null
}

function under(rel, prefix) {
  return rel === prefix || rel.startsWith(`${prefix}/`)
}

function isTestOnly(rel) {
  return /\.test\.tsx?$/.test(rel) || /\.test\.support\.tsx?$/.test(rel)
}

function walkTs(root, dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(entry.name)) walkTs(root, abs, out)
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
  return out
}

function resolveSpecifier(root, fromRel, spec) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  const cleaned = joined.endsWith('/') ? joined.slice(0, -1) : joined
  for (const candidate of [cleaned, `${cleaned}.ts`, `${cleaned}.tsx`, `${cleaned}/index.ts`]) {
    const abs = path.join(root, candidate)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return candidate
  }
  return cleaned
}

/** The files `rel` imports as code (type-only imports left out). */
export function codeImportsOf(root, rel, text) {
  const out = []
  for (const m of text.matchAll(STATEMENT_KEYWORD)) {
    const spec = staticSpecifierAt(text, m.index + m[0].length)
    if (spec !== null) out.push(resolveSpecifier(root, rel, spec))
  }
  for (const m of text.matchAll(DYNAMIC_IMPORT)) out.push(resolveSpecifier(root, rel, m[1]))
  return out
}

function readSource(root, rel) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return fs.readFileSync(abs, 'utf8')
}

function importsAcme(root, rel, text) {
  return codeImportsOf(root, rel, text).some((target) => under(target, ACME_DIR))
}

function lintImporters(root, failures) {
  for (const rel of walkTs(root, path.join(root, 'src'))) {
    if (isTestOnly(rel) || SELF_HOSTED_ONLY.some((allowed) => under(rel, allowed))) continue
    if (FROZEN_ACME_IMPORTERS.includes(rel)) continue
    const text = readSource(root, rel)
    if (text !== null && importsAcme(root, rel, text)) {
      failures.push(`${rel} imports ${ACME_DIR}, which only self-hosted code may import`)
    }
  }
  for (const rel of FROZEN_ACME_IMPORTERS) {
    const text = readSource(root, rel)
    if (text === null || !importsAcme(root, rel, text)) {
      failures.push(
        `${rel} no longer imports ${ACME_DIR}: take it off FROZEN_ACME_IMPORTERS (the list only shrinks)`
      )
    }
  }
}

/** Checks one Workers-reachable file and returns the imports to follow. */
function visitWorkersFile(root, rel, text, failures) {
  if (DIRECTORY_HOST.test(text)) {
    failures.push(
      `${rel} names a Let's Encrypt directory host and is reachable from ${WORKERS_ENTRY}`
    )
  }
  const next = []
  for (const target of codeImportsOf(root, rel, text)) {
    if (!under(target, ACME_DIR)) next.push(target)
    else if (!WORKERS_REACHABLE.includes(rel)) {
      failures.push(`${WORKERS_ENTRY} reaches ${target} through ${rel}`)
    }
  }
  return next
}

function lintWorkersGraph(root, failures) {
  if (readSource(root, WORKERS_ENTRY) === null) return
  const seen = new Set()
  const stack = [WORKERS_ENTRY]
  while (stack.length > 0) {
    const rel = stack.pop()
    if (seen.has(rel) || !rel.startsWith('src/') || isTestOnly(rel)) continue
    const text = readSource(root, rel)
    if (text === null) continue
    seen.add(rel)
    stack.push(...visitWorkersFile(root, rel, text, failures))
  }
  for (const rel of WORKERS_REACHABLE) {
    if (!seen.has(rel)) {
      failures.push(
        `${rel} is no longer reachable from ${WORKERS_ENTRY}: take it off WORKERS_REACHABLE (the list only shrinks)`
      )
    }
  }
}

/**
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function checkWorkersAcmeBoundary(options = {}) {
  const root = options.root ?? ROOT
  const failures = []
  lintImporters(root, failures)
  lintWorkersGraph(root, failures)
  return [...new Set(failures)].sort((a, b) => a.localeCompare(b))
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

function main() {
  const failures = checkWorkersAcmeBoundary()
  if (failures.length > 0) {
    console.error('Workers ACME boundary check failed:\n')
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    console.error(
      `\n${failures.length} problem(s) found. The High Availability build never talks to ` +
        "Let's Encrypt. See scripts/check-workers-acme-boundary.mjs. Do not grow its lists."
    )
    process.exit(1)
  }
  console.log(
    `check-workers-acme-boundary: ${ACME_DIR} and the Let's Encrypt directory hosts stay out of ${WORKERS_ENTRY}.`
  )
}

if (isDirectRun()) main()
