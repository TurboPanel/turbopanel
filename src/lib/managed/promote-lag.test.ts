import { assertEquals } from '@std/assert'
import {
  evaluateManagedPromoteLagGate,
  isAutomaticFailoverHealthy,
  replicationFromMemberMetadata,
} from './promote-lag.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-08-19T12:00:00.000Z')
const FRESH = '2026-08-19T11:59:00.000Z'

test('missing replication is not healthy enough for automatic failover', () => {
  assertEquals(isAutomaticFailoverHealthy(undefined, NOW), false)
  assertEquals(isAutomaticFailoverHealthy(null, NOW), false)
  assertEquals(
    isAutomaticFailoverHealthy({ state: 'stopped', observedAt: FRESH }, NOW),
    false,
  )
  assertEquals(
    evaluateManagedPromoteLagGate(undefined, NOW),
    'managed_replica_not_streaming',
  )
})

test('fresh streaming under threshold is healthy for automatic failover', () => {
  assertEquals(
    isAutomaticFailoverHealthy(
      { state: 'streaming', observedAt: FRESH, lagBytes: 12, lagSeconds: 1 },
      NOW,
    ),
    true,
  )
})

test('stale or lagging observations fail closed', () => {
  assertEquals(
    isAutomaticFailoverHealthy(
      { state: 'streaming', observedAt: '2026-08-19T11:00:00.000Z' },
      NOW,
    ),
    false,
  )
  assertEquals(
    isAutomaticFailoverHealthy(
      {
        state: 'streaming',
        observedAt: FRESH,
        lagBytes: 65 * 1024 * 1024,
      },
      NOW,
    ),
    false,
  )
})

test('replicationFromMemberMetadata reads node.metadata.replication', () => {
  assertEquals(replicationFromMemberMetadata(null), undefined)
  assertEquals(
    replicationFromMemberMetadata({
      replication: { state: 'streaming', observedAt: FRESH },
    }),
    { state: 'streaming', observedAt: FRESH },
  )
})
