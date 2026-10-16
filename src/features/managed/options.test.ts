import { assertEquals } from '@std/assert'
import { postgresEngineSpec } from './postgres.ts'
import {
  type ManagedRowOptions,
  parseManagedRowOptions,
  writeManagedRowOptions,
} from './options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function defaultSettings(): ManagedRowOptions['settings'] {
  const settings = postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings)
  if (!settings) {
    throw new TypeError('failed to parse default postgres settings')
  }
  return settings
}

test('parseManagedRowOptions rejects non-objects', () => {
  assertEquals(parseManagedRowOptions(postgresEngineSpec, null), null)
  assertEquals(parseManagedRowOptions(postgresEngineSpec, []), null)
  assertEquals(parseManagedRowOptions(postgresEngineSpec, 'x'), null)
})

test('parseManagedRowOptions rejects invalid settings', () => {
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings: { image: '' },
      databases: ['postgres'],
    }),
    null
  )
})

test('parseManagedRowOptions rejects invalid database names', () => {
  const settings = defaultSettings()
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: [123],
    }),
    null
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: ['  '],
    }),
    null
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: ['bad-name-with-hyphen'],
    }),
    null
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: 'postgres',
    }),
    null
  )
})

test('parseManagedRowOptions parses settings and databases', () => {
  const settings = defaultSettings()
  const parsed = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ['postgres', ' app '],
  })
  assertEquals(parsed, {
    settings,
    databases: ['postgres', 'app'],
  })
})

test('writeManagedRowOptions round-trips settings and databases', () => {
  const options: ManagedRowOptions = {
    settings: defaultSettings(),
    databases: ['postgres', 'app'],
  }
  assertEquals(writeManagedRowOptions(options), {
    settings: options.settings,
    databases: options.databases,
  })
})

test('parseManagedRowOptions keeps ownerRoleDatabases (optional, only listed names) and writes it back', () => {
  const settings = defaultSettings()
  // Old rows have no key: parse and write give today's shape.
  const old = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ['postgres'],
  })
  assertEquals(old && 'ownerRoleDatabases' in old, false)
  assertEquals('ownerRoleDatabases' in writeManagedRowOptions(old!), false)

  const parsed = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ['postgres', 'shop'],
    ownerRoleDatabases: ['shop', 'gone', 3],
  })
  assertEquals(parsed?.ownerRoleDatabases, ['shop'])
  assertEquals(writeManagedRowOptions(parsed!).ownerRoleDatabases, ['shop'])
})

test('parseManagedRowOptions keeps databaseOwners only for owner-role databases and writes it back', () => {
  const settings = defaultSettings()
  const old = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ['postgres'],
  })
  assertEquals('databaseOwners' in writeManagedRowOptions(old!), false)

  const parsed = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ['postgres', 'shop', 'blog'],
    ownerRoleDatabases: ['shop'],
    databaseOwners: {
      shop: { loginId: 'l1', username: 'app', extra: 1 },
      // Not an owner-role database, or malformed: dropped.
      blog: { loginId: 'l2', username: 'x' },
      gone: { loginId: 'l3', username: 'y' },
    },
  })
  assertEquals(parsed?.databaseOwners, { shop: { loginId: 'l1', username: 'app' } })
  assertEquals(writeManagedRowOptions(parsed!).databaseOwners, {
    shop: { loginId: 'l1', username: 'app' },
  })
})
