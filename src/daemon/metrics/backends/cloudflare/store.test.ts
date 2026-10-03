import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  type HostCpuMetrics,
  type HostKernelMetrics,
  type HostMemoryMetrics,
  type HostNetworkMetrics,
  type HostStorageMetrics,
  type MetricsSampleInput,
} from '../../../../contracts/metrics-contract.ts'
import type { AuthenticatedMetricsSample, SlotMapping } from '../../types.ts'
import { buildMetricsDataPoints, buildStatusDataPoint } from './field-map.ts'
import {
  type AnalyticsEngineDatasetLike,
  CloudflareAnalyticsEngineServerMetricsStore,
} from './store.ts'

function zeroFields<T extends readonly string[]>(fields: T): { [K in T[number]]: number | null } {
  const out = {} as { [K in T[number]]: number | null }
  for (const field of fields) out[field as T[number]] = null
  return out
}

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

function mkNic(deviceId: string) {
  return {
    deviceId,
    receiveBytesPerSecond: 1,
    transmitBytesPerSecond: 2,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }
}

function mkGpu(gpuId: string) {
  return {
    gpuId,
    utilizationPercent: 1,
    memoryUsedBytes: 1,
    memoryActivityPercent: 1,
    pcieReceiveBytesPerSecond: 1,
    pcieTransmitBytesPerSecond: 1,
    throttlePercent: 1,
  }
}

function mkSignal(signalId: string) {
  return { signalId, kind: 'temp', value: 1 }
}

function mkIngress(sourceId: string) {
  return {
    sourceId,
    sourceKind: 'caddy',
    requests: 1,
    responses2xx: 1,
    responses3xx: 0,
    responses4xx: 0,
    responses5xx: 0,
    requestErrors: 0,
    requestBytes: 1,
    responseBytes: 1,
    requestDurationSecondsSum: 0.1,
    bucket10ms: 1,
    bucket50ms: 1,
    bucket100ms: 1,
    bucket500ms: 1,
    bucket1s: 1,
    bucket5s: 1,
    requestsInFlight: 1,
    upstreamsHealthy: 1,
    upstreamsTotal: 1,
    retries: 0,
  }
}

function mkDatabaseProxy(sourceId: string) {
  return {
    sourceId,
    sourceKind: 'proxysql',
    queries: 1,
    slowQueries: 0,
    queryLatencyMsAvg: 0,
    backendLatencyMsAvg: 0,
    activeTransactions: 0,
    clientConnections: 1,
    clientConnectionsCreated: 1,
    clientConnectionsAborted: 0,
    connectionsRejectedMaxConns: 0,
    backendConnections: 1,
    backendConnectionsCreated: 1,
    backendConnectionsAborted: 0,
    connectionErrors: 0,
    backendsUp: 1,
    backendsTotal: 1,
    bytesFromBackends: 1,
    bytesToBackends: 1,
  }
}

function createFakeDataset(): {
  dataset: AnalyticsEngineDatasetLike
  calls: Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }>
} {
  const calls: Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }> = []
  return {
    calls,
    dataset: {
      writeDataPoint(event) {
        calls.push(event)
      },
    },
  }
}

function writeCountFor(overrides: Partial<MetricsSampleInput>, slotMapping?: SlotMapping): number {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  store.writeSample(buildSample(overrides), slotMapping)
  return fake.calls.length
}

/** Slot mapping for a 2-uplink host: `eth0`/`eth1` are the normal NIC slots. */
function twoUplinkSlotMapping(fabricDeviceIds: string[] = []): SlotMapping {
  return {
    normalNicSlots: ['eth0', 'eth1'],
    fabricDeviceIds,
    rootFilesystemId: null,
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
  }
}

// ---------------------------------------------------------------------------
// Row-count matrix (see plan §6 for the machine-shape → expected-row-count
// list this mirrors). host.system + host.io are always 2 baseline rows;
// every other row is presence-gated / paged on top of that.
// ---------------------------------------------------------------------------

it('1-NIC VM: 4 rows (the four host rows; both NICs embed in host.network, here just 1)', () => {
  assertEquals(writeCountFor({ networks: [mkNic('eth0')] }), 4)
})

it('2-NIC VM: 4 rows (both NICs embed in host.network)', () => {
  assertEquals(writeCountFor({ networks: [mkNic('eth0'), mkNic('eth1')] }), 4)
})

it('2-NIC + extra fabric device, topology generation unknown: 5 rows (conservative positional fallback, no slot mapping to tell fabric apart yet)', () => {
  assertEquals(
    writeCountFor({
      networks: [mkNic('eth0'), mkNic('eth1'), mkNic('fabric0')],
    }),
    5
  )
})

it('2-NIC + extra fabric device, topology generation known: 4 rows — fabric never pages once SlotMapping identifies it', () => {
  assertEquals(
    writeCountFor(
      { networks: [mkNic('eth0'), mkNic('eth1'), mkNic('fabric0')] },
      twoUplinkSlotMapping(['fabric0'])
    ),
    4
  )
})

it('2-NIC + a genuine 3rd uplink, topology generation known: 5 rows — only fabric is excluded from paging, not every extra device', () => {
  assertEquals(
    writeCountFor(
      { networks: [mkNic('eth0'), mkNic('eth1'), mkNic('eth2')] },
      twoUplinkSlotMapping([])
    ),
    5
  )
})

it('+1 GPU: 5 rows (four host rows, one gpu page)', () => {
  assertEquals(writeCountFor({ gpus: [mkGpu('gpu0')] }), 5)
})

it('+Caddy: still 4 rows (its totals ride host.web, no row of its own)', () => {
  assertEquals(writeCountFor({ ingressSources: [mkIngress('caddy0')] }), 4)
})

it('web (Caddy) + GPU: 5 rows', () => {
  assertEquals(
    writeCountFor({
      ingressSources: [mkIngress('caddy0')],
      gpus: [mkGpu('gpu0')],
    }),
    5
  )
})

it('VM with no managed database data: 4 rows', () => {
  assertEquals(writeCountFor({}), 4)
})

it('DB + ProxySQL (managed.database): 5 rows', () => {
  assertEquals(writeCountFor({ databaseProxies: [mkDatabaseProxy('proxysql0')] }), 5)
})

it('bare-metal <=19 hardware signals: 5 rows (four host rows, one hardware.physical page)', () => {
  const signals = Array.from({ length: 12 }, (_, i) => mkSignal(`sig${i}`))
  assertEquals(writeCountFor({ hardwareSignals: signals }), 5)
})

it('bare-metal + GPU: 6 rows', () => {
  const signals = Array.from({ length: 12 }, (_, i) => mkSignal(`sig${i}`))
  assertEquals(writeCountFor({ hardwareSignals: signals, gpus: [mkGpu('gpu0')] }), 6)
})

it('4-NIC host: 5 rows (four host rows, one network page of the 2 extras)', () => {
  const networks = [mkNic('eth0'), mkNic('eth1'), mkNic('eth2'), mkNic('eth3')]
  assertEquals(writeCountFor({ networks }), 5)
})

it('8-NIC host: 6 rows (four host rows, two network pages of the 6 extras)', () => {
  const networks = Array.from({ length: 8 }, (_, i) => mkNic(`eth${i}`))
  assertEquals(writeCountFor({ networks }), 6)
})

it('16-GPU host: 10 rows (four host rows, six gpu pages of 3 each)', () => {
  const gpus = Array.from({ length: 16 }, (_, i) => mkGpu(`gpu${i}`))
  assertEquals(writeCountFor({ gpus }), 10)
})

it('presence-gated empty arrays: exactly the 4 host rows, no extra writes', () => {
  assertEquals(writeCountFor({}), 4)
})

it('events: one extra writeDataPoint call per event, on top of the four host rows', () => {
  const events = [
    {
      eventId: 'evt1',
      at: '2026-01-01T00:00:00.500Z',
      kind: 'nic_link_down' as const,
      severity: 'warning' as const,
    },
    {
      eventId: 'evt2',
      at: '2026-01-01T00:00:01.500Z',
      kind: 'fs_read_only' as const,
      severity: 'critical' as const,
    },
  ]
  assertEquals(writeCountFor({ events }), 6)
})

// ---------------------------------------------------------------------------
// writeSample / writeStatusEvent delegate to field-map.ts exactly
// ---------------------------------------------------------------------------

it('writeSample: calls match buildMetricsDataPoints exactly, fire-and-forget', () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const sample = buildSample({ gpus: [mkGpu('gpu0')] })
  store.writeSample(sample)
  assertEquals(fake.calls, buildMetricsDataPoints(sample))
})

it('writeSample: every row is indexed under the authenticated serverId (host.system bare, other families suffixed)', () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const sample = buildSample({ gpus: [mkGpu('gpu0')] })
  store.writeSample(sample)
  const indexes = fake.calls.map((call) => call.indexes?.[0] ?? '')
  for (const index of indexes) {
    assertEquals(index === sample.serverId || index.startsWith(`${sample.serverId}:`), true)
  }
  // One bare row per sample (host.system), and the GPU burst on its own index.
  assertEquals(indexes.filter((index) => index === sample.serverId).length, 1)
  assertEquals(indexes.includes(`${sample.serverId}:gpu`), true)
})

it('writeStatusEvent: exactly one writeDataPoint, matching buildStatusDataPoint', () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const event = {
    serverId: '11111111-2222-4333-8444-555555555555',
    connected: false,
    reason: 'disconnect' as const,
    at: '2026-01-01T00:00:00.000Z',
  }
  store.writeStatusEvent(event)
  assertEquals(fake.calls.length, 1)
  assertEquals(fake.calls[0], buildStatusDataPoint(event))
})

// ---------------------------------------------------------------------------
// v5 read-path wiring — no `sql` config reports `available: false` with the
// correct empty shape; a configured `sql` client delegates to sql-api.ts.
// ---------------------------------------------------------------------------

const READ_SERVER_ID = '11111111-2222-4333-8444-555555555555'

it('queryHostSeries: no sql config reports available:false with an empty series', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const result = await store.queryHostSeries!({
    serverId: READ_SERVER_ID,
    metrics: ['host.cpu.busyPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.points, [])
  assertEquals(result.sampleCount, 0)
})

it('queryHostSummary: no sql config reports available:false', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const result = await store.queryHostSummary!({
    serverId: READ_SERVER_ID,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.sampleCount, 0)
  assertEquals(result.latestAt, null)
})

it('queryFleetHostSnapshot: no sql config reports available:false with no servers', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const result = await store.queryFleetHostSnapshot!({
    serverIds: [READ_SERVER_ID],
    metrics: ['host.cpu.busyPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.servers, [])
})

it('queryMetricEvents: no sql config reports available:false with no events', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const result = await store.queryMetricEvents!({
    serverId: READ_SERVER_ID,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.events, [])
  assertEquals(result.truncated, false)
})

it('queryEntitySeries: no sql config reports available:false with no entities', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const result = await store.queryEntitySeries!({
    serverId: READ_SERVER_ID,
    family: 'gpu',
    entityIds: ['gpu0'],
    metrics: ['utilizationPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.entities, [])
})

it('queryEntityIdsSeen: no sql config reports available:false with no ids', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset)
  const result = await store.queryEntityIdsSeen!({
    serverId: READ_SERVER_ID,
    family: 'gpu',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.entityIds, [])
})

it('queryHostSeries: with sql config, delegates to the AE SQL API path', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fake.dataset, {
    sql: {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(
            JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: { data: [], meta: [], rows: 0 },
            }),
            { status: 200 }
          )
        }
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: {
              data: [
                {
                  bucket: 1735689600,
                  sample_count: 1,
                  avg_interval_seconds: 10,
                  m0: 55,
                },
              ],
              meta: [],
              rows: 1,
            },
          }),
          { status: 200 }
        )
      },
    },
  })
  const result = await store.queryHostSeries!({
    serverId: READ_SERVER_ID,
    metrics: ['host.cpu.busyPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, true)
  assertEquals(result.points[0].values['host.cpu.busyPercent'], 55)
})
