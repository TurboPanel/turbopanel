import { assertEquals } from '@std/assert'
import { decideNicAutoMonitor, resolveUplinkDeviceIdByInterface } from './nic-auto-monitor.ts'
import type { NetworkDeviceTopology, TopologySnapshot } from '../../contracts/topology-types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const GATEWAY: NetworkDeviceTopology = {
  deviceId: 'mac:a',
  kind: 'uplink',
  name: 'eth0',
  identity: { mac: 'a' },
  defaultRoute: true,
}

const SECOND_UPLINK: NetworkDeviceTopology = {
  deviceId: 'mac:b',
  kind: 'uplink',
  name: 'eth1',
  identity: { mac: 'b' },
}

const BOND_MEMBER: NetworkDeviceTopology = {
  deviceId: 'mac:c',
  kind: 'member',
  name: 'eth2',
  identity: { mac: 'c' },
}

function snapshot(networks: NetworkDeviceTopology[]): TopologySnapshot {
  return {
    generation: 0,
    bootGeneration: 0,
    networks,
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    cpu: { sockets: 1, coresPerSocket: 1, threadsPerSocket: 1, model: null },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  }
}

test('resolveUplinkDeviceIdByInterface resolves a matching uplink', () => {
  const id = resolveUplinkDeviceIdByInterface([GATEWAY, SECOND_UPLINK], 'eth1')
  assertEquals(id, 'mac:b')
})

test('resolveUplinkDeviceIdByInterface returns null when the interface is not present', () => {
  const id = resolveUplinkDeviceIdByInterface([GATEWAY, SECOND_UPLINK], 'eth9')
  assertEquals(id, null)
})

test('resolveUplinkDeviceIdByInterface returns null for a non-uplink device kind', () => {
  const id = resolveUplinkDeviceIdByInterface([GATEWAY, BOND_MEMBER], 'eth2')
  assertEquals(id, null)
})

test('resolveUplinkDeviceIdByInterface returns null when networks is undefined', () => {
  const id = resolveUplinkDeviceIdByInterface(undefined, 'eth0')
  assertEquals(id, null)
})

test('decideNicAutoMonitor adds the NIC when a free slot exists', () => {
  const decision = decideNicAutoMonitor([], snapshot([GATEWAY, SECOND_UPLINK]), 'mac:b', 2)
  assertEquals(decision, { action: 'add', nicSlotDeviceIds: ['mac:a', 'mac:b'] })
})

test('decideNicAutoMonitor skips when there is no free slot', () => {
  const decision = decideNicAutoMonitor([], snapshot([GATEWAY, SECOND_UPLINK]), 'mac:b', 1)
  assertEquals(decision, { action: 'skip', reason: 'no-free-slot' })
})

test('decideNicAutoMonitor skips when already monitored via the implicit gateway default', () => {
  const decision = decideNicAutoMonitor([], snapshot([GATEWAY, SECOND_UPLINK]), 'mac:a', 2)
  assertEquals(decision, { action: 'skip', reason: 'already-monitored' })
})

test('decideNicAutoMonitor skips when already monitored via an explicit override', () => {
  const decision = decideNicAutoMonitor(
    ['mac:a', 'mac:b'],
    snapshot([GATEWAY, SECOND_UPLINK]),
    'mac:b',
    4
  )
  assertEquals(decision, { action: 'skip', reason: 'already-monitored' })
})

test('decideNicAutoMonitor never evicts — the add case is a strict superset of the prior effective list', () => {
  const decision = decideNicAutoMonitor(['mac:a'], snapshot([GATEWAY, SECOND_UPLINK]), 'mac:b', 2)
  assertEquals(decision, { action: 'add', nicSlotDeviceIds: ['mac:a', 'mac:b'] })
})

test('decideNicAutoMonitor chains across multiple pins against a shrinking budget', () => {
  const third: NetworkDeviceTopology = {
    deviceId: 'mac:d',
    kind: 'uplink',
    name: 'eth3',
    identity: { mac: 'd' },
  }
  const snapWithThird = snapshot([GATEWAY, SECOND_UPLINK, third])

  const first = decideNicAutoMonitor([], snapWithThird, 'mac:b', 2)
  assertEquals(first, { action: 'add', nicSlotDeviceIds: ['mac:a', 'mac:b'] })

  const nextOverride = first.action === 'add' ? first.nicSlotDeviceIds : []
  const second = decideNicAutoMonitor(nextOverride, snapWithThird, 'mac:d', 2)
  assertEquals(second, { action: 'skip', reason: 'no-free-slot' })
})
