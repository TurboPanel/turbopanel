#!/usr/bin/env node
/**
 * Query-cache boundary check (CI guard).
 *
 * Only the code that builds the cached database connection and the cached
 * read models may touch it. Everything else (routes, cron, the queue consumer,
 * the Durable Objects, the daemon) stays on the primary connection, so a
 * statement that must not be cached cannot reach the cached binding by
 * accident.
 *
 * Each guarded name lists the non-test source files allowed to mention it.
 * Test files are not scanned. Comment-only lines are skipped.
 *
 * Usage:
 *   node scripts/check-query-cache-boundaries.mjs
 *   pnpm check:query-cache-boundaries
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const QUERY_CACHE = 'src/query-cache/'
const READ_MODELS = 'src/query-cache/read-models/'
const BINDINGS = 'src/platform/workers/workers-bindings.ts'

/** name -> allowed path prefixes (a prefix ending in `/` allows a folder). */
export const GUARDED = {
  HYPERDRIVE_CACHED: [BINDINGS, 'src/platform/workers/wrangler-hyperdrive-bindings.ts'],
  cachedDb: [BINDINGS, QUERY_CACHE],
  resolveWorkersCachedDb: [BINDINGS],
  withCacheableUnsafe: ['src/db/connection.ts', QUERY_CACHE],
  getQueryCache: ['src/db/connection.ts', 'src/query-cache/cached-read.ts'],
  runApprovedCachedReadModel: [QUERY_CACHE],
  defineCachedRead: [READ_MODELS, 'src/query-cache/cached-read.ts'],
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.wrangler', '.git'])

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name))
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      yield path.join(dir, entry.name)
    }
  }
}

function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

export function findViolations(files, guarded = GUARDED) {
  const violations = []
  for (const { rel, text } of files) {
    const lines = text.split('\n')
    for (const [name, allowed] of Object.entries(guarded)) {
      if (
        allowed.some((prefix) => rel === prefix || (prefix.endsWith('/') && rel.startsWith(prefix)))
      ) {
        continue
      }
      const pattern = new RegExp(`\\b${name}\\b`)
      lines.forEach((line, i) => {
        if (!isCommentLine(line) && pattern.test(line)) {
          violations.push(`${rel}:${i + 1}: ${name} is only for ${allowed.join(', ')}`)
        }
      })
    }
  }
  return violations
}

function main() {
  const files = []
  for (const root of ['src']) {
    for (const file of walk(path.join(ROOT, root))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      files.push({ rel, text: fs.readFileSync(file, 'utf8') })
    }
  }
  const violations = findViolations(files)
  if (violations.length > 0) {
    console.error('Query-cache boundary violations:')
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log('Query-cache boundaries OK')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
