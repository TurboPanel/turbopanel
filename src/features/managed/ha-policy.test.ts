import { assertEquals } from '@std/assert'
import {
  automaticFailoverBlockCause,
  automaticFailoverBlockedReason,
  isAutomaticFailoverCandidate,
  isAutomaticFailoverClassMember,
  orchestratorBindingRejection,
  orchestratorPromotionRule,
  pickAutomaticFailoverCandidate,
  pickHaAdvertiseAddress,
  assignHaRaftDatacenters,
  HA_DEFAULT_DATACENTER_POLICY,
  type HaDatacenterPolicy,
  type HaRaftPin,
  replicaClassAfterDisasterRecovery,
  selectHaRaftMembers,
  serverHostsManagedHa,
  shouldBlockUnreachablePrimaryFence,
  haEventRejection,
  automaticFailoverCoolingDown,
  type HaMemberCandidateInput,
} from './ha-policy.ts'
import {
  DEFAULT_DATACENTER_PRIORITY,
  DEFAULT_DATACENTER_TRUSTED,
} from '../datacenters/datacenter-options.ts'
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
    false
  )
  assertEquals(isAutomaticFailoverCandidate({ ...failoverSameDc, healthy: false }), false)
  assertEquals(isAutomaticFailoverClassMember({ ...failoverSameDc, healthy: false }), true)
})

test('pickAutomaticFailoverCandidate is lowest ordinal and ignores readEligible', () => {
  const later = { ...failoverSameDc, id: 'm-later', ordinal: 5 }
  assertEquals(
    pickAutomaticFailoverCandidate([readSameDc, later, failoverSameDc])?.id,
    'm-failover'
  )
  assertEquals(pickAutomaticFailoverCandidate([readSameDc, failoverRemote]), null)
  // Equal ordinal: stable id order via localeCompare.
  const twinA = { ...failoverSameDc, id: 'm-a', ordinal: 2 }
  const twinB = { ...failoverSameDc, id: 'm-b', ordinal: 2 }
  assertEquals(pickAutomaticFailoverCandidate([twinB, twinA])?.id, 'm-a')
})

test('pickAutomaticFailoverCandidate skips unhealthy and picks the next healthy ordinal', () => {
  const unhealthyEarly = { ...failoverSameDc, id: 'm-lagging', ordinal: 2, healthy: false }
  const healthyLater = { ...failoverSameDc, id: 'm-ok', ordinal: 5, healthy: true }
  assertEquals(
    pickAutomaticFailoverCandidate([unhealthyEarly, healthyLater, readSameDc])?.id,
    'm-ok'
  )
  assertEquals(pickAutomaticFailoverCandidate([unhealthyEarly, readSameDc, failoverRemote]), null)
})

test('automaticFailoverBlockCause distinguishes no-candidate from unhealthy', () => {
  assertEquals(automaticFailoverBlockCause([failoverSameDc]), null)
  assertEquals(automaticFailoverBlockCause([readSameDc, failoverRemote]), 'no-candidate')
  assertEquals(automaticFailoverBlockCause([{ ...failoverSameDc, healthy: false }]), 'unhealthy')
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
  assertEquals(automaticFailoverBlockedReason('unfenced'), AUTOMATIC_FAILOVER_BLOCKED_MESSAGE)
  assertEquals(
    automaticFailoverBlockedReason('no-candidate'),
    AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE
  )
  assertEquals(automaticFailoverBlockedReason('unhealthy'), AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE)
})

test('disaster recovery demotes remote failover to read and never upgrades read', () => {
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'failover',
      sameDatacenterAsNewPrimary: false,
    }),
    'read'
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'failover',
      sameDatacenterAsNewPrimary: true,
    }),
    'failover'
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'read',
      sameDatacenterAsNewPrimary: true,
    }),
    'read'
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'primary',
      replicaClass: null,
      sameDatacenterAsNewPrimary: true,
    }),
    null
  )
  // Unknown / missing replica class on a non-primary falls back to read.
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: null,
      sameDatacenterAsNewPrimary: true,
    }),
    'read'
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'standby',
      sameDatacenterAsNewPrimary: false,
    }),
    'read'
  )
})

test('serverHostsManagedHa includes primary and failover, not read-only', () => {
  assertEquals(serverHostsManagedHa([{ role: 'primary', replicaClass: null }]), true)
  assertEquals(serverHostsManagedHa([{ role: 'replica', replicaClass: 'failover' }]), true)
  assertEquals(serverHostsManagedHa([{ role: 'replica', replicaClass: 'read' }]), false)
})

test('pickHaAdvertiseAddress prefers IPv4 datacenter pins', () => {
  assertEquals(
    pickHaAdvertiseAddress([
      { address: '2001:db8::10', family: 6 },
      { address: '203.0.113.10', family: 4 },
    ]),
    '203.0.113.10'
  )
  assertEquals(pickHaAdvertiseAddress([{ address: '2001:db8::10', family: 6 }]), '2001:db8::10')
  assertEquals(pickHaAdvertiseAddress([]), null)
})

test('selectHaRaftMembers keeps the raft group inside this server datacenter', () => {
  const pins = new Map([
    ['lan-a', [{ datacenterId: 'dc-lan', address: '10.10.1.10', family: 4 as const }]],
    ['lan-b', [{ datacenterId: 'dc-lan', address: '10.10.1.20', family: 4 as const }]],
    ['vpc-a', [{ datacenterId: 'dc-vpc', address: '10.100.0.4', family: 4 as const }]],
    ['vpc-b', [{ datacenterId: 'dc-vpc', address: '10.100.0.5', family: 4 as const }]],
  ])
  const all = ['lan-a', 'lan-b', 'vpc-a', 'vpc-b']
  assertEquals(selectHaRaftMembers('vpc-a', all, pins), {
    advertiseAddress: '10.100.0.4',
    peers: [
      { serverId: 'vpc-a', address: '10.100.0.4' },
      { serverId: 'vpc-b', address: '10.100.0.5' },
    ],
  })
  assertEquals(
    selectHaRaftMembers('lan-b', all, pins)?.peers.map((peer) => peer.serverId),
    ['lan-a', 'lan-b']
  )
})

test('selectHaRaftMembers dials a multi-datacenter peer on its shared-datacenter pin', () => {
  const pins = new Map([
    ['a', [{ datacenterId: 'dc-1', address: '10.0.0.1', family: 4 as const }]],
    [
      'b',
      [
        { datacenterId: 'dc-2', address: '192.168.0.2', family: 4 as const },
        { datacenterId: 'dc-1', address: '10.0.0.2', family: 4 as const },
      ],
    ],
  ])
  assertEquals(selectHaRaftMembers('a', ['a', 'b'], pins)?.peers, [
    { serverId: 'a', address: '10.0.0.1' },
    { serverId: 'b', address: '10.0.0.2' },
  ])
  assertEquals(selectHaRaftMembers('c', ['a', 'b', 'c'], pins), null)
})

test('pickHaAdvertiseAddress does not depend on row order', () => {
  const pins = [
    { address: '10.0.0.9', family: 4 as const },
    { address: '10.0.0.3', family: 4 as const },
    { address: '2001:db8::1', family: 6 as const },
  ]
  assertEquals(pickHaAdvertiseAddress(pins), '10.0.0.3')
  assertEquals(pickHaAdvertiseAddress(pins.toReversed()), '10.0.0.3')
})

test('selectHaRaftMembers uses the highest-priority trusted datacenter, whatever the pin order', () => {
  // Both servers share two networks: a public-cloud VPC (priority 100, the
  // default) and a private LAN the owner ranked first (priority 10).
  const aPins = [
    { datacenterId: 'dc-vpc', address: '10.100.0.4', family: 4 as const },
    { datacenterId: 'dc-lan', address: '192.168.1.4', family: 4 as const },
  ]
  const bPins = [
    { datacenterId: 'dc-lan', address: '192.168.1.5', family: 4 as const },
    { datacenterId: 'dc-vpc', address: '10.100.0.5', family: 4 as const },
  ]
  const policies = new Map([
    ['dc-lan', { priority: 10, trusted: true }],
    ['dc-vpc', { priority: 100, trusted: true }],
  ])
  const expected = {
    advertiseAddress: '192.168.1.4',
    peers: [
      { serverId: 'a', address: '192.168.1.4' },
      { serverId: 'b', address: '192.168.1.5' },
    ],
  }
  for (const order of [aPins, aPins.toReversed()]) {
    const pins = new Map([
      ['a', order],
      ['b', bPins],
    ])
    assertEquals(selectHaRaftMembers('a', ['a', 'b'], pins, policies), expected)
  }
})

test('selectHaRaftMembers never puts Raft on a network marked untrusted', () => {
  const pins = new Map([
    [
      'a',
      [
        { datacenterId: 'dc-open', address: '172.16.0.4', family: 4 as const },
        { datacenterId: 'dc-safe', address: '10.0.0.4', family: 4 as const },
      ],
    ],
    [
      'b',
      [
        { datacenterId: 'dc-open', address: '172.16.0.5', family: 4 as const },
        { datacenterId: 'dc-safe', address: '10.0.0.5', family: 4 as const },
      ],
    ],
  ])
  // The untrusted network has the better priority; it is still skipped.
  const policies = new Map([
    ['dc-open', { priority: 1, trusted: false }],
    ['dc-safe', { priority: 50, trusted: true }],
  ])
  assertEquals(selectHaRaftMembers('a', ['a', 'b'], pins, policies)?.peers, [
    { serverId: 'a', address: '10.0.0.4' },
    { serverId: 'b', address: '10.0.0.5' },
  ])
  // Only untrusted networks: no Raft group rather than one on that network.
  const onlyOpen = new Map([['a', [pins.get('a')![0]!]]])
  assertEquals(selectHaRaftMembers('a', ['a'], onlyOpen, policies), null)
})

test('assignHaRaftDatacenters breaks a priority tie by datacenter id and defaults missing policies', () => {
  const pins = new Map([
    [
      'a',
      [
        { datacenterId: 'dc-b', address: '10.0.0.2', family: 4 as const },
        { datacenterId: 'dc-a', address: '10.0.0.1', family: 4 as const },
      ],
    ],
  ])
  assertEquals(assignHaRaftDatacenters(['a'], pins, new Map()).get('a'), 'dc-a')
  assertEquals(
    assignHaRaftDatacenters(['a'], pins, new Map([['dc-b', { priority: 5, trusted: true }]])).get(
      'a'
    ),
    'dc-b'
  )
  assertEquals(assignHaRaftDatacenters(['a'], new Map(), new Map()).size, 0)
})

test('the Raft default policy matches the documented datacenter defaults', () => {
  assertEquals(HA_DEFAULT_DATACENTER_POLICY, {
    priority: DEFAULT_DATACENTER_PRIORITY,
    trusted: DEFAULT_DATACENTER_TRUSTED,
  })
})

/** Every server's voter list, keyed by server, for agreement checks. */
function allMemberLists(
  ids: readonly string[],
  pins: ReadonlyMap<string, readonly HaRaftPin[]>,
  policies: ReadonlyMap<string, HaDatacenterPolicy>
): Map<string, string[]> {
  const lists = new Map<string, string[]>()
  for (const id of ids) {
    const members = selectHaRaftMembers(id, ids, pins, policies)
    if (members) lists.set(id, members.peers.map((peer) => peer.serverId).toSorted())
  }
  return lists
}

test('Raft servers never disagree on their group when one sits on a better private network alone', () => {
  // A is alone on a LAN the owner ranked first and shares the VPC with B and
  // C. A must not form a group of one there while B and C count it as a voter.
  const pins = new Map<string, HaRaftPin[]>([
    [
      'a',
      [
        { datacenterId: 'dc-lan', address: '192.168.1.4', family: 4 },
        { datacenterId: 'dc-vpc', address: '10.100.0.4', family: 4 },
      ],
    ],
    ['b', [{ datacenterId: 'dc-vpc', address: '10.100.0.5', family: 4 }]],
    ['c', [{ datacenterId: 'dc-vpc', address: '10.100.0.6', family: 4 }]],
  ])
  const policies = new Map([
    ['dc-lan', { priority: 10, trusted: true }],
    ['dc-vpc', { priority: 100, trusted: true }],
  ])
  const ids = ['a', 'b', 'c']
  assertEquals(selectHaRaftMembers('a', ids, pins, policies), {
    advertiseAddress: '10.100.0.4',
    peers: [
      { serverId: 'a', address: '10.100.0.4' },
      { serverId: 'b', address: '10.100.0.5' },
      { serverId: 'c', address: '10.100.0.6' },
    ],
  })
  const lists = allMemberLists(ids, pins, policies)
  for (const id of ids) assertEquals(lists.get(id), ['a', 'b', 'c'])
})

test('Raft groups stay mutually consistent when servers share several networks', () => {
  // A and B share a LAN (priority 10); all three share a VPC (priority 100).
  const pins = new Map<string, HaRaftPin[]>([
    [
      'a',
      [
        { datacenterId: 'dc-lan', address: '192.168.1.4', family: 4 },
        { datacenterId: 'dc-vpc', address: '10.100.0.4', family: 4 },
      ],
    ],
    [
      'b',
      [
        { datacenterId: 'dc-vpc', address: '10.100.0.5', family: 4 },
        { datacenterId: 'dc-lan', address: '192.168.1.5', family: 4 },
      ],
    ],
    ['c', [{ datacenterId: 'dc-vpc', address: '10.100.0.6', family: 4 }]],
  ])
  const policies = new Map([
    ['dc-lan', { priority: 10, trusted: true }],
    ['dc-vpc', { priority: 100, trusted: true }],
  ])
  const ids = ['a', 'b', 'c']
  const lists = allMemberLists(ids, pins, policies)
  // Whoever lists a voter is listed back by it, with the same group.
  for (const [id, members] of lists) {
    assertEquals(members.includes(id), true)
    for (const peer of members) assertEquals(lists.get(peer), members)
  }
  assertEquals(lists.get('a'), ['a', 'b'])
  assertEquals(lists.get('c'), ['c'])
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
    fourMemberTopology().some((row) => row.id === 'server-d' && isAutomaticFailoverCandidate(row)),
    false
  )
})

test('four-member topology: unhealthy B yields C; both unhealthy blocks', () => {
  assertEquals(
    pickAutomaticFailoverCandidate(fourMemberTopology({ bHealthy: false }))?.id,
    'server-c'
  )
  assertEquals(
    pickAutomaticFailoverCandidate(fourMemberTopology({ bHealthy: false, cHealthy: false })),
    null
  )
  assertEquals(
    automaticFailoverBlockCause(fourMemberTopology({ bHealthy: false, cHealthy: false })),
    'unhealthy'
  )
})

test('four-member topology: remote-only survivors are never automatic candidates', () => {
  const remoteOnly = fourMemberTopology().filter(
    (row) => row.id === 'server-a' || row.id === 'server-d'
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
    'read'
  )
  assertEquals(
    replicaClassAfterDisasterRecovery({
      role: 'replica',
      replicaClass: 'read',
      sameDatacenterAsNewPrimary: true,
    }),
    'read'
  )
})

const PRIMARY = { id: 'mem-primary', serverId: 'srv-a' }
const GATE = {
  detector: 'postgres-probe',
  engine: 'postgres',
  sourceMemberId: 'mem-primary',
  reporterServerId: 'srv-a',
  reporterOrganizationId: 'org-1',
  clusterOrganizationId: 'org-1',
  memberServerIds: ['srv-a', 'srv-b'],
  primary: PRIMARY,
}

test('haEventRejection: Orchestrator events (no detector) cover MySQL/MariaDB only', () => {
  const orchestrator = { ...GATE, detector: undefined, sourceMemberId: undefined }
  for (const engine of ['mysql', 'mariadb']) {
    assertEquals(haEventRejection({ ...orchestrator, engine }), null)
  }
  assertEquals(
    haEventRejection({ ...orchestrator, engine: 'postgres' }),
    'detector orchestrator does not cover engine postgres'
  )
  assertEquals(
    haEventRejection({ ...orchestrator, detector: 'orchestrator', engine: 'postgres' }),
    'detector orchestrator does not cover engine postgres'
  )
})

test('haEventRejection: every detector must come from a member server of the same org', () => {
  for (const base of [GATE, { ...GATE, detector: undefined, engine: 'mysql' }]) {
    assertEquals(
      haEventRejection({ ...base, reporterServerId: 'srv-x' }),
      'reporting server hosts no member of this cluster'
    )
    assertEquals(
      haEventRejection({ ...base, reporterOrganizationId: 'org-2' }),
      "reporting server is not in the cluster's organization"
    )
    assertEquals(
      haEventRejection({ ...base, reporterOrganizationId: null }),
      "reporting server is not in the cluster's organization"
    )
    assertEquals(
      haEventRejection({ ...base, clusterOrganizationId: null, reporterOrganizationId: null }),
      "reporting server is not in the cluster's organization"
    )
  }
})

test('haEventRejection: postgres-probe must name the current primary from its own server', () => {
  assertEquals(haEventRejection(GATE), null)
  assertEquals(
    haEventRejection({ ...GATE, sourceMemberId: 'mem-old-primary' }),
    'event does not name the current primary'
  )
  assertEquals(haEventRejection({ ...GATE, sourceMemberId: undefined }) !== null, true)
  assertEquals(
    haEventRejection({ ...GATE, reporterServerId: 'srv-b' }),
    "event did not come from the current primary's server"
  )
  assertEquals(haEventRejection({ ...GATE, primary: null }), 'no current primary')
})

test('haEventRejection: postgres-probe never speaks for MySQL/MariaDB', () => {
  for (const engine of ['mysql', 'mariadb']) {
    assertEquals(
      haEventRejection({ ...GATE, engine }),
      `detector postgres-probe does not cover engine ${engine}`
    )
  }
})

test('haEventRejection: unknown detectors (e.g. host loss, not enabled) never fail over', () => {
  assertEquals(
    haEventRejection({ ...GATE, detector: 'host-lost' }),
    'detector host-lost may not start automatic failover'
  )
})

test('automaticFailoverCoolingDown: 15 minutes from the last accepted failover', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  assertEquals(automaticFailoverCoolingDown(null, now), false)
  assertEquals(automaticFailoverCoolingDown('2026-10-01T11:50:00Z', now), true)
  assertEquals(automaticFailoverCoolingDown('2026-10-01T11:45:00Z', now), false)
  assertEquals(automaticFailoverCoolingDown('not-a-date', now), false)
})

const BOUND_PRIMARY = { host: '10.0.0.5', port: 3306 }

test('orchestratorBindingRejection: the current primary proceeds', () => {
  assertEquals(
    orchestratorBindingRejection({
      reporterBindsInstance: true,
      instanceHost: '10.0.0.5',
      instancePort: 3306,
      expectedPrimary: BOUND_PRIMARY,
    }),
    null
  )
})

test('orchestratorBindingRejection: another host, another port, or no primary address is stale', () => {
  const base = { reporterBindsInstance: true, expectedPrimary: BOUND_PRIMARY }
  assertEquals(
    typeof orchestratorBindingRejection({ ...base, instanceHost: '10.0.0.6', instancePort: 3306 }),
    'string'
  )
  assertEquals(
    typeof orchestratorBindingRejection({ ...base, instanceHost: '10.0.0.5', instancePort: 3307 }),
    'string'
  )
  assertEquals(
    typeof orchestratorBindingRejection({
      ...base,
      instanceHost: '10.0.0.5',
      instancePort: 3306,
      expectedPrimary: null,
    }),
    'string'
  )
})

test('orchestratorBindingRejection: a missing instance is legacy only for a daemon without the feature', () => {
  assertEquals(
    orchestratorBindingRejection({ reporterBindsInstance: false, expectedPrimary: BOUND_PRIMARY }),
    null
  )
  assertEquals(
    typeof orchestratorBindingRejection({
      reporterBindsInstance: true,
      expectedPrimary: BOUND_PRIMARY,
    }),
    'string'
  )
})
