import { assertEquals } from '@std/assert'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import {
  type ManagedBackupRecord,
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
  const settings = postgresEngineSpec.parseSettings(
    postgresEngineSpec.defaultSettings,
  )
  if (!settings) {
    throw new TypeError('failed to parse default postgres settings')
  }
  return settings
}

function validBackup(
  overrides?: Partial<ManagedBackupRecord>,
): ManagedBackupRecord {
  return {
    id: 'bk_abc123',
    createdAt: '2024-01-01T00:00:00.000Z',
    sizeBytes: 1024,
    checksum: 'a'.repeat(64),
    path: '/var/lib/turbopanel/managed/m1/backups/bk_abc123.dump',
    ...overrides,
  }
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
    null,
  )
})

test('parseManagedRowOptions rejects invalid database names', () => {
  const settings = defaultSettings()
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: [123],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: ['  '],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: ['bad-name-with-hyphen'],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: 'postgres',
    }),
    null,
  )
})

test('parseManagedRowOptions treats missing backups as empty and validates records', () => {
  const settings = defaultSettings()
  const parsed = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ['postgres', ' app '],
  })
  assertEquals(parsed, {
    settings,
    databases: ['postgres', 'app'],
    backups: [],
  })
})

test('parseManagedRowOptions accepts a valid backup with optional database', () => {
  const settings = defaultSettings()
  const backup = validBackup({ database: 'app' })
  const parsed = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ['postgres'],
    backups: [backup],
  })
  assertEquals(parsed?.backups, [backup])
})

test('parseManagedRowOptions rejects malformed backups', () => {
  const settings = defaultSettings()
  const base = { settings, databases: ['postgres'] }

  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, { ...base, backups: 'nope' }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [null],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [validBackup({ id: 'has spaces' })],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [validBackup({ createdAt: '' })],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [validBackup({ sizeBytes: -1 })],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [validBackup({ checksum: 'not-sha256' })],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [validBackup({ path: '' })],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [validBackup({ database: '' })],
    }),
    null,
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      ...base,
      backups: [validBackup({ database: 1 as unknown as string })],
    }),
    null,
  )
})

test('parseManagedRowOptions rejects more than 200 backup records', () => {
  const settings = defaultSettings()
  const backups = Array.from(
    { length: 201 },
    (_, i) => validBackup({ id: `bk_${String(i).padStart(3, '0')}` }),
  )
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: ['postgres'],
      backups,
    }),
    null,
  )
})

test('writeManagedRowOptions round-trips settings, databases, and backups', () => {
  const options: ManagedRowOptions = {
    settings: defaultSettings(),
    databases: ['postgres', 'app'],
    backups: [validBackup({ database: 'app' })],
  }
  assertEquals(writeManagedRowOptions(options), {
    settings: options.settings,
    databases: options.databases,
    backups: options.backups,
  })
})
