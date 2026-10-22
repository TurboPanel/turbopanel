/**
 * Host-free coverage for storing the two WAL positions of a planned switchover
 * and for the daemon feature check the re-seed depends on.
 */
import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { MANAGED_SWITCHOVER_FINAL_POSITION_FEATURE } from '../../lib/version-wire.ts'
import type { RecoveryRecord } from './recovery.ts'
import {
  daemonReportsFinalPosition,
  daemonsAllReportFinalPosition,
  finalPositionStopFields,
} from './switchover-position.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const db = {} as Db
const NEW_DAEMON = '00000000-0000-4000-8000-0000000000d1'
const OLD_DAEMON = '00000000-0000-4000-8000-0000000000d2'
const UNENROLLED = '00000000-0000-4000-8000-0000000000d3'

const lookup = (_db: Db, serverId: string) => {
  if (serverId === NEW_DAEMON) {
    return Promise.resolve({
      projection: {
        features: ['managed-owner-role-v1', MANAGED_SWITCHOVER_FINAL_POSITION_FEATURE],
      },
    })
  }
  if (serverId === OLD_DAEMON) {
    return Promise.resolve({ projection: { features: ['managed-owner-role-v1'] } })
  }
  return Promise.resolve(null)
}

test('a daemon reports the final position only when it lists the feature', async () => {
  assertEquals(await daemonReportsFinalPosition(db, NEW_DAEMON, lookup), true)
  assertEquals(await daemonReportsFinalPosition(db, OLD_DAEMON, lookup), false)
  assertEquals(await daemonReportsFinalPosition(db, UNENROLLED, lookup), false)
})

test('both servers must list the feature: one old daemon on either side fails closed', async () => {
  assertEquals(await daemonsAllReportFinalPosition(db, [NEW_DAEMON], lookup), true)
  assertEquals(await daemonsAllReportFinalPosition(db, [NEW_DAEMON, OLD_DAEMON], lookup), false)
  assertEquals(await daemonsAllReportFinalPosition(db, [OLD_DAEMON, NEW_DAEMON], lookup), false)
  assertEquals(await daemonsAllReportFinalPosition(db, [NEW_DAEMON, UNENROLLED], lookup), false)
})

const RECOVERY_ID = '00000000-0000-4000-8000-0000000000c3'

function recovery(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    id: RECOVERY_ID,
    managedId: '00000000-0000-4000-8000-000000000001',
    kind: 'switchover',
    sourcePrimaryMemberId: '00000000-0000-4000-8000-0000000000a1',
    targetMemberId: null,
    state: 'fencing',
    startedAt: '2026-10-22T00:00:00.000Z',
    completedAt: null,
    metadata: { primaryEpochAtStart: 4 },
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  }
}

test('a Postgres switchover stop on a capable daemon asks for the final position with the epoch', async () => {
  assertEquals(
    await finalPositionStopFields(
      db,
      { recovery: recovery(), engine: 'postgres', sourceServerId: NEW_DAEMON },
      lookup
    ),
    { switchoverRecoveryId: RECOVERY_ID, primaryEpoch: 4 }
  )
})

test('every other stop is sent exactly as before', async () => {
  const cases = [
    { recovery: recovery(), engine: 'postgres', sourceServerId: OLD_DAEMON },
    { recovery: recovery(), engine: 'mysql', sourceServerId: NEW_DAEMON },
    {
      recovery: recovery({ kind: 'automatic-failover' }),
      engine: 'postgres',
      sourceServerId: NEW_DAEMON,
    },
    { recovery: recovery({ metadata: {} }), engine: 'postgres', sourceServerId: NEW_DAEMON },
  ]
  for (const params of cases) {
    assertEquals(await finalPositionStopFields(db, params, lookup), {})
  }
})
