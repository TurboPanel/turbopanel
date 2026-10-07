/**
 * Metrics v7 readers: every v7 number can be queried back, on both backends.
 *
 * The same logical samples go through the self-hosted store (DuckDB) and the
 * hosted store (the real Analytics Engine writer and the real SQL builders,
 * executed against the in-memory stand-in dataset), then the v7 canonical names
 * are read with `queryHostSeries` / `queryEntitySeries`. Values are pinned, not
 * just compared, so two backends resolving the same wrong slot still fail.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  type MetricsSampleInput,
} from '../../../../contracts/metrics-contract.ts'
import type { AuthenticatedMetricsSample, SlotMapping } from '../../types.ts'
import { DuckDbParquetServerMetricsStore } from '../duckdb/store.ts'
import { CloudflareAnalyticsEngineServerMetricsStore } from './store.ts'
import { createFakeAnalyticsEngine } from '../../testing/fake-analytics-engine.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 9, 5)
const INTERVAL_SECONDS = 60

const V7_HOST_METRICS = [
  'extended.host.pidLimitUsedPercent',
  'extended.host.oomKills',
  'extended.host.rootDiskQueueDepth',
  'extended.host.rootDiskOpsPerSecond',
  'extended.host.systemdUnitsFailed',
  'extended.host.mdArraysDegraded',
  'extended.docker.containersRunning',
  'extended.docker.containersUnhealthy',
  'extended.docker.containersRestarting',
  'extended.docker.containerOomEvents',
  'extended.docker.containerDieEvents',
  'extended.docker.containersCpuPercent',
  'extended.docker.containersMemoryBytes',
  'extended.docker.reclaimableBytes',
  'extended.ingress.tlsCertSoonestExpiryDays',
  'extended.sizes.memoryTotalBytes',
  'extended.sizes.swapTotalBytes',
  'extended.sizes.commitLimitBytes',
  'extended.sizes.logicalCores',
  'extended.sizes.rootFilesystemTotalBytes',
  'extended.sizes.rootFilesystemTotalInodes',
] as const

const slotMapping: SlotMapping = {
  normalNicSlots: [],
  fabricDeviceIds: [],
  rootFilesystemId: null,
  gpuPageOrder: ['gpu0'],
  blockPageOrder: ['sda', 'sdb'],
  filesystemPageOrder: ['fs-a', 'fs-b'],
  hardwareSignalPageOrder: [],
}

function drive(deviceId: string, readOps: number | null, writeOps: number | null) {
  return {
    deviceId,
    readBytesPerSecond: 1,
    writeBytesPerSecond: 1,
    readOpsPerSecond: readOps,
    writeOpsPerSecond: writeOps,
    readLatencyMs: 1,
    writeLatencyMs: 1,
    utilizationPercent: 1,
    queueDepth: 1,
  }
}

function input(atMs: number, withExtended: boolean): MetricsSampleInput {
  return {
    metadata: {
      version: withExtended ? 7 : 6,
      sampledAt: new Date(atMs).toISOString(),
      intervalSeconds: INTERVAL_SECONDS,
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
    filesystems: [
      { filesystemId: 'fs-a', availableBytes: 10, freeInodes: 20 },
      { filesystemId: 'fs-b', availableBytes: 30, freeInodes: 40 },
    ],
    // sda reports both halves; sdb is missing one, so its combined figure is a gap.
    blockDevices: [drive('sda', 100, 50), drive('sdb', 7, null)],
    gpus: [
      {
        gpuId: 'gpu0',
        utilizationPercent: 5,
        memoryUsedBytes: 4_000,
        memoryActivityPercent: null,
        pcieReceiveBytesPerSecond: null,
        pcieTransmitBytesPerSecond: null,
        throttlePercent: null,
      },
    ],
    hardwareSignals: [],
    ingressSources: [
      {
        sourceId: 'caddy',
        sourceKind: 'caddy',
        requests: 5,
        responses2xx: 5,
        responses3xx: 0,
        responses4xx: 0,
        responses5xx: 0,
        requestErrors: 0,
        requestBytes: 1,
        responseBytes: 1,
        requestDurationSecondsSum: 0.1,
        bucket10ms: 0,
        bucket50ms: 0,
        bucket100ms: 5,
        bucket500ms: 5,
        bucket1s: 5,
        bucket5s: 5,
        requestsInFlight: 1,
        upstreamsHealthy: 1,
        upstreamsTotal: 1,
        retries: 0,
      },
    ],
    databaseProxies: [],
    events: [],
    dockerUsage: {
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
    },
    ...(withExtended
      ? {
          extended: {
            host: {
              pidLimitUsedPercent: 12.5,
              oomKills: 2,
              rootDiskQueueDepth: 3,
              rootDiskOpsPerSecond: 410,
              systemdUnitsFailed: 1,
              mdArraysDegraded: 0,
              mdArraysResyncing: 0,
            },
            docker: {
              containersRunning: 7,
              containersUnhealthy: 1,
              containersRestarting: 0,
              containerOomEvents: 1,
              containerDieEvents: 4,
              containersCpuPercent: 33,
              containersMemoryBytes: 5_000_000,
              reclaimableBytes: 4242,
            },
            ingress: { tlsCertSoonestExpiryDays: 21 },
            sizes: {
              memoryTotalBytes: 8_000_000_000,
              swapTotalBytes: 2_000_000_000,
              commitLimitBytes: 6_000_000_000,
              logicalCores: 4,
              rootFilesystemTotalBytes: 100_000_000_000,
              rootFilesystemTotalInodes: 6_000_000,
            },
            filesystemSizes: [
              // Out of page order: the size is matched to its filesystem by id.
              { filesystemId: 'fs-b', totalBytes: 2_000, totalInodes: 400 },
              { filesystemId: 'fs-a', totalBytes: 1_000, totalInodes: 200 },
            ],
            gpuSizes: [{ gpuId: 'gpu0', memoryTotalBytes: 16_000 }],
          },
        }
      : {}),
  }
}

function sampleAt(atMs: number, withExtended: boolean): AuthenticatedMetricsSample {
  const built = buildMetricsSample(input(atMs, withExtended))
  return { ...built, serverId: SERVER_ID, receivedAt: built.metadata.sampledAt }
}

type SeriesResult = { points: { at: string; values: Partial<Record<string, number | null>> }[] }

function valueAt(result: SeriesResult, atMs: number, metric: string): number | null {
  const at = new Date(atMs).toISOString()
  return result.points.find((point) => point.at === at)?.values[metric] ?? null
}

it('every v7 number reads back on DuckDB and on the hosted store, and a v6 sample leaves gaps', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-v7-readers-' })
  const duckStore = new DuckDbParquetServerMetricsStore({ metricsDir }, { writeBatchMaxRows: 1 })
  const fakeAe = await createFakeAnalyticsEngine()
  const aeStore = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    const v7At = BASE_MS
    const v6At = BASE_MS + INTERVAL_SECONDS * 1000
    for (const [atMs, withExtended] of [
      [v7At, true],
      [v6At, false],
    ] as const) {
      const sample = sampleAt(atMs, withExtended)
      await duckStore.writeSample(sample)
      fakeAe.setNow(atMs)
      aeStore.writeSample(sample, slotMapping)
    }
    const range = {
      serverId: SERVER_ID,
      from: new Date(BASE_MS - 60_000).toISOString(),
      to: new Date(v6At + 120_000).toISOString(),
      resolutionSeconds: INTERVAL_SECONDS,
    }

    const expected: Record<string, number> = {
      'extended.host.pidLimitUsedPercent': 12.5,
      'extended.host.oomKills': 2,
      'extended.host.rootDiskQueueDepth': 3,
      'extended.host.rootDiskOpsPerSecond': 410,
      'extended.host.systemdUnitsFailed': 1,
      'extended.host.mdArraysDegraded': 0,
      'extended.docker.containersRunning': 7,
      'extended.docker.containersUnhealthy': 1,
      'extended.docker.containersRestarting': 0,
      'extended.docker.containerOomEvents': 1,
      'extended.docker.containerDieEvents': 4,
      'extended.docker.containersCpuPercent': 33,
      'extended.docker.containersMemoryBytes': 5_000_000,
      'extended.docker.reclaimableBytes': 4242,
      'extended.ingress.tlsCertSoonestExpiryDays': 21,
      'extended.sizes.memoryTotalBytes': 8_000_000_000,
      'extended.sizes.swapTotalBytes': 2_000_000_000,
      'extended.sizes.commitLimitBytes': 6_000_000_000,
      'extended.sizes.logicalCores': 4,
      'extended.sizes.rootFilesystemTotalBytes': 100_000_000_000,
      'extended.sizes.rootFilesystemTotalInodes': 6_000_000,
    }
    const duck = await duckStore.queryHostSeries({ ...range, metrics: [...V7_HOST_METRICS] })
    const ae = await aeStore.queryHostSeries({ ...range, metrics: [...V7_HOST_METRICS] })
    for (const metric of V7_HOST_METRICS) {
      assertEquals(valueAt(duck, v7At, metric), expected[metric], `duckdb ${metric}`)
      assertEquals(valueAt(ae, v7At, metric), expected[metric], `hosted ${metric}`)
    }

    // A v6 daemon sends no `extended` section: every v7 number is a gap on
    // both backends (never a 0), except Docker's reclaimable bytes, which both
    // fall back to the sum of the three reclaimable groups of the disk breakdown.
    for (const metric of V7_HOST_METRICS) {
      const fallback = metric === 'extended.docker.reclaimableBytes' ? 1000 + 100 + 92 : null
      assertEquals(valueAt(duck, v6At, metric), fallback, `duckdb v6 ${metric}`)
      assertEquals(valueAt(ae, v6At, metric), fallback, `hosted v6 ${metric}`)
    }

    // A drive's combined ops/s: read plus write, a gap when either half is missing.
    const opsQuery = {
      ...range,
      family: 'block' as const,
      entityIds: ['sda', 'sdb'],
      metrics: ['opsPerSecond'],
    }
    const duckOps = await duckStore.queryEntitySeries(opsQuery)
    const aeOps = await aeStore.queryEntitySeries(opsQuery)
    for (const [label, result] of [
      ['duckdb', duckOps],
      ['hosted', aeOps],
    ] as const) {
      const sda = result.entities.find((entity) => entity.entityId === 'sda')!
      const sdb = result.entities.find((entity) => entity.entityId === 'sdb')!
      assertEquals(sda.points[0]!.values.opsPerSecond, 150, `${label} sda ops/s`)
      assertEquals(sdb.points[0]!.values.opsPerSecond ?? null, null, `${label} sdb ops/s`)
    }
  } finally {
    await duckStore.close()
    await fakeAe.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})
