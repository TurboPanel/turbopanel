/**
 * Host-free coverage for the network probe sweep: a fake `Db` records the pin
 * writes; the check and the loaders are injected, so no host is asked.
 */

import { assertEquals } from '@std/assert'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import type { DatacenterMembershipWithMetadataRow } from '../../features/net/datacenter-membership.ts'
import type { NetworkCheckReport } from '../../features/net/server-network-check.ts'
import {
  NETWORK_PROBE_MIN_INTERVAL_MS,
  resetNetworkProbeThrottle,
  runNetworkProbeSweep,
  type TrustedNetwork,
} from './network-probe-sweep.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '00000000-0000-4000-8000-0000000000b1'
const BACKPLANE = '00000000-0000-4000-8000-0000000000d1'
const LAN = '00000000-0000-4000-8000-0000000000d2'
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000a2'
const NOW_MS = Date.parse('2026-10-23T18:00:00.000Z')
const registry = {} as DaemonCellRegistry

type Write = { metadata: Record<string, unknown>; repinPendingFanoutAt?: string }

function fakeDb(writes: Write[]): Db {
  return {
    update: () => ({
      set: (patch: Write) => ({
        where: () => {
          writes.push(patch)
          return Promise.resolve(undefined)
        },
      }),
    }),
  } as unknown as Db
}

function pin(
  ipId: string,
  serverId: string,
  datacenterId: string,
  metadata: unknown = null
): DatacenterMembershipWithMetadataRow {
  return {
    ipId,
    serverId,
    datacenterId,
    networkId: null,
    address: '172.20.4.1',
    family: 4,
    metadata,
  }
}

const networks: Map<string, TrustedNetwork[]> = new Map([
  [
    ORG,
    [
      { id: BACKPLANE, organizationId: ORG, priority: 10 },
      { id: LAN, organizationId: ORG, priority: 100 },
    ],
  ],
])

function cutReport(datacenterId: string): NetworkCheckReport {
  const peer = (peerServerId: string) => ({
    peerServerId,
    address: '172.20.4.1',
    port: 22,
    result: 'not_reachable' as const,
  })
  return {
    datacenterId,
    servers: [
      { serverId: A, status: 'checked', peers: [peer(B)] },
      { serverId: B, status: 'checked', peers: [peer(A)] },
    ],
    unreachableCount: 2,
    notTestedCount: 0,
  }
}

const okMarker = { failures: 2, okStreak: 0, firstOkAt: '2026-10-23T17:00:00.000Z' }

test('the third failed round marks both pins and asks for the routing re-plan', async () => {
  resetNetworkProbeThrottle()
  const writes: Write[] = []
  const probedIds: string[] = []
  const result = await runNetworkProbeSweep(fakeDb(writes), registry, {
    now: () => NOW_MS,
    loadTrustedNetworks: () => Promise.resolve(networks),
    loadPins: (_db, datacenterId) =>
      Promise.resolve(
        datacenterId === BACKPLANE
          ? [
              pin('ip-a', A, BACKPLANE, { unreachable: okMarker }),
              pin('ip-b', B, BACKPLANE, { unreachable: okMarker }),
            ]
          : []
      ),
    runCheck: (_db, _registry, params) => {
      probedIds.push(params.datacenterId)
      return Promise.resolve(cutReport(params.datacenterId))
    },
  })
  // Only the network that carries the traffic is probed.
  assertEquals(probedIds, [BACKPLANE])
  assertEquals(result, { probed: 1, routingChanges: 2 })
  assertEquals(writes.length, 2)
  for (const write of writes) {
    assertEquals(typeof write.repinPendingFanoutAt, 'string')
    const marker = write.metadata.unreachable as { downSince?: string }
    assertEquals(marker.downSince, '2026-10-23T18:00:00.000Z')
  }
})

test('a network that still carries a mark keeps being probed so recovery is noticed', async () => {
  resetNetworkProbeThrottle()
  const writes: Write[] = []
  const probedIds: string[] = []
  const marked = { failures: 3, okStreak: 0, firstOkAt: 'x', downSince: '2026-10-23T17:30:00.000Z' }
  await runNetworkProbeSweep(fakeDb(writes), registry, {
    now: () => NOW_MS,
    loadTrustedNetworks: () => Promise.resolve(networks),
    loadPins: (_db, datacenterId) =>
      Promise.resolve(datacenterId === LAN ? [pin('ip-l', A, LAN, { unreachable: marked })] : []),
    runCheck: (_db, _registry, params) => {
      probedIds.push(params.datacenterId)
      return Promise.resolve({ ...cutReport(params.datacenterId), servers: [] })
    },
  })
  assertEquals(probedIds.sort(), [BACKPLANE, LAN].sort())
})

test('the sweep is throttled and does nothing without a registry', async () => {
  resetNetworkProbeThrottle()
  let checks = 0
  const deps = {
    loadTrustedNetworks: () => Promise.resolve(networks),
    loadPins: () => Promise.resolve([]),
    runCheck: () => {
      checks += 1
      return Promise.resolve({ ...cutReport(BACKPLANE), servers: [] })
    },
  }
  const db = fakeDb([])
  await runNetworkProbeSweep(db, undefined, { ...deps, now: () => NOW_MS })
  assertEquals(checks, 0)
  await runNetworkProbeSweep(db, registry, { ...deps, now: () => NOW_MS })
  await runNetworkProbeSweep(db, registry, { ...deps, now: () => NOW_MS + 1000 })
  assertEquals(checks, 1)
  await runNetworkProbeSweep(db, registry, {
    ...deps,
    now: () => NOW_MS + NETWORK_PROBE_MIN_INTERVAL_MS,
  })
  assertEquals(checks, 2)
})

test('an organization with one trusted network is not probed', async () => {
  resetNetworkProbeThrottle()
  let checks = 0
  await runNetworkProbeSweep(fakeDb([]), registry, {
    now: () => NOW_MS,
    loadTrustedNetworks: () => Promise.resolve(new Map()),
    runCheck: () => {
      checks += 1
      return Promise.resolve(cutReport(BACKPLANE))
    },
  })
  assertEquals(checks, 0)
})
