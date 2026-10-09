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
  const tables = SERVER_FOREIGN_KEY_REFERENCES.map((row) => row.table).sort((a, b) =>
    a.localeCompare(b)
  )
  assertEquals(tables, [
    'backup',
    'bulwark',
    'capability',
    'command',
    'container',
    'copy',
    'deployment',
    'edict',
    'environment',
    'generation',
    'ip',
    'key',
    'label',
    'leaf',
    'license',
    'managed',
    'marker',
    'monitor',
    'network',
    'relay',
    'replica',
    'slot',
    'snapshot',
    'stage',
    'subnet',
    'variable',
  ])
})

test('referringTableFromConstraintName maps server_id FK constraint names', () => {
  assertEquals(referringTableFromConstraintName('stage_server_id_server_id_fk'), 'stage')
  assertEquals(referringTableFromConstraintName('copy_server_id_server_id_fk'), 'copy')
})
