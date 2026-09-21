#!/usr/bin/env node
/**
 * Migration freeze guard (schema freeze, Road-to-0.1.x).
 *
 * drizzle's migrator (`drizzle-orm/pg-core/dialect.js` `migrate`) decides
 * what to apply by comparing each journal entry's `when` against the newest
 * `created_at` in `public.migration`; the sha256 `hash` it stores per file is
 * written and never read back. Consequences this guard exists to catch:
 *
 *   - an already-applied migration file that is edited is silently *not*
 *     re-applied — every instance that migrated before the edit runs a
 *     different schema from every instance that migrated after it;
 *   - a journal entry whose `when` is not newer than the entry before it is
 *     a migration that never runs on an instance already past that point;
 *   - a `NNNN_*.sql` file that is not in the journal is ignored outright.
 *
 * The manifest (`migrations/manifest.json`) pins every migration the
 * repo has ever shipped: idx, tag, journal `when`, and the sha256 of the file
 * exactly as drizzle computes it (`readMigrationFiles` in
 * `drizzle-orm/migrator.js`: the whole file as a UTF-8 string, breakpoints
 * included) — so a manifest entry is directly comparable to a live database's
 * `public.migration.hash` column.
 *
 * Invariants (mode `check`, the default; also run by
 * `src/db/migration-manifest.test.ts`):
 *
 *   1. journal `idx` values are contiguous from 0 and each `tag` starts with
 *      its zero-padded idx;
 *   2. journal `when` is strictly increasing;
 *   3. every `NNNN_*.sql` under `migrations/` is in the journal and every
 *      journal entry has its file;
 *   4. every entry has `meta/NNNN_snapshot.json`, and the snapshots chain:
 *      each `prevId` equals the previous snapshot's `id` (the first is the
 *      nil UUID);
 *   5. the manifest lists exactly the journal's entries, in order, and each
 *      recorded sha256 equals the file on disk.
 *
 * Modes:
 *
 *   node scripts/check-migration-freeze.mjs               # verify (CI, tests)
 *   node scripts/check-migration-freeze.mjs --update      # append new entries
 *   node scripts/check-migration-freeze.mjs --rebaseline  # rewrite everything
 *
 * `--update` is the everyday path after `pnpm generate`: it appends the new
 * journal entries and refuses to change or drop an existing one — a changed
 * hash means an already-shipped file was edited, and the fix is a new forward
 * migration, not a manifest edit. `--rebaseline` is the one carve-out, for
 * the pre-tag fold that regenerates `0000_init.sql` (see `src/db/AGENTS.md`,
 * "The baseline has been regenerated…"): it rewrites the manifest from the
 * journal, bumps `generation`, and is expected to be run in the fold commit
 * itself. Once `frozen` is true (set by that fold commit), existing entries
 * never change again: the CI wiring that lands with the fold diffs the
 * manifest against trunk and accepts appends only.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'
export const MANIFEST_VERSION = 1

/** Same digest drizzle records in `public.migration.hash`. */
export function migrationDigest(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Read journal, files and snapshots under `migrationsDir` and return the
 * entries as the manifest records them plus every invariant violation
 * (1–4 above) as a message. Never throws on a broken layout — callers report.
 */
export function readMigrationTree(migrationsDir) {
  const problems = []
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json')
  if (!fs.existsSync(journalPath)) {
    return { entries: [], problems: [`missing ${journalPath}`] }
  }
  const journal = readJson(journalPath)
  const journalEntries = Array.isArray(journal.entries) ? journal.entries : []

  const onDisk = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .map((name) => name.slice(0, -'.sql'.length))
    .sort()
  const journaled = new Set(journalEntries.map((entry) => entry.tag))
  for (const tag of onDisk) {
    if (!journaled.has(tag)) {
      problems.push(`${tag}.sql is on disk but not in meta/_journal.json — drizzle ignores it`)
    }
  }

  const entries = []
  let previousWhen = -Infinity
  let previousSnapshotId = NIL_UUID
  journalEntries.forEach((entry, position) => {
    const expectedPrefix = String(position).padStart(4, '0')
    if (entry.idx !== position) {
      problems.push(
        `journal entry ${position} has idx ${entry.idx} — idx must be contiguous from 0`
      )
    }
    if (typeof entry.tag !== 'string' || !entry.tag.startsWith(`${expectedPrefix}_`)) {
      problems.push(
        `journal entry ${position} tag ${JSON.stringify(entry.tag)} does not start with ${expectedPrefix}_`
      )
    }
    if (typeof entry.when !== 'number' || !(entry.when > previousWhen)) {
      problems.push(
        `journal entry ${entry.tag} has when=${entry.when}, not newer than the previous entry (${previousWhen}) — drizzle would never apply it on an instance already past that point`
      )
    }
    previousWhen = typeof entry.when === 'number' ? entry.when : previousWhen

    const sqlPath = path.join(migrationsDir, `${entry.tag}.sql`)
    let sha256 = null
    if (fs.existsSync(sqlPath)) {
      sha256 = migrationDigest(fs.readFileSync(sqlPath, 'utf8'))
    } else {
      problems.push(`journal entry ${entry.tag} has no ${entry.tag}.sql`)
    }

    const snapshotPath = path.join(migrationsDir, 'meta', `${expectedPrefix}_snapshot.json`)
    if (fs.existsSync(snapshotPath)) {
      const snapshot = readJson(snapshotPath)
      if (snapshot.prevId !== previousSnapshotId) {
        problems.push(
          `${expectedPrefix}_snapshot.json prevId ${snapshot.prevId} does not chain to the previous snapshot id ${previousSnapshotId}`
        )
      }
      previousSnapshotId = snapshot.id
    } else {
      problems.push(`journal entry ${entry.tag} has no meta/${expectedPrefix}_snapshot.json`)
    }

    entries.push({ idx: entry.idx, tag: entry.tag, when: entry.when, sha256 })
  })

  return { entries, problems }
}

/** Invariant 5: the manifest matches the tree. Returns violation messages. */
export function compareManifest(manifest, entries) {
  const problems = []
  if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.entries)) {
    return [`manifest is not a version ${MANIFEST_VERSION} manifest — run --rebaseline`]
  }
  const recorded = manifest.entries
  const shared = Math.min(recorded.length, entries.length)
  for (let i = 0; i < shared; i++) {
    const want = recorded[i]
    const have = entries[i]
    if (want.tag !== have.tag) {
      problems.push(`manifest entry ${i} is ${want.tag} but the journal has ${have.tag}`)
      continue
    }
    if (want.when !== have.when) {
      problems.push(`${want.tag}: journal when changed (${want.when} → ${have.when})`)
    }
    if (want.sha256 !== have.sha256) {
      problems.push(
        `${want.tag}.sql was edited after it shipped (manifest ${want.sha256.slice(0, 12)}…, disk ${String(have.sha256).slice(0, 12)}…) — instances that already applied it will never see the change; add a forward migration instead`
      )
    }
  }
  for (const missing of recorded.slice(shared)) {
    problems.push(`manifest entry ${missing.tag} is no longer in the journal`)
  }
  for (const extra of entries.slice(shared)) {
    problems.push(
      `${extra.tag} is in the journal but not in the manifest — run \`node scripts/check-migration-freeze.mjs --update\``
    )
  }
  return problems
}

export function buildManifest(entries, previous) {
  return {
    version: MANIFEST_VERSION,
    frozen: previous?.frozen ?? false,
    generation: previous?.generation ?? 0,
    entries,
  }
}

function writeManifest(file, manifest) {
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

export function main(argv, { root } = {}) {
  const repoRoot = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const migrationsDir = path.join(repoRoot, 'migrations')
  const manifestPath = path.join(migrationsDir, 'manifest.json')
  const mode = argv.includes('--rebaseline')
    ? 'rebaseline'
    : argv.includes('--update')
      ? 'update'
      : 'check'

  const { entries, problems } = readMigrationTree(migrationsDir)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`migration-freeze: ${problem}`)
    return 1
  }
  const previous = fs.existsSync(manifestPath) ? readJson(manifestPath) : null

  if (mode === 'rebaseline') {
    const manifest = buildManifest(entries, previous)
    manifest.generation = (previous?.generation ?? 0) + 1
    writeManifest(manifestPath, manifest)
    console.log(
      `migration-freeze: REBASELINED manifest at generation ${manifest.generation} with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — only the pre-tag fold may do this`
    )
    return 0
  }

  if (mode === 'update') {
    const recorded = previous?.entries ?? []
    const mismatches = compareManifest(previous ?? buildManifest([], null), entries).filter(
      (problem) => !problem.includes('not in the manifest')
    )
    if (mismatches.length > 0) {
      for (const problem of mismatches) console.error(`migration-freeze: ${problem}`)
      console.error(
        'migration-freeze: --update appends only; an existing entry changed (see above)'
      )
      return 1
    }
    const added = entries.slice(recorded.length)
    writeManifest(manifestPath, buildManifest(entries, previous))
    console.log(
      added.length === 0
        ? 'migration-freeze: manifest already current'
        : `migration-freeze: appended ${added.map((entry) => entry.tag).join(', ')}`
    )
    return 0
  }

  const mismatches = compareManifest(previous, entries)
  if (mismatches.length > 0) {
    for (const problem of mismatches) console.error(`migration-freeze: ${problem}`)
    return 1
  }
  console.log(
    `migration-freeze: ${entries.length} migrations match the manifest (generation ${previous.generation})`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
