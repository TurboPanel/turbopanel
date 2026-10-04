import { assertEquals, assertThrows } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  type HostCpuMetrics,
  type HostKernelMetrics,
  type HostMemoryMetrics,
  type HostNetworkMetrics,
  type HostStorageMetrics,
  type MetricsExtended,
  type MetricsSampleInput,
} from '../../../../contracts/metrics-contract.ts'
import type { AuthenticatedMetricsSample, SlotMapping } from '../../types.ts'
import {
  _internalFieldMap,
  AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX,
  AE_BLOB_COUNT,
  AE_BLOB_ENTITY_IDS_INDEX,
  AE_BLOB_EVENT_ENTITY_ID_INDEX,
  AE_BLOB_EVENT_ID_INDEX,
  AE_BLOB_EVENT_PAYLOAD_INDEX,
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_KIND_INDEX,
  AE_BLOB_SAMPLED_AT_INDEX,
  AE_BLOB_SCHEMA_VERSION_INDEX,
  AE_BLOB_SOURCE_OR_IDENTITY_INDEX,
  AE_BLOB_STATUS_OR_EVENT_REASON_INDEX,
  AE_BLOB_TOPOLOGY_GENERATION_INDEX,
  AE_DOUBLE_COUNT,
  AE_DOUBLE_INTERVAL_INDEX,
  AE_EVENT_BLOB_TOPOLOGY_GENERATION_INDEX,
  AE_EVENT_INDEX_SUFFIX,
  AE_FAMILY_HOST_IO,
  AE_FAMILY_HOST_SYSTEM,
  AE_KIND_EVENT,
  AE_KIND_METRICS,
  AE_MAX_DATA_POINTS_PER_INVOCATION,
  AE_MISSING_METRIC_SENTINEL,
  aeIndexesForFamilies,
  aeIndexForFamily,
  type AnalyticsEngineDataPointLike,
  buildMetricsDataPoints,
  doubleIndexForHostField,
  findHostFieldSlot,
  formatAeSampleTime,
  hostIoEmbeddedNicDoubleIndex,
} from './field-map.ts'

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

function buildSample(
  overrides: Partial<MetricsSampleInput> = {},
  identity: { serverId?: string; receivedAt?: string } = {}
): AuthenticatedMetricsSample {
  const built = buildMetricsSample(baseInput(overrides))
  return {
    ...built,
    serverId: identity.serverId ?? '11111111-2222-4333-8444-555555555555',
    receivedAt: identity.receivedAt ?? '2026-01-01T00:00:01.000Z',
  }
}

function mkNic(deviceId: string, seed = 0) {
  return {
    deviceId,
    receiveBytesPerSecond: seed + 1,
    transmitBytesPerSecond: seed + 2,
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

function mkFilesystem(filesystemId: string) {
  return { filesystemId, availableBytes: 1, freeInodes: 1 }
}

/** 1..19 in physical slot order: the 7 CPU fields, then the 12 memory fields. */
function mkDiagnostics(): MetricsSampleInput['diagnostics'] {
  return {
    cpu: {
      averageFrequencyMHz: 1,
      minimumFrequencyMHz: 2,
      maximumFrequencyMHz: 3,
      contextSwitchesPerSecond: 4,
      interruptsPerSecond: 5,
      forksPerSecond: 6,
      cpuIrqPercent: 7,
    },
    memory: {
      memoryFreeBytes: 8,
      cachedBytes: 9,
      anonPagesBytes: 10,
      slabReclaimableBytes: 11,
      slabUnreclaimableBytes: 12,
      dirtyBytes: 13,
      writebackBytes: 14,
      shmemBytes: 15,
      committedAsBytes: 16,
      pageScanDirectPerSecond: 17,
      pageScanKswapdPerSecond: 18,
      compactionStallsPerSecond: 19,
    },
  }
}

function mkBlock(deviceId: string) {
  return {
    deviceId,
    readBytesPerSecond: 1,
    writeBytesPerSecond: 1,
    readOpsPerSecond: 1,
    writeOpsPerSecond: 1,
    readLatencyMs: 1,
    writeLatencyMs: 1,
    utilizationPercent: 1,
    queueDepth: 1,
  }
}

function mkSignal(signalId: string, value: number) {
  return { signalId, kind: 'temp', value }
}

// ---------------------------------------------------------------------------
// host.system / host.io exact positions
// ---------------------------------------------------------------------------

/** The `page`-th (0-based) row of `family`, in emission order. */
function pointFor(
  points: AnalyticsEngineDataPointLike[],
  family: string,
  page = 0
): AnalyticsEngineDataPointLike {
  const found = points.filter((point) => point.blobs[AE_BLOB_FAMILY_INDEX] === family)[page]
  if (!found) throw new Error(`no point found for family ${family} page ${page}`)
  return found
}

function countPointsOfFamily(points: AnalyticsEngineDataPointLike[], family: string): number {
  return points.filter((point) => point.blobs[AE_BLOB_FAMILY_INDEX] === family).length
}

/** A 19-slot expectation: sentinel everywhere except `slots`, plus double20 = interval. */
function expectedDoubles(slots: Record<number, number>, interval = 60): number[] {
  const out = new Array<number>(AE_DOUBLE_COUNT).fill(AE_MISSING_METRIC_SENTINEL)
  for (const [index, value] of Object.entries(slots)) out[Number(index)] = value
  out[AE_DOUBLE_INTERVAL_INDEX] = interval
  return out
}

/** Content text blobs start at blob7 (index 6). */
function contentBlobs(point: AnalyticsEngineDataPointLike, count: number): string[] {
  return point.blobs.slice(6, 6 + count)
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

it('metrics rows: blob1 kind, blob2 family, blob3 "7", blob4 topology generation, blob5 UTC text sample time, blob6 entity ids', () => {
  const sample = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-03-04T05:06:07.890Z',
      intervalSeconds: 60,
      sequence: 9,
      topologyGeneration: 12,
      bootGeneration: 1,
    },
    gpus: [mkGpu('gpu0'), mkGpu('gpu1')],
  })
  const points = buildMetricsDataPoints(sample)
  const gpu = pointFor(points, 'gpu')
  assertEquals(gpu.blobs.slice(0, 6), [
    'metrics',
    'gpu',
    '7',
    '12',
    '2026-03-04 05:06:07',
    'gpu0,gpu1',
  ])
  const host = pointFor(points, 'host.system')
  assertEquals(host.blobs[AE_BLOB_ENTITY_IDS_INDEX], '')
  assertEquals(host.blobs[AE_BLOB_TOPOLOGY_GENERATION_INDEX], '12')
  assertEquals(host.blobs[AE_BLOB_SAMPLED_AT_INDEX], '2026-03-04 05:06:07')
})

it('blob3 is always the storage version "7", even for a v6-stamped sample', () => {
  for (const version of [6, 7] as const) {
    const input = baseInput()
    input.metadata.version = version
    const built = buildMetricsSample(input)
    const points = buildMetricsDataPoints({ ...built, serverId: 's', receivedAt: 'x' })
    for (const point of points) assertEquals(point.blobs[AE_BLOB_SCHEMA_VERSION_INDEX], '7')
  }
})

it('formatAeSampleTime: UTC YYYY-MM-DD hh:mm:ss, offset inputs normalized, garbage empty', () => {
  assertEquals(formatAeSampleTime('2026-01-01T00:00:00.000Z'), '2026-01-01 00:00:00')
  assertEquals(formatAeSampleTime('2026-01-01T02:30:05+02:00'), '2026-01-01 00:30:05')
  assertEquals(formatAeSampleTime('not a date'), '')
})

it('metrics rows write no sequence, plan-generation or page blobs', () => {
  const sample = { ...buildSample({ gpus: [mkGpu('gpu0')] }), capabilityPlanGeneration: 7 }
  for (const point of buildMetricsDataPoints(sample)) {
    // blob7.. hold only content text; none of it is a stringified counter.
    assertEquals(
      point.blobs.slice(6).every((blob) => blob === ''),
      true
    )
    assertEquals(point.blobs.length, AE_BLOB_COUNT)
  }
})

it('index scheme: host.system keeps the bare serverId, every other family its own index', () => {
  const sample = buildSample({ gpus: [mkGpu('gpu0')] })
  const points = buildMetricsDataPoints(sample)
  assertEquals(pointFor(points, 'host.system').indexes, [sample.serverId])
  assertEquals(pointFor(points, 'host.io').indexes, [`${sample.serverId}:host.io`])
  assertEquals(pointFor(points, 'host.network').indexes, [`${sample.serverId}:host.network`])
  assertEquals(pointFor(points, 'host.web').indexes, [`${sample.serverId}:host.web`])
  assertEquals(pointFor(points, 'gpu').indexes, [`${sample.serverId}:gpu`])
})

it('aeIndexesForFamilies: bare serverId first (host.system + pre-split rows), then each family once', () => {
  const sid = '01a0e07a-bbf5-75df-a846-53864fc8cee3'
  assertEquals(aeIndexesForFamilies(sid, [AE_FAMILY_HOST_SYSTEM]), [sid])
  assertEquals(
    aeIndexesForFamilies(sid, [AE_FAMILY_HOST_IO, AE_FAMILY_HOST_IO, AE_EVENT_INDEX_SUFFIX]),
    [sid, `${sid}:host.io`, `${sid}:event`]
  )
  assertEquals(aeIndexForFamily(sid, 'host.web'), `${sid}:host.web`)
})

// ---------------------------------------------------------------------------
// Host rows: exact slot positions
// ---------------------------------------------------------------------------

const EXTENDED: MetricsExtended = {
  host: {
    pidLimitUsedPercent: 20,
    oomKills: 19,
    rootDiskQueueDepth: 31,
    rootDiskOpsPerSecond: 32,
    systemdUnitsFailed: 41,
    mdArraysDegraded: 42,
    mdArraysResyncing: 43,
  },
  docker: {
    containersRunning: 51,
    containersUnhealthy: 52,
    containersRestarting: 53,
    containerOomEvents: 54,
    containerDieEvents: 55,
    containersCpuPercent: 56,
    containersMemoryBytes: 57,
    reclaimableBytes: 58,
  },
  ingress: { tlsCertSoonestExpiryDays: 61 },
  text: {
    loadavg: '0.5 0.6 0.7 1/200 99',
    topCpu: 'php-fpm8.3',
    cpuModel: 'EPYC',
    topMem: 'mysqld',
    lastOom: 'php 16:02Z',
    unhealthyContainers: 'web-1',
    dockerVersion: '29.0.1',
    failedUnits: 'a.service',
    raidState: 'md0 [UU]',
    rebootRequired: 'kernel',
    kernel: '6.8.0',
    os: 'Debian 13',
    bootId: 'boot-1',
    virt: 'kvm',
    cloudProvider: 'Hetzner',
    agentVersion: '0.2.0',
    timeSync: 'yes',
    pendingUpdates: '3',
    fsReadOnly: '/srv',
    phpVersions: '8.3',
    webEngines: 'nginx',
    fpmBusiest: 'site42 3/20',
    topSites: 'site1 1GB',
    caddyVersion: '2.9',
    certSoonest: 'site2 20d',
    traefikVersion: '3.1',
    unhealthyBackends: 'svc1',
    dbVersions: 'pg16',
  },
}

it('host.system: cpu, memory (incl. oom kills), kernel limits, pid limit, slab-unreclaimable', () => {
  const sample = buildSample({
    host: {
      cpu: {
        busyPercent: 1,
        userPercent: 2,
        systemPercent: 3,
        iowaitPercent: 4,
        stealPercent: 5,
        softirqPercent: 6,
        pressureSomePercent: 7,
        saturatedCoreCount: 8,
        procsRunning: 90,
        procsBlocked: 91,
        processCount: 92,
      },
      kernel: { fileHandlesUsedPercent: 17, conntrackUsedPercent: 18 },
      memory: {
        usedBytes: 11,
        cachedFilesBytes: 12,
        swapUsedBytes: 13,
        pressureSomePercent: 14,
        pressureFullPercent: 15,
        swapInBytesPerSecond: 93,
        swapOutBytesPerSecond: 94,
        majorPageFaultsPerSecond: 16,
      },
      storage: zeroFields(HOST_STORAGE_FIELDS),
      network: zeroFields(HOST_NETWORK_FIELDS),
    },
    diagnostics: mkDiagnostics(),
    extended: EXTENDED,
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'host.system')
  // procs*, processCount and swap in/out are not stored in v7.
  assertEquals(
    point.doubles,
    expectedDoubles({
      0: 1,
      1: 2,
      2: 3,
      3: 4,
      4: 5,
      5: 6,
      6: 7,
      7: 8,
      8: 11,
      9: 12,
      10: 13,
      11: 14,
      12: 15,
      13: 16,
      14: 19,
      15: 17,
      16: 18,
      17: 20,
      18: 12,
    })
  )
  assertEquals(contentBlobs(point, 5), [
    '0.5 0.6 0.7 1/200 99',
    'php-fpm8.3',
    'EPYC',
    'mysqld',
    'php 16:02Z',
  ])
})

it('host.io: disk I/O, root disk queue/ops, Docker health and usage', () => {
  const sample = buildSample({
    host: {
      cpu: zeroFields(HOST_CPU_FIELDS),
      kernel: zeroFields(HOST_KERNEL_FIELDS),
      memory: zeroFields(HOST_MEMORY_FIELDS),
      storage: {
        ioPressureSomePercent: 1,
        ioPressureFullPercent: 2,
        diskReadBytesPerSecond: 3,
        diskWriteBytesPerSecond: 4,
        diskLatencyMs: 5,
        rootFilesystemAvailableBytes: 8,
        rootFilesystemFreeInodes: 9,
      },
      network: zeroFields(HOST_NETWORK_FIELDS),
    },
    dockerUsage: {
      layersBytes: 71,
      imagesCount: 99,
      imagesReclaimableBytes: 1,
      containersBytes: 72,
      containersCount: 99,
      volumesBytes: 73,
      volumesCount: 99,
      volumesReclaimableBytes: 2,
      buildCacheBytes: 74,
      buildCacheReclaimableBytes: 4,
    },
    extended: EXTENDED,
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'host.io')
  assertEquals(
    point.doubles,
    expectedDoubles({
      0: 1,
      1: 2,
      2: 3,
      3: 4,
      4: 5,
      5: 31,
      6: 32,
      7: 51,
      8: 52,
      9: 53,
      10: 54,
      11: 55,
      12: 56,
      13: 57,
      14: 71,
      15: 72,
      16: 73,
      17: 74,
      18: 58,
    })
  )
  assertEquals(contentBlobs(point, 2), ['web-1', '29.0.1'])
})

it('host.io reclaimable total: the sum of the three df groups when the daemon sent none', () => {
  const sample = buildSample({
    dockerUsage: {
      layersBytes: null,
      imagesCount: null,
      imagesReclaimableBytes: 1,
      containersBytes: null,
      containersCount: null,
      volumesBytes: null,
      volumesCount: null,
      volumesReclaimableBytes: 2,
      buildCacheBytes: null,
      buildCacheReclaimableBytes: 4,
    },
  })
  assertEquals(pointFor(buildMetricsDataPoints(sample), 'host.io').doubles[18], 7)
})

it('host.network: root filesystem, retransmits, embedded NICs, health, committed memory, Traefik', () => {
  const sample = buildSample({
    host: {
      cpu: zeroFields(HOST_CPU_FIELDS),
      kernel: zeroFields(HOST_KERNEL_FIELDS),
      memory: zeroFields(HOST_MEMORY_FIELDS),
      storage: {
        ...zeroFields(HOST_STORAGE_FIELDS),
        rootFilesystemAvailableBytes: 8,
        rootFilesystemFreeInodes: 9,
      },
      network: { tcpRetransmitPercent: 10, softnetDropsPerSecond: 99 },
    },
    networks: [
      {
        ...mkNic('eth0'),
        receiveBytesPerSecond: 100,
        transmitBytesPerSecond: 200,
        receiveErrorsPerSecond: 1,
        transmitErrorsPerSecond: 2,
        receiveDropsPerSecond: 3,
        transmitDropsPerSecond: 4,
      },
      { ...mkNic('eth1'), receiveBytesPerSecond: 300, transmitBytesPerSecond: 400 },
    ],
    filesystems: [{ filesystemId: '/mnt/a', availableBytes: 500, freeInodes: 600 }],
    diagnostics: mkDiagnostics(),
    router: {
      backendsUp: 21,
      backendsTotal: 22,
      servicesTotal: 99,
      routersTotal: 99,
      retries: 99,
      backendErrors5xx: 23,
      backendLatencyMsAvg: 24,
      backendRequests: 25,
      httpOpenConnections: 99,
      configReloads: 99,
      configLastReloadAgeSeconds: 99,
      tlsCertSoonestExpiryDays: 99,
    },
    extended: EXTENDED,
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'host.network')
  assertEquals(
    point.doubles,
    expectedDoubles({
      0: 8,
      1: 9,
      2: 500,
      3: 600,
      4: 10,
      5: 100,
      6: 200,
      7: 10,
      8: 300,
      9: 400,
      10: 0,
      11: 41,
      12: 42,
      13: 16,
      14: 21,
      15: 22,
      16: 23,
      17: 24,
      18: 25,
    })
  )
  assertEquals(contentBlobs(point, 14), [
    'a.service',
    'md0 [UU]',
    'kernel',
    '6.8.0',
    'Debian 13',
    'boot-1',
    'kvm',
    'Hetzner',
    '0.2.0',
    'yes',
    '3',
    '/srv',
    '8.3',
    'nginx',
  ])
})

it('host.network: a NIC with any missing error/drop input has a sentinel problems slot, never a partial sum', () => {
  const nic = { ...mkNic('eth0'), receiveDropsPerSecond: null }
  const point = pointFor(buildMetricsDataPoints(buildSample({ networks: [nic] })), 'host.network')
  assertEquals(point.doubles[5], 1)
  assertEquals(point.doubles[7], AE_MISSING_METRIC_SENTINEL)
  assertEquals(point.doubles[8], AE_MISSING_METRIC_SENTINEL)
})

it('host.network embeds slot-mapped NICs by identity, not array position', () => {
  const sample = buildSample({ networks: [mkNic('eth0', 10), mkNic('eth1', 20)] })
  const slotMapping: SlotMapping = {
    normalNicSlots: ['eth1', 'eth0'],
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
  }
  const point = pointFor(buildMetricsDataPoints(sample, slotMapping), 'host.network')
  assertEquals(point.doubles[hostIoEmbeddedNicDoubleIndex(0, 'receiveBytesPerSecond')], 21)
  assertEquals(point.doubles[hostIoEmbeddedNicDoubleIndex(1, 'receiveBytesPerSecond')], 11)
})

it('host.web: hosting usage, Caddy totals, certificate expiry and text', () => {
  const sample = buildSample({
    storage: {
      hostingUsedBytes: 1,
      backupUsedBytes: 2,
      dockerUsedBytes: 3,
      logsUsedBytes: 4,
      hostingFreeBytes: 5,
      backupFreeBytes: 6,
      logsFreeBytes: 99,
      postgres: {
        instancesRunning: null,
        instancesHealthy: null,
        connectionsUsed: null,
        connectionsMax: null,
      },
      mysql: {
        instancesRunning: null,
        instancesHealthy: null,
        connectionsUsed: null,
        connectionsMax: null,
      },
      mariadb: {
        instancesRunning: null,
        instancesHealthy: null,
        connectionsUsed: null,
        connectionsMax: null,
      },
    },
    ingressSources: [
      {
        sourceId: 'caddy',
        sourceKind: 'caddy',
        requests: 10,
        responses2xx: 11,
        responses3xx: 99,
        responses4xx: 12,
        responses5xx: 13,
        requestErrors: 14,
        requestBytes: 15,
        responseBytes: 16,
        requestDurationSecondsSum: 17,
        bucket10ms: 99,
        bucket50ms: 99,
        bucket100ms: 18,
        bucket500ms: 19,
        bucket1s: 20,
        bucket5s: 99,
        requestsInFlight: 21,
        upstreamsHealthy: 99,
        upstreamsTotal: 99,
        retries: 99,
      },
    ],
    extended: EXTENDED,
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'host.web')
  assertEquals(
    point.doubles,
    expectedDoubles({
      0: 1,
      1: 2,
      2: 3,
      3: 4,
      4: 5,
      5: 6,
      6: 10,
      7: 11,
      8: 12,
      9: 13,
      10: 14,
      11: 15,
      12: 16,
      13: 17,
      14: 18,
      15: 19,
      16: 20,
      17: 21,
      18: 61,
    })
  )
  assertEquals(contentBlobs(point, 6), [
    'site42 3/20',
    'site1 1GB',
    '2.9',
    'site2 20d',
    '3.1',
    'svc1',
  ])
})

it('managed.database: census and ProxySQL, only when managed databases are present', () => {
  assertEquals(countPointsOfFamily(buildMetricsDataPoints(buildSample()), 'managed.database'), 0)
  const sample = buildSample({
    storage: {
      hostingUsedBytes: null,
      backupUsedBytes: null,
      dockerUsedBytes: null,
      logsUsedBytes: null,
      hostingFreeBytes: null,
      backupFreeBytes: null,
      logsFreeBytes: null,
      postgres: {
        instancesRunning: 2,
        instancesHealthy: 1,
        connectionsUsed: 99,
        connectionsMax: 99,
      },
      mysql: {
        instancesRunning: null,
        instancesHealthy: null,
        connectionsUsed: null,
        connectionsMax: null,
      },
      mariadb: {
        instancesRunning: 3,
        instancesHealthy: 3,
        connectionsUsed: 99,
        connectionsMax: 99,
      },
    },
    databaseProxies: [
      {
        sourceId: 'proxysql',
        sourceKind: 'proxysql',
        queries: 1,
        slowQueries: 2,
        queryLatencyMsAvg: 3,
        backendLatencyMsAvg: 4,
        activeTransactions: 5,
        clientConnections: 6,
        clientConnectionsCreated: 99,
        clientConnectionsAborted: 7,
        connectionsRejectedMaxConns: 8,
        backendConnections: 9,
        backendConnectionsCreated: 99,
        backendConnectionsAborted: 99,
        connectionErrors: 10,
        backendsUp: 11,
        backendsTotal: 12,
        bytesFromBackends: 99,
        bytesToBackends: 99,
      },
    ],
    extended: EXTENDED,
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'managed.database')
  assertEquals(
    point.doubles,
    expectedDoubles({
      0: 2,
      1: 1,
      4: 3,
      5: 3,
      6: 1,
      7: 2,
      8: 3,
      9: 4,
      10: 5,
      11: 6,
      12: 7,
      13: 8,
      14: 9,
      15: 10,
      16: 11,
      17: 12,
    })
  )
  assertEquals(contentBlobs(point, 1), ['pg16'])
})

it('a v6-shaped sample (no extended section) still writes every host row: sentinels and empty text', () => {
  const points = buildMetricsDataPoints(buildSample())
  assertEquals(
    points.map((p) => p.blobs[AE_BLOB_FAMILY_INDEX]),
    ['host.system', 'host.io', 'host.network', 'host.web']
  )
  for (const point of points) {
    assertEquals(
      point.blobs.slice(6).every((blob) => blob === ''),
      true
    )
    assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60)
    // Everything is null in the zeroed base sample, so every metric slot is the sentinel.
    for (const value of point.doubles.slice(0, AE_DOUBLE_INTERVAL_INDEX)) {
      assertEquals(value, AE_MISSING_METRIC_SENTINEL)
    }
  }
})

// ---------------------------------------------------------------------------
// Entity rows
// ---------------------------------------------------------------------------

it('block: no row for a single drive; more than one pages 3 per row with ids and model/SMART text', () => {
  assertEquals(
    countPointsOfFamily(
      buildMetricsDataPoints(buildSample({ blockDevices: [mkBlock('nvme0n1')] })),
      'block'
    ),
    0
  )
  const devices = ['a', 'b', 'c', 'd'].map(mkBlock)
  const sample = buildSample({
    blockDevices: devices.map((d) => ({ ...d, readOpsPerSecond: 3, writeOpsPerSecond: 4 })),
    extended: {
      blockDeviceText: [
        { deviceId: 'a', model: 'Samsung', smart: 'PASSED' },
        { deviceId: 'd', model: 'WD' },
      ],
    },
  })
  const points = buildMetricsDataPoints(sample)
  assertEquals(countPointsOfFamily(points, 'block'), 2)
  const first = pointFor(points, 'block', 0)
  assertEquals(first.blobs[AE_BLOB_ENTITY_IDS_INDEX], 'a,b,c')
  // readBytes, writeBytes, ops (read + write), readLatency, writeLatency, queue per drive
  assertEquals(first.doubles.slice(0, 6), [1, 1, 7, 1, 1, 1])
  assertEquals(first.doubles.slice(6, 12), [1, 1, 7, 1, 1, 1])
  assertEquals(first.doubles[18], AE_MISSING_METRIC_SENTINEL)
  assertEquals(contentBlobs(first, 6), ['Samsung', 'PASSED', '', '', '', ''])
  const second = pointFor(points, 'block', 1)
  assertEquals(second.blobs[AE_BLOB_ENTITY_IDS_INDEX], 'd')
  assertEquals(contentBlobs(second, 2), ['WD', ''])
})

it('block ops are sentinel when either read or write ops is missing', () => {
  const sample = buildSample({
    blockDevices: [{ ...mkBlock('a'), writeOpsPerSecond: null }, mkBlock('b')],
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'block')
  assertEquals(point.doubles[2], AE_MISSING_METRIC_SENTINEL)
  assertEquals(point.doubles[8], 2)
})

it('filesystem: exactly one extra filesystem folds into host.network; two or more page 9 per row', () => {
  const one = buildMetricsDataPoints(buildSample({ filesystems: [mkFilesystem('/a')] }))
  assertEquals(countPointsOfFamily(one, 'filesystem'), 0)
  const many = Array.from({ length: 10 }, (_, i) => mkFilesystem(`/m${i}`))
  const points = buildMetricsDataPoints(buildSample({ filesystems: many }))
  assertEquals(countPointsOfFamily(points, 'filesystem'), 2)
  assertEquals(
    pointFor(points, 'filesystem', 0).blobs[AE_BLOB_ENTITY_IDS_INDEX].split(',').length,
    9
  )
  assertEquals(pointFor(points, 'filesystem', 1).blobs[AE_BLOB_ENTITY_IDS_INDEX], '/m9')
  // The folded slots stay empty once the filesystem pages.
  assertEquals(pointFor(points, 'host.network').doubles[2], AE_MISSING_METRIC_SENTINEL)
})

it('gpu: 3 per row, driver and model text per GPU', () => {
  const sample = buildSample({
    gpus: ['g0', 'g1', 'g2', 'g3'].map(mkGpu),
    extended: { gpuText: [{ gpuId: 'g1', driver: 'nvidia 570', model: 'RTX' }] },
  })
  const points = buildMetricsDataPoints(sample)
  assertEquals(countPointsOfFamily(points, 'gpu'), 2)
  assertEquals(contentBlobs(pointFor(points, 'gpu', 0), 6), ['', '', 'nvidia 570', 'RTX', '', ''])
  assertEquals(pointFor(points, 'gpu', 1).blobs[AE_BLOB_ENTITY_IDS_INDEX], 'g3')
})

it('network: NIC 3 and up page 3 per row, in slot order', () => {
  const sample = buildSample({ networks: Array.from({ length: 8 }, (_, i) => mkNic(`eth${i}`)) })
  const points = buildMetricsDataPoints(sample)
  assertEquals(countPointsOfFamily(points, 'network'), 2)
  assertEquals(pointFor(points, 'network', 0).blobs[AE_BLOB_ENTITY_IDS_INDEX], 'eth2,eth3,eth4')
  assertEquals(pointFor(points, 'network', 1).blobs[AE_BLOB_ENTITY_IDS_INDEX], 'eth5,eth6,eth7')
})

it('hardware.physical: one double per signal, up to 19 per row', () => {
  const signals = Array.from({ length: 20 }, (_, i) => mkSignal(`sig${i}`, i))
  const points = buildMetricsDataPoints(buildSample({ hardwareSignals: signals }))
  assertEquals(countPointsOfFamily(points, 'hardware.physical'), 2)
  const first = pointFor(points, 'hardware.physical', 0)
  assertEquals(first.blobs[AE_BLOB_ENTITY_IDS_INDEX].split(',').length, 19)
  assertEquals(
    first.doubles.slice(0, 19),
    Array.from({ length: 19 }, (_, i) => i)
  )
  const second = pointFor(points, 'hardware.physical', 1)
  assertEquals(second.blobs[AE_BLOB_ENTITY_IDS_INDEX], 'sig19')
  assertEquals(second.doubles[0], 19)
})

it('presence-gated families emit no rows when their source array is empty', () => {
  const points = buildMetricsDataPoints(buildSample())
  for (const family of ['gpu', 'network', 'filesystem', 'block', 'hardware.physical']) {
    assertEquals(countPointsOfFamily(points, family), 0)
  }
})

it('every produced point has exactly AE_DOUBLE_COUNT doubles and AE_BLOB_COUNT blobs', () => {
  const sample = buildSample({
    networks: [mkNic('a'), mkNic('b'), mkNic('c')],
    gpus: [mkGpu('g')],
    blockDevices: [mkBlock('x'), mkBlock('y')],
    filesystems: [mkFilesystem('/a'), mkFilesystem('/b')],
    hardwareSignals: [mkSignal('s', 1)],
  })
  for (const point of buildMetricsDataPoints(sample)) {
    assertEquals(point.doubles.length, AE_DOUBLE_COUNT)
    assertEquals(point.blobs.length, AE_BLOB_COUNT)
  }
})

// ---------------------------------------------------------------------------
// Events keep their v6 blob positions
// ---------------------------------------------------------------------------

it('events: one event-kind row per entry at the v6 blob positions, blob3 "7" and blob5 UTC text', () => {
  const sample = buildSample({
    events: [
      {
        eventId: 'evt1',
        at: '2026-01-01T00:00:00.500Z',
        kind: 'nic_link_down',
        severity: 'warning',
        entityId: 'eth0',
        source: 'daemon',
        payload: { reason: 'carrier lost' },
      },
    ],
  })
  const event = buildMetricsDataPoints(sample).find(
    (p) => p.blobs[AE_BLOB_KIND_INDEX] === AE_KIND_EVENT
  )!
  assertEquals(event.blobs[AE_BLOB_FAMILY_INDEX], 'nic_link_down')
  assertEquals(event.blobs[AE_BLOB_SCHEMA_VERSION_INDEX], '7')
  assertEquals(event.blobs[AE_BLOB_SAMPLED_AT_INDEX], '2026-01-01 00:00:00')
  assertEquals(event.blobs[AE_EVENT_BLOB_TOPOLOGY_GENERATION_INDEX], '1')
  assertEquals(event.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], 'daemon')
  assertEquals(event.blobs[AE_BLOB_EVENT_ENTITY_ID_INDEX], 'eth0')
  assertEquals(event.blobs[AE_BLOB_EVENT_ID_INDEX], 'evt1')
  assertEquals(JSON.parse(event.blobs[AE_BLOB_EVENT_PAYLOAD_INDEX]), { reason: 'carrier lost' })
  assertEquals(event.blobs[AE_BLOB_STATUS_OR_EVENT_REASON_INDEX], 'warning')
  assertEquals(event.doubles[AE_DOUBLE_INTERVAL_INDEX], 60)
  for (const value of event.doubles.slice(0, AE_DOUBLE_INTERVAL_INDEX)) {
    assertEquals(value, AE_MISSING_METRIC_SENTINEL)
  }
})

it('events: the capability-plan generation is still stamped on event rows (blob8)', () => {
  const sample = {
    ...buildSample({
      events: [
        { eventId: 'e', at: '2026-01-01T00:00:00.000Z', kind: 'oom_kill', severity: 'warning' },
      ],
    }),
    capabilityPlanGeneration: 7,
  }
  const event = buildMetricsDataPoints(sample).find(
    (p) => p.blobs[AE_BLOB_KIND_INDEX] === AE_KIND_EVENT
  )!
  assertEquals(event.blobs[AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX], '7')
})

// ---------------------------------------------------------------------------
// Read-side lookups
// ---------------------------------------------------------------------------

it('doubleIndexForHostField resolves stored fields to their v7 row and slot', () => {
  assertEquals(doubleIndexForHostField('host.cpu', 'busyPercent'), {
    family: 'host.system',
    doubleIndex: 0,
  })
  assertEquals(doubleIndexForHostField('host.storage', 'diskReadBytesPerSecond'), {
    family: 'host.io',
    doubleIndex: 2,
  })
  assertEquals(doubleIndexForHostField('host.network', 'tcpRetransmitPercent'), {
    family: 'host.network',
    doubleIndex: 4,
  })
  assertEquals(doubleIndexForHostField('router', 'backendsUp'), {
    family: 'host.network',
    doubleIndex: 14,
  })
  assertEquals(doubleIndexForHostField('ingress', 'requests'), {
    family: 'host.web',
    doubleIndex: 6,
  })
  assertEquals(doubleIndexForHostField('storage', 'mysqlInstancesRunning'), {
    family: 'managed.database',
    doubleIndex: 2,
  })
})

it('a field v7 dropped has no slot (findHostFieldSlot undefined, doubleIndexForHostField throws)', () => {
  assertEquals(findHostFieldSlot('host.cpu', 'procsRunning'), undefined)
  assertEquals(findHostFieldSlot('host.memory', 'swapInBytesPerSecond'), undefined)
  assertThrows(
    () => doubleIndexForHostField('host.cpu', 'procsRunning'),
    TypeError,
    'no AE v7 host double slot'
  )
})

it('the layout fits the AE page budgets at module load', () => {
  _internalFieldMap.assertV7LayoutWithinBudgets()
})

// ---------------------------------------------------------------------------
// Analytics Engine invocation limit
// ---------------------------------------------------------------------------

/** A sample at the contract's own array caps: the largest thing the wire can carry. */
function maxCardinalitySample() {
  const n = <T>(count: number, make: (i: number) => T): T[] =>
    Array.from({ length: count }, (_, i) => make(i))
  return buildSample({
    networks: n(64, (i) => mkNic(`eth${i}`)),
    filesystems: n(64, (i) => mkFilesystem(`fs${i}`)),
    blockDevices: n(64, (i) => mkBlock(`blk${i}`)),
    gpus: n(64, (i) => mkGpu(`gpu${i}`)),
    hardwareSignals: n(64, (i) => mkSignal(`sig${i}`, 1)),
    events: n(128, (i) => ({
      eventId: `e${i}`,
      at: '2026-01-01T00:00:00.000Z',
      kind: 'oom_kill' as const,
      severity: 'warning' as const,
    })),
  })
}

it('the contract array caps stay under the Analytics Engine invocation limit in v7', () => {
  // v7 folded Caddy and ProxySQL into host rows, so 64-entry arrays plus 128
  // events top out at 4 host rows + 22 + 21 + 8 + 22 + 4 pages + 128 events.
  const points = buildMetricsDataPoints(maxCardinalitySample())
  assertEquals(points.length, 4 + 22 + 21 + 8 + 22 + 4 + 128)
  assertEquals(points.length <= AE_MAX_DATA_POINTS_PER_INVOCATION, true)
})

function syntheticPoint(kind: string, family: string, index: number): AnalyticsEngineDataPointLike {
  const blobs = new Array<string>(AE_BLOB_COUNT).fill('')
  blobs[AE_BLOB_KIND_INDEX] = kind
  blobs[AE_BLOB_FAMILY_INDEX] = family
  blobs[AE_BLOB_ENTITY_IDS_INDEX] = String(index)
  return { indexes: ['s'], doubles: new Array<number>(AE_DOUBLE_COUNT).fill(0), blobs }
}

it('shedding for the invocation limit keeps the host rows and every event, drops entity rows first', () => {
  const points = [
    ...['host.system', 'host.io', 'host.network', 'host.web'].map((f, i) =>
      syntheticPoint(AE_KIND_METRICS, f, i)
    ),
    ...Array.from({ length: 200 }, (_, i) => syntheticPoint(AE_KIND_METRICS, 'gpu', i)),
    ...Array.from({ length: 100 }, (_, i) => syntheticPoint(AE_KIND_EVENT, 'oom_kill', i)),
  ]
  const kept = _internalFieldMap.capToInvocationLimit(points, 'srv')
  assertEquals(kept.length, AE_MAX_DATA_POINTS_PER_INVOCATION)
  assertEquals(countPointsOfFamily(kept, 'host.web'), 1)
  assertEquals(kept.filter((p) => p.blobs[AE_BLOB_KIND_INDEX] === AE_KIND_EVENT).length, 100)
  assertEquals(countPointsOfFamily(kept, 'gpu'), 146)
})

it('leaves a normally-sized sample completely untouched', () => {
  const points = buildMetricsDataPoints(buildSample({ networks: [mkNic('eth0')] }))
  assertEquals(points.length, 4)
})
