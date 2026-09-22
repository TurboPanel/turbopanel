#!/usr/bin/env node
/**
 * Migration freeze guard, layer two (CI): once the manifest is frozen,
 * `migrations/` may only grow.
 *
 * Layer one (`scripts/check-migration-freeze.mjs`, run by
 * `src/db/migration-manifest.test.ts`) proves the working tree matches
 * `migrations/manifest.json`. That alone cannot stop a commit that edits a
 * shipped migration *and* re-records its hash — so this script compares the
 * commit against its base ref and refuses any modified or deleted
 * `NNNN_*.sql` or `meta/NNNN_snapshot.json` when the *base's* manifest says
 * `frozen: true`. `_journal.json` and `manifest.json` are expected to change
 * (they append). The fold commit itself passes because its base is unfrozen.
 *
 * Why the base's flag, not the working tree's: a commit could flip `frozen`
 * back to false alongside its edit. What was already frozen decides.
 *
 * Usage:
 *   node scripts/check-migration-additions.mjs <base-ref>
 *   node scripts/check-migration-additions.mjs            # base = origin/trunk
 * CI (`build.yml`) passes `github.event.before` on a push and
 * `github.event.pull_request.base.sha` on a pull request.
 */
import { execFileSync } from 'node:child_process'

const NIL_SHA = '0000000000000000000000000000000000000000'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(`migration-additions: ${message}`)
  process.exit(1)
}

const requested = process.argv[2]?.trim()
const base = !requested || requested === NIL_SHA ? 'origin/trunk' : requested

let baseManifest = null
try {
  baseManifest = JSON.parse(git('show', `${base}:migrations/manifest.json`))
} catch {
  console.log(
    `migration-additions: ${base} has no migrations/manifest.json — nothing frozen yet, skipping`
  )
  process.exit(0)
}
if (baseManifest.frozen !== true) {
  console.log(
    `migration-additions: ${base} manifest is not frozen (the fold has not landed there) — skipping`
  )
  process.exit(0)
}

const changes = git('diff', '--name-status', base, 'HEAD', '--', 'migrations/')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split('\t')
    return { status: status[0], path: paths[paths.length - 1] }
  })

const IMMUTABLE = /^migrations\/(\d{4}_.+\.sql|meta\/\d{4}_snapshot\.json)$/
const violations = changes.filter((change) => change.status !== 'A' && IMMUTABLE.test(change.path))
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `migration-additions: ${violation.path} was ${violation.status === 'D' ? 'deleted' : 'modified'} — shipped migrations are immutable; add a forward migration instead`
    )
  }
  fail(`${violations.length} change(s) to frozen migration files since ${base}`)
}

const added = changes.filter((change) => change.status === 'A').map((change) => change.path)
console.log(
  added.length === 0
    ? `migration-additions: no migration files changed since ${base}`
    : `migration-additions: additions only since ${base}: ${added.join(', ')}`
)
