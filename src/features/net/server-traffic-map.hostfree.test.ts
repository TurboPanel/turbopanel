/**
 * Host-free coverage for the server traffic map builder: chosen network by
 * priority, link-down handling, planned versus observed, and the
 * "not on the chosen network" flag.
 */

import { assertEquals } from '@std/assert'
import type { ServerReportedIp } from '../../contracts/server-addresses.ts'
import type { DatacenterMembershipRow } from './datacenter-membership.ts'
import type { DatacenterPolicyRow } from './datacenter-networks.ts'
import type { PrivateEndpointCaches } from './private-endpoint.ts'
import {
  buildServerTrafficMap,
  type BuildServerTrafficMapInput,
  type TrafficMapRelay,
} from './server-traffic-map.ts'

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

function ip(
  address: string,
  iface: string,
  link?: 'up' | 'down',
  preferred = false
): ServerReportedIp {
  return {
    address,
    version: 4,
    scope: 'private',
    interface: iface,
    ...(link ? { link } : {}),
    ...(preferred ? { preferred: true } : {}),
  }
}

function caches(options: { aBackhaulDown?: boolean } = {}): PrivateEndpointCaches {
  return {
    membershipsByServer: new Map([
      [
        'a',
        [pin('a', LAN, '192.168.1.10'), pin('a', BACKHAUL, '10.9.0.10', options.aBackhaulDown)],
      ],
      ['b', [pin('b', LAN, '192.168.1.11'), pin('b', BACKHAUL, '10.9.0.11')]],
    ]),
    relays: [],
    policiesByDatacenter: new Map([
      [LAN, policy(100)],
      [BACKHAUL, policy(10)],
    ]),
    publicAddressesByServer: new Map(),
  }
}

function input(
  options: { aBackhaulDown?: boolean; relays?: TrafficMapRelay[] } = {}
): BuildServerTrafficMapInput {
  const aLink = options.aBackhaulDown ? 'down' : 'up'
  return {
    serverId: 'a',
    peers: [
      { serverId: 'a', name: 'adrastea' },
      { serverId: 'b', name: 'kore' },
    ],
    caches: caches(options),
    datacenterNames: new Map([
      [LAN, 'Office LAN'],
      [BACKHAUL, 'Backhaul'],
    ]),
    reportedIpsByServer: new Map([
      ['a', [ip('192.168.1.10', 'eth0', 'up', true), ip('10.9.0.10', 'eth1', aLink)]],
      ['b', [ip('192.168.1.11', 'eth0', 'up', true), ip('10.9.0.11', 'eth1', 'up')]],
    ]),
    fabricRelays: options.relays ?? [],
    nicMetrics: new Map([['eth0', { deviceId: 'nic-eth0', monitored: true, speedMbps: 1000 }]]),
  }
}

test('the backhaul wins by priority and carries every kind of traffic', () => {
  const map = buildServerTrafficMap(input())
  assertEquals(map.peers.length, 1)
  const peer = map.peers[0]
  assertEquals(peer.name, 'kore')
  assertEquals(peer.chosenDatacenterId, BACKHAUL)
  assertEquals(
    peer.sharedNetworks.map((row) => [row.datacenterId, row.state, row.localInterface]),
    [
      [BACKHAUL, 'chosen', 'eth1'],
      [LAN, 'standby', 'eth0'],
    ]
  )
  assertEquals(peer.sharedNetworks[0].name, 'Backhaul')
  assertEquals(peer.sharedNetworks[0].priority, 10)
  for (const row of peer.traffic) {
    assertEquals(row.planned?.datacenterId, BACKHAUL)
    assertEquals(row.planned?.address, '10.9.0.11')
    assertEquals(row.planned?.localInterface, 'eth1')
    assertEquals(row.onChosenNetwork, true)
  }
})

test('a backhaul with its link down is listed down and the LAN becomes the chosen network', () => {
  const peer = buildServerTrafficMap(input({ aBackhaulDown: true })).peers[0]
  assertEquals(peer.chosenDatacenterId, LAN)
  assertEquals(
    peer.sharedNetworks.map((row) => [row.datacenterId, row.state, row.localLink, row.peerLink]),
    [
      [LAN, 'chosen', 'up', 'up'],
      [BACKHAUL, 'link_down', 'down', 'up'],
    ]
  )
  for (const row of peer.traffic) assertEquals(row.planned?.datacenterId, LAN)
})

test('every shared network down: nothing is chosen and traffic is marked as a last resort', () => {
  const base = input({ aBackhaulDown: true })
  base.caches.membershipsByServer.set('a', [
    pin('a', LAN, '192.168.1.10', true),
    pin('a', BACKHAUL, '10.9.0.10', true),
  ])
  const peer = buildServerTrafficMap(base).peers[0]
  assertEquals(peer.chosenDatacenterId, null)
  assertEquals(
    peer.sharedNetworks.map((row) => row.state),
    ['link_down', 'link_down']
  )
  const failover = peer.traffic.find((row) => row.purpose === 'failover-replication')
  assertEquals(failover?.planned?.linkDown, true)
  assertEquals(failover?.planned?.datacenterId, BACKHAUL)
  assertEquals(failover?.onChosenNetwork, false)
})

test('an untrusted shared network is shown as untrusted and never chosen', () => {
  const base = input()
  base.caches.policiesByDatacenter.set(BACKHAUL, policy(0, false))
  const peer = buildServerTrafficMap(base).peers[0]
  assertEquals(peer.chosenDatacenterId, LAN)
  assertEquals(
    peer.sharedNetworks.map((row) => row.state),
    ['chosen', 'untrusted']
  )
})

test('a better-priority network without an address both servers can use is skipped for the chosen one', () => {
  const base = input()
  base.caches.policiesByDatacenter.set(LAN, policy(5))
  // The LAN has IPv6 on one side and IPv4 on the other: no common family there.
  base.caches.membershipsByServer.set('a', [
    { ...pin('a', LAN, '2001:db8::1'), family: 6 },
    pin('a', BACKHAUL, '10.9.0.10'),
  ])
  const peer = buildServerTrafficMap(base).peers[0]
  assertEquals(peer.chosenDatacenterId, BACKHAUL)
  assertEquals(
    peer.traffic.every((row) => row.planned?.datacenterId === BACKHAUL),
    true
  )
  assertEquals(
    peer.traffic.every((row) => row.onChosenNetwork),
    true
  )
})

test('no network both servers can use: error rows and nothing chosen', () => {
  const base = input()
  base.caches.membershipsByServer.set('a', [{ ...pin('a', LAN, '2001:db8::1'), family: 6 }])
  base.caches.membershipsByServer.set('b', [pin('b', LAN, '192.168.1.11')])
  const peer = buildServerTrafficMap(base).peers[0]
  assertEquals(peer.chosenDatacenterId, null)
  assertEquals(
    peer.traffic.every((row) => row.error === 'private_family_mismatch'),
    true
  )
})

test('a peer that shares nothing private still lists its fallback by error, with no chosen network', () => {
  const base = input()
  base.caches.membershipsByServer.set('b', [])
  const peer = buildServerTrafficMap(base).peers[0]
  assertEquals(peer.chosenDatacenterId, null)
  assertEquals(peer.sharedNetworks, [])
  assertEquals(
    peer.traffic.map((row) => row.error),
    ['private_path_unavailable', 'private_path_unavailable', 'private_path_unavailable']
  )
})

test('the NIC list shows link state, the default-route NIC and the datacenter each address is pinned into', () => {
  const map = buildServerTrafficMap(input({ aBackhaulDown: true }))
  assertEquals(map.nics, [
    {
      name: 'eth0',
      link: 'up',
      defaultRoute: true,
      addresses: [{ address: '192.168.1.10', datacenterId: LAN }],
      metrics: { deviceId: 'nic-eth0', monitored: true, speedMbps: 1000 },
    },
    {
      name: 'eth1',
      link: 'down',
      defaultRoute: false,
      addresses: [{ address: '10.9.0.10', datacenterId: BACKHAUL }],
      metrics: null,
    },
  ])
})

const RELAYS: TrafficMapRelay[] = [
  {
    serverId: 'a',
    publicKey: 'key-a',
    metadata: {
      paths: {
        entries: [
          {
            peerServerId: 'b',
            selected: 'direct_lan',
            endpoint: '10.9.0.11:51820',
            degraded: false,
          },
        ],
      },
      observed: {
        at: '2026-10-05T10:00:00.000Z',
        peers: [
          {
            publicKey: 'key-b',
            endpoint: '10.9.0.11:51820',
            interface: 'eth1',
            lastHandshakeAt: '2026-10-05T09:59:50.000Z',
            transferRx: 1000,
            transferTx: 2000,
          },
        ],
      },
    },
  },
  { serverId: 'b', publicKey: 'key-b', metadata: {} },
]

test('the tunnel row carries the observed NIC and counters; other rows stay planned only', () => {
  const peer = buildServerTrafficMap(input({ relays: RELAYS })).peers[0]
  assertEquals(peer.fabric, {
    plannedPath: 'direct_lan',
    plannedEndpoint: '10.9.0.11:51820',
    degraded: false,
    observed: {
      at: '2026-10-05T10:00:00.000Z',
      interface: 'eth1',
      endpoint: '10.9.0.11:51820',
      lastHandshakeAt: '2026-10-05T09:59:50.000Z',
      transferRx: 1000,
      transferTx: 2000,
    },
    onChosenNetwork: true,
  })
  assertEquals('observed' in peer.traffic[0], false)
})

test('a tunnel on another NIC than the chosen network is flagged; an unreported tunnel is unknown', () => {
  const other = structuredClone(RELAYS)
  const peers = other[0].metadata.observed?.peers
  if (!peers) throw new TypeError('fixture has observed peers')
  peers[0].interface = 'eth0'
  peers[0].endpoint = '192.168.1.11:51820'
  assertEquals(
    buildServerTrafficMap(input({ relays: other })).peers[0].fabric?.onChosenNetwork,
    false
  )

  const unreported = structuredClone(RELAYS)
  delete unreported[0].metadata.observed
  delete unreported[0].metadata.paths
  const fabric = buildServerTrafficMap(input({ relays: unreported })).peers[0].fabric
  assertEquals(fabric?.observed, null)
  assertEquals(fabric?.onChosenNetwork, null)
})

test('a server off the fabric has no tunnel row', () => {
  assertEquals(buildServerTrafficMap(input({ relays: [RELAYS[0]] })).peers[0].fabric, null)
  assertEquals(buildServerTrafficMap(input()).peers[0].fabric, null)
})
