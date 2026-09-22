/**
 * Guard: every shipped migration file still hashes to what
 * `migrations/manifest.json` recorded when it shipped, and the journal
 * is something drizzle's migrator will actually replay in full.
 *
 * drizzle applies a journal entry only when its `when` is newer than the
 * newest `created_at` already in `public.migration`, and never re-reads the
 * sha256 it stores — so an edited migration is silently skipped on every
 * instance that already ran it, and a stale `when` is a migration that never
 * runs. The manifest pins idx/tag/when/sha256 per file (sha256 computed the
 * way drizzle's `readMigrationFiles` does, so it equals the live
 * `public.migration.hash`). Append entries with
 * `node scripts/check-migration-freeze.mjs --update`; only the pre-tag fold
 * may `--rebaseline`. See scripts/check-migration-freeze.mjs for the full
 * invariant list and src/db/AGENTS.md (baseline policy).
 */

import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const here = dirname(fromFileUrl(import.meta.url))
const repoRoot = join(here, '../..')
const migrationsDir = join(repoRoot, 'migrations')
const script = join(repoRoot, 'scripts/check-migration-freeze.mjs')

type JournalEntry = { idx: number; tag: string; when: number }
type ManifestEntry = JournalEntry & { sha256: string }
type Manifest = { version: number; frozen: boolean; generation: number; entries: ManifestEntry[] }

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(file)) as T
}

/** Same digest drizzle records in `public.migration.hash`: whole file, UTF-8. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

test('manifest pins every journaled migration file byte-for-byte', async () => {
  const journal = await readJson<{ entries: JournalEntry[] }>(
    join(migrationsDir, 'meta/_journal.json')
  )
  const manifest = await readJson<Manifest>(join(migrationsDir, 'manifest.json'))
  assertEquals(manifest.version, 1)
  assertEquals(
    manifest.entries.map((e) => e.tag),
    journal.entries.map((e) => e.tag),
    'manifest and journal list different migrations — run `node scripts/check-migration-freeze.mjs --update`'
  )
  for (const [i, entry] of manifest.entries.entries()) {
    const journaled = journal.entries[i]
    assertEquals(entry.idx, journaled.idx, `${entry.tag}: idx`)
    assertEquals(entry.when, journaled.when, `${entry.tag}: journal when changed`)
    const sql = await Deno.readTextFile(join(migrationsDir, `${entry.tag}.sql`))
    assertEquals(
      await sha256Hex(sql),
      entry.sha256,
      `${entry.tag}.sql was edited after it shipped — instances that already applied it will never see the change; add a forward migration instead`
    )
  }
})

test('journal is contiguous, strictly increasing, and covers every migration file on disk', async () => {
  const journal = await readJson<{ entries: JournalEntry[] }>(
    join(migrationsDir, 'meta/_journal.json')
  )
  const onDisk: string[] = []
  for await (const item of Deno.readDir(migrationsDir)) {
    if (item.isFile && /^\d{4}_.+\.sql$/.test(item.name))
      onDisk.push(item.name.slice(0, -'.sql'.length))
  }
  onDisk.sort()
  assertEquals(
    journal.entries.map((e) => e.tag),
    onDisk,
    'a NNNN_*.sql not in meta/_journal.json is ignored by drizzle outright'
  )
  let previousWhen = -Infinity
  for (const [i, entry] of journal.entries.entries()) {
    assertEquals(entry.idx, i, `${entry.tag}: idx must be contiguous from 0`)
    assertEquals(
      entry.tag.slice(0, 5),
      `${String(i).padStart(4, '0')}_`,
      `${entry.tag}: tag prefix`
    )
    assertEquals(
      entry.when > previousWhen,
      true,
      `${entry.tag}: when=${entry.when} is not newer than the previous entry — drizzle would never apply it`
    )
    previousWhen = entry.when
  }
})

test('snapshots chain prevId → id from the nil UUID', async () => {
  const journal = await readJson<{ entries: JournalEntry[] }>(
    join(migrationsDir, 'meta/_journal.json')
  )
  let previousId = '00000000-0000-0000-0000-000000000000'
  for (const [i, entry] of journal.entries.entries()) {
    const snapshot = await readJson<{ id: string; prevId: string }>(
      join(migrationsDir, `meta/${String(i).padStart(4, '0')}_snapshot.json`)
    )
    assertEquals(snapshot.prevId, previousId, `${entry.tag}: snapshot prevId does not chain`)
    previousId = snapshot.id
  }
})

test('scripts/check-migration-freeze.mjs passes in check mode', async () => {
  const out = await new Deno.Command('node', {
    args: [script],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const stderr = new TextDecoder().decode(out.stderr)
  assertEquals(out.success, true, `check-migration-freeze failed:\n${stderr}`)
})
