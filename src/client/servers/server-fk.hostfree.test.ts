import { assertEquals } from '@std/assert'
import { referringTableFromConstraintName, SERVER_FOREIGN_KEY_REFERENCES } from './server-fk.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('SERVER_FOREIGN_KEY_REFERENCES lists every server FK from schema migrations', () => {
  const tables = SERVER_FOREIGN_KEY_REFERENCES.map((row) => row.table)
  assertEquals(new Set(tables).size, tables.length)
  assertEquals(tables.length, 26)
  const onDelete = new Map(SERVER_FOREIGN_KEY_REFERENCES.map((row) => [row.table, row.onDelete]))
  assertEquals(onDelete.get('backup'), 'set null')
  assertEquals(onDelete.get('stage'), 'cascade')
  assertEquals(onDelete.get('managed'), 'restrict')
})

test('referringTableFromConstraintName maps server_id FK constraint names', () => {
  assertEquals(referringTableFromConstraintName('stage_server_id_server_id_fk'), 'stage')
  assertEquals(referringTableFromConstraintName('copy_server_id_server_id_fk'), 'copy')
})
