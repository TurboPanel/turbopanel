import { assertEquals } from '@std/assert'
import type { HaMemberCandidateInput } from '../../lib/managed/ha-policy.ts'
import { OrchestratorManagedHaAuthority } from './ha-authority.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function member(
  overrides: Partial<HaMemberCandidateInput> & Pick<HaMemberCandidateInput, 'id'>,
): HaMemberCandidateInput {
  return {
    role: 'replica',
    replicaClass: 'failover',
    ordinal: 2,
    sameDatacenterAsPrimary: true,
    healthy: true,
    ...overrides,
  }
}

test('OrchestratorManagedHaAuthority picks the lowest healthy same-DC failover', () => {
  const later = member({ id: 'b', ordinal: 3 })
  const earlier = member({ id: 'a', ordinal: 2 })
  const read = member({
    id: 'c',
    replicaClass: 'read',
    sameDatacenterAsPrimary: false,
  })
  const unhealthy = member({ id: 'd', ordinal: 1, healthy: false })

  assertEquals(
    OrchestratorManagedHaAuthority.isAutomaticCandidate(earlier),
    true,
  )
  assertEquals(OrchestratorManagedHaAuthority.isAutomaticCandidate(read), false)
  assertEquals(
    OrchestratorManagedHaAuthority.pickAutomaticCandidate([
      later,
      read,
      unhealthy,
      earlier,
    ])?.id,
    'a',
  )
  assertEquals(
    OrchestratorManagedHaAuthority.pickAutomaticCandidate([unhealthy, read]),
    null,
  )
})

test('OrchestratorManagedHaAuthority promotion and DR class rewrite', () => {
  assertEquals(OrchestratorManagedHaAuthority.promotionRule('failover'), 'prefer')
  assertEquals(OrchestratorManagedHaAuthority.promotionRule('read'), 'must_not')
  assertEquals(OrchestratorManagedHaAuthority.promotionRule(null), 'must_not')

  assertEquals(OrchestratorManagedHaAuthority.shouldUseOrchestrator(true), true)
  assertEquals(OrchestratorManagedHaAuthority.shouldUseOrchestrator(false), false)

  assertEquals(
    OrchestratorManagedHaAuthority.replicaClassAfterDisasterRecovery({
      role: 'primary',
      replicaClass: 'failover',
      sameDatacenterAsNewPrimary: false,
    }),
    null,
  )
  assertEquals(
    OrchestratorManagedHaAuthority.replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'failover',
      sameDatacenterAsNewPrimary: false,
    }),
    'read',
  )
  assertEquals(
    OrchestratorManagedHaAuthority.replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'read',
      sameDatacenterAsNewPrimary: true,
    }),
    'read',
  )
})
