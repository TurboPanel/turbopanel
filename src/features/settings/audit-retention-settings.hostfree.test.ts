import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  AUDIT_RETENTION_MAX_MONTHS,
  AUDIT_RETENTION_MIN_MONTHS,
  getAuditRetentionMonths,
  isValidAuditRetentionMonths,
  setAuditRetentionMonths,
} from './audit-retention-settings.ts'

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
    insert() {
      return {
        values() {
          return {
            onConflictDoUpdate(args: { set: { value: string } }) {
              stored = args.set.value
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
  }
  return db as unknown as Db
}

test('0 and the 3 to 120 window are valid, everything else is not', () => {
  assertEquals(isValidAuditRetentionMonths(0), true)
  assertEquals(isValidAuditRetentionMonths(AUDIT_RETENTION_MIN_MONTHS), true)
  assertEquals(isValidAuditRetentionMonths(13), true)
  assertEquals(isValidAuditRetentionMonths(AUDIT_RETENTION_MAX_MONTHS), true)
  for (const bad of [1, 2, 121, -1, 12.5, Number.NaN]) {
    assertEquals(isValidAuditRetentionMonths(bad), false, String(bad))
  }
})

test('an unset or invalid stored value reads as 13 months', async () => {
  assertEquals(await getAuditRetentionMonths(createFakeSettingDb()), 13)
  assertEquals(await getAuditRetentionMonths(createFakeSettingDb('2')), 13)
  assertEquals(await getAuditRetentionMonths(createFakeSettingDb('abc')), 13)
  assertEquals(await getAuditRetentionMonths(createFakeSettingDb({})), 13)
})

test('a stored value round-trips, 0 included', async () => {
  const db = createFakeSettingDb()
  await setAuditRetentionMonths(db, 24)
  assertEquals(await getAuditRetentionMonths(db), 24)
  await setAuditRetentionMonths(db, 0)
  assertEquals(await getAuditRetentionMonths(db), 0)
  assertEquals(await getAuditRetentionMonths(createFakeSettingDb(18)), 18)
})

test('a value outside the window is refused at write time', async () => {
  const db = createFakeSettingDb()
  await assertRejects(() => setAuditRetentionMonths(db, 2), TypeError)
  await assertRejects(() => setAuditRetentionMonths(db, 121), TypeError)
  assertEquals(await getAuditRetentionMonths(db), 13)
})
