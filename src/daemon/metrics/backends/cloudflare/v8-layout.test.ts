/**
 * Pins the v8 writer to the canonical layout fixture
 * (`../../testing/v8-layout.fixture.json`, spec `../../V8-LAYOUT.md`): for each
 * of the fixture's 240 plan x machine x hardware x service cases, a synthetic
 * sample is run through capability-plan truncation and the real data-point
 * builder, and the rows it writes (family, page, entity ids, folded filesystem,
 * embedded NICs) must be exactly the fixture's.
 */
import { assert, assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  type MetricsCapabilityPlan,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  truncateSampleToCapabilityPlan,
} from '../../../../contracts/capability-plan.ts'
import {
  buildMetricsSample,
  type MetricsSampleInput,
} from '../../../../contracts/metrics-contract.ts'
import fixtureJson from '../../testing/v8-layout.fixture.json' with { type: 'json' }
import type { AuthenticatedMetricsSample, SlotMapping } from '../../types.ts'
import {
  AE_BLOB_ENTITY_IDS_INDEX,
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_KIND_INDEX,
  AE_KIND_METRICS,
  AE_MISSING_METRIC_SENTINEL,
  buildMetricsDataPoints,
} from './field-map.ts'
import {
  V8_CONTENT_BLOB_CAPACITY,
  V8_ENTITIES_PER_PAGE,
  V8_ENTITY_FIELD_ORDER,
  V8_HOST_FAMILIES,
  V8_HOST_ROW_SPECS,
} from './v8-layout.ts'

type FixtureRow = { family: string; page?: number; entities?: string[] }
type FixtureCase = {
  id: string
  plan: string
  machine: 'vps' | 'phys'
  hardware: { nics: number; disks: number; gpus: number; fs: number }
  docker: boolean
  db: boolean
  embeddedNics: string[]
  foldedFilesystem: string | null
  rowCount: number
  rows: FixtureRow[]
}
type FixtureTemplate = {
  kind: string
  doubles: (string | null)[]
  blobs: string[]
  perPageEntities?: number
}
const fixture = fixtureJson as unknown as {
  planLimits: Record<
    string,
    {
      nicSlots: number
      driveSlots: number
      gpuSlots: number
      filesystemSlots: number
      sensorSignals: number
    }
  >
  families: Record<string, FixtureTemplate>
  cases: FixtureCase[]
}

const SERVER_ID = '11111111-2222-4333-8444-555555555555'

function names(kind: 'vps' | 'phys', hw: FixtureCase['hardware']) {
  const virt = kind === 'vps'
  const nics = Array.from({ length: hw.nics }, (_, i) => (virt ? `eth${i}` : `enp${5 + i}s0`))
  const disks = Array.from({ length: hw.disks }, (_, i) =>
    virt ? `vd${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ''}` : `nvme${i}n1`
  )
  const gpus = Array.from({ length: hw.gpus }, (_, i) => `gpu${i}`)
  const fs = Array.from({ length: hw.fs }, (_, i) => `/mnt/data${i + 1}`)
  const sensors = virt
    ? []
    : [
        'cpu.package',
        'cpu.hottest-core',
        'cpu.throttled',
        'cpu.power',
        'board',
        'chipset',
        ...disks,
        ...gpus.flatMap((g) => [`${g}:temp`, `${g}:memtemp`, `${g}:power`]),
      ]
  return { nics, disks, gpus, fs, sensors }
}

function engine(running: number | null) {
  return {
    instancesRunning: running,
    instancesHealthy: running,
    connectionsUsed: null,
    connectionsMax: null,
  }
}

function sampleFor(c: FixtureCase): MetricsSampleInput {
  const n = names(c.machine, c.hardware)
  const nulls = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]))
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
      cpu: nulls(['busyPercent']),
      kernel: {},
      memory: {},
      storage: {},
      network: {},
    } as unknown as MetricsSampleInput['host'],
    networks: n.nics.map((deviceId, i) => ({
      deviceId,
      receiveBytesPerSecond: 100 + i,
      transmitBytesPerSecond: 200 + i,
      receiveErrorsPerSecond: 0,
      transmitErrorsPerSecond: 0,
      receiveDropsPerSecond: 0,
      transmitDropsPerSecond: 0,
    })),
    filesystems: n.fs.map((filesystemId) => ({ filesystemId, availableBytes: 5, freeInodes: 6 })),
    blockDevices: n.disks.map((deviceId) => ({
      deviceId,
      readBytesPerSecond: 1,
      writeBytesPerSecond: 1,
      readOpsPerSecond: 1,
      writeOpsPerSecond: 1,
      readLatencyMs: 1,
      writeLatencyMs: 1,
      utilizationPercent: 1,
      queueDepth: 1,
    })),
    gpus: n.gpus.map((gpuId) => ({
      gpuId,
      utilizationPercent: 1,
      memoryUsedBytes: 1,
      memoryActivityPercent: 1,
      pcieReceiveBytesPerSecond: 1,
      pcieTransmitBytesPerSecond: 1,
      throttlePercent: 1,
    })),
    hardwareSignals: n.sensors.map((signalId) => ({ signalId, kind: 'temp', value: 1 })),
    ingressSources: [],
    databaseProxies: c.db
      ? [
          {
            sourceId: 'proxysql',
            sourceKind: 'proxysql',
            queries: 1,
          } as MetricsSampleInput['databaseProxies'][number],
        ]
      : [],
    events: [],
    ...(c.db
      ? {
          storage: {
            postgres: engine(1),
            mysql: engine(null),
            mariadb: engine(null),
          } as unknown as MetricsSampleInput['storage'],
        }
      : {}),
  }
}

function planFor(c: FixtureCase): MetricsCapabilityPlan {
  const limits = fixture.planLimits[c.plan]
  return {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    normalNicSlots: limits.nicSlots,
    extraFilesystemSlots: limits.filesystemSlots,
    detailedBlockDeviceSlots: limits.driveSlots,
    gpuSlots: limits.gpuSlots,
    physicalHardwareSignalSlots: limits.sensorSignals,
  }
}

function slotMappingFor(c: FixtureCase): SlotMapping {
  const n = names(c.machine, c.hardware)
  return {
    normalNicSlots: n.nics,
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: n.gpus,
    blockPageOrder: n.disks,
    filesystemPageOrder: n.fs,
    hardwareSignalPageOrder: n.sensors,
  }
}

function writtenRows(c: FixtureCase): {
  rows: FixtureRow[]
  points: ReturnType<typeof buildMetricsDataPoints>
} {
  const slotMapping = slotMappingFor(c)
  const built = buildMetricsSample(sampleFor(c))
  const truncated = truncateSampleToCapabilityPlan(built, planFor(c), slotMapping)
  const sample: AuthenticatedMetricsSample = { ...truncated, serverId: SERVER_ID, receivedAt: 'x' }
  const points = buildMetricsDataPoints(sample, slotMapping).filter(
    (p) => p.blobs[AE_BLOB_KIND_INDEX] === AE_KIND_METRICS
  )
  const pageOf = new Map<string, number>()
  const rows = points.map((p): FixtureRow => {
    const family = p.blobs[AE_BLOB_FAMILY_INDEX]
    if ((V8_HOST_FAMILIES as readonly string[]).includes(family)) return { family }
    const page = pageOf.get(family) ?? 0
    pageOf.set(family, page + 1)
    return { family, page, entities: p.blobs[AE_BLOB_ENTITY_IDS_INDEX].split(',') }
  })
  return { rows, points }
}

for (const c of fixture.cases) {
  it(`v8 writer matches the fixture: ${c.id}`, () => {
    const { rows, points } = writtenRows(c)
    assertEquals(rows, c.rows)
    assertEquals(rows.length, c.rowCount)

    const io = points.find((p) => p.blobs[AE_BLOB_FAMILY_INDEX] === 'host.io')
    const network = points.find((p) => p.blobs[AE_BLOB_FAMILY_INDEX] === 'host.network')
    assert(io && network)
    // Folded lone filesystem: its values sit in host.io's fs slots.
    const foldedSlot = V8_HOST_ROW_SPECS['host.io'].doubles.indexOf('fs_availableBytes')
    const folded = io.doubles[foldedSlot] !== AE_MISSING_METRIC_SENTINEL
    assertEquals(folded, c.foldedFilesystem !== null, 'folded filesystem slots')
    // Embedded NICs: first two slot-mapped NICs, in slot order, named in blob6.
    const named = network.blobs[AE_BLOB_ENTITY_IDS_INDEX]
    c.embeddedNics.forEach((nic, i) => {
      const index = names(c.machine, c.hardware).nics.indexOf(nic)
      const slot = V8_HOST_ROW_SPECS['host.network'].doubles.indexOf(`nic${i + 1}.rx`)
      assertEquals(network.doubles[slot], 100 + index, `embedded NIC ${i + 1}`)
      assert(named.includes(`nic${i + 1}=${nic}@`), `blob6 names NIC ${i + 1}`)
    })
    assertEquals(named.includes('fs='), c.foldedFilesystem !== null, 'blob6 names the folded disk')
  })
}

it('the host row specs are exactly the fixture templates (slot ids per double and blob)', () => {
  for (const family of V8_HOST_FAMILIES) {
    const template = fixture.families[family]
    assertEquals([...V8_HOST_ROW_SPECS[family].doubles], template.doubles, `${family} doubles`)
    assertEquals([...V8_HOST_ROW_SPECS[family].blobs], template.blobs, `${family} blobs`)
    assert(template.blobs.length <= V8_CONTENT_BLOB_CAPACITY)
  }
})

it('the entity row shapes match the fixture templates (width, entities per page)', () => {
  for (const family of ['block', 'network', 'filesystem', 'gpu'] as const) {
    const template = fixture.families[family]
    assertEquals(V8_ENTITY_FIELD_ORDER[family].length, template.doubles.length, `${family} width`)
    assertEquals(V8_ENTITIES_PER_PAGE[family], template.perPageEntities, `${family} per page`)
  }
  assertEquals(V8_ENTITY_FIELD_ORDER['hardware.physical'].length, 1)
  assertEquals(V8_ENTITIES_PER_PAGE['hardware.physical'], 19)
})
