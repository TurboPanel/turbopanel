import { assert, assertEquals } from '@std/assert'
import {
  recordedTopologyForSample,
  reportIsSameTopology,
  sampleFitsTopology,
  sampleMatchesRecordedTopology,
  topologyIdentityKey,
} from './topology-identity.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SNAPSHOT = {
  networks: [
    { deviceId: 'eth0', kind: 'uplink', defaultRoute: true, name: 'eth0' },
    { deviceId: 'tp0', kind: 'fabric', name: 'tp0' },
  ],
  filesystems: [{ filesystemId: 'fs-root', roles: ['root', 'hosting'] }],
  blockDevices: [
    { deviceId: 'nvme0n1', deviceType: 'physical' },
    { deviceId: 'nvme0n1p1', deviceType: 'partition' },
  ],
  gpus: [],
  hardwareSignals: [{ signalId: 'signal:coretemp:package-0' }],
  memoryTotalBytes: 8_000_000_000,
}

function sample(
  overrides: Partial<{
    networks: string[]
    filesystems: string[]
    blockDevices: string[]
    gpus: string[]
  }> = {}
) {
  return {
    metadata: {
      version: 8 as const,
      sampledAt: '2026-11-05T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      bootGeneration: 1,
    },
    networks: (overrides.networks ?? ['eth0', 'tp0']).map((deviceId) => ({
      deviceId,
      receiveBytesPerSecond: null,
      transmitBytesPerSecond: null,
      receiveErrorsPerSecond: null,
      transmitErrorsPerSecond: null,
      receiveDropsPerSecond: null,
      transmitDropsPerSecond: null,
    })),
    filesystems: (overrides.filesystems ?? ['fs-root']).map((filesystemId) => ({
      filesystemId,
      availableBytes: null,
      freeInodes: null,
    })),
    blockDevices: (overrides.blockDevices ?? ['nvme0n1']).map((deviceId) => ({
      deviceId,
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
      readOpsPerSecond: null,
      writeOpsPerSecond: null,
      readLatencyMs: null,
      writeLatencyMs: null,
      utilizationPercent: null,
      queueDepth: null,
    })),
    gpus: (overrides.gpus ?? []).map((gpuId) => ({
      gpuId,
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryActivityPercent: null,
      pcieReceiveBytesPerSecond: null,
      pcieTransmitBytesPerSecond: null,
      throttlePercent: null,
    })),
  }
}

test('topologyIdentityKey ignores order, sizes and labels', () => {
  const reordered = {
    ...SNAPSHOT,
    // The retired numbers an older daemon still sends must not change the key.
    generation: 7,
    bootGeneration: 3,
    networks: [...SNAPSHOT.networks].reverse().map((n) => ({ ...n, name: 'renamed' })),
    filesystems: [{ filesystemId: 'fs-root', roles: ['hosting', 'root'] }],
    blockDevices: [...SNAPSHOT.blockDevices].reverse(),
    memoryTotalBytes: 16_000_000_000,
  }
  assertEquals(topologyIdentityKey(reordered), topologyIdentityKey(SNAPSHOT))
})

test('topologyIdentityKey changes with anything the slot mapping reads', () => {
  const base = topologyIdentityKey(SNAPSHOT)
  const variants: unknown[] = [
    { ...SNAPSHOT, networks: [...SNAPSHOT.networks, { deviceId: 'eth1', kind: 'uplink' }] },
    {
      ...SNAPSHOT,
      networks: [{ ...SNAPSHOT.networks[0], defaultRoute: false }, SNAPSHOT.networks[1]],
    },
    { ...SNAPSHOT, networks: [SNAPSHOT.networks[0], { deviceId: 'tp0', kind: 'uplink' }] },
    { ...SNAPSHOT, filesystems: [{ filesystemId: 'fs-root', roles: ['root'] }] },
    { ...SNAPSHOT, blockDevices: [{ deviceId: 'nvme0n1', deviceType: 'physical' }] },
    { ...SNAPSHOT, gpus: [{ gpuId: 'gpu0' }] },
    { ...SNAPSHOT, hardwareSignals: [] },
  ]
  for (const variant of variants) {
    assert(topologyIdentityKey(variant) !== base, JSON.stringify(variant))
  }
})

test('topologyIdentityKey gives a key for any value', () => {
  assertEquals(topologyIdentityKey(null), topologyIdentityKey({}))
  assertEquals(topologyIdentityKey([]), topologyIdentityKey({ networks: 'nope' }))
  assertEquals(topologyIdentityKey({ networks: [null, 3, []] }), topologyIdentityKey({}))
})

test('sampleFitsTopology needs every named network, filesystem, block device and GPU', () => {
  assert(sampleFitsTopology(sample(), SNAPSHOT))
  // A device the snapshot lists but the sample leaves out is fine.
  assert(sampleFitsTopology(sample({ networks: ['eth0'], blockDevices: [] }), SNAPSHOT))
  assertEquals(sampleFitsTopology(sample({ networks: ['eth0', 'eth1'] }), SNAPSHOT), false)
  assertEquals(sampleFitsTopology(sample({ filesystems: ['fs-new'] }), SNAPSHOT), false)
  assertEquals(sampleFitsTopology(sample({ blockDevices: ['sda'] }), SNAPSHOT), false)
  assertEquals(sampleFitsTopology(sample({ gpus: ['gpu0'] }), SNAPSHOT), false)
  assertEquals(sampleFitsTopology(sample(), null), false)
  // An empty sample fits anything, even a snapshot with no arrays.
  assert(
    sampleFitsTopology(sample({ networks: [], filesystems: [], blockDevices: [], gpus: [] }), {
      hardwareSignals: [],
    })
  )
})

test('sampleMatchesRecordedTopology: the sample entity ids decide', () => {
  const record = { snapshot: SNAPSHOT }
  assert(sampleMatchesRecordedTopology(record, sample()))
  assertEquals(sampleMatchesRecordedTopology(record, sample({ networks: ['eth9'] })), false)
  assertEquals(sampleMatchesRecordedTopology(undefined, sample()), false)
})

test('reportIsSameTopology: the identity key decides', () => {
  const record = { snapshot: SNAPSHOT }
  assertEquals(reportIsSameTopology(record, { snapshot: { other: true } }), false)
  assert(reportIsSameTopology(record, { snapshot: { ...SNAPSHOT, memoryTotalBytes: 1 } }))
  assertEquals(
    reportIsSameTopology(record, { snapshot: { ...SNAPSHOT, gpus: [{ gpuId: 'gpu0' }] } }),
    false
  )
  assert(reportIsSameTopology(record, { snapshot: SNAPSHOT }))
})

test('recordedTopologyForSample hands back the record only when the sample matches it', () => {
  const record = { snapshot: SNAPSHOT, extra: 'kept' }
  assertEquals(recordedTopologyForSample(record, sample()), record)
  assertEquals(recordedTopologyForSample(record, sample({ gpus: ['gpu9'] })), undefined)
  assertEquals(recordedTopologyForSample(undefined, sample()), undefined)
})
