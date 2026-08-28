#!/usr/bin/env node
/**
 * Vocabulary check (CI guard).
 *
 * Scans human-authored source, scripts, and maintainer docs for forbidden
 * daemon-as-agent phrasing left over from before the daemon build-identity
 * rename (`agent` -> `daemonBuild`; see `src/daemon/cell/protocol.ts`) and
 * Apple-associated glass product copy. The daemon is a "daemon" / "host
 * daemon", never an "agent" -- that word is reserved for coding-agent
 * tooling (`AGENTS.md`, `.agents/skills`) and unrelated third-party terms
 * (HTTP `User-Agent`, npm package names). Shell chrome is "frosted chrome".
 *
 * Companion guard to `scripts/check-workers-bundle.mjs` -- keep the
 * forbidden-phrase list and allowlist in sync with the sibling checks in
 * `../turbopaneld/scripts/check-vocabulary.ts`,
 * `../website/scripts/check-vocabulary.mjs`,
 * `../ui/src/lib/vocabulary.ts`, and
 * `../.github/scripts/check-vocabulary.sh`.
 *
 * Usage:
 *   node scripts/check-vocabulary.mjs
 *   pnpm check:vocabulary
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url))

// Exact phrases, matched case-insensitively as substrings. Extend this list
// as new daemon-as-agent or Apple-associated chrome regressions are found;
// keep the sibling repo copies aligned.
const FORBIDDEN_PHRASES = [
  'turbopanel agent',
  'node agent',
  'agent host',
  'agent identity',
  'agent commit',
  'server.daemon.projection.agent',
  // Spaced/hyphenated Apple product copy. CamelCase expo-glass-effect
  // identifiers (`isLiquidGlassAvailable`) do not match these phrases.
  'liquid glass',
  'liquid-glass',
  // Machine-brochure marketing vocabulary. TurboPanel copy uses plain words
  // (see website AGENTS.md "Messaging"); stems catch suffixed forms.
  'seamless',
  'effortless',
  'empower',
  'revolutioniz',
  'supercharg',
  'game-chang',
  'next-generation',
  'all-in-one',
]

// Lines that must never be flagged, even if a forbidden phrase substring
// appears (defensive -- none of the phrases above currently collide with
// these, but keep the guard broad-list-safe as it grows).
const ALLOWLIST_LINE_PATTERNS = [
  /user-agent/i, // HTTP User-Agent header
  /\.agents\/skills/i, // installed agent-skill packs
  /^\s*#+\s*agent\b/i, // AGENTS.md coding-agent policy headings (e.g. "### Agent policy")
  /\bcoding[- ]agent\b/i,
  /@scalar\/agent-chat|agent-base|agent-cli-detector|https-proxy-agent/i, // dependency names
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
  'THIRD_PARTY_NOTICES.md',
])

// Generated type declarations -- never hand-authored.
const GENERATED_TYPE_FILES = new Set(['worker-configuration.d.ts', 'cloudflare-env.d.ts'])

/** Vendored/generated trees and skill packs that must never be scanned. */
function isSkippedPath(rel) {
  return (
    /(^|\/)migrations(\/|$)/.test(rel) ||
    /(^|\/)\.agents\/skills(\/|$)/.test(rel) ||
    rel === SELF
  )
}

function isSkippedDir(entry, rel) {
  return SKIP_DIR_NAMES.has(entry.name) || isSkippedPath(rel)
}

function isSkippedFile(entry, rel) {
  return (
    SKIP_FILENAMES.has(entry.name) ||
    GENERATED_TYPE_FILES.has(entry.name) ||
    isSkippedPath(rel)
  )
}

const SCAN_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|md|mdx|yml|yaml|sh|json|css)$/

function* walk(dir) {
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

function isAllowlisted(line) {
  return ALLOWLIST_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

const failures = []

for (const file of walk(ROOT)) {
  if (!SCAN_EXTENSIONS.test(file)) continue
  const rel = path.relative(ROOT, file)
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    if (isAllowlisted(line)) return
    const lower = line.toLowerCase()
    for (const phrase of FORBIDDEN_PHRASES) {
      if (lower.includes(phrase)) {
        failures.push(`${rel}:${i + 1} uses forbidden phrase "${phrase}"`)
      }
    }
  })
}

if (failures.length > 0) {
  console.error('Vocabulary check failed:\n')
  for (const failure of failures) {
    console.error(`  \u2717 ${failure}`)
  }
  console.error(
    `\n${failures.length} problem(s) found. The daemon is a "daemon" / "host daemon" / "turbopaneld", never an "agent". ` +
      'Shell chrome is "frosted chrome", never Apple-associated glass product copy. ' +
      'Update the allowlist in this script (and the sibling repo copies) if this is a legitimate coding-agent, third-party, or expo-glass-effect identifier.',
  )
  process.exit(1)
}

console.log('check-vocabulary: no forbidden phrasing found.')
