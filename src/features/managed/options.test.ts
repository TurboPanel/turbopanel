import { assertEquals } from '@std/assert'
import { postgresEngineSpec } from './postgres.ts'
import type { Db } from '../../db/connection.ts'
import {
  type ManagedRowOptions,
  markConvertedDatabasesRoleOwned,
  parseManagedSettings,
  writeManagedSettings,
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

test('parseManagedSettings rejects non-objects', () => {
  assertEquals(parseManagedSettings(postgresEngineSpec, null), null)
  assertEquals(parseManagedSettings(postgresEngineSpec, []), null)
  assertEquals(parseManagedSettings(postgresEngineSpec, 'x'), null)
})

test('parseManagedSettings rejects invalid settings', () => {
  assertEquals(parseManagedSettings(postgresEngineSpec, { settings: { image: '' } }), null)
})

test('parseManagedSettings reads the settings key and ignores anything else', () => {
  const settings = defaultSettings()
  assertEquals(parseManagedSettings(postgresEngineSpec, { settings }), settings)
  assertEquals(
    parseManagedSettings(postgresEngineSpec, { settings, databases: ['not-read-from-here'] }),
    settings
  )
})

test('writeManagedSettings stores the settings only; databases are rows', () => {
  const settings = defaultSettings()
  assertEquals(writeManagedSettings(settings), { settings })
  assertEquals(parseManagedSettings(postgresEngineSpec, writeManagedSettings(settings)), settings)
})

test('markConvertedDatabasesRoleOwned writes nothing when no database moved', async () => {
  let writes = 0
  const db = {
    update() {
      writes += 1
      return {}
    },
  } as unknown as Db
  await markConvertedDatabasesRoleOwned(db, 'managed-1', [])
  assertEquals(writes, 0)
})

test('markConvertedDatabasesRoleOwned flags the moved databases as role owned', async () => {
  const set: Record<string, unknown>[] = []
  let filtered = false
  const db = {
    update() {
      return {
        set(values: Record<string, unknown>) {
          set.push(values)
          return {
            where() {
              filtered = true
              return Promise.resolve()
            },
          }
        },
      }
    },
  } as unknown as Db
  await markConvertedDatabasesRoleOwned(db, 'managed-1', ['first'])
  assertEquals(set.length, 1)
  assertEquals(set[0]!.isRoleOwned, true)
  assertEquals(filtered, true)
})
