import { assertEquals, assertRejects } from '@std/assert'
import { setting } from '../../db/schema.ts'
import type { Db } from '../../db/connection.ts'
import {
  DEFAULT_UPGRADE_SETTINGS,
  getUpgradeSettings,
  isValidUpgradeSettings,
  normalizeUpgradeSettings,
  parseUpgradeBatchDefault,
  setUpgradeSettings,
  type UpgradeSettings,
  UPGRADE_SETTINGS_KEY,
} from './upgrade-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createFakeSettingDb(initial?: unknown) {
  let stored: unknown = initial
  const db = {
    select() {
      const builder = {
        from() {
          return builder
        },
        where() {
          return builder
        },
        limit(): Promise<Array<{ value: unknown }>> {
          return stored === undefined ? Promise.resolve([]) : Promise.resolve([{ value: stored }])
        },
      }
      return builder
    },
    insert(table: unknown) {
      return {
        values(row: { key: string; value: unknown }) {
          return {
            onConflictDoUpdate(args: { set: { value: unknown } }) {
              if (table === setting && row.key === UPGRADE_SETTINGS_KEY) {
                stored = args.set.value
              }
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
  }
  return db as unknown as Db
}

function sample(overrides: Partial<UpgradeSettings> = {}): UpgradeSettings {
  return { batch: overrides.batch ?? DEFAULT_UPGRADE_SETTINGS.batch }
}

/** A row exactly as v0.1.20 saved it from Admin > Updates. */
const V0_1_20_ROW = {
  autoUpdate: false,
  batch: { mode: 'count', value: 3 },
  maintenanceWindow: { enabled: true, startMinute: 120, durationMinutes: 60, weekdays: [1, 5] },
}

test('isValidUpgradeSettings accepts the default and rejects drift', () => {
  assertEquals(isValidUpgradeSettings(DEFAULT_UPGRADE_SETTINGS), true)
  assertEquals(isValidUpgradeSettings(sample({ batch: { mode: 'count', value: 3 } })), true)
  assertEquals(isValidUpgradeSettings(sample({ batch: { mode: 'percent', value: 0 } })), false)
  assertEquals(isValidUpgradeSettings(sample({ batch: { mode: 'percent', value: 101 } })), false)
  assertEquals(isValidUpgradeSettings(sample({ batch: { mode: 'count', value: 0 } })), false)
  assertEquals(isValidUpgradeSettings({}), false)
  assertEquals(isValidUpgradeSettings({ ...sample(), surprise: true }), false)
})

test('a row saved before updates were always automatic still reads, keeping its batch', () => {
  assertEquals(isValidUpgradeSettings(V0_1_20_ROW), true)
  assertEquals(normalizeUpgradeSettings(V0_1_20_ROW), { batch: { mode: 'count', value: 3 } })
  assertEquals(normalizeUpgradeSettings({ autoUpdate: false }), null)
})

test('getUpgradeSettings falls back when the row is missing or invalid', async () => {
  assertEquals(await getUpgradeSettings(createFakeSettingDb()), DEFAULT_UPGRADE_SETTINGS)
  assertEquals(
    await getUpgradeSettings(createFakeSettingDb({ autoUpdate: 'no' })),
    DEFAULT_UPGRADE_SETTINGS
  )
  assertEquals(await getUpgradeSettings(createFakeSettingDb(V0_1_20_ROW)), {
    batch: { mode: 'count', value: 3 },
  })
})

test('setUpgradeSettings rejects invalid values and round-trips a valid one', async () => {
  const db = createFakeSettingDb()
  await assertRejects(
    () => setUpgradeSettings(db, sample({ batch: { mode: 'percent', value: 0 } })),
    TypeError,
    'upgrade settings are invalid'
  )
  await setUpgradeSettings(db, sample({ batch: { mode: 'count', value: 4 } }))
  assertEquals(await getUpgradeSettings(db), { batch: { mode: 'count', value: 4 } })
})

test('a save keeps the row readable by an older control plane, with updates on and no window', async () => {
  let written: unknown
  const db = {
    insert() {
      return {
        values(row: { value: unknown }) {
          written = row.value
          return { onConflictDoUpdate: () => Promise.resolve(undefined) }
        },
      }
    },
  } as unknown as Db
  await setUpgradeSettings(db, sample({ batch: { mode: 'percent', value: 25 } }))
  assertEquals(written, {
    autoUpdate: true,
    batch: { mode: 'percent', value: 25 },
    maintenanceWindow: { enabled: false, startMinute: 0, durationMinutes: 60, weekdays: [] },
  })
})

test('the built-in default updates every server in one wave', () => {
  assertEquals(DEFAULT_UPGRADE_SETTINGS.batch, { mode: 'percent', value: 100 })
})

test('parseUpgradeBatchDefault reads count and percent, else every server at once', () => {
  assertEquals(parseUpgradeBatchDefault('percent:25'), { mode: 'percent', value: 25 })
  assertEquals(parseUpgradeBatchDefault(' count:5 '), { mode: 'count', value: 5 })
  const bad = [
    undefined,
    '',
    'all',
    'percent:0',
    'percent:101',
    'count:0',
    'count:10001',
    'count:x',
  ]
  for (const raw of bad) {
    assertEquals(parseUpgradeBatchDefault(raw), { mode: 'percent', value: 100 })
  }
})

test('an unset row uses the environment default; a saved row wins', async () => {
  const fallback = { mode: 'count', value: 2 } as const
  const unset = await getUpgradeSettings(createFakeSettingDb(), fallback)
  assertEquals(unset.batch, fallback)
  const fake = createFakeSettingDb(V0_1_20_ROW)
  assertEquals((await getUpgradeSettings(fake, fallback)).batch, { mode: 'count', value: 3 })
})
