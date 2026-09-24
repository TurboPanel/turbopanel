import { assertEquals, assertRejects } from '@std/assert'
import { setting } from '../../db/schema.ts'
import type { Db } from '../../db/connection.ts'
import {
  DEFAULT_UPGRADE_SETTINGS,
  getUpgradeSettings,
  isValidUpgradeSettings,
  normalizeUpgradeSettings,
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
          return stored === undefined
            ? Promise.resolve([])
            : Promise.resolve([{ value: stored }])
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
  return {
    ...DEFAULT_UPGRADE_SETTINGS,
    ...overrides,
    batch: overrides.batch ?? DEFAULT_UPGRADE_SETTINGS.batch,
    maintenanceWindow: overrides.maintenanceWindow ??
      DEFAULT_UPGRADE_SETTINGS.maintenanceWindow,
  }
}

test('isValidUpgradeSettings accepts the default and rejects drift', () => {
  assertEquals(isValidUpgradeSettings(DEFAULT_UPGRADE_SETTINGS), true)
  assertEquals(isValidUpgradeSettings(sample({ autoUpdate: true })), true)
  assertEquals(
    isValidUpgradeSettings(sample({ batch: { mode: 'count', value: 3 } })),
    true,
  )
  assertEquals(isValidUpgradeSettings(sample({ autoUpdate: 'yes' as never })), false)
  assertEquals(
    isValidUpgradeSettings(sample({ batch: { mode: 'percent', value: 0 } })),
    false,
  )
  assertEquals(
    isValidUpgradeSettings(sample({ batch: { mode: 'percent', value: 101 } })),
    false,
  )
  assertEquals(
    isValidUpgradeSettings(sample({ batch: { mode: 'count', value: 0 } })),
    false,
  )
  assertEquals(
    isValidUpgradeSettings(sample({
      maintenanceWindow: {
        enabled: true,
        startMinute: 120,
        durationMinutes: 60,
        weekdays: [1, 1],
      },
    })),
    false,
  )
  assertEquals(
    isValidUpgradeSettings(sample({
      maintenanceWindow: {
        enabled: false,
        startMinute: 0,
        durationMinutes: 60,
        weekdays: [7],
      },
    })),
    false,
  )
})

test('normalizeUpgradeSettings sorts weekdays and drops invalid objects', () => {
  const normalized = normalizeUpgradeSettings(sample({
    maintenanceWindow: {
      enabled: true,
      startMinute: 60,
      durationMinutes: 30,
      weekdays: [5, 1],
    },
  }))
  if (!normalized) throw new TypeError('expected valid settings')
  assertEquals(normalized.maintenanceWindow.weekdays, [1, 5])
  assertEquals(normalizeUpgradeSettings({ autoUpdate: false }), null)
})

test('getUpgradeSettings falls back when the row is missing or invalid', async () => {
  assertEquals(
    await getUpgradeSettings(createFakeSettingDb()),
    DEFAULT_UPGRADE_SETTINGS,
  )
  assertEquals(
    await getUpgradeSettings(createFakeSettingDb({ autoUpdate: 'no' })),
    DEFAULT_UPGRADE_SETTINGS,
  )
})

test('setUpgradeSettings rejects invalid values and round-trips a valid one', async () => {
  const db = createFakeSettingDb()
  await assertRejects(
    () => setUpgradeSettings(db, sample({ batch: { mode: 'percent', value: 0 } })),
    TypeError,
    'upgrade settings are invalid',
  )
  const next = sample({
    autoUpdate: true,
    batch: { mode: 'count', value: 4 },
    maintenanceWindow: {
      enabled: true,
      startMinute: 90,
      durationMinutes: 45,
      weekdays: [3, 1],
    },
  })
  await setUpgradeSettings(db, next)
  const stored = await getUpgradeSettings(db)
  assertEquals(stored.autoUpdate, true)
  assertEquals(stored.batch, { mode: 'count', value: 4 })
  assertEquals(stored.maintenanceWindow.weekdays, [1, 3])
})
