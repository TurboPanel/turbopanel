import { assertEquals } from '@std/assert'
import {
  automaticFailoverBlockCause,
  automaticFailoverBlockedReason,
  isAutomaticFailoverCandidate,
  isAutomaticFailoverClassMember,
  orchestratorPromotionRule,
  pickAutomaticFailoverCandidate,
  pickHaAdvertiseAddress,
  replicaClassAfterDisasterRecovery,
  serverHostsManagedHa,
  shouldBlockUnreachablePrimaryFence,
  type HaMemberCandidateInput,
} from './ha-policy.ts'
import {
  AUTOMATIC_FAILOVER_BLOCKED_MESSAGE,
  AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE,
  AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE,
} from './recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const failoverSameDc: HaMemberCandidateInput = {
  id: 'm-failover',
  role: 'replica',
  replicaClass: 'failover',
  ordinal: 2,
  sameDatacenterAsPrimary: true,
  healthy: true,
}

const readSameDc: HaMemberCandidateInput = {
  id: 'm-read',
  role: 'replica',
  replicaClass: 'read',
  ordinal: 3,
  sameDatacenterAsPrimary: true,
  healthy: true,
}

const failoverRemote: HaMemberCandidateInput = {
  id: 'm-remote',
  role: 'replica',
  replicaClass: 'failover',
  ordinal: 4,
  sameDatacenterAsPrimary: false,
  healthy: true,
}

test('automatic candidate requires replica + failover + same datacenter + healthy', () => {
  assertEquals(isAutomaticFailoverCandidate(failoverSameDc), true)
  assertEquals(isAutomaticFailoverCandidate(readSameDc), false)
  assertEquals(isAutomaticFailoverCandidate(failoverRemote), false)
  assertEquals(
    isAutomaticFailoverCandidate({
      ...failoverSameDc,
      role: 'primary',
    }),
    false,
  )
  assertEquals(
    isAutomaticFailoverCandidate({ ...failoverSameDc, healthy: false }),
    false,
  )
  assertEquals(isAutomaticFailoverClassMember({ ...failoverSameDc, healthy: false }), true)
})

test('pickAutomaticFailoverCandidate is lowest ordinal and ignores readEligible', () => {
  const later = { ...failoverSameDc, id: 'm-later', ordinal: 5 }
  assertEquals(
    pickAutomaticFailoverCandidate([readSameDc, later, failoverSameDc])?.id,
    'm-failover',
  )
  assertEquals(pickAutomaticFailoverCandidate([readSameDc, failoverRemote]), null)
})

test('pickAutomaticFailoverCandidate skips unhealthy and picks the next healthy ordinal', () => {
  const unhealthyEarly = { ...failoverSameDc, id: 'm-lagging', ordinal: 2, healthy: false }
  const healthyLater = { ...failoverSameDc, id: 'm-ok', ordinal: 5, healthy: true }
  assertEquals(
    pickAutomaticFailoverCandidate([unhealthyEarly, healthyLater, readSameDc])?.id,
    'm-ok',
  )
  assertEquals(
    pickAutomaticFailoverCandidate([unhealthyEarly, readSameDc, failoverRemote]),
    null,
  )
})

test('automaticFailoverBlockCause distinguishes no-candidate from unhealthy', () => {
  assertEquals(automaticFailoverBlockCause([failoverSameDc]), null)
  assertEquals(automaticFailoverBlockCause([readSameDc, failoverRemote]), 'no-candidate')
  assertEquals(
    automaticFailoverBlockCause([{ ...failoverSameDc, healthy: false }]),
    'unhealthy',
  )
})

test('Orchestrator promotion rules prefer failover and must_not read', () => {
  assertEquals(orchestratorPromotionRule('failover'), 'prefer')
  assertEquals(orchestratorPromotionRule('read'), 'must_not')
  assertEquals(orchestratorPromotionRule(null), 'must_not')
})

test('unreachable primary fence blocks automatic failover only', () => {
  // Acceptance: auto-failover refuses an unproven fence; operator switchover
  // and manual DR may continue (four-member remote D stays a DR candidate).
  assertEquals(shouldBlockUnreachablePrimaryFence('automatic-failover'), true)
  assertEquals(shouldBlockUnreachablePrimaryFence('switchover'), false)
  assertEquals(shouldBlockUnreachablePrimaryFence('disaster-recovery'), false)
})

test('automaticFailoverBlockedReason uses the product copy', () => {
  assertEquals(
    automaticFailoverBlockedReason('unfenced'),
    AUTOMATIC_FAILOVER_BLOCKED_MESSAGE,
  )
  assertEquals(
    automaticFailoverBlockedReason('no-candidate'),
    AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE,
  )
  assertEquals(
    automaticFailoverBlockedReason('unhealthy'),
    AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE,
  )
})

test('disaster recovery demotes remote failover to read and never upgrades read', () => {
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'failover',
      sameDatacenterAsNewPrimary: false,
    }),
    'read',
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'failover',
      sameDatacenterAsNewPrimary: true,
    }),
    'failover',
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'read',
      sameDatacenterAsNewPrimary: true,
    }),
    'read',
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'primary',
      replicaClass: null,
      sameDatacenterAsNewPrimary: true,
    }),
    null,
  )
})

test('serverHostsManagedHa includes primary and failover, not read-only', () => {
  assertEquals(
    serverHostsManagedHa([{ role: 'primary', replicaClass: null }]),
    true,
  )
  assertEquals(
    serverHostsManagedHa([{ role: 'replica', replicaClass: 'failover' }]),
    true,
  )
  assertEquals(
    serverHostsManagedHa([{ role: 'replica', replicaClass: 'read' }]),
    false,
  )
})

test('pickHaAdvertiseAddress prefers IPv4 datacenter pins', () => {
  assertEquals(
    pickHaAdvertiseAddress([
      { address: '2001:db8::10', family: 6 },
      { address: '203.0.113.10', family: 4 },
    ]),
    '203.0.113.10',
  )
  assertEquals(pickHaAdvertiseAddress([]), null)
})

/**
 * Acceptance topology: A primary, B failover+reads, C failover standby,
 * D remote read. `readEligible` is not a candidate field.
 */
function fourMemberTopology(overrides?: {
  bHealthy?: boolean
  cHealthy?: boolean
}): HaMemberCandidateInput[] {
  return [
    {
      id: 'server-a',
      role: 'primary',
      replicaClass: null,
      ordinal: 1,
      sameDatacenterAsPrimary: true,
      healthy: true,
    },
    {
      id: 'server-b',
      role: 'replica',
      replicaClass: 'failover',
      ordinal: 2,
      sameDatacenterAsPrimary: true,
      healthy: overrides?.bHealthy ?? true,
    },
    {
      id: 'server-c',
      role: 'replica',
      replicaClass: 'failover',
      ordinal: 3,
      sameDatacenterAsPrimary: true,
      healthy: overrides?.cHealthy ?? true,
    },
    {
      id: 'server-d',
      role: 'replica',
      replicaClass: 'read',
      ordinal: 4,
      sameDatacenterAsPrimary: false,
      healthy: true,
    },
  ]
}

test('four-member topology: auto pick is same-DC failover, never the remote read', () => {
  // B would serve reads and C is standby-only; readEligible is not an input,
  // so disabling reads on B would not drop it from automatic candidacy.
  assertEquals(pickAutomaticFailoverCandidate(fourMemberTopology())?.id, 'server-b')
  assertEquals(automaticFailoverBlockCause(fourMemberTopology()), null)
  assertEquals(
    fourMemberTopology().some((row) =>
      row.id === 'server-d' && isAutomaticFailoverCandidate(row)
    ),
    false,
  )
})

test('four-member topology: unhealthy B yields C; both unhealthy blocks', () => {
  assertEquals(
    pickAutomaticFailoverCandidate(fourMemberTopology({ bHealthy: false }))?.id,
    'server-c',
  )
  assertEquals(
    pickAutomaticFailoverCandidate(fourMemberTopology({ bHealthy: false, cHealthy: false })),
    null,
  )
  assertEquals(
    automaticFailoverBlockCause(fourMemberTopology({ bHealthy: false, cHealthy: false })),
    'unhealthy',
  )
})

test('four-member topology: remote-only survivors are never automatic candidates', () => {
  const remoteOnly = fourMemberTopology().filter((row) =>
    row.id === 'server-a' || row.id === 'server-d'
  )
  assertEquals(pickAutomaticFailoverCandidate(remoteOnly), null)
  assertEquals(automaticFailoverBlockCause(remoteOnly), 'no-candidate')
})

test('disaster recovery reclassifies former same-DC failover members that left the new primary site', () => {
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'failover',
      sameDatacenterAsNewPrimary: false,
    }),
    'read',
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'read',
      sameDatacenterAsNewPrimary: true,
    }),
    'read',
  )
})
