/**
 * Guard: physical boolean columns must use an `is_` prefix.
 *
 * Asserts the latest Drizzle snapshot (and `schema.ts` `boolean('…')`
 * declarations) so a later squash of `0000_init.sql` cannot hide a bypass.
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

/**
 * Physical boolean column names that intentionally omit the `is_` prefix
 * because an external compatibility constraint requires the old name.
 *
 * Keep this empty unless a third-party model depends on a specific column.
 */
const PHYSICAL_BOOLEAN_NAME_EXCEPTIONS = new Set<string>([])

const RETIRED_BOOLEAN_NAMES = [
  'connected',
  'read_eligible',
  'for_build',
  'for_runtime',
  'emit_engine_defaults',
  'read_only',
] as const

const BOOLEAN_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['connected', 'is_connected'],
  ['read_eligible', 'is_read_eligible'],
  ['for_build', 'is_for_build'],
  ['for_runtime', 'is_for_runtime'],
  ['emit_engine_defaults', 'is_emit_engine_defaults'],
  ['read_only', 'is_read_only'],
]

const SCHEMA_BOOLEAN_RE = /\bboolean\(\s*'([^']+)'\s*\)/g

type SnapshotColumn = {
  name?: unknown
  type?: unknown
}

type SnapshotTable = {
  columns?: Record<string, SnapshotColumn>
}

type DrizzleSnapshot = {
  tables?: Record<string, SnapshotTable>
}

type Journal = {
  entries?: Array<{ idx?: number; tag?: string }>
}

function assertPhysicalBooleanName(name: string): void {
  if (PHYSICAL_BOOLEAN_NAME_EXCEPTIONS.has(name)) return
  if (!name.startsWith('is_')) {
    throw new TypeError(
      `physical boolean column "${name}" must start with is_; ` +
        `add an explicit exception only for external compatibility`,
    )
  }
}

function extractSchemaBooleanNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(SCHEMA_BOOLEAN_RE)) {
    const name = match[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

function extractSnapshotBooleanNames(snapshot: DrizzleSnapshot): string[] {
  const names: string[] = []
  for (const table of Object.values(snapshot.tables ?? {})) {
    for (const column of Object.values(table.columns ?? {})) {
      if (column.type !== 'boolean') continue
      if (typeof column.name !== 'string') {
        throw new TypeError('snapshot boolean column is missing a string name')
      }
      names.push(column.name)
    }
  }
  return names
}

async function readLatestSnapshot(
  metaDir: string,
): Promise<{ tag: string; snapshot: DrizzleSnapshot; snapshotFile: string }> {
  const journal = JSON.parse(
    await Deno.readTextFile(join(metaDir, '_journal.json')),
  ) as Journal
  const last = journal.entries?.at(-1)
  const tag = last?.tag
  const idx = last?.idx
  if (!tag || typeof idx !== 'number') {
    throw new TypeError('migrations/meta/_journal.json last entry is missing tag/idx')
  }
  // drizzle-kit names snapshots `{idx padded}_snapshot.json`, not `{tag}_snapshot.json`.
  const snapshotFile = `${String(idx).padStart(4, '0')}_snapshot.json`
  const snapshot = JSON.parse(
    await Deno.readTextFile(join(metaDir, snapshotFile)),
  ) as DrizzleSnapshot
  return { tag, snapshot, snapshotFile }
}

function assertNoRetiredBooleanNames(names: readonly string[]): void {
  for (const retired of RETIRED_BOOLEAN_NAMES) {
    if (names.includes(retired)) {
      throw new TypeError(
        `retired boolean column "${retired}" must not appear after the is_ rename`,
      )
    }
  }
}

test('schema.ts boolean() physical names start with is_', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const schemaPath = join(here, 'schema.ts')
  const source = await Deno.readTextFile(schemaPath)
  const names = extractSchemaBooleanNames(source)
  if (names.length === 0) {
    throw new TypeError('expected at least one boolean() declaration in schema.ts')
  }
  for (const name of names) {
    assertPhysicalBooleanName(name)
  }
  assertNoRetiredBooleanNames(names)
  assertEquals(PHYSICAL_BOOLEAN_NAME_EXCEPTIONS.size, 0)
})

test('latest drizzle snapshot boolean columns start with is_', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const metaDir = join(here, '../../../migrations/meta')
  const { tag, snapshot, snapshotFile } = await readLatestSnapshot(metaDir)
  if (tag === '0000_init') {
    throw new TypeError(
      'expected a versioned snapshot after 0000_init so the is_ rename is recorded',
    )
  }
  const names = extractSnapshotBooleanNames(snapshot)
  if (names.length === 0) {
    throw new TypeError(`expected boolean columns in ${snapshotFile}`)
  }
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b))
  for (const name of unique) {
    assertPhysicalBooleanName(name)
  }
  assertNoRetiredBooleanNames(unique)
  for (const required of [
    'is_connected',
    'is_read_eligible',
    'is_for_build',
    'is_for_runtime',
    'is_emit_engine_defaults',
    'is_read_only',
  ]) {
    if (!unique.includes(required)) {
      throw new TypeError(`expected boolean column "${required}" in ${snapshotFile}`)
    }
  }
})

test('versioned boolean rename migration uses RENAME COLUMN', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const metaDir = join(here, '../../../migrations/meta')
  const { tag } = await readLatestSnapshot(metaDir)
  const sqlPath = join(here, '../../../migrations', `${tag}.sql`)
  const sql = await Deno.readTextFile(sqlPath)
  for (const [from, to] of BOOLEAN_RENAMES) {
    const stmt = `RENAME COLUMN "${from}" TO "${to}"`
    if (!sql.includes(stmt)) {
      throw new TypeError(`expected ${stmt} in ${tag}.sql so existing data is preserved`)
    }
  }
})
