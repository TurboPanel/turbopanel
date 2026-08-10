/**
 * Host-free coverage for settings resolver DB helpers (mock Db).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  createSettingsResolver,
  deleteSettingValue,
  loadSettingValues,
  SettingsResolver,
  type SettingValue,
  upsertSettingValue,
} from './resolver.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('loadSettingValues returns empty map for no keys', async () => {
  const db = {} as Db
  const map = await loadSettingValues(db, [])
  assertEquals(map.size, 0)
})

test('loadSettingValues normalizes keys and coerces row values', async () => {
  let queriedKeys: unknown[] | undefined
  const db = {
    select: () => ({
      from: () => ({
        where: (keys: unknown) => {
          queriedKeys = keys as unknown[]
          return Promise.resolve([
            { key: '  turbopanel_example__host  ', value: 'db-host' },
            { key: 'TURBOPANEL_EXAMPLE__PORT', value: 9443 },
          ])
        },
      }),
    }),
  } as unknown as Db

  const map = await loadSettingValues(db, ['TURBOPANEL_EXAMPLE__HOST'])
  assertEquals(queriedKeys !== undefined, true)
  assertEquals(map.get('TURBOPANEL_EXAMPLE__HOST'), 'db-host')
  assertEquals(map.get('TURBOPANEL_EXAMPLE__PORT'), 9443)
})

test('upsertSettingValue normalizes key on insert', async () => {
  let inserted: { key: string; value: unknown } | undefined
  const db = {
    insert: () => ({
      values: (row: { key: string; value: unknown }) => {
        inserted = row
        return {
          onConflictDoUpdate: () => Promise.resolve(undefined),
        }
      },
    }),
  } as unknown as Db

  await upsertSettingValue(db, '  example__flag ', true)
  assertEquals(inserted?.key, 'EXAMPLE__FLAG')
  assertEquals(inserted?.value, true)
})

test('deleteSettingValue normalizes key before delete', async () => {
  let deletedKey: unknown
  const db = {
    delete: () => ({
      where: (key: unknown) => {
        deletedKey = key
        return Promise.resolve(undefined)
      },
    }),
  } as unknown as Db

  await deleteSettingValue(db, ' turbopanel_example__host ')
  assertEquals(deletedKey !== undefined, true)
})

test('SettingsResolver coerces boolean and array db values to strings', () => {
  const resolver = new SettingsResolver({
    prefix: 'TURBOPANEL_EXAMPLE',
    keys: { FLAG: '', JSON: '' },
    env: {},
    dbValues: new Map<string, SettingValue>([
      ['TURBOPANEL_EXAMPLE__FLAG', true],
      ['TURBOPANEL_EXAMPLE__JSON', ['a', 'b']],
    ]),
  })

  assertEquals(resolver.resolve('FLAG'), { value: 'true', source: 'db' })
  assertEquals(resolver.resolve('JSON'), { value: '["a","b"]', source: 'db' })
})

test('createSettingsResolver loads db values for schema keys', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { key: 'TURBOPANEL_EXAMPLE__HOST', value: 'from-db' },
          ]),
      }),
    }),
  } as unknown as Db

  const resolver = await createSettingsResolver(db, {
    prefix: 'TURBOPANEL_EXAMPLE',
    keys: { HOST: 'fallback', PORT: '8080' },
    env: {},
  })

  assertEquals(resolver.resolve('HOST'), { value: 'from-db', source: 'db' })
  assertEquals(resolver.resolve('PORT'), { value: '8080', source: 'default' })
})
