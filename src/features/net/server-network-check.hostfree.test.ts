/**
 * Host-free coverage for the server-to-server network check: the per-host
 * plan, the report the screen shows, and the "chosen network is down" warning.
 */

import { assertEquals } from '@std/assert'
import { MAX_DAEMON_WS_NETWORK_CHECK_TARGETS } from '../../contracts/cell-protocol.ts'
import type { DatacenterMembershipRow } from './datacenter-membership.ts'
import {
  chosenNetworkDownWarnings,
  type NetworkCheckServerOutcome,
  planNetworkCheck,
  summarizeNetworkCheck,
  winningNetworkId,
} from './server-network-check.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const DC = '00000000-0000-4000-8000-0000000000d1'
const DC2 = '00000000-0000-4000-8000-0000000000d2'
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000a2'
const C = '00000000-0000-4000-8000-0000000000a3'

const members = [
  { serverId: A, address: '10.0.0.1' },
  { serverId: B, address: '10.0.0.2' },
  { serverId: C, address: '10.0.0.3' },
]

test('planNetworkCheck asks each member about every other member on its ssh port', () => {
  const plan = planNetworkCheck(members, new Map([[B, 2222]]))
  assertEquals(plan, [
    {
      serverId: A,
      targets: [
        { peerServerId: B, address: '10.0.0.2', port: 2222 },
        { peerServerId: C, address: '10.0.0.3', port: 22 },
      ],
    },
    {
      serverId: B,
      targets: [
        { peerServerId: A, address: '10.0.0.1', port: 22 },
        { peerServerId: C, address: '10.0.0.3', port: 22 },
      ],
    },
    {
      serverId: C,
      targets: [
        { peerServerId: A, address: '10.0.0.1', port: 22 },
        { peerServerId: B, address: '10.0.0.2', port: 2222 },
      ],
    },
  ])
})

test('planNetworkCheck leaves out a member alone in the network', () => {
  assertEquals(planNetworkCheck([members[0]!], new Map()), [])
})

test('planNetworkCheck cuts targets at the wire limit', () => {
  const many = Array.from({ length: MAX_DAEMON_WS_NETWORK_CHECK_TARGETS + 5 }, (_, i) => ({
    serverId: `s-${i}`,
    address: `10.1.0.${i}`,
  }))
  const plan = planNetworkCheck(many, new Map())
  assertEquals(plan[0]!.targets.length, MAX_DAEMON_WS_NETWORK_CHECK_TARGETS)
})

test('summarizeNetworkCheck counts unreachable and untested peers separately', () => {
  const plan = planNetworkCheck(members.slice(0, 2), new Map())
  const outcomes = new Map<string, NetworkCheckServerOutcome>([
    [
      A,
      {
        status: 'checked',
        results: [
          {
            peerServerId: B,
            address: '10.0.0.2',
            reachable: true,
            latencyMs: 2,
            sourceAddress: '10.0.0.1',
            interface: 'eth1',
          },
        ],
      },
    ],
    [B, { status: 'not_tested', reason: 'daemon_update_required' }],
  ])
  const report = summarizeNetworkCheck(DC, plan, outcomes)
  assertEquals(report.unreachableCount, 0)
  assertEquals(report.notTestedCount, 1)
  assertEquals(report.servers[0]!.peers[0], {
    peerServerId: B,
    address: '10.0.0.2',
    port: 22,
    result: 'reachable',
    latencyMs: 2,
    sourceAddress: '10.0.0.1',
    interface: 'eth1',
  })
  assertEquals(report.servers[1]!.status, 'not_tested')
  assertEquals(report.servers[1]!.reason, 'daemon_update_required')
})

test('summarizeNetworkCheck reports a refused peer and a peer the host did not answer for', () => {
  const plan = planNetworkCheck(members, new Map())
  const outcomes = new Map<string, NetworkCheckServerOutcome>([
    [
      A,
      {
        status: 'checked',
        results: [{ peerServerId: B, address: '10.0.0.2', reachable: false, error: 'refused' }],
      },
    ],
  ])
  const report = summarizeNetworkCheck(DC, plan, outcomes)
  assertEquals(report.servers[0]!.peers, [
    { peerServerId: B, address: '10.0.0.2', port: 22, result: 'not_reachable', reason: 'refused' },
    { peerServerId: C, address: '10.0.0.3', port: 22, result: 'not_tested', reason: 'no_answer' },
  ])
  // B and C sent nothing back at all: every peer they hold is untested.
  assertEquals(report.unreachableCount, 1)
  assertEquals(report.notTestedCount, 5)
})

const rivals = [
  { id: DC2, priority: 20, trusted: true },
  { id: DC, priority: 10, trusted: true },
  { id: 'untrusted', priority: 1, trusted: false },
]

function pin(serverId: string, datacenterId: string, linkDown?: boolean): DatacenterMembershipRow {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: null,
    address: '10.0.0.9',
    family: 4,
    ...(linkDown === undefined ? {} : { linkDown }),
  }
}

test('winningNetworkId picks the lowest trusted number', () => {
  assertEquals(winningNetworkId(rivals), DC)
  assertEquals(winningNetworkId([{ id: 'x', priority: 1, trusted: false }]), null)
})

test('chosenNetworkDownWarnings names the servers whose link on the chosen network is down', () => {
  const warnings = chosenNetworkDownWarnings(rivals, [
    pin(B, DC, true),
    pin(A, DC, true),
    pin(A, DC, true),
    pin(C, DC, false),
    pin(C, DC2, true),
  ])
  assertEquals(warnings, [
    {
      code: 'chosen_network_down',
      datacenterId: DC,
      fallbackDatacenterId: DC2,
      serverIds: [A, B],
      reason: 'link_down',
    },
  ])
})

test('chosenNetworkDownWarnings has no fallback when no other trusted network exists', () => {
  const warnings = chosenNetworkDownWarnings([rivals[1]!, rivals[2]!], [pin(A, DC, true)])
  assertEquals(warnings[0]!.fallbackDatacenterId, null)
})

test('chosenNetworkDownWarnings is quiet when every link is up', () => {
  assertEquals(chosenNetworkDownWarnings(rivals, [pin(A, DC), pin(B, DC, false)]), [])
})

test('chosenNetworkDownWarnings says unreachable when only the probes marked the servers', () => {
  const probed = (serverId: string): DatacenterMembershipRow => ({
    ...pin(serverId, DC, true),
    probedDown: true,
  })
  const warnings = chosenNetworkDownWarnings(rivals, [probed(A), probed(B)])
  assertEquals(warnings[0]!.reason, 'unreachable')
  assertEquals(warnings[0]!.serverIds, [A, B])
  // A network card that reports no link on one of them keeps the stronger reason.
  assertEquals(
    chosenNetworkDownWarnings(rivals, [probed(A), pin(B, DC, true)])[0]!.reason,
    'link_down'
  )
})
