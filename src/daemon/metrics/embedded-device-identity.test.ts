/**
 * Embedded-device identity for the v7 Analytics Engine write and read paths.
 *
 * `host.network` embeds NIC 1 and NIC 2 (and the lone extra filesystem) in
 * its own doubles, so the doubles carry no per-slot identity. Every such row
 * therefore names its devices in blob6 (`nic1=<id>@<speed>;nic2=<id>@<speed>;fs=<id>`),
 * and readers look a NIC up by that id. No topology generation is stored or
 * consulted, so history stays attached to the right device however the slots
 * were reassigned or however many hardware changes happened since.
 *
 * The write-path tests prove the packer is identity-addressed (not
 * positional) once a `SlotMapping` is available and that blob6 names the
 * devices. The query tests run the real `queryXViaSqlApi` SQL against
 * `createFakeAnalyticsEngine` (`testing/fake-analytics-engine.ts`, an
 * in-memory DuckDB-backed AE dataset) to prove a swap of slots never gives one
 * device the other's history.
 */
import { assertEquals } from '@std/assert'
import { V7_HOST_ROW_SPECS } from './backends/cloudflare/v7-layout.ts'
import { it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  type HostCpuMetrics,
  type HostKernelMetrics,
  type HostMemoryMetrics,
  type HostNetworkMetrics,
  type HostStorageMetrics,
  type MetricsSampleInput,
} from '../../contracts/metrics-contract.ts'
import type { AuthenticatedMetricsSample, SlotMapping } from './types.ts'
import {
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_ENTITY_IDS_INDEX,
  AE_FAMILY_HOST_NETWORK,
  AE_FAMILY_HOST_SYSTEM,
  AE_FAMILY_NETWORK,
  AE_MISSING_METRIC_SENTINEL,
  type AnalyticsEngineDataPointLike,
  buildMetricsDataPoints,
} from './backends/cloudflare/field-map.ts'
import { CloudflareAnalyticsEngineServerMetricsStore } from './backends/cloudflare/store.ts'
import { createFakeAnalyticsEngine } from './testing/fake-analytics-engine.ts'

const HOST_CPU_FIELDS = [
  'busyPercent',
  'userPercent',
  'systemPercent',
  'iowaitPercent',
  'stealPercent',
  'softirqPercent',
  'pressureSomePercent',
  'saturatedCoreCount',
  'procsRunning',
  'procsBlocked',
  'processCount',
] as const satisfies readonly (keyof HostCpuMetrics)[]
const HOST_KERNEL_FIELDS = [
  'fileHandlesUsedPercent',
  'conntrackUsedPercent',
] as const satisfies readonly (keyof HostKernelMetrics)[]
const HOST_MEMORY_FIELDS = [
  'usedBytes',
  'cachedFilesBytes',
  'swapUsedBytes',
  'pressureSomePercent',
  'pressureFullPercent',
  'swapInBytesPerSecond',
  'swapOutBytesPerSecond',
  'majorPageFaultsPerSecond',
] as const satisfies readonly (keyof HostMemoryMetrics)[]
const HOST_STORAGE_FIELDS = [
  'ioPressureSomePercent',
  'ioPressureFullPercent',
  'diskReadBytesPerSecond',
  'diskWriteBytesPerSecond',
  'diskLatencyMs',
  'rootFilesystemAvailableBytes',
  'rootFilesystemFreeInodes',
] as const satisfies readonly (keyof HostStorageMetrics)[]
const HOST_NETWORK_FIELDS = [
  'tcpRetransmitPercent',
  'softnetDropsPerSecond',
] as const satisfies readonly (keyof HostNetworkMetrics)[]

function zeroFields<T extends readonly string[]>(fields: T): { [K in T[number]]: number | null } {
  const out = {} as { [K in T[number]]: number | null }
  for (const field of fields) out[field as T[number]] = null
  return out
}

function baseInput(overrides: Partial<MetricsSampleInput> = {}): MetricsSampleInput {
  return {
    metadata: {
      version: 6,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: zeroFields(HOST_CPU_FIELDS),
      kernel: zeroFields(HOST_KERNEL_FIELDS),
      memory: zeroFields(HOST_MEMORY_FIELDS),
      storage: zeroFields(HOST_STORAGE_FIELDS),
      network: zeroFields(HOST_NETWORK_FIELDS),
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    ...overrides,
  }
}

function buildSample(overrides: Partial<MetricsSampleInput> = {}): AuthenticatedMetricsSample {
  const built = buildMetricsSample(baseInput(overrides))
  return {
    ...built,
    serverId: '11111111-2222-4333-8444-555555555555',
    receivedAt: '2026-01-01T00:00:01.000Z',
  }
}

function nic(deviceId: string, seed: number) {
  return {
    deviceId,
    receiveBytesPerSecond: seed,
    transmitBytesPerSecond: seed + 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }
}

function emptySlotMapping(overrides: Partial<SlotMapping> = {}): SlotMapping {
  return {
    normalNicSlots: [],
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
    ...overrides,
  }
}

function hostNetworkPoint(points: AnalyticsEngineDataPointLike[]): AnalyticsEngineDataPointLike {
  const found = points.find((point) => point.blobs[AE_BLOB_FAMILY_INDEX] === AE_FAMILY_HOST_NETWORK)
  if (!found) throw new Error('no host.network point found')
  return found
}

// host.network's NIC0 rx-bytes/s embed slot: after the root filesystem pair
// (double1..2), the folded filesystem pair (double3..4) and tcp retransmits
// (double5), so double6 (index 5) in the v7 layout.
const NIC0_RX_DOUBLE_INDEX = V7_HOST_ROW_SPECS['host.network'].doubles.indexOf('nic1.rx')

// ---------------------------------------------------------------------------
// Identity-addressed packing: each sample is packed with the mapping that
// names its own devices.
// ---------------------------------------------------------------------------

it('a host.network row embeds the slot-mapped NIC and names it in blob6', () => {
  const sampleGen1 = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    networks: [nic('eth0', 100)],
  })
  const slotMappingGen1 = emptySlotMapping({ normalNicSlots: ['eth0'] })
  const point = hostNetworkPoint(buildMetricsDataPoints(sampleGen1, slotMappingGen1))
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], 100)
  assertEquals(point.blobs[AE_BLOB_ENTITY_IDS_INDEX], 'nic1=eth0@')
})

it('a replaced NIC is embedded and named under its own id', () => {
  const sampleGen2 = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-02T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 2,
      topologyGeneration: 2,
      bootGeneration: 1,
    },
    networks: [nic('eth1', 300)],
  })
  const slotMappingGen2 = emptySlotMapping({ normalNicSlots: ['eth1'] })
  const point = hostNetworkPoint(buildMetricsDataPoints(sampleGen2, slotMappingGen2))
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], 300)
  assertEquals(point.blobs[AE_BLOB_ENTITY_IDS_INDEX], 'nic1=eth1@')
})

it("packing a sample with a mapping that does not name its device never reads another device's value (identity-addressed, not positional)", () => {
  const sampleGen2 = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-02T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 2,
      topologyGeneration: 2,
      bootGeneration: 1,
    },
    networks: [nic('eth1', 300)],
  })
  const staleMapping = emptySlotMapping({ normalNicSlots: ['eth0'] })
  const point = hostNetworkPoint(buildMetricsDataPoints(sampleGen2, staleMapping))
  // eth0 does not exist in this sample under the stale mapping —
  // the slot goes missing rather than silently reading eth1's value under
  // eth0's name.
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], AE_MISSING_METRIC_SENTINEL)
})

it('the same raw sample decodes to different slot-1 values under a swapped mapping (real identity resolution, not array-position packing)', () => {
  // Both devices are simultaneously present (e.g. a topology reorder that
  // renumbered which uplink is "primary" without physically removing
  // either NIC) — network array order stays [eth0, eth1] in both cases.
  const sample = buildSample({
    networks: [nic('eth0', 100), nic('eth1', 300)],
  })
  const mappingA = emptySlotMapping({
    normalNicSlots: ['eth0', 'eth1'],
  })
  const mappingB = emptySlotMapping({
    normalNicSlots: ['eth1', 'eth0'],
  })
  const pointA = hostNetworkPoint(buildMetricsDataPoints(sample, mappingA))
  const pointB = hostNetworkPoint(buildMetricsDataPoints(sample, mappingB))
  assertEquals(pointA.doubles[NIC0_RX_DOUBLE_INDEX], 100)
  assertEquals(pointB.doubles[NIC0_RX_DOUBLE_INDEX], 300)
})

// ---------------------------------------------------------------------------
// Positional fallback (no recorded SlotMapping yet) — documented
// graceful-degradation behavior.
// ---------------------------------------------------------------------------

it('without a SlotMapping, host.network falls back to positional embedding (networks[0]/networks[1])', () => {
  const sample = buildSample({
    networks: [nic('eth0', 100), nic('eth1', 300)],
  })
  const point = hostNetworkPoint(buildMetricsDataPoints(sample, undefined))
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], 100)
})

// ---------------------------------------------------------------------------
// blob4 is reserved and written empty on every row: the topology generation is
// no longer stored, rows name their own devices instead.
// ---------------------------------------------------------------------------

it('every row is written with an empty blob4, whatever generation the sample reports', () => {
  const sample = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-03T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 3,
      topologyGeneration: 7,
      bootGeneration: 1,
    },
    networks: [nic('eth0', 1), nic('eth1', 2), nic('eth2', 3), nic('eth3', 4)],
  })
  const points = buildMetricsDataPoints(sample, undefined)
  const families = points.map((point) => point.blobs[AE_BLOB_FAMILY_INDEX])
  assertEquals(
    families.includes(AE_FAMILY_HOST_SYSTEM) &&
      families.includes(AE_FAMILY_HOST_NETWORK) &&
      families.includes(AE_FAMILY_NETWORK),
    true
  )
  for (const point of points) {
    assertEquals(point.blobs[3], '', `family ${point.blobs[AE_BLOB_FAMILY_INDEX]} blob4`)
  }
})

// ---------------------------------------------------------------------------
// Executed query-layer resolution (Cloudflare AE, via
// `createFakeAnalyticsEngine`) — proves the real `queryXViaSqlApi` SQL
// resolves historical rows by their own device identity after a reorder or
// swap, not just that the write-path packer produced the right bytes.
// ---------------------------------------------------------------------------

function gpu(gpuId: string, seed: number) {
  return {
    gpuId,
    utilizationPercent: seed,
    memoryUsedBytes: seed * 1000,
    memoryActivityPercent: seed,
    pcieReceiveBytesPerSecond: seed * 10,
    pcieTransmitBytesPerSecond: seed * 11,
    throttlePercent: 0,
  }
}

it("queryEntitySeries resolves a page-position swap by identity, not by slot: a GPU that moves slots never inherits the other GPU's value at its old timestamp", async () => {
  const SERVER_ID = '11111111-2222-4333-8444-555555555555'
  const BASE_MS = Date.UTC(2026, 5, 2)
  const INTERVAL_SECONDS = 60
  const fakeAe = await createFakeAnalyticsEngine()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    // Generation 1: gpu0 occupies page slot 0, gpu1 occupies slot 1.
    const gen1AtMs = BASE_MS
    const gen1Sample = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(gen1AtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 1,
        topologyGeneration: 1,
        bootGeneration: 1,
      },
      gpus: [gpu('gpu0', 11), gpu('gpu1', 22)],
    })
    fakeAe.setNow(gen1AtMs)
    store.writeSample(gen1Sample, emptySlotMapping({ gpuPageOrder: ['gpu0', 'gpu1'] }))

    // Generation 2: a topology reorder swaps page slots — gpu1 now occupies
    // slot 0 (where gpu0 used to be) and gpu0 occupies slot 1. New values so
    // a wrong-generation/positional read is distinguishable from a correct
    // identity-addressed one.
    const gen2AtMs = BASE_MS + INTERVAL_SECONDS * 1000
    const gen2Sample = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(gen2AtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 2,
        topologyGeneration: 2,
        bootGeneration: 1,
      },
      gpus: [gpu('gpu0', 33), gpu('gpu1', 44)],
    })
    fakeAe.setNow(gen2AtMs)
    store.writeSample(gen2Sample, emptySlotMapping({ gpuPageOrder: ['gpu1', 'gpu0'] }))

    const from = new Date(gen1AtMs - 60_000).toISOString()
    const to = new Date(gen2AtMs + 60_000).toISOString()

    const gpu0Series = await store.queryEntitySeries({
      serverId: SERVER_ID,
      family: 'gpu',
      entityIds: ['gpu0'],
      metrics: ['utilizationPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    const gpu0 = gpu0Series.entities.find((e) => e.entityId === 'gpu0')!
    const gpu0ByAt = new Map(gpu0.points.map((p) => [p.at, p.values.utilizationPercent]))
    assertEquals(gpu0ByAt.get(gen1Sample.metadata.sampledAt), 11, 'gen1: gpu0 at slot 0')
    assertEquals(
      gpu0ByAt.get(gen2Sample.metadata.sampledAt),
      33,
      "gen2: gpu0 at slot 1 (swapped) — never gpu1's 44"
    )

    const gpu1Series = await store.queryEntitySeries({
      serverId: SERVER_ID,
      family: 'gpu',
      entityIds: ['gpu1'],
      metrics: ['utilizationPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    const gpu1 = gpu1Series.entities.find((e) => e.entityId === 'gpu1')!
    const gpu1ByAt = new Map(gpu1.points.map((p) => [p.at, p.values.utilizationPercent]))
    assertEquals(gpu1ByAt.get(gen1Sample.metadata.sampledAt), 22, 'gen1: gpu1 at slot 1')
    assertEquals(
      gpu1ByAt.get(gen2Sample.metadata.sampledAt),
      44,
      "gen2: gpu1 at slot 0 (swapped) — never gpu0's 33"
    )
  } finally {
    await fakeAe.close()
  }
})

it('queryEntitySeries (network): an embedded NIC keeps its own history when another NIC takes its slot', async () => {
  const SERVER_ID = '11111111-2222-4333-8444-555555555555'
  const BASE_MS = Date.UTC(2026, 5, 3)
  const INTERVAL_SECONDS = 60
  const fakeAe = await createFakeAnalyticsEngine()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    const firstAtMs = BASE_MS
    const first = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(firstAtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 1,
        topologyGeneration: 1,
        bootGeneration: 1,
      },
      networks: [nic('eth0', 100)],
    })
    fakeAe.setNow(firstAtMs)
    store.writeSample(first, emptySlotMapping({ normalNicSlots: ['eth0'] }))

    // eth0 is replaced by eth1 in the primary slot.
    const secondAtMs = BASE_MS + INTERVAL_SECONDS * 1000
    const second = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(secondAtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 2,
        topologyGeneration: 2,
        bootGeneration: 1,
      },
      networks: [nic('eth1', 300)],
    })
    fakeAe.setNow(secondAtMs)
    store.writeSample(second, emptySlotMapping({ normalNicSlots: ['eth1'] }))

    const series = await store.queryEntitySeries({
      serverId: SERVER_ID,
      family: 'network',
      entityIds: ['eth0', 'eth1'],
      metrics: ['receiveBytesPerSecond'],
      from: new Date(firstAtMs - 60_000).toISOString(),
      to: new Date(secondAtMs + 60_000).toISOString(),
      resolutionSeconds: INTERVAL_SECONDS,
    })
    const rxByAt = (id: string) =>
      new Map(
        series.entities
          .find((e) => e.entityId === id)!
          .points.map((p) => [p.at, p.values.receiveBytesPerSecond])
      )
    const eth0 = rxByAt('eth0')
    assertEquals(eth0.get(first.metadata.sampledAt), 100)
    assertEquals(
      eth0.has(second.metadata.sampledAt),
      false,
      'eth0 has no point once eth1 replaced it'
    )
    const eth1 = rxByAt('eth1')
    assertEquals(eth1.get(second.metadata.sampledAt), 300)
    assertEquals(eth1.has(first.metadata.sampledAt), false, 'eth1 has no point before it existed')
  } finally {
    await fakeAe.close()
  }
})
