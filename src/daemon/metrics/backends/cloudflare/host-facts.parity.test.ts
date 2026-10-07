/**
 * Latest host facts on both stores: the text a v7 sample carries beside its
 * numbers (kernel, OS, versions, a drive's model and SMART verdict, a GPU's
 * driver, model and memory size, each filesystem's size and each NIC's link speed) is written through the real DuckDB store and the real
 * hosted writer, then read back with `queryHostFacts` and compared.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  type MetricsExtended,
  type MetricsSampleInput,
} from '../../../../contracts/metrics-contract.ts'
import { emptyHostFacts, hostFactsFromSample } from '../../query/host-facts.ts'
import type { AuthenticatedMetricsSample, HostFactsResult, SlotMapping } from '../../types.ts'
import { DuckDbParquetServerMetricsStore } from '../duckdb/store.ts'
import { CloudflareAnalyticsEngineServerMetricsStore } from './store.ts'
import { createFakeAnalyticsEngine } from '../../testing/fake-analytics-engine.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_SERVER_ID = '99999999-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 9, 5, 12, 0, 0)

const DRIVES = ['disk:a', 'disk:b', 'disk:c', 'disk:d']
const GPUS = ['gpu:0', 'gpu:1', 'gpu:2', 'gpu:3']

function drive(deviceId: string) {
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

function gpu(gpuId: string) {
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

const slotMapping: SlotMapping = {
  normalNicSlots: [],
  fabricDeviceIds: [],
  rootFilesystemId: null,
  gpuPageOrder: GPUS,
  blockPageOrder: DRIVES,
  filesystemPageOrder: [],
  hardwareSignalPageOrder: [],
}

function input(atMs: number, serverExtended: MetricsExtended | undefined): MetricsSampleInput {
  return {
    metadata: {
      version: serverExtended ? 7 : 6,
      sampledAt: new Date(atMs).toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: 10,
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
    blockDevices: DRIVES.map(drive),
    gpus: GPUS.map(gpu),
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    // A managed database makes the `managed.database` row exist (it carries `dbVersions`).
    storage: {
      hostingUsedBytes: null,
      backupUsedBytes: null,
      dockerUsedBytes: null,
      logsUsedBytes: null,
      hostingFreeBytes: null,
      backupFreeBytes: null,
      logsFreeBytes: null,
      postgres: {
        instancesRunning: 1,
        instancesHealthy: 1,
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
    ...(serverExtended ? { extended: serverExtended } : {}),
  }
}

const FULL_FACTS: MetricsExtended = {
  text: {
    loadavg: '0.10 0.20 0.30',
    topCpu: 'php-fpm',
    kernel: '6.8.0-45-generic',
    os: 'Ubuntu 24.04.1 LTS',
    unhealthyContainers: 'web-1',
    caddyVersion: 'v2.11.4',
    fpmBusiest: 'site-7',
    dbVersions: 'postgres 16.4',
  },
  blockDeviceText: [
    { deviceId: 'disk:a', model: 'Samsung SSD 990 PRO 1TB', smart: 'passed' },
    // Only a model: a missing half is simply absent.
    { deviceId: 'disk:b', model: 'WDC WD40EFRX' },
    { deviceId: 'disk:d', smart: 'failing' },
  ],
  gpuText: [
    { gpuId: 'gpu:0', driver: '570.86.15', model: 'NVIDIA RTX 4000' },
    { gpuId: 'gpu:3', model: 'NVIDIA T4' },
  ],
}

function sampleAt(
  atMs: number,
  extended: MetricsExtended | undefined,
  serverId = SERVER_ID
): AuthenticatedMetricsSample {
  const built = buildMetricsSample(input(atMs, extended))
  return { ...built, serverId, receivedAt: built.metadata.sampledAt }
}

function sortFacts(result: HostFactsResult): HostFactsResult {
  return {
    ...result,
    facts: {
      ...result.facts,
      blockDevices: [...result.facts.blockDevices].sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId)
      ),
      gpus: [...result.facts.gpus].sort((a, b) => a.gpuId.localeCompare(b.gpuId)),
      filesystems: [...result.facts.filesystems].sort((a, b) =>
        a.filesystemId.localeCompare(b.filesystemId)
      ),
      networks: [...result.facts.networks].sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
    },
  }
}

it('host facts: both stores return the newest sample facts, drop what disappears, and keep servers apart', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-host-facts-' })
  const duckStore = new DuckDbParquetServerMetricsStore({ metricsDir }, { writeBatchMaxRows: 1 })
  const fakeAe = await createFakeAnalyticsEngine()
  const aeStore = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  const write = async (sample: AuthenticatedMetricsSample, atMs: number) => {
    await duckStore.writeSample(sample)
    fakeAe.setNow(atMs)
    aeStore.writeSample(sample, slotMapping)
  }
  const window = {
    from: new Date(BASE_MS - 3_600_000).toISOString(),
    to: new Date(BASE_MS + 3_600_000).toISOString(),
  }
  const both = async (serverId = SERVER_ID) => {
    const query = { serverId, ...window }
    return [
      sortFacts(await duckStore.queryHostFacts(query)),
      sortFacts(await aeStore.queryHostFacts(query)),
    ] as const
  }
  try {
    // Nothing written yet: no sample, no facts, on both.
    for (const result of await both()) {
      assertEquals(result.sampledAt, null)
      assertEquals(result.facts, emptyHostFacts())
    }

    const first = sampleAt(BASE_MS, FULL_FACTS)
    await write(first, BASE_MS)
    await write(sampleAt(BASE_MS, { text: { kernel: 'other server' } }, OTHER_SERVER_ID), BASE_MS)
    const expected = hostFactsFromSample(first)
    assertEquals(expected.blockDevices.length, 3)
    assertEquals(expected.gpus.length, 2)
    const [duck1, ae1] = await both()
    for (const [label, result] of [
      ['duckdb', duck1],
      ['hosted', ae1],
    ] as const) {
      assertEquals(result.sampledAt, new Date(BASE_MS).toISOString(), `${label} sampledAt`)
      assertEquals(result.facts.text, expected.text, `${label} text`)
      assertEquals(result.facts.blockDevices, expected.blockDevices, `${label} drives`)
      assertEquals(result.facts.gpus, expected.gpus, `${label} gpus`)
    }
    assertEquals(duck1.facts.text.kernel, '6.8.0-45-generic')
    assertEquals(
      duck1.facts.blockDevices.find((d) => d.deviceId === 'disk:b'),
      { deviceId: 'disk:b', model: 'WDC WD40EFRX' }
    )

    // The other server only ever sees its own facts.
    for (const result of await both(OTHER_SERVER_ID)) {
      assertEquals(result.facts.text, { kernel: 'other server' })
    }

    // A newer sample replaces the older one: the drives and GPUs it no longer
    // reports are gone, and the kernel text has moved on.
    const secondAt = BASE_MS + 60_000
    await write(sampleAt(secondAt, { text: { kernel: '6.8.0-50-generic' } }), secondAt)
    for (const result of await both()) {
      assertEquals(result.sampledAt, new Date(secondAt).toISOString())
      assertEquals(result.facts, { ...emptyHostFacts(), text: { kernel: '6.8.0-50-generic' } })
    }

    // A late-arriving older sample never wins over the newer one.
    await write(sampleAt(BASE_MS - 60_000, FULL_FACTS), BASE_MS - 60_000)
    for (const result of await both()) {
      assertEquals(result.facts.text, { kernel: '6.8.0-50-generic' })
    }

    // A sample outside the window is not "latest": both answer none.
    const farFuture = {
      from: new Date(BASE_MS + 7_200_000).toISOString(),
      to: new Date(BASE_MS + 10_800_000).toISOString(),
    }
    for (const result of [
      await duckStore.queryHostFacts({ serverId: SERVER_ID, ...farFuture }),
      await aeStore.queryHostFacts({ serverId: SERVER_ID, ...farFuture }),
    ]) {
      assertEquals(result.sampledAt, null)
      assertEquals(result.facts.text, {})
    }
  } finally {
    await duckStore.close()
    await fakeAe.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})

function nic(deviceId: string) {
  return {
    deviceId,
    receiveBytesPerSecond: 1,
    transmitBytesPerSecond: 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }
}

it("host facts: each device's own size (filesystem bytes and inodes, GPU memory, NIC link speed) reads the same on both stores", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-host-facts-sizes-' })
  const duckStore = new DuckDbParquetServerMetricsStore({ metricsDir }, { writeBatchMaxRows: 1 })
  const fakeAe = await createFakeAnalyticsEngine()
  const aeStore = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    const extended: MetricsExtended = {
      gpuText: [{ gpuId: 'gpu:0', model: 'NVIDIA RTX 4000' }],
      gpuSizes: [
        { gpuId: 'gpu:0', memoryTotalBytes: 20_000_000_000 },
        // A size with no text still lists the GPU.
        { gpuId: 'gpu:1', memoryTotalBytes: 8_000_000_000 },
      ],
      // The first two NICs are the ones the hosted layout embeds in `host.network`; the rest page.
      networkSizes: [
        { deviceId: 'eth0', linkSpeedMbps: 10_000 },
        { deviceId: 'eth1', linkSpeedMbps: 1_000 },
        { deviceId: 'eth2', linkSpeedMbps: 25_000 },
        // No speed reported: the NIC is simply not listed.
        { deviceId: 'eth3' },
      ],
      filesystemSizes: [
        { filesystemId: 'fs:a', totalBytes: 500_000_000_000, totalInodes: 30_000_000 },
        { filesystemId: 'fs:b', totalBytes: 100_000_000_000 },
        { filesystemId: 'fs:c', totalInodes: 9_000_000 },
        { filesystemId: 'fs:d' },
      ],
    }
    const base = input(BASE_MS, extended)
    const sample: AuthenticatedMetricsSample = {
      ...buildMetricsSample({
        ...base,
        networks: ['eth0', 'eth1', 'eth2', 'eth3'].map(nic),
        filesystems: ['fs:a', 'fs:b', 'fs:c', 'fs:d'].map((filesystemId) => ({
          filesystemId,
          availableBytes: 1,
          freeInodes: 1,
        })),
      }),
      serverId: SERVER_ID,
      receivedAt: new Date(BASE_MS).toISOString(),
    }
    await duckStore.writeSample(sample)
    fakeAe.setNow(BASE_MS)
    aeStore.writeSample(sample, slotMapping)

    const query = {
      serverId: SERVER_ID,
      from: new Date(BASE_MS - 3_600_000).toISOString(),
      to: new Date(BASE_MS + 3_600_000).toISOString(),
    }
    const expected = hostFactsFromSample(sample)
    assertEquals(expected.networks.length, 3)
    assertEquals(expected.filesystems.length, 3)
    assertEquals(
      expected.gpus.find((g) => g.gpuId === 'gpu:1'),
      {
        gpuId: 'gpu:1',
        memoryTotalBytes: 8_000_000_000,
      }
    )
    for (const [label, result] of [
      ['duckdb', sortFacts(await duckStore.queryHostFacts(query))],
      ['hosted', sortFacts(await aeStore.queryHostFacts(query))],
    ] as const) {
      const sorted = sortFacts({ ...result, facts: expected }).facts
      assertEquals(result.facts.networks, sorted.networks, `${label} NIC link speeds`)
      assertEquals(result.facts.filesystems, sorted.filesystems, `${label} filesystem sizes`)
      assertEquals(
        result.facts.gpus.map((g) => [g.gpuId, g.memoryTotalBytes]),
        sorted.gpus.map((g) => [g.gpuId, g.memoryTotalBytes]),
        `${label} GPU memory`
      )
    }
  } finally {
    await duckStore.close()
    await fakeAe.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})
