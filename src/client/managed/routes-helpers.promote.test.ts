/**
 * Host-free promote lag-gate helpers.
 *
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals } from '@std/assert'
import {
  evaluateManagedPromoteLagGate,
  isManagedReplicationPrincipal,
} from './routes-helpers.ts'

const test = Deno.test.bind(Deno)

test('evaluateManagedPromoteLagGate rejects missing observation', () => {
  assertEquals(evaluateManagedPromoteLagGate(undefined), 'managed_replica_not_streaming')
  assertEquals(evaluateManagedPromoteLagGate(null), 'managed_replica_not_streaming')
  assertEquals(
    evaluateManagedPromoteLagGate({ state: 'stopped', observedAt: new Date().toISOString() }),
    'managed_replica_not_streaming',
  )
})

test('evaluateManagedPromoteLagGate accepts fresh streaming health', () => {
  const now = Date.parse('2026-08-09T12:00:00.000Z')
  assertEquals(
    evaluateManagedPromoteLagGate(
      {
        state: 'streaming',
        lagBytes: 100,
        lagSeconds: 1,
        observedAt: '2026-08-09T11:59:30.000Z',
      },
      now,
    ),
    null,
  )
})

test('evaluateManagedPromoteLagGate detects lag and staleness', () => {
  const now = Date.parse('2026-08-09T12:00:00.000Z')
  assertEquals(
    evaluateManagedPromoteLagGate(
      {
        state: 'streaming',
        lagBytes: 100_000_000,
        observedAt: '2026-08-09T11:59:30.000Z',
      },
      now,
    ),
    'managed_replica_lagging',
  )
  assertEquals(
    evaluateManagedPromoteLagGate(
      {
        state: 'streaming',
        observedAt: '2026-08-09T11:00:00.000Z',
      },
      now,
    ),
    'managed_replica_health_stale',
  )
})

test('isManagedReplicationPrincipal reads metadata flag', () => {
  assertEquals(isManagedReplicationPrincipal({ managedReplication: true }), true)
  assertEquals(isManagedReplicationPrincipal({ managedRoot: true }), false)
})
