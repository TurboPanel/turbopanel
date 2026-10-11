import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  assertEnvironmentForgetForeignKeyCoverage,
  assertServerRestrictForeignKeyCoverage,
  ENVIRONMENT_FORGET_FOREIGN_KEY_HANDLERS,
  listEnvironmentForeignKeysFromMigrationSql,
  listServerForeignKeysFromMigrationSql,
  listServerRestrictForeignKeyTablesFromMigrationSql,
  SERVER_RESTRICT_FOREIGN_KEY_HANDLERS,
} from './server-fk.ts'

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '../../..')

const SERVER_PURGE_SOURCE = join(repoRoot, 'src/client/servers/server-fk.ts')
const SERVER_FORGET_SOURCE = join(repoRoot, 'src/client/servers/delete-guards.ts')
const ENVIRONMENT_DROP_SOURCE = join(repoRoot, 'src/features/projects/project-delete.ts')

function assertSourceMentionsTable(source: string, table: string, context: string): void {
  const drizzleTable = table === 'copy' ? 'storageCopy' : table
  const mentioned =
    source.includes(`.delete(${drizzleTable})`) ||
    source.includes(`.delete(${table})`) ||
    source.includes(`from(${drizzleTable})`) ||
    source.includes(`from(${table})`)
  assertEquals(mentioned, true, `${context}: expected implementation reference to ${table}`)
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

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
  'shipped migrations match server delete and environment forget FK handler registries',
  { permissions: { read: true } },
  async () => {
    const chunks = await loadMigrationSqlInJournalOrder()

    const serverRestrictTables = listServerRestrictForeignKeyTablesFromMigrationSql(chunks)
    assertServerRestrictForeignKeyCoverage(serverRestrictTables)
    assertEquals(
      Object.keys(SERVER_RESTRICT_FOREIGN_KEY_HANDLERS).sort((a, b) => a.localeCompare(b)),
      serverRestrictTables
    )

    const serverRows = listServerForeignKeysFromMigrationSql(chunks)
    const serverTables = new Set(serverRows.map((row) => row.table))
    for (const table of Object.keys(SERVER_RESTRICT_FOREIGN_KEY_HANDLERS)) {
      assertEquals(serverTables.has(table), true, `expected server_id FK on ${table}`)
    }
    assertEquals(
      serverRows.some((row) => row.table === 'backup' && row.onDelete === 'set null'),
      true
    )
    assertEquals(
      serverRows.some((row) => row.table === 'stage' && row.onDelete === 'cascade'),
      true
    )

    const environmentRows = listEnvironmentForeignKeysFromMigrationSql(chunks)
    const environmentTables = environmentRows
      .map((row) => row.table)
      .sort((a, b) => a.localeCompare(b))
    assertEnvironmentForgetForeignKeyCoverage(environmentTables)
    assertEquals(
      Object.keys(ENVIRONMENT_FORGET_FOREIGN_KEY_HANDLERS).sort((a, b) => a.localeCompare(b)),
      environmentTables
    )

    const serverPurgeSource = await Deno.readTextFile(SERVER_PURGE_SOURCE)
    const serverForgetSource = await Deno.readTextFile(SERVER_FORGET_SOURCE)
    const environmentDropSource = await Deno.readTextFile(ENVIRONMENT_DROP_SOURCE)

    for (const [table, handler] of Object.entries(SERVER_RESTRICT_FOREIGN_KEY_HANDLERS)) {
      if (handler === 'purge') {
        assertSourceMentionsTable(serverPurgeSource, table, 'purgeServerRestrictForeignKeys')
      } else if (handler === 'fabric') {
        assertSourceMentionsTable(serverPurgeSource, table, 'purgeServerFabricForeignKeys')
      } else {
        assertSourceMentionsTable(serverForgetSource, table, 'forgetServerOwnedResources')
      }
    }

    for (const [table, handler] of Object.entries(ENVIRONMENT_FORGET_FOREIGN_KEY_HANDLERS)) {
      if (handler === 'drop-subtree') {
        assertSourceMentionsTable(environmentDropSource, table, 'dropEnvironmentSubtreeInTx')
      }
    }
  }
)
