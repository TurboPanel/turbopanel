/**
 * Round trip of every registered value through both editions.
 *
 * One sample with a distinct value in every field is written to the real
 * self-hosted store and to the hosted store (on the in-memory Analytics Engine
 * stand-in), then read back through the same `ServerMetricsStore` methods. Each
 * stored number must read back equal on both and equal to what was written;
 * each value neither edition stores must read as empty on both. The text facts
 * are compared at the places the registry names: the hosted text slot of the
 * data point and the self-hosted text column.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  METRICS_TEXT_FIELD_NAMES,
  type MetricsSampleInput,
} from '../../../../contracts/metrics-contract.ts'
import {
  DIAGNOSTICS_CPU_FIELD_NAMES,
  HOST_METRICS_METRIC_DESCRIPTORS,
  type HostMetricsMetricDescriptor,
} from '../../metric-descriptors.ts'
import {
  NOT_STORED_FIELD_IDS,
  REGISTRY_TABLES,
  STORED_FIELDS,
  type StoredField,
} from '../../field-registry.ts'
import { createFakeAnalyticsEngine } from '../../testing/fake-analytics-engine.ts'
import type { AuthenticatedMetricsSample, PerEntityHostedFamily, SlotMapping } from '../../types.ts'
import { openDuckDb, resolveDuckDbPaths } from '../duckdb/database.ts'
import { DuckDbParquetServerMetricsStore } from '../duckdb/store.ts'
import { AE_BLOB_FAMILY_INDEX } from './field-map.ts'
import { CloudflareAnalyticsEngineServerMetricsStore } from './store.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const AT_MS = Date.UTC(2026, 5, 2, 12, 0, 0)

type Bag = Record<string, unknown>

/** The next distinct reading: below 100 for 390 values, so percent fields are never clamped. */
function distinctValues(): () => number {
  let n = 0
  return () => 1 + (n++ % 390) * 0.25
}

const ENTITY_IDS: Readonly<Record<PerEntityHostedFamily, readonly string[]>> = {
  network: ['eth0', 'eth1', 'eth2'],
  filesystem: ['fs1', 'fs2'],
  block: ['sda', 'sdb'],
  gpu: ['gpu0'],
  'hardware.physical': ['sig0', 'sig1'],
  'managed.ingress': ['caddy'],
  'managed.database_proxy': ['proxysql'],
}

const ENTITY_SCOPE_FAMILY: Readonly<Record<string, PerEntityHostedFamily>> = {
  network: 'network',
  filesystem: 'filesystem',
  block: 'block',
  gpu: 'gpu',
  hardwareSignal: 'hardware.physical',
  ingress: 'managed.ingress',
  databaseProxy: 'managed.database_proxy',
}

/** Two embedded NICs; the third pages. */
const EMBEDDED_NICS = new Set(['eth0', 'eth1'])
const NIC_SPLIT_FIELDS = new Set([
  'receiveErrorsPerSecond',
  'transmitErrorsPerSecond',
  'receiveDropsPerSecond',
  'transmitDropsPerSecond',
])

type Built = {
  input: MetricsSampleInput
  /** `canonicalName` (host-wide) or `canonicalName@entityId` -> the number written. */
  written: Map<string, number>
}

function newEntities(family: PerEntityHostedFamily): Bag[] {
  return ENTITY_IDS[family].map((id) => {
    switch (family) {
      case 'network':
        return { deviceId: id }
      case 'filesystem':
        return { filesystemId: id }
      case 'block':
        return { deviceId: id }
      case 'gpu':
        return { gpuId: id }
      case 'hardware.physical':
        return { signalId: id, kind: id === 'sig0' ? 'temperature' : 'power' }
      default:
        return { sourceId: id, sourceKind: id }
    }
  })
}

function entityIdOf(entity: Bag): string {
  return String(
    entity.deviceId ?? entity.filesystemId ?? entity.gpuId ?? entity.signalId ?? entity.sourceId
  )
}

/** Where a host-wide descriptor's field lives in the sample. */
function hostWideTarget(
  descriptor: HostMetricsMetricDescriptor,
  groups: Record<string, Bag>
): { bag: Bag; key: string } {
  const { entityScope: scope, fieldName: field } = descriptor
  if (scope.startsWith('host.')) return { bag: groups[scope]!, key: field }
  if (scope === 'diagnostics') {
    const half = DIAGNOSTICS_CPU_FIELD_NAMES.includes(field)
      ? 'diagnostics.cpu'
      : 'diagnostics.memory'
    return { bag: groups[half]!, key: field }
  }
  if (scope === 'storage') {
    const engine = ['postgres', 'mysql', 'mariadb'].find((name) => field.startsWith(name))
    if (engine === undefined) return { bag: groups.storage!, key: field }
    const rest = field.slice(engine.length)
    return { bag: groups[`storage.${engine}`]!, key: rest[0]!.toLowerCase() + rest.slice(1) }
  }
  return { bag: groups[scope]!, key: field }
}

function buildSample(): Built {
  const next = distinctValues()
  const written = new Map<string, number>()
  const groups: Record<string, Bag> = {}
  for (const name of [
    'host.cpu',
    'host.kernel',
    'host.memory',
    'host.storage',
    'host.network',
    'diagnostics.cpu',
    'diagnostics.memory',
    'router',
    'storage',
    'storage.postgres',
    'storage.mysql',
    'storage.mariadb',
    'dockerUsage',
    'extended.host',
    'extended.docker',
    'extended.ingress',
    'extended.sizes',
  ]) {
    groups[name] = {}
  }
  const entities = Object.fromEntries(
    (Object.keys(ENTITY_IDS) as PerEntityHostedFamily[]).map((family) => [
      family,
      newEntities(family),
    ])
  ) as Record<PerEntityHostedFamily, Bag[]>

  for (const descriptor of Object.values(HOST_METRICS_METRIC_DESCRIPTORS)) {
    if (descriptor.wire === false) continue
    const family = ENTITY_SCOPE_FAMILY[descriptor.entityScope]
    if (family === undefined) {
      const value = next()
      const { bag, key } = hostWideTarget(descriptor, groups)
      bag[key] = value
      written.set(descriptor.canonicalName, value)
      continue
    }
    for (const entity of entities[family]) {
      const value = next()
      entity[descriptor.fieldName] = value
      written.set(`${descriptor.canonicalName}@${entityIdOf(entity)}`, value)
    }
  }
  // A drive's combined operations per second is the sum of its two halves.
  for (const drive of entities.block) {
    const sum = (drive.readOpsPerSecond as number) + (drive.writeOpsPerSecond as number)
    written.set(`block.opsPerSecond@${entityIdOf(drive)}`, sum)
  }

  const text = Object.fromEntries(METRICS_TEXT_FIELD_NAMES.map((key) => [key, `text-${key}`]))
  const input = {
    metadata: {
      version: 8,
      sampledAt: new Date(AT_MS).toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: groups['host.cpu'],
      kernel: groups['host.kernel'],
      memory: groups['host.memory'],
      storage: groups['host.storage'],
      network: groups['host.network'],
    },
    diagnostics: { cpu: groups['diagnostics.cpu'], memory: groups['diagnostics.memory'] },
    networks: entities.network,
    filesystems: entities.filesystem,
    blockDevices: entities.block,
    gpus: entities.gpu,
    hardwareSignals: entities['hardware.physical'],
    ingressSources: entities['managed.ingress'],
    databaseProxies: entities['managed.database_proxy'],
    router: groups.router,
    storage: {
      ...groups.storage,
      postgres: groups['storage.postgres'],
      mysql: groups['storage.mysql'],
      mariadb: groups['storage.mariadb'],
    },
    dockerUsage: groups.dockerUsage,
    events: [],
    extended: {
      host: groups['extended.host'],
      docker: groups['extended.docker'],
      ingress: groups['extended.ingress'],
      sizes: groups['extended.sizes'],
      text,
      blockDeviceText: ENTITY_IDS.block.map((id) => ({
        deviceId: id,
        model: `model-${id}`,
        smart: `smart-${id}`,
      })),
      gpuText: [{ gpuId: 'gpu0', driver: 'driver-gpu0', model: 'model-gpu0' }],
      gpuSizes: [{ gpuId: 'gpu0', memoryTotalBytes: 8_000_000 }],
      networkSizes: ENTITY_IDS.network.map((id, i) => ({ deviceId: id, linkSpeedMbps: 1000 + i })),
      filesystemSizes: ENTITY_IDS.filesystem.map((id, i) => ({
        filesystemId: id,
        totalBytes: 5_000 + i,
        totalInodes: 600 + i,
      })),
    },
  } as unknown as MetricsSampleInput
  return { input, written }
}

const SLOT_MAPPING: SlotMapping = {
  normalNicSlots: ['eth0', 'eth1', 'eth2'],
  fabricDeviceIds: [],
  rootFilesystemId: null,
  gpuPageOrder: ['gpu0'],
  blockPageOrder: ['sda', 'sdb'],
  filesystemPageOrder: ['fs1', 'fs2'],
  hardwareSignalPageOrder: ['sig0', 'sig1'],
}

/** What a reader must answer for this value: the number written, or empty. */
function expectedReading(
  descriptor: HostMetricsMetricDescriptor,
  entityId: string | null,
  written: Map<string, number>
): number | null {
  if (NOT_STORED_FIELD_IDS.has(descriptor.canonicalName)) return null
  // A NIC embedded in a host row keeps its errors and drops only as their sum.
  if (
    descriptor.entityScope === 'network' &&
    entityId !== null &&
    EMBEDDED_NICS.has(entityId) &&
    NIC_SPLIT_FIELDS.has(descriptor.fieldName)
  ) {
    return null
  }
  const key =
    entityId === null ? descriptor.canonicalName : `${descriptor.canonicalName}@${entityId}`
  return written.get(key) ?? null
}

type Stores = {
  duck: DuckDbParquetServerMetricsStore
  ae: CloudflareAnalyticsEngineServerMetricsStore
}

const RANGE = {
  from: new Date(AT_MS - 60_000).toISOString(),
  to: new Date(AT_MS + 60_000).toISOString(),
  resolutionSeconds: 60,
}

async function readHostWide(stores: Stores, ids: string[]) {
  const query = { serverId: SERVER_ID, metrics: ids, ...RANGE }
  const [duck, ae] = await Promise.all([
    stores.duck.queryHostSeries(query),
    stores.ae.queryHostSeries(query),
  ])
  return { duck: duck.points[0]?.values ?? {}, ae: ae.points[0]?.values ?? {} }
}

async function readEntities(stores: Stores, family: PerEntityHostedFamily, fields: string[]) {
  const query = {
    serverId: SERVER_ID,
    family,
    entityIds: ENTITY_IDS[family],
    metrics: fields,
    ...RANGE,
  }
  const [duck, ae] = await Promise.all([
    stores.duck.queryEntitySeries(query),
    stores.ae.queryEntitySeries(query),
  ])
  const byEntity = (result: typeof duck) =>
    new Map(result.entities.map((entity) => [entity.entityId, entity.points[0]?.values ?? {}]))
  return { duck: byEntity(duck), ae: byEntity(ae) }
}

function hostWideDescriptors(): HostMetricsMetricDescriptor[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS).filter(
    (d) => ENTITY_SCOPE_FAMILY[d.entityScope] === undefined && d.wire !== false
  )
}

function entityDescriptors(family: PerEntityHostedFamily): HostMetricsMetricDescriptor[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS).filter(
    (d) => ENTITY_SCOPE_FAMILY[d.entityScope] === family
  )
}

/** Text as the hosted data point carries it, found by the registry's own row and slot. */
function hostedHostText(points: { blobs?: string[] }[], field: StoredField): string | undefined {
  const home = field.hosted
  if (!('blob' in home)) return undefined
  return points.find((p) => p.blobs?.[AE_BLOB_FAMILY_INDEX] === home.row)?.blobs?.[home.blob - 1]
}

it('every stored number reads back the same on both editions; every unstored one reads empty', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-registry-round-trip-' })
  const duck = new DuckDbParquetServerMetricsStore({ metricsDir }, { writeBatchMaxRows: 1 })
  const fakeAe = await createFakeAnalyticsEngine()
  const recorded: { blobs?: string[] }[] = []
  const ae = new CloudflareAnalyticsEngineServerMetricsStore(
    {
      writeDataPoint(event) {
        recorded.push(event)
        fakeAe.dataset.writeDataPoint(event)
      },
    },
    { sql: fakeAe.sqlConfig }
  )
  try {
    const { input, written } = buildSample()
    const sample: AuthenticatedMetricsSample = {
      ...buildMetricsSample(input),
      serverId: SERVER_ID,
      receivedAt: input.metadata.sampledAt,
    }
    await duck.writeSample(sample, SLOT_MAPPING)
    fakeAe.setNow(AT_MS)
    ae.writeSample(sample, SLOT_MAPPING)
    const stores = { duck, ae }

    // Every stored number is compared (a read that is empty on both sides proves nothing).
    let compared = 0
    // Host-wide readings.
    const hostWide = hostWideDescriptors()
    const hostRead = await readHostWide(
      stores,
      hostWide.map((d) => d.canonicalName)
    )
    for (const d of hostWide) {
      const want = expectedReading(d, null, written)
      if (want !== null) compared++
      assertEquals(hostRead.ae[d.canonicalName] ?? null, want, `hosted ${d.canonicalName}`)
      assertEquals(hostRead.duck[d.canonicalName] ?? null, want, `self-hosted ${d.canonicalName}`)
    }

    // Per-device readings.
    for (const family of Object.keys(ENTITY_IDS) as PerEntityHostedFamily[]) {
      const descriptors = entityDescriptors(family)
      const read = await readEntities(
        stores,
        family,
        descriptors.map((d) => d.fieldName)
      )
      for (const entityId of ENTITY_IDS[family]) {
        for (const d of descriptors) {
          const want = expectedReading(d, entityId, written)
          if (want !== null) compared++
          const label = `${d.canonicalName} on ${entityId}`
          assertEquals(read.ae.get(entityId)?.[d.fieldName] ?? null, want, `hosted ${label}`)
          assertEquals(read.duck.get(entityId)?.[d.fieldName] ?? null, want, `self-hosted ${label}`)
        }
      }
    }

    // 61 host-wide readings, plus the device readings (NICs 1 and 2 keep two of six each).
    assertEquals(compared, 118)

    // Host facts: the hosted text slot and the self-hosted column hold the same text.
    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      const textRow = (
        await handle.connection.runAndReadAll(`SELECT * FROM ${REGISTRY_TABLES.hostText}`)
      ).getRowObjectsJS()[0]!
      for (const field of STORED_FIELDS.filter((f) => f.id.startsWith('text.'))) {
        const key = field.id.slice('text.'.length)
        assertEquals(textRow[field.duckdb.column], `text-${key}`, `self-hosted ${field.id}`)
        assertEquals(hostedHostText(recorded, field), `text-${key}`, `hosted ${field.id}`)
      }
      const blockRows = (
        await handle.connection.runAndReadAll(
          `SELECT device_id, model, smart FROM ${REGISTRY_TABLES.block} ORDER BY device_id`
        )
      ).getRowObjectsJS()
      assertEquals(blockRows, [
        { device_id: 'sda', model: 'model-sda', smart: 'smart-sda' },
        { device_id: 'sdb', model: 'model-sdb', smart: 'smart-sdb' },
      ])
    } finally {
      handle.close()
    }
  } finally {
    await duck.close()
    await fakeAe.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})
