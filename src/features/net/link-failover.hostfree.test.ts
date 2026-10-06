/**
 * Host-free coverage for "use the best network that is up": the link-aware
 * resolver ladder, `splitTrustedByLink`, and the TurboFabric LAN rung.
 */

import { assertEquals } from '@std/assert'
import type { DatacenterMembershipRow } from './datacenter-membership.ts'
import type { DatacenterPolicyRow } from './datacenter-networks.ts'
import {
  type PrivateEndpointCaches,
  resolveOneFromCaches,
  splitTrustedByLink,
} from './private-endpoint.ts'
import { directCandidates, type EndpointAddressCaches } from '../fabric/fabric-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const LAN = 'dc-lan'
const BACKHAUL = 'dc-backhaul'

function pin(
  serverId: string,
  datacenterId: string,
  address: string,
  linkDown = false
): DatacenterMembershipRow {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: null,
    address,
    family: 4,
    ...(linkDown ? { linkDown: true } : {}),
  }
}

function policy(priority: number, trusted = true): DatacenterPolicyRow {
  return { addressPreference: 'ipv4', priority, trusted }
}

/** `a` and `b` share a normal LAN (priority 100) and a backhaul (priority 10). */
function twoNicCaches(
  down: { aBackhaul?: boolean; bBackhaul?: boolean; aLan?: boolean } = {}
): PrivateEndpointCaches {
  return {
    membershipsByServer: new Map([
      [
        'a',
        [pin('a', LAN, '192.168.1.10', down.aLan), pin('a', BACKHAUL, '10.9.0.10', down.aBackhaul)],
      ],
      ['b', [pin('b', LAN, '192.168.1.11'), pin('b', BACKHAUL, '10.9.0.11', down.bBackhaul)]],
    ]),
    relays: [],
    policiesByDatacenter: new Map([
      [LAN, policy(100)],
      [BACKHAUL, policy(10)],
    ]),
    publicAddressesByServer: new Map([['b', '203.0.113.11']]),
  }
}

function resolve(
  caches: PrivateEndpointCaches,
  purpose: 'failover-replication' | 'read-replication' | 'client-backend'
) {
  return resolveOneFromCaches({ fromServerId: 'a', toServerId: 'b', purpose, ...caches })
}

test('lowest priority number wins while both links are up (or unreported)', () => {
  for (const purpose of ['failover-replication', 'read-replication', 'client-backend'] as const) {
    assertEquals(resolve(twoNicCaches(), purpose), {
      address: '10.9.0.11',
      transport: 'datacenter',
      datacenterId: BACKHAUL,
    })
  }
})

test('a backhaul whose link is down on either server hands over to the next network by priority', () => {
  for (const down of [{ aBackhaul: true }, { bBackhaul: true }]) {
    for (const purpose of ['failover-replication', 'read-replication', 'client-backend'] as const) {
      assertEquals(resolve(twoNicCaches(down), purpose), {
        address: '192.168.1.11',
        transport: 'datacenter',
        datacenterId: LAN,
      })
    }
  }
})

test('the backhaul takes over again once the link flag is cleared', () => {
  const caches = twoNicCaches({ aBackhaul: true })
  assertEquals((resolve(caches, 'client-backend') as { datacenterId: string }).datacenterId, LAN)
  assertEquals(
    (resolve(twoNicCaches(), 'client-backend') as { datacenterId: string }).datacenterId,
    BACKHAUL
  )
})

test('every network down: failover replication keeps the best-priority network as a last resort', () => {
  const resolved = resolve(twoNicCaches({ aBackhaul: true, aLan: true }), 'failover-replication')
  assertEquals(resolved, {
    address: '10.9.0.11',
    transport: 'datacenter',
    datacenterId: BACKHAUL,
    linkDown: true,
  })
})

test('every datacenter network down: read and client traffic use fabric or public before a dead network', () => {
  const caches = twoNicCaches({ aBackhaul: true, aLan: true })
  assertEquals(resolve(caches, 'client-backend'), { address: '203.0.113.11', transport: 'public' })
  caches.publicAddressesByServer.clear()
  assertEquals(resolve(caches, 'client-backend'), {
    address: '10.9.0.11',
    transport: 'datacenter',
    datacenterId: BACKHAUL,
    linkDown: true,
  })
})

test('a network down on one server only does not hide an up network of lower priority', () => {
  const caches = twoNicCaches({ aBackhaul: true })
  caches.policiesByDatacenter.set(LAN, policy(500))
  assertEquals((resolve(caches, 'read-replication') as { datacenterId: string }).datacenterId, LAN)
})

test('an untrusted network is never chosen, up or down', () => {
  const caches = twoNicCaches()
  caches.policiesByDatacenter.set(BACKHAUL, policy(0, false))
  assertEquals((resolve(caches, 'client-backend') as { datacenterId: string }).datacenterId, LAN)
})

test('splitTrustedByLink keeps (priority, id) order in both lists', () => {
  const fromPins = [
    pin('a', 'dc-1', '10.1.0.1', true),
    pin('a', 'dc-2', '10.2.0.1'),
    pin('a', 'dc-3', '10.3.0.1'),
  ]
  const toPins = [
    pin('b', 'dc-1', '10.1.0.2'),
    pin('b', 'dc-2', '10.2.0.2'),
    pin('b', 'dc-3', '10.3.0.2', true),
  ]
  assertEquals(splitTrustedByLink(['dc-1', 'dc-2', 'dc-3'], fromPins, toPins), {
    available: ['dc-2'],
    down: ['dc-1', 'dc-3'],
  })
  assertEquals(splitTrustedByLink(['dc-1'], [], []), { available: ['dc-1'], down: [] })
})

function fabricCaches(down: boolean): EndpointAddressCaches {
  return {
    publicAddressByServer: new Map([['b', '203.0.113.11']]),
    reportedByServer: new Map(),
    datacenterMembershipsByServer: new Map([
      ['a', [pin('a', BACKHAUL, '10.9.0.10', down)]],
      ['b', [pin('b', BACKHAUL, '10.9.0.11')]],
    ]),
    policyByDatacenter: new Map([[BACKHAUL, policy(10)]]),
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
  }
}

test('TurboFabric tries a LAN whose link is up first, public next, a dead LAN last', () => {
  const peer = { serverId: 'b', endpointAddress: null }
  assertEquals(directCandidates('a', peer, fabricCaches(false)), [
    { kind: 'direct_lan', address: '10.9.0.11', datacenterId: BACKHAUL },
    { kind: 'direct_public', address: '203.0.113.11' },
  ])
  assertEquals(directCandidates('a', peer, fabricCaches(true)), [
    { kind: 'direct_public', address: '203.0.113.11' },
    { kind: 'direct_lan', address: '10.9.0.11', datacenterId: BACKHAUL },
  ])
})

test('a dead LAN is still the only candidate when nothing else reaches the peer', () => {
  const caches = fabricCaches(true)
  caches.publicAddressByServer.clear()
  assertEquals(directCandidates('a', { serverId: 'b', endpointAddress: null }, caches), [
    { kind: 'direct_lan', address: '10.9.0.11', datacenterId: BACKHAUL },
  ])
})

test('up networks with no shared address family hand over to a compatible network that is down, not to an error', () => {
  // Backhaul (priority 10, up) is IPv6 on a and IPv4 on b: no common family.
  // The office LAN (priority 100) is compatible but a's link there is down.
  const caches = twoNicCaches({ aLan: true })
  caches.membershipsByServer.set('a', [
    pin('a', LAN, '192.168.1.10', true),
    { ...pin('a', BACKHAUL, 'fd00:9::10'), family: 6 },
  ])
  for (const purpose of ['failover-replication', 'read-replication', 'client-backend'] as const) {
    assertEquals(resolve(caches, purpose), {
      address: '192.168.1.11',
      transport: 'datacenter',
      datacenterId: LAN,
      linkDown: true,
    })
  }
})

test('up networks with no shared family and nothing else compatible still report the family mismatch', () => {
  const caches = twoNicCaches()
  caches.membershipsByServer.set('a', [
    { ...pin('a', LAN, 'fd00:1::10'), family: 6 },
    { ...pin('a', BACKHAUL, 'fd00:9::10'), family: 6 },
  ])
  for (const purpose of ['failover-replication', 'read-replication', 'client-backend'] as const) {
    const resolved = resolve(caches, purpose)
    assertEquals('kind' in resolved && resolved.kind, 'private_family_mismatch')
  }
})

test('a network counts as down when any pin of either server in it is flagged, whatever the family', () => {
  const fromPins = [
    pin('a', LAN, '192.168.1.10'),
    { ...pin('a', LAN, 'fd00:1::10', true), family: 6 as const },
  ]
  const toPins = [pin('b', LAN, '192.168.1.11')]
  assertEquals(splitTrustedByLink([LAN], fromPins, toPins), { available: [], down: [LAN] })
})

test('TurboFabric with two LANs, one up and one down: LAN-up, public, NAT, then LAN-down', () => {
  const caches = fabricCaches(false)
  caches.datacenterMembershipsByServer.set('a', [
    pin('a', BACKHAUL, '10.9.0.10', true),
    pin('a', LAN, '192.168.1.10'),
  ])
  caches.datacenterMembershipsByServer.set('b', [
    pin('b', BACKHAUL, '10.9.0.11'),
    pin('b', LAN, '192.168.1.11'),
  ])
  caches.policyByDatacenter.set(LAN, policy(100))
  caches.natEndpointByPair.set('a>b', '198.51.100.7:51820')
  assertEquals(directCandidates('a', { serverId: 'b', endpointAddress: null }, caches), [
    { kind: 'direct_lan', address: '192.168.1.11', datacenterId: LAN },
    { kind: 'direct_public', address: '203.0.113.11' },
    { kind: 'direct_nat', address: '198.51.100.7:51820' },
    { kind: 'direct_lan', address: '10.9.0.11', datacenterId: BACKHAUL },
  ])
})
