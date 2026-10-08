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
import { V8_HOST_ROW_SPECS } from './v8-layout.ts'
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
  AE_STORAGE_VERSION,
  AE_DOUBLE_COUNT,
  AE_DOUBLE_INTERVAL_INDEX,
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

it('metrics rows: blob1 kind, blob2 family, blob3 "8", blob4 empty, blob5 UTC text sample time, blob6 entity ids', () => {
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
    '8',
    '',
    '2026-03-04 05:06:07',
    'gpu0,gpu1',
  ])
  const host = pointFor(points, 'host.system')
  assertEquals(host.blobs[AE_BLOB_ENTITY_IDS_INDEX], '')
  assertEquals(host.blobs[3], '', 'blob4 is reserved and written empty')
  assertEquals(host.blobs[AE_BLOB_SAMPLED_AT_INDEX], '2026-03-04 05:06:07')
})

it('blob3 is always the storage layout revision "8", even for a v6-stamped sample, so rows written before the sizes amendment are never read with the new slot meanings', () => {
  for (const version of [6, 8] as const) {
    const input = baseInput()
    input.metadata.version = version
    const built = buildMetricsSample(input)
    const points = buildMetricsDataPoints({ ...built, serverId: 's', receivedAt: 'x' })
    for (const point of points)
      assertEquals(point.blobs[AE_BLOB_SCHEMA_VERSION_INDEX], String(AE_STORAGE_VERSION))
    assertEquals(AE_STORAGE_VERSION, 8)
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
  sizes: {
    memoryTotalBytes: 201,
    swapTotalBytes: 202,
    commitLimitBytes: 203,
    logicalCores: 204,
    rootFilesystemTotalBytes: 205,
    rootFilesystemTotalInodes: 206,
  },
  filesystemSizes: [
    { filesystemId: '/mnt/a', totalBytes: 700, totalInodes: 800 },
    { filesystemId: '/mnt/b', totalBytes: 710, totalInodes: 810 },
  ],
  gpuSizes: [{ gpuId: 'gpu0', memoryTotalBytes: 16_000 }],
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

/**
 * One sample in which every host-row data point has its own value, keyed by the
 * catalogue id the layout uses, so each row can be checked slot by slot against
 * `V8_HOST_ROW_SPECS` (the layout, not hand-copied positions).
 */
function fullHostSample(): {
  sample: AuthenticatedMetricsSample
  expected: Record<string, number>
} {
  const expected: Record<string, number> = {
    busy: 1,
    user: 2,
    system: 3,
    iowait: 4,
    steal: 5,
    softirq: 6,
    cpuPsi: 7,
    used: 11,
    cachedFiles: 12,
    swapUsed: 13,
    memPsiSome: 14,
    memPsiFull: 15,
    oomKills: 19,
    fileHandles: 17,
    conntrack: 18,
    pidLimit: 20,
    irqPsiFull: 22,
    dCommit: 16,
    memTotal: 201,
    swapTotal: 202,
    commitLimit: 203,
    cores: 204,
    rootTotal: 205,
    rootInodesTotal: 206,
    fs_totalBytes: 700,
    fs_totalInodes: 800,
    ioPsiSome: 31,
    ioPsiFull: 32,
    diskRead: 33,
    diskWrite: 34,
    diskLatency: 35,
    rootAvail: 36,
    rootInodes: 37,
    rootQueue: 41,
    rootOps: 42,
    fs_availableBytes: 500,
    fs_freeInodes: 600,
    hostingUsed: 51,
    backupUsed: 52,
    backupFree: 56,
    mdDegraded: 43,
    tcpRetrans: 61,
    'nic1.rx': 100,
    'nic1.tx': 200,
    'nic1.problems': 10,
    'nic2.rx': 300,
    'nic2.tx': 400,
    'nic2.problems': 0,
    ctrRunning: 71,
    ctrUnhealthy: 72,
    ctrRestarting: 73,
    ctrOom: 74,
    ctrDie: 75,
    ctrCpu: 76,
    ctrMem: 77,
    layers: 81,
    ctrBytes: 82,
    volumes: 83,
    buildCache: 84,
    reclTotal: 78,
    cReq: 90,
    c4xx: 92,
    c5xx: 93,
    cErr: 94,
    cReqB: 95,
    cRespB: 96,
    cDur: 97,
    cB100: 98,
    cB500: 99,
    cB1s: 101,
    cInFlight: 102,
    cTls: 61,
    tTotal: 112,
    t5xx: 113,
    tLatency: 114,
    systemdFailed: 44,
  }
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
      storage: {
        ioPressureSomePercent: 31,
        ioPressureFullPercent: 32,
        diskReadBytesPerSecond: 33,
        diskWriteBytesPerSecond: 34,
        diskLatencyMs: 35,
        rootFilesystemAvailableBytes: 36,
        rootFilesystemFreeInodes: 37,
      },
      network: { tcpRetransmitPercent: 61, softnetDropsPerSecond: 99 },
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
      backendsUp: 111,
      backendsTotal: 112,
      servicesTotal: 99,
      routersTotal: 99,
      retries: 99,
      backendErrors5xx: 113,
      backendLatencyMsAvg: 114,
      backendRequests: 115,
      httpOpenConnections: 99,
      configReloads: 99,
      configLastReloadAgeSeconds: 99,
      tlsCertSoonestExpiryDays: 99,
    },
    storage: {
      hostingUsedBytes: 51,
      backupUsedBytes: 52,
      dockerUsedBytes: 53,
      logsUsedBytes: 54,
      hostingFreeBytes: 55,
      backupFreeBytes: 56,
      logsFreeBytes: 57,
      postgres: emptyEngine(),
      mysql: emptyEngine(),
      mariadb: emptyEngine(),
    },
    dockerUsage: {
      layersBytes: 81,
      imagesCount: 99,
      imagesReclaimableBytes: 1,
      containersBytes: 82,
      containersCount: 99,
      volumesBytes: 83,
      volumesCount: 99,
      volumesReclaimableBytes: 2,
      buildCacheBytes: 84,
      buildCacheReclaimableBytes: 4,
    },
    ingressSources: [
      {
        sourceId: 'caddy',
        sourceKind: 'caddy',
        requests: 90,
        responses2xx: 91,
        responses3xx: 99,
        responses4xx: 92,
        responses5xx: 93,
        requestErrors: 94,
        requestBytes: 95,
        responseBytes: 96,
        requestDurationSecondsSum: 97,
        bucket10ms: 99,
        bucket50ms: 99,
        bucket100ms: 98,
        bucket500ms: 99,
        bucket1s: 101,
        bucket5s: 99,
        requestsInFlight: 102,
        upstreamsHealthy: 99,
        upstreamsTotal: 99,
        retries: 99,
      },
    ],
    extended: {
      ...EXTENDED,
      host: {
        ...EXTENDED.host,
        irqPressureFullPercent: 22,
        mdArraysDegraded: 43,
        systemdUnitsFailed: 44,
        rootDiskQueueDepth: 41,
        rootDiskOpsPerSecond: 42,
        oomKills: 19,
        pidLimitUsedPercent: 20,
      },
      docker: {
        containersRunning: 71,
        containersUnhealthy: 72,
        containersRestarting: 73,
        containerOomEvents: 74,
        containerDieEvents: 75,
        containersCpuPercent: 76,
        containersMemoryBytes: 77,
        reclaimableBytes: 78,
      },
      ingress: { tlsCertSoonestExpiryDays: 61 },
      networkSizes: [{ deviceId: 'eth0', linkSpeedMbps: 1000 }],
    },
  })
  return { sample, expected }
}

function emptyEngine() {
  return {
    instancesRunning: null,
    instancesHealthy: null,
    connectionsUsed: null,
    connectionsMax: null,
  }
}

for (const family of ['host.system', 'host.io', 'host.network', 'host.web'] as const) {
  it(`${family}: every slot holds the data point the layout names there`, () => {
    const { sample, expected } = fullHostSample()
    const point = pointFor(buildMetricsDataPoints(sample), family)
    const slots: Record<number, number> = {}
    V8_HOST_ROW_SPECS[family].doubles.forEach((id, index) => {
      if (id === null) return
      if (!(id in expected)) throw new Error(`test has no value for ${id}`)
      slots[index] = expected[id]!
    })
    assertEquals(point.doubles, expectedDoubles(slots))
  })
}

it('the 9 data points the owner dropped are written nowhere on the host rows', () => {
  for (const family of ['host.system', 'host.io', 'host.network', 'host.web'] as const) {
    for (const dropped of [
      'saturated',
      'hostingFree',
      'dockerUsed',
      'tUp',
      'tRequests',
      'majorFaults',
      'c2xx',
      'dSlabU',
      'logsUsed',
    ]) {
      assertEquals(
        V8_HOST_ROW_SPECS[family].doubles.includes(dropped),
        false,
        `${family} ${dropped}`
      )
    }
  }
})

it('host row text follows its numbers: system facts on host.system, web facts on host.web', () => {
  const { sample } = fullHostSample()
  const points = buildMetricsDataPoints(sample)
  assertEquals(contentBlobs(pointFor(points, 'host.system'), 3), [
    '0.5 0.6 0.7 1/200 99',
    'php-fpm8.3',
    'EPYC',
  ])
  assertEquals(contentBlobs(pointFor(points, 'host.io'), 2), ['/srv', 'md0 [UU]'])
  assertEquals(contentBlobs(pointFor(points, 'host.network'), 2), ['web-1', '29.0.1'])
  assertEquals(contentBlobs(pointFor(points, 'host.web'), 9).at(-1), 'a.service')
})

it('host.network blob6 names NIC 1, NIC 2 (with link speed) and the folded disk; other host rows leave it empty', () => {
  const { sample } = fullHostSample()
  const points = buildMetricsDataPoints(sample)
  assertEquals(
    pointFor(points, 'host.network').blobs[AE_BLOB_ENTITY_IDS_INDEX],
    'nic1=eth0@1000;nic2=eth1@;fs=/mnt/a'
  )
  for (const family of ['host.system', 'host.io', 'host.web']) {
    assertEquals(pointFor(points, family).blobs[AE_BLOB_ENTITY_IDS_INDEX], '')
  }
})

it('host.network reclaimable total: the sum of the three df groups when the daemon sent none', () => {
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
  const slot = V8_HOST_ROW_SPECS['host.network'].doubles.indexOf('reclTotal')
  assertEquals(pointFor(buildMetricsDataPoints(sample), 'host.network').doubles[slot], 7)
})

it('host.network: a NIC with any missing error/drop input has a sentinel problems slot, never a partial sum', () => {
  const nic = { ...mkNic('eth0'), receiveDropsPerSecond: null }
  const point = pointFor(buildMetricsDataPoints(buildSample({ networks: [nic] })), 'host.network')
  const spec = V8_HOST_ROW_SPECS['host.network'].doubles
  assertEquals(point.doubles[spec.indexOf('nic1.rx')], 1)
  assertEquals(point.doubles[spec.indexOf('nic1.problems')], AE_MISSING_METRIC_SENTINEL)
  assertEquals(point.doubles[spec.indexOf('nic2.rx')], AE_MISSING_METRIC_SENTINEL)
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
  assertEquals(point.blobs[AE_BLOB_ENTITY_IDS_INDEX], 'nic1=eth1@;nic2=eth0@')
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

it('filesystem: exactly one extra filesystem folds into host.io; two or more page 9 per row', () => {
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
  const folded = V8_HOST_ROW_SPECS['host.io'].doubles.indexOf('fs_availableBytes')
  assertEquals(pointFor(points, 'host.io').doubles[folded], AE_MISSING_METRIC_SENTINEL)
})

it("filesystem rows carry each filesystem's size as text on its own row, looked up by id", () => {
  const sample = buildSample({
    filesystems: [
      { filesystemId: '/mnt/a', availableBytes: 1, freeInodes: 2 },
      { filesystemId: '/mnt/b', availableBytes: 3, freeInodes: 4 },
      { filesystemId: '/mnt/c', availableBytes: 5, freeInodes: 6 },
    ],
    extended: {
      filesystemSizes: [
        // Deliberately out of order: the lookup is by id, not position.
        { filesystemId: '/mnt/b', totalBytes: 30, totalInodes: null },
        { filesystemId: '/mnt/a', totalBytes: 10, totalInodes: 20 },
      ],
    },
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'filesystem', 0)
  // Numbers are unchanged: two per filesystem.
  assertEquals(point.doubles.slice(0, 6), [1, 2, 3, 4, 5, 6])
  // One text per filesystem: `<bytes>/<inodes>`, empty when nothing is known.
  assertEquals(contentBlobs(point, 3), ['10/20', '30/', ''])
})

it("gpu rows keep memory activity and carry each GPU's memory size as text", () => {
  const sample = buildSample({
    gpus: [{ ...mkGpu('g0'), memoryUsedBytes: 5, memoryActivityPercent: 7 }],
    extended: {
      gpuSizes: [{ gpuId: 'g0', memoryTotalBytes: 16_000 }],
      gpuText: [{ gpuId: 'g0', driver: 'nvidia 570', model: 'RTX' }],
    },
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'gpu', 0)
  assertEquals(point.doubles.slice(0, 3), [1, 5, 7])
  assertEquals(contentBlobs(point, 3), ['nvidia 570', 'RTX', '16000'])
})

it("NIC rows carry each NIC's link speed as text", () => {
  const sample = buildSample({
    networks: ['eth0', 'eth1', 'eth2', 'eth3'].map((id) => mkNic(id)),
    extended: { networkSizes: [{ deviceId: 'eth2', linkSpeedMbps: 10_000 }] },
  })
  const point = pointFor(buildMetricsDataPoints(sample), 'network', 0)
  assertEquals(point.blobs[AE_BLOB_ENTITY_IDS_INDEX], 'eth2,eth3')
  assertEquals(contentBlobs(point, 2), ['10000', ''])
})

it('gpu: 3 per row, driver and model text per GPU', () => {
  const sample = buildSample({
    gpus: ['g0', 'g1', 'g2', 'g3'].map(mkGpu),
    extended: { gpuText: [{ gpuId: 'g1', driver: 'nvidia 570', model: 'RTX' }] },
  })
  const points = buildMetricsDataPoints(sample)
  assertEquals(countPointsOfFamily(points, 'gpu'), 2)
  assertEquals(contentBlobs(pointFor(points, 'gpu', 0), 9), [
    '',
    '',
    '',
    'nvidia 570',
    'RTX',
    '',
    '',
    '',
    '',
  ])
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

it('events: one event-kind row per entry at the v6 blob positions, blob3 "8" and blob5 UTC text', () => {
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
  assertEquals(event.blobs[AE_BLOB_SCHEMA_VERSION_INDEX], '8')
  assertEquals(event.blobs[AE_BLOB_SAMPLED_AT_INDEX], '2026-01-01 00:00:00')
  assertEquals(event.blobs[6], '', 'blob7 is reserved and written empty on events')
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

it('doubleIndexForHostField resolves stored fields to their v8 row and slot', () => {
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
    doubleIndex: 0,
  })
  assertEquals(doubleIndexForHostField('router', 'backendsTotal'), {
    family: 'host.web',
    doubleIndex: 12,
  })
  assertEquals(doubleIndexForHostField('ingress', 'requests'), {
    family: 'host.web',
    doubleIndex: 0,
  })
  assertEquals(doubleIndexForHostField('extended.sizes', 'memoryTotalBytes'), {
    family: 'host.system',
    doubleIndex: 14,
  })
  assertEquals(doubleIndexForHostField('storage', 'mysqlInstancesRunning'), {
    family: 'managed.database',
    doubleIndex: 2,
  })
})

it('a field v8 dropped has no slot (findHostFieldSlot undefined, doubleIndexForHostField throws)', () => {
  assertEquals(findHostFieldSlot('host.cpu', 'procsRunning'), undefined)
  assertEquals(findHostFieldSlot('host.memory', 'swapInBytesPerSecond'), undefined)
  // Owner-dropped 2026-10-07: derivable or duplicated elsewhere.
  assertEquals(findHostFieldSlot('host.cpu', 'saturatedCoreCount'), undefined)
  assertEquals(findHostFieldSlot('router', 'backendsUp'), undefined)
  assertEquals(findHostFieldSlot('storage', 'dockerUsedBytes'), undefined)
  assertThrows(
    () => doubleIndexForHostField('host.cpu', 'procsRunning'),
    TypeError,
    'no AE v8 host double slot'
  )
})

it('the layout fits the AE page budgets at module load', () => {
  _internalFieldMap.assertV8LayoutWithinBudgets()
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
    events: n(16, (i) => ({
      eventId: `e${i}`,
      at: '2026-01-01T00:00:00.000Z',
      kind: 'oom_kill' as const,
      severity: 'warning' as const,
    })),
  })
}

it('the contract array caps stay under the Analytics Engine invocation limit in v8', () => {
  // v8 folded Caddy and ProxySQL into host rows, so 64-entry arrays plus the
  // 16-event cap top out at 4 host rows + 22 + 21 + 8 + 22 + 4 pages + 16 events.
  const points = buildMetricsDataPoints(maxCardinalitySample())
  assertEquals(points.length, 4 + 22 + 21 + 8 + 22 + 4 + 16)
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
