import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { jobEveryMinutes } from '../../jobs/registry.ts'
import {
  JOB_CADENCES_CACHE_MS,
  loadJobCadences,
  resetJobCadencesCacheForTests,
  resolveJobCadencesFromEnv,
} from './job-cadences.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

/** A database double that answers the `setting` read and counts the reads. */
function settingDb(rows: { key: string; value: unknown }[] | Error) {
  const state = { reads: 0 }
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          state.reads += 1
          return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)
        },
      }),
    }),
  } as unknown as Db
  return { db, state }
}

const ROW = { key: 'JOBS__CADENCES', value: '{"executionLogs":120}' }
const T0 = Date.parse('2026-01-01T00:00:00.000Z')

test('Workers read the var and never need a database', () => {
  const resolved = resolveJobCadencesFromEnv({ TURBOPANEL_JOB_CADENCES: '{"tierNotices":720}' })
  assertEquals(jobEveryMinutes('tierNotices', resolved.table), 720)
  assertEquals(resolveJobCadencesFromEnv({}).warnings, [])
})

test('self-hosted: the env var beats the setting row and skips the read', async () => {
  resetJobCadencesCacheForTests()
  const { db, state } = settingDb([ROW])
  const resolved = await loadJobCadences(
    db,
    { TURBOPANEL_JOB_CADENCES: '{"executionLogs":30}' },
    T0
  )
  assertEquals(jobEveryMinutes('executionLogs', resolved.table), 30)
  assertEquals(state.reads, 0)
})

test('self-hosted: the setting row applies when no env var is set, then the default', async () => {
  resetJobCadencesCacheForTests()
  const withRow = await loadJobCadences(settingDb([ROW]).db, {}, T0)
  assertEquals(jobEveryMinutes('executionLogs', withRow.table), 120)
  resetJobCadencesCacheForTests()
  const without = await loadJobCadences(settingDb([]).db, {}, T0)
  assertEquals(jobEveryMinutes('executionLogs', without.table), 15)
})

test('self-hosted: a row stored as a JSON object reads the same as text', async () => {
  resetJobCadencesCacheForTests()
  const resolved = await loadJobCadences(
    settingDb([{ key: 'JOBS__CADENCES', value: { tierNotices: 90 } }]).db,
    {},
    T0
  )
  assertEquals(jobEveryMinutes('tierNotices', resolved.table), 90)
})

test('self-hosted: the row is read once per cache window', async () => {
  resetJobCadencesCacheForTests()
  const { db, state } = settingDb([ROW])
  await loadJobCadences(db, {}, T0)
  await loadJobCadences(db, {}, T0 + 60_000)
  assertEquals(state.reads, 1)
  await loadJobCadences(db, {}, T0 + JOB_CADENCES_CACHE_MS)
  assertEquals(state.reads, 2)
})

test('self-hosted: an unreadable row keeps the last value, warns and never throws', async () => {
  resetJobCadencesCacheForTests()
  await loadJobCadences(settingDb([ROW]).db, {}, T0)
  const failing = settingDb(new Error('connection lost'))
  const resolved = await loadJobCadences(failing.db, {}, T0 + JOB_CADENCES_CACHE_MS)
  assertEquals(jobEveryMinutes('executionLogs', resolved.table), 120)
  assertEquals(resolved.warnings.length, 1)
  // The failure is retried on the next pass, not after the cache window.
  await loadJobCadences(failing.db, {}, T0 + JOB_CADENCES_CACHE_MS + 1)
  assertEquals(failing.state.reads, 2)
  resetJobCadencesCacheForTests()
  const cold = await loadJobCadences(settingDb(new Error('down')).db, {}, T0)
  assertEquals(jobEveryMinutes('executionLogs', cold.table), 15)
})

test('self-hosted: bad values in the row clamp and come back as warnings', async () => {
  resetJobCadencesCacheForTests()
  const resolved = await loadJobCadences(
    settingDb([{ key: 'JOBS__CADENCES', value: '{"offlineDetection":30,"executionLogs":-5}' }]).db,
    {},
    T0
  )
  assertEquals(jobEveryMinutes('offlineDetection', resolved.table), 1)
  assertEquals(jobEveryMinutes('executionLogs', resolved.table), 1)
  assertEquals(resolved.warnings.length, 2)
})
