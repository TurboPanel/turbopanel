import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  assertServerRestrictForeignKeyCoverage,
  listServerRestrictForeignKeyTablesFromMigrationSql,
  SERVER_RESTRICT_FOREIGN_KEY_HANDLERS,
} from './server-fk.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '../../..')

async function loadMigrationSqlInJournalOrder(): Promise<string[]> {
  const migrationsDir = join(repoRoot, 'migrations')
  const journalPath = join(migrationsDir, 'meta', '_journal.json')
  const journal = JSON.parse(await Deno.readTextFile(journalPath)) as {
    entries: Array<{ tag: string }>
  }
  const chunks: string[] = []
  for (const entry of journal.entries) {
    chunks.push(await Deno.readTextFile(join(migrationsDir, `${entry.tag}.sql`)))
  }
  return chunks
}

test(
  'every RESTRICT server_id FK in migrations is covered by the delete path',
  { permissions: { read: true } },
  async () => {
  const chunks = await loadMigrationSqlInJournalOrder()
  const tables = listServerRestrictForeignKeyTablesFromMigrationSql(chunks)
  assertServerRestrictForeignKeyCoverage(tables)
  assertEquals(
    Object.keys(SERVER_RESTRICT_FOREIGN_KEY_HANDLERS).sort((a, b) => a.localeCompare(b)),
    tables
  )
  }
)

test(
  'migration SQL lists every handler table as a RESTRICT server_id FK',
  { permissions: { read: true } },
  async () => {
  const chunks = await loadMigrationSqlInJournalOrder()
  const tables = new Set(listServerRestrictForeignKeyTablesFromMigrationSql(chunks))
  for (const table of Object.keys(SERVER_RESTRICT_FOREIGN_KEY_HANDLERS)) {
    assertEquals(tables.has(table), true, `expected migrations to declare RESTRICT FK on ${table}`)
  }
  }
)
