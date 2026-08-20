#!/usr/bin/env node
/**
 * CA-boundary check (CI guard).
 *
 * Organization CA / org TLS library sources (`src/lib/tls/`, `src/client/tls/`)
 * must never reference Platform CA paths. Canonical rule:
 * `src/lib/tls/AGENTS.md`.
 *
 * Usage:
 *   node scripts/check-ca-boundary.mjs
 *   pnpm check:ca-boundary
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url))

const SCAN_ROOTS = [
  path.join(ROOT, 'src/lib/tls'),
  path.join(ROOT, 'src/client/tls'),
]

const FORBIDDEN_TOKENS = [
  'TURBOPANEL_TLS_CA',
  'resolveInstanceTlsCa',
  'ca-bundle.pem',
  'instance-ca.pem',
]

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.turbo',
  'workers',
])

const SKIP_FILENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'deno.lock',
])

function isSkippedPath(rel) {
  return rel === SELF
}

function isSkippedDir(entry, rel) {
  return SKIP_DIR_NAMES.has(entry.name) || isSkippedPath(rel)
}

function isSkippedFile(entry, rel) {
  return SKIP_FILENAMES.has(entry.name) || isSkippedPath(rel)
}

const SCAN_EXTENSIONS = /\.(ts|tsx)$/

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const rel = path.relative(ROOT, abs)
    if (entry.isDirectory()) {
      if (isSkippedDir(entry, rel)) continue
      yield* walk(abs)
    } else if (entry.isFile() && !isSkippedFile(entry, rel)) {
      yield abs
    }
  }
}

function isServerPathsImport(line) {
  return (
    /\bfrom\s+['"][^'"]*server-paths\.ts['"]/.test(line) ||
    /\bimport\s*\(\s*['"][^'"]*server-paths\.ts['"]/.test(line)
  )
}

const failures = []

for (const root of SCAN_ROOTS) {
  for (const file of walk(root)) {
    if (!SCAN_EXTENSIONS.test(file)) continue
    const rel = path.relative(ROOT, file)
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n')

    lines.forEach((line, i) => {
      for (const token of FORBIDDEN_TOKENS) {
        if (line.includes(token)) {
          failures.push(
            `${rel}:${i + 1} references Platform CA token "${token}"`,
          )
        }
      }
      if (isServerPathsImport(line)) {
        failures.push(
          `${rel}:${i + 1} imports server-paths.ts (Platform CA path resolution)`,
        )
      }
    })
  }
}

if (failures.length > 0) {
  console.error('CA boundary check failed:\n')
  for (const failure of failures) {
    console.error(`  \u2717 ${failure}`)
  }
  console.error(
    `\n${failures.length} problem(s) found. Organization CA code may not touch Platform CA paths. ` +
      'See src/lib/tls/AGENTS.md. Do not widen this script\'s allowlist without review — ' +
      'move Platform CA references out of src/lib/tls/ and src/client/tls/ instead.',
  )
  process.exit(1)
}

console.log(
  'check-ca-boundary: Organization CA sources do not reference Platform CA paths.',
)
