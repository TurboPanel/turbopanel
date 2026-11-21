/** Host-free coverage for storing the two WAL positions of a planned switchover. */
import { assertEquals } from '@std/assert'
import type { RecoveryRecord } from './recovery.ts'
import { finalPositionStopFields } from './switchover-position.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

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

test('a Postgres switchover stop asks for the final position with the epoch', async () => {
  assertEquals(finalPositionStopFields({ recovery: recovery(), engine: 'postgres' }), {
    switchoverRecoveryId: RECOVERY_ID,
    primaryEpoch: 4,
  })
})

test('every other stop is sent exactly as before', async () => {
  const cases = [
    { recovery: recovery(), engine: 'mysql' },
    {
      recovery: recovery({ kind: 'automatic-failover' }),
      engine: 'postgres',
    },
    { recovery: recovery({ metadata: {} }), engine: 'postgres' },
  ]
  for (const params of cases) {
    assertEquals(finalPositionStopFields(params), {})
  }
})
