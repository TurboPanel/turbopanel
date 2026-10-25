import { assertEquals } from '@std/assert'
import {
  type MetricsCapabilityPlan,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
} from '../../contracts/capability-plan.ts'
import type { MetricsSample } from '../../contracts/metrics-contract.ts'
import type { SlotMapping } from '../../contracts/topology-types.ts'
import { prepareSampleForStorage } from './ingest-preparation.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ALL_ON: MetricsCapabilityPlan = PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN

// ---------------------------------------------------------------------------
// What both editions do before a sample is stored
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

function emptySample(): MetricsSample {
  return {
    type: 'metrics',
    metadata: {
      version: 6,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 0,
      topologyGeneration: 0,
      bootGeneration: 0,
    },
    host: {
      cpu: {
        busyPercent: null,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        saturatedCoreCount: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        usedBytes: null,
        cachedFilesBytes: null,
        swapUsedBytes: null,
        pressureSomePercent: null,
        pressureFullPercent: null,
        swapInBytesPerSecond: null,
        swapOutBytesPerSecond: null,
        majorPageFaultsPerSecond: null,
      },
      storage: {
        ioPressureSomePercent: null,
        ioPressureFullPercent: null,
        diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: null,
        diskLatencyMs: null,
        rootFilesystemAvailableBytes: null,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  }
}

function makeIngressSource(sourceId: string) {
  return {
    sourceId,
    sourceKind: sourceId,
    requests: null,
    responses2xx: null,
    responses3xx: null,
    responses4xx: null,
    responses5xx: null,
    requestErrors: null,
    requestBytes: null,
    responseBytes: null,
    requestDurationSecondsSum: null,
    bucket10ms: null,
    bucket50ms: null,
    bucket100ms: null,
    bucket500ms: null,
    bucket1s: null,
    bucket5s: null,
    requestsInFlight: null,
    upstreamsHealthy: null,
    upstreamsTotal: null,
    retries: null,
  }
}

test('managedIngressEnabled=false drops all ingress sources regardless of count', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
  }
  const sample = emptySample()
  sample.ingressSources = [makeIngressSource('caddy'), makeIngressSource('nginx')]
  const truncated = prepareSampleForStorage(sample, plan)
  assertEquals(truncated.ingressSources, [])
})

test('managedIngressEnabled=true keeps ingress sources', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: true,
  }
  const sample = emptySample()
  sample.ingressSources = [makeIngressSource('caddy')]
  const truncated = prepareSampleForStorage(sample, plan)
  assertEquals(
    truncated.ingressSources.map((s) => s.sourceId),
    ['caddy']
  )
})

function makeRouter() {
  return {
    backendsUp: 1,
    backendsTotal: 2,
    servicesTotal: 3,
    routersTotal: 4,
    retries: 0,
    backendErrors5xx: 0,
    backendLatencyMsAvg: 5,
    backendRequests: 10,
    httpOpenConnections: 2,
    configReloads: 1,
    configLastReloadAgeSeconds: 30,
    tlsCertSoonestExpiryDays: 60,
  }
}

test('managedIngressEnabled gates the router the same way it gates ingress sources', () => {
  const enabledSample = emptySample()
  enabledSample.router = makeRouter()
  const kept = prepareSampleForStorage(enabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: true,
  })
  assertEquals(kept.router, makeRouter())

  const disabledSample = emptySample()
  disabledSample.router = makeRouter()
  const dropped = prepareSampleForStorage(disabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
  })
  // Dropped by omitting the key, never by assigning `undefined` — a
  // present-but-undefined property is a different shape than an absent one.
  assertEquals(dropped.router, undefined)
  assertEquals(Object.hasOwn(dropped, 'router'), false)
})

function makeStorage() {
  const engine = {
    instancesRunning: null,
    instancesHealthy: null,
    connectionsUsed: null,
    connectionsMax: null,
  }
  return {
    hostingUsedBytes: 4096,
    backupUsedBytes: 2048,
    dockerUsedBytes: 8192,
    logsUsedBytes: 512,
    hostingFreeBytes: 1_000_000,
    backupFreeBytes: 2_000_000,
    logsFreeBytes: 3_000_000,
    postgres: { ...engine },
    mysql: { ...engine },
    mariadb: { ...engine },
  }
}

function makeDockerUsage() {
  return {
    layersBytes: 6000,
    imagesCount: 4,
    imagesReclaimableBytes: 1000,
    containersBytes: 1200,
    containersCount: 3,
    volumesBytes: 900,
    volumesCount: 2,
    volumesReclaimableBytes: 100,
    buildCacheBytes: 92,
    buildCacheReclaimableBytes: 92,
  }
}

test('managedDockerEnabled gates dockerUsage by omitting the key', () => {
  const enabledSample = emptySample()
  enabledSample.dockerUsage = makeDockerUsage()
  const kept = prepareSampleForStorage(enabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedDockerEnabled: true,
  })
  assertEquals(kept.dockerUsage, makeDockerUsage())

  const disabledSample = emptySample()
  disabledSample.dockerUsage = makeDockerUsage()
  const dropped = prepareSampleForStorage(disabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedDockerEnabled: false,
  })
  assertEquals(dropped.dockerUsage, undefined)
  assertEquals(Object.hasOwn(dropped, 'dockerUsage'), false)
})

test('storage is ungated and survives every flag being off', () => {
  const sample = emptySample()
  sample.storage = makeStorage()
  const truncated = prepareSampleForStorage(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    managedDockerEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
  assertEquals(truncated.storage, makeStorage())
})

test('the router and dockerUsage gates compose independently', () => {
  const sample = emptySample()
  sample.router = makeRouter()
  sample.dockerUsage = makeDockerUsage()
  sample.storage = makeStorage()
  const truncated = prepareSampleForStorage(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
    managedDockerEnabled: false,
  })
  assertEquals(Object.hasOwn(truncated, 'router'), false)
  assertEquals(Object.hasOwn(truncated, 'dockerUsage'), false)
  assertEquals(truncated.storage, makeStorage())
})

function makeDiagnostics() {
  return {
    cpu: {
      averageFrequencyMHz: null,
      minimumFrequencyMHz: null,
      maximumFrequencyMHz: null,
      contextSwitchesPerSecond: null,
      interruptsPerSecond: null,
      forksPerSecond: null,
      cpuIrqPercent: null,
    },
    memory: {
      memoryFreeBytes: null,
      cachedBytes: null,
      anonPagesBytes: null,
      slabReclaimableBytes: null,
      slabUnreclaimableBytes: null,
      dirtyBytes: null,
      writebackBytes: null,
      shmemBytes: null,
      committedAsBytes: null,
      pageScanDirectPerSecond: null,
      pageScanKswapdPerSecond: null,
      compactionStallsPerSecond: null,
    },
  }
}

test('diagnostics is ungated and always passes through untouched', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  }
  const sample = emptySample()
  const diagnostics = makeDiagnostics()
  sample.diagnostics = diagnostics
  const truncated = prepareSampleForStorage(sample, plan)
  assertEquals(truncated.diagnostics, diagnostics)
})

test('a root-tagged filesystem entry is dropped, never stored as an extra filesystem', () => {
  const sample = emptySample()
  sample.filesystems = [
    { filesystemId: 'fs-root', availableBytes: null, freeInodes: null },
    { filesystemId: 'fs-data', availableBytes: null, freeInodes: null },
    { filesystemId: 'fs-more', availableBytes: null, freeInodes: null },
  ]
  const slotMapping: SlotMapping = {
    normalNicSlots: [],
    fabricDeviceIds: [],
    rootFilesystemId: 'fs-root',
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
  }

  // Without a slot mapping there is nothing to identify as root.
  assertEquals(
    prepareSampleForStorage(sample, ALL_ON).filesystems.map((f) => f.filesystemId),
    ['fs-root', 'fs-data', 'fs-more']
  )
  // With one, the root entry goes and every other filesystem is kept: no count cuts.
  assertEquals(
    prepareSampleForStorage(sample, ALL_ON, slotMapping).filesystems.map((f) => f.filesystemId),
    ['fs-data', 'fs-more']
  )
})

test('devices are stored as reported: no count cap on drives, cards, GPUs or sensors', () => {
  const sample = emptySample()
  sample.blockDevices = Array.from({ length: 9 }, (_, i) => ({
    deviceId: `nvme${i}n1`,
    readBytesPerSecond: null,
    writeBytesPerSecond: null,
    readOpsPerSecond: null,
    writeOpsPerSecond: null,
    readLatencyMs: null,
    writeLatencyMs: null,
    utilizationPercent: null,
    queueDepth: 1,
  }))
  sample.networks = Array.from({ length: 6 }, (_, i) => ({
    deviceId: `eth${i}`,
    receiveBytesPerSecond: 1,
    transmitBytesPerSecond: 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }))
  const kept = prepareSampleForStorage(sample, ALL_ON)
  assertEquals(kept.blockDevices.length, 9)
  assertEquals(kept.networks.length, 6)
})

test('mesh interfaces are dropped only while their switch is off', () => {
  const sample = emptySample()
  const nic = (deviceId: string) => ({
    deviceId,
    receiveBytesPerSecond: 1,
    transmitBytesPerSecond: 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  })
  sample.networks = [nic('eth0'), nic('mesh0')]
  const slotMapping = {
    normalNicSlots: ['eth0'],
    fabricDeviceIds: ['mesh0'],
    rootFilesystemId: null,
  }
  assertEquals(
    prepareSampleForStorage(sample, ALL_ON, slotMapping).networks.map((n) => n.deviceId),
    ['eth0', 'mesh0']
  )
  assertEquals(
    prepareSampleForStorage(
      sample,
      { ...ALL_ON, turboFabricEnabled: false },
      slotMapping
    ).networks.map((n) => n.deviceId),
    ['eth0']
  )
})

test('databaseProxyMetricsEnabled and hardwareHealthEventsEnabled gate their arrays', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  }
  const sample = emptySample()
  sample.databaseProxies = [
    {
      sourceId: 'proxysql',
      sourceKind: 'proxysql',
      queries: null,
      slowQueries: null,
      queryLatencyMsAvg: null,
      backendLatencyMsAvg: null,
      activeTransactions: null,
      clientConnections: null,
      clientConnectionsCreated: null,
      clientConnectionsAborted: null,
      connectionsRejectedMaxConns: null,
      backendConnections: null,
      backendConnectionsCreated: null,
      backendConnectionsAborted: null,
      connectionErrors: null,
      backendsUp: null,
      backendsTotal: null,
      bytesFromBackends: null,
      bytesToBackends: null,
    },
  ]
  sample.events = [
    {
      eventId: 'evt-1',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'fan_fault',
      severity: 'critical',
    },
  ]
  const truncated = prepareSampleForStorage(sample, plan)
  assertEquals(truncated.databaseProxies, [])
  assertEquals(truncated.events, [])
})

test('hardwareHealthEventsEnabled=false drops only hardware-health event kinds', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    hardwareHealthEventsEnabled: false,
  }
  const sample = emptySample()
  sample.events = [
    {
      eventId: 'evt-hw',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'fan_fault',
      severity: 'critical',
    },
    {
      eventId: 'evt-oom',
      at: '2026-01-01T00:00:01.000Z',
      kind: 'oom_kill',
      severity: 'critical',
    },
    {
      eventId: 'evt-fabric',
      at: '2026-01-01T00:00:02.000Z',
      kind: 'fabric_unavailable',
      severity: 'warning',
    },
    {
      eventId: 'evt-clock',
      at: '2026-01-01T00:00:03.000Z',
      kind: 'clock_sync_lost',
      severity: 'warning',
    },
    {
      eventId: 'evt-topology',
      at: '2026-01-01T00:00:04.000Z',
      kind: 'topology_generation_changed',
      severity: 'info',
    },
    {
      eventId: 'evt-boot',
      at: '2026-01-01T00:00:05.000Z',
      kind: 'boot_generation_changed',
      severity: 'info',
    },
    {
      eventId: 'evt-remount',
      at: '2026-01-01T00:00:06.000Z',
      kind: 'fs_remount',
      severity: 'info',
    },
  ]

  const truncated = prepareSampleForStorage(sample, plan)
  assertEquals(
    truncated.events.map((event) => event.eventId),
    ['evt-oom', 'evt-fabric', 'evt-clock', 'evt-topology', 'evt-boot', 'evt-remount']
  )
})

test('hardwareHealthEventsEnabled=true keeps every event kind', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    hardwareHealthEventsEnabled: true,
  }
  const sample = emptySample()
  sample.events = [
    {
      eventId: 'evt-hw',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'fan_fault',
      severity: 'critical',
    },
    {
      eventId: 'evt-oom',
      at: '2026-01-01T00:00:01.000Z',
      kind: 'oom_kill',
      severity: 'critical',
    },
  ]

  const truncated = prepareSampleForStorage(sample, plan)
  assertEquals(
    truncated.events.map((event) => event.eventId),
    ['evt-hw', 'evt-oom']
  )
})

// ---------------------------------------------------------------------------
// networks truncation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Machine class
// ---------------------------------------------------------------------------
