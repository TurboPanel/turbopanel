/**
 * Metrics v7 slot layout: the static row table the Analytics Engine writer
 * packs and the read path resolves against. It is the code twin of the
 * canonical layout spec (`../../V7-LAYOUT.md`, `../../testing/v7-layout.fixture.json`);
 * `v7-layout.test.ts` pins every row below to that fixture.
 *
 * Every slot is named by its catalogue id (`busy`, `oomKills`, `nic1.rx`, ...).
 * This module maps each id to the `MetricsSample` field behind it. It is pure
 * (no AE constants, no I/O) so `field-map.ts` can own the envelope and the
 * sentinel while this file owns "which value goes where".
 *
 * A sample from a v6 daemon has no `extended` section: every slot that reads
 * it simply resolves to `null` / empty text, and the row is still written.
 */

import type {
  BlockDeviceSample,
  DatabaseProxySample,
  FilesystemSample,
  GpuSample,
  HardwareSignalSample,
  IngressSourceSample,
  MetricsExtended,
  MetricsSample,
  NetworkDeviceSample,
} from '../../../../contracts/metrics-contract.ts'
import type { MetricEntityScope } from '../../metric-descriptors.ts'

export const V7_HOST_FAMILIES = [
  'host.system',
  'host.io',
  'host.network',
  'host.web',
  'managed.database',
] as const

export type V7HostFamily = (typeof V7_HOST_FAMILIES)[number]

export type V7EntityFamily = 'block' | 'network' | 'filesystem' | 'gpu' | 'hardware.physical'

/** Doubles available to a row's metric values (double1..double19). */
export const V7_DOUBLE_SLOTS = 19

/** Content text blobs start after the six envelope blobs (blob7). */
export const V7_FIRST_CONTENT_BLOB_INDEX = 6

/** Content text blobs a row can carry (blob7..blob20). */
export const V7_CONTENT_BLOB_CAPACITY = 14

/** The one source id the single-source families (`managed.ingress`, `managed.database_proxy`) report as. */
export const V7_SOURCE_IDS = {
  'managed.ingress': 'caddy',
  'managed.database_proxy': 'proxysql',
} as const

/** What a per-sample row builder reads besides the sample itself. */
export type V7Context = {
  sample: MetricsSample
  /** Embedded NIC 1 and NIC 2 (`SlotMapping.normalNicSlots[0..1]`). */
  nics: readonly [NetworkDeviceSample | undefined, NetworkDeviceSample | undefined]
  /** The lone extra filesystem, folded into `host.network`. */
  foldedFilesystem: FilesystemSample | undefined
  ingress: IngressSourceSample | undefined
  proxy: DatabaseProxySample | undefined
}

export type V7FieldRef = { scope: MetricEntityScope; field: string }

type DoubleDef = { ref?: V7FieldRef; read: (ctx: V7Context) => number | null }

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function num(source: unknown, key: string): number | null {
  if (typeof source !== 'object' || source === null) return null
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

type HostGroup = 'cpu' | 'kernel' | 'memory' | 'storage' | 'network'

function hostField(scope: MetricEntityScope, field: string): DoubleDef {
  const group = scope.slice('host.'.length) as HostGroup
  return { ref: { scope, field }, read: (c) => num(c.sample.host[group], field) }
}

function extended(section: 'host' | 'docker' | 'ingress', field: string): DoubleDef {
  return {
    ref: { scope: `extended.${section}`, field },
    read: (c) => num(c.sample.extended?.[section as keyof MetricsExtended], field),
  }
}

function diagnostics(half: 'cpu' | 'memory', field: string): DoubleDef {
  return {
    ref: { scope: 'diagnostics', field },
    read: (c) => num(c.sample.diagnostics?.[half], field),
  }
}

function sampleScope(
  scope: 'router' | 'storage' | 'dockerUsage',
  field: string,
  read: (c: V7Context) => unknown = (c) => c.sample[scope]
): DoubleDef {
  return { ref: { scope, field }, read: (c) => num(read(c), field) }
}

function engineField(engine: 'postgres' | 'mysql' | 'mariadb', field: string): DoubleDef {
  const flat = `${engine}${field[0].toUpperCase()}${field.slice(1)}`
  return {
    ref: { scope: 'storage', field: flat },
    read: (c) => num(c.sample.storage?.[engine], field),
  }
}

function ingressField(field: string): DoubleDef {
  return { ref: { scope: 'ingress', field }, read: (c) => num(c.ingress, field) }
}

function proxyField(field: string): DoubleDef {
  return { ref: { scope: 'databaseProxy', field }, read: (c) => num(c.proxy, field) }
}

/** Sum of a NIC's four error/drop rates, `null` if any input is missing. */
function nicProblems(nic: NetworkDeviceSample | undefined): number | null {
  if (!nic) return null
  const parts = [
    nic.receiveErrorsPerSecond,
    nic.transmitErrorsPerSecond,
    nic.receiveDropsPerSecond,
    nic.transmitDropsPerSecond,
  ]
  if (parts.includes(null)) return null
  return (parts as number[]).reduce((sum, value) => sum + value, 0)
}

function embeddedNic(slot: 0 | 1, key: 'rx' | 'tx' | 'problems'): DoubleDef {
  return {
    read: (c) => {
      const nic = c.nics[slot]
      if (key === 'problems') return nicProblems(nic)
      return (key === 'rx' ? nic?.receiveBytesPerSecond : nic?.transmitBytesPerSecond) ?? null
    },
  }
}

/** Docker's reclaimable bytes: the daemon's own sum, else the three df groups added up. */
function reclaimableTotal(c: V7Context): number | null {
  const own = num(c.sample.extended?.docker, 'reclaimableBytes')
  if (own !== null) return own
  const parts = [
    num(c.sample.dockerUsage, 'imagesReclaimableBytes'),
    num(c.sample.dockerUsage, 'volumesReclaimableBytes'),
    num(c.sample.dockerUsage, 'buildCacheReclaimableBytes'),
  ].filter((part): part is number => part !== null)
  return parts.length === 0 ? null : parts.reduce((sum, part) => sum + part, 0)
}

function foldedFilesystemField(field: 'availableBytes' | 'freeInodes'): DoubleDef {
  return { read: (c) => c.foldedFilesystem?.[field] ?? null }
}

const DOUBLE_DEFS: Readonly<Record<string, DoubleDef>> = {
  // host.system
  busy: hostField('host.cpu', 'busyPercent'),
  user: hostField('host.cpu', 'userPercent'),
  system: hostField('host.cpu', 'systemPercent'),
  iowait: hostField('host.cpu', 'iowaitPercent'),
  steal: hostField('host.cpu', 'stealPercent'),
  softirq: hostField('host.cpu', 'softirqPercent'),
  cpuPsi: hostField('host.cpu', 'pressureSomePercent'),
  saturated: hostField('host.cpu', 'saturatedCoreCount'),
  used: hostField('host.memory', 'usedBytes'),
  cachedFiles: hostField('host.memory', 'cachedFilesBytes'),
  swapUsed: hostField('host.memory', 'swapUsedBytes'),
  memPsiSome: hostField('host.memory', 'pressureSomePercent'),
  memPsiFull: hostField('host.memory', 'pressureFullPercent'),
  majorFaults: hostField('host.memory', 'majorPageFaultsPerSecond'),
  oomKills: extended('host', 'oomKills'),
  fileHandles: hostField('host.kernel', 'fileHandlesUsedPercent'),
  conntrack: hostField('host.kernel', 'conntrackUsedPercent'),
  pidLimit: extended('host', 'pidLimitUsedPercent'),
  dSlabU: diagnostics('memory', 'slabUnreclaimableBytes'),
  // host.io
  ioPsiSome: hostField('host.storage', 'ioPressureSomePercent'),
  ioPsiFull: hostField('host.storage', 'ioPressureFullPercent'),
  diskRead: hostField('host.storage', 'diskReadBytesPerSecond'),
  diskWrite: hostField('host.storage', 'diskWriteBytesPerSecond'),
  diskLatency: hostField('host.storage', 'diskLatencyMs'),
  rootQueue: extended('host', 'rootDiskQueueDepth'),
  rootOps: extended('host', 'rootDiskOpsPerSecond'),
  ctrRunning: extended('docker', 'containersRunning'),
  ctrUnhealthy: extended('docker', 'containersUnhealthy'),
  ctrRestarting: extended('docker', 'containersRestarting'),
  ctrOom: extended('docker', 'containerOomEvents'),
  ctrDie: extended('docker', 'containerDieEvents'),
  ctrCpu: extended('docker', 'containersCpuPercent'),
  ctrMem: extended('docker', 'containersMemoryBytes'),
  layers: sampleScope('dockerUsage', 'layersBytes'),
  ctrBytes: sampleScope('dockerUsage', 'containersBytes'),
  volumes: sampleScope('dockerUsage', 'volumesBytes'),
  buildCache: sampleScope('dockerUsage', 'buildCacheBytes'),
  reclTotal: {
    ref: { scope: 'extended.docker', field: 'reclaimableBytes' },
    read: reclaimableTotal,
  },
  // host.network
  rootAvail: hostField('host.storage', 'rootFilesystemAvailableBytes'),
  rootInodes: hostField('host.storage', 'rootFilesystemFreeInodes'),
  fs_availableBytes: foldedFilesystemField('availableBytes'),
  fs_freeInodes: foldedFilesystemField('freeInodes'),
  tcpRetrans: hostField('host.network', 'tcpRetransmitPercent'),
  'nic1.rx': embeddedNic(0, 'rx'),
  'nic1.tx': embeddedNic(0, 'tx'),
  'nic1.problems': embeddedNic(0, 'problems'),
  'nic2.rx': embeddedNic(1, 'rx'),
  'nic2.tx': embeddedNic(1, 'tx'),
  'nic2.problems': embeddedNic(1, 'problems'),
  systemdFailed: extended('host', 'systemdUnitsFailed'),
  mdDegraded: extended('host', 'mdArraysDegraded'),
  dCommit: diagnostics('memory', 'committedAsBytes'),
  tUp: sampleScope('router', 'backendsUp'),
  tTotal: sampleScope('router', 'backendsTotal'),
  t5xx: sampleScope('router', 'backendErrors5xx'),
  tLatency: sampleScope('router', 'backendLatencyMsAvg'),
  tRequests: sampleScope('router', 'backendRequests'),
  // host.web
  hostingUsed: sampleScope('storage', 'hostingUsedBytes'),
  backupUsed: sampleScope('storage', 'backupUsedBytes'),
  dockerUsed: sampleScope('storage', 'dockerUsedBytes'),
  logsUsed: sampleScope('storage', 'logsUsedBytes'),
  hostingFree: sampleScope('storage', 'hostingFreeBytes'),
  backupFree: sampleScope('storage', 'backupFreeBytes'),
  cReq: ingressField('requests'),
  c2xx: ingressField('responses2xx'),
  c4xx: ingressField('responses4xx'),
  c5xx: ingressField('responses5xx'),
  cErr: ingressField('requestErrors'),
  cReqB: ingressField('requestBytes'),
  cRespB: ingressField('responseBytes'),
  cDur: ingressField('requestDurationSecondsSum'),
  cB100: ingressField('bucket100ms'),
  cB500: ingressField('bucket500ms'),
  cB1s: ingressField('bucket1s'),
  cInFlight: ingressField('requestsInFlight'),
  cTls: extended('ingress', 'tlsCertSoonestExpiryDays'),
  // managed.database
  dbpostgresInstancesRunning: engineField('postgres', 'instancesRunning'),
  dbpostgresInstancesHealthy: engineField('postgres', 'instancesHealthy'),
  dbmysqlInstancesRunning: engineField('mysql', 'instancesRunning'),
  dbmysqlInstancesHealthy: engineField('mysql', 'instancesHealthy'),
  dbmariadbInstancesRunning: engineField('mariadb', 'instancesRunning'),
  dbmariadbInstancesHealthy: engineField('mariadb', 'instancesHealthy'),
  pxqueries: proxyField('queries'),
  pxslowQueries: proxyField('slowQueries'),
  pxqueryLatencyMsAvg: proxyField('queryLatencyMsAvg'),
  pxbackendLatencyMsAvg: proxyField('backendLatencyMsAvg'),
  pxactiveTransactions: proxyField('activeTransactions'),
  pxclientConnections: proxyField('clientConnections'),
  pxclientConnectionsAborted: proxyField('clientConnectionsAborted'),
  pxconnectionsRejectedMaxConns: proxyField('connectionsRejectedMaxConns'),
  pxbackendConnections: proxyField('backendConnections'),
  pxconnectionErrors: proxyField('connectionErrors'),
  pxbackendsUp: proxyField('backendsUp'),
  pxbackendsTotal: proxyField('backendsTotal'),
}

/** Catalogue text id -> the contract `extended.text` key (identical except `unhealthyNames`). */
const TEXT_KEYS: Readonly<Record<string, keyof NonNullable<MetricsExtended['text']>>> = {
  loadavg: 'loadavg',
  topCpu: 'topCpu',
  cpuModel: 'cpuModel',
  topMem: 'topMem',
  lastOom: 'lastOom',
  unhealthyNames: 'unhealthyContainers',
  dockerVersion: 'dockerVersion',
  failedUnits: 'failedUnits',
  raidState: 'raidState',
  rebootRequired: 'rebootRequired',
  kernel: 'kernel',
  os: 'os',
  bootId: 'bootId',
  virt: 'virt',
  cloudProvider: 'cloudProvider',
  agentVersion: 'agentVersion',
  timeSync: 'timeSync',
  pendingUpdates: 'pendingUpdates',
  fsReadOnly: 'fsReadOnly',
  phpVersions: 'phpVersions',
  webEngines: 'webEngines',
  fpmBusiest: 'fpmBusiest',
  topSites: 'topSites',
  caddyVersion: 'caddyVersion',
  certSoonest: 'certSoonest',
  traefikVersion: 'traefikVersion',
  unhealthyBackends: 'unhealthyBackends',
  dbVersions: 'dbVersions',
}

// ---------------------------------------------------------------------------
// Host rows (written once per sample)
// ---------------------------------------------------------------------------

type HostRowSpec = { doubles: readonly (string | null)[]; blobs: readonly string[] }

/** Slot ids for a host row, written as one space-separated list. */
function ids(list: string): string[] {
  return list.split(' ')
}

export const V7_HOST_ROW_SPECS: Readonly<Record<V7HostFamily, HostRowSpec>> = {
  'host.system': {
    doubles: ids(
      'busy user system iowait steal softirq cpuPsi saturated used cachedFiles swapUsed memPsiSome memPsiFull majorFaults oomKills fileHandles conntrack pidLimit dSlabU'
    ),
    blobs: ids('loadavg topCpu cpuModel topMem lastOom'),
  },
  'host.io': {
    doubles: ids(
      'ioPsiSome ioPsiFull diskRead diskWrite diskLatency rootQueue rootOps ctrRunning ctrUnhealthy ctrRestarting ctrOom ctrDie ctrCpu ctrMem layers ctrBytes volumes buildCache reclTotal'
    ),
    blobs: ids('unhealthyNames dockerVersion'),
  },
  'host.network': {
    doubles: ids(
      'rootAvail rootInodes fs_availableBytes fs_freeInodes tcpRetrans nic1.rx nic1.tx nic1.problems nic2.rx nic2.tx nic2.problems systemdFailed mdDegraded dCommit tUp tTotal t5xx tLatency tRequests'
    ),
    blobs: ids(
      'failedUnits raidState rebootRequired kernel os bootId virt cloudProvider agentVersion timeSync pendingUpdates fsReadOnly phpVersions webEngines'
    ),
  },
  'host.web': {
    doubles: ids(
      'hostingUsed backupUsed dockerUsed logsUsed hostingFree backupFree cReq c2xx c4xx c5xx cErr cReqB cRespB cDur cB100 cB500 cB1s cInFlight cTls'
    ),
    blobs: ids('fpmBusiest topSites caddyVersion certSoonest traefikVersion unhealthyBackends'),
  },
  'managed.database': {
    doubles: [
      ...ids(
        'dbpostgresInstancesRunning dbpostgresInstancesHealthy dbmysqlInstancesRunning dbmysqlInstancesHealthy dbmariadbInstancesRunning dbmariadbInstancesHealthy pxqueries pxslowQueries pxqueryLatencyMsAvg pxbackendLatencyMsAvg pxactiveTransactions pxclientConnections pxclientConnectionsAborted pxconnectionsRejectedMaxConns pxbackendConnections pxconnectionErrors pxbackendsUp pxbackendsTotal'
      ),
      null,
    ],
    blobs: ids('dbVersions'),
  },
}

function defOf(id: string): DoubleDef {
  const def = DOUBLE_DEFS[id]
  if (!def) throw new TypeError(`v7 layout names an unknown slot id: ${id}`)
  return def
}

function textOf(c: V7Context, id: string): string {
  const key = TEXT_KEYS[id]
  if (!key) throw new TypeError(`v7 layout names an unknown text id: ${id}`)
  return c.sample.extended?.text?.[key] ?? ''
}

export type V7RowValues = { doubles: (number | null)[]; blobs: string[] }

/** Values for one host row: 19 nullable doubles and the content text blobs. */
export function v7HostRowValues(family: V7HostFamily, ctx: V7Context): V7RowValues {
  const spec = V7_HOST_ROW_SPECS[family]
  return {
    doubles: spec.doubles.map((id) => (id === null ? null : defOf(id).read(ctx))),
    blobs: spec.blobs.map((id) => textOf(ctx, id)),
  }
}

/** `true` when the sample carries managed-database data (census or a ProxySQL source). */
export function hasManagedDatabase(sample: MetricsSample): boolean {
  if (sample.databaseProxies.length > 0) return true
  const storage = sample.storage
  if (!storage) return false
  return [storage.postgres, storage.mysql, storage.mariadb].some(
    (engine) => engine.instancesRunning !== null || engine.instancesHealthy !== null
  )
}

// ---------------------------------------------------------------------------
// Read-side resolution: contract field -> (row family, double index)
// ---------------------------------------------------------------------------

export type V7Slot = { family: V7HostFamily; doubleIndex: number }

const SLOT_BY_REF: ReadonlyMap<string, V7Slot> = (() => {
  const map = new Map<string, V7Slot>()
  for (const family of V7_HOST_FAMILIES) {
    V7_HOST_ROW_SPECS[family].doubles.forEach((id, doubleIndex) => {
      const ref = id === null ? undefined : defOf(id).ref
      if (ref) map.set(`${ref.scope}.${ref.field}`, { family, doubleIndex })
    })
  }
  return map
})()

/** Where a contract field lives on a v7 host row, or `undefined` when v7 does not store it. */
export function v7HostSlotFor(scope: MetricEntityScope, field: string): V7Slot | undefined {
  return SLOT_BY_REF.get(`${scope}.${field}`)
}

/**
 * A single-source family's field names laid out by physical double index on the
 * host row that carries it (`null` elsewhere), so `indexOf(field)` is the slot.
 */
function slotArrayFor(family: V7HostFamily, scope: MetricEntityScope): readonly (string | null)[] {
  return V7_HOST_ROW_SPECS[family].doubles.map((id) => {
    const ref = id === null ? undefined : defOf(id).ref
    return ref?.scope === scope ? ref.field : null
  })
}

export const V7_SINGLE_SOURCE_FAMILIES = {
  'managed.ingress': { hostFamily: 'host.web', scope: 'ingress' },
  'managed.database_proxy': { hostFamily: 'managed.database', scope: 'databaseProxy' },
} as const satisfies Record<string, { hostFamily: V7HostFamily; scope: MetricEntityScope }>

export const V7_SINGLE_SOURCE_FIELD_ORDER = {
  'managed.ingress': slotArrayFor('host.web', 'ingress'),
  'managed.database_proxy': slotArrayFor('managed.database', 'databaseProxy'),
} as const

/** Physical double index of NIC `slot`'s receive or transmit rate on `host.network`. */
export function v7EmbeddedNicDoubleIndex(slot: 0 | 1, key: 'rx' | 'tx'): number {
  const id = `nic${slot + 1}.${key}`
  return V7_HOST_ROW_SPECS['host.network'].doubles.indexOf(id)
}

// ---------------------------------------------------------------------------
// Entity rows (paged)
// ---------------------------------------------------------------------------

type EntityRowSpec<E> = {
  /** Per-entity double slots in physical order; `field` is the contract field name (null = no descriptor yet). */
  doubles: readonly { field: string | null; read: (entity: E) => number | null }[]
  /** Per-entity text blobs, appended entity by entity. */
  blobs: readonly { read: (entity: E, sample: MetricsSample) => string }[]
  perPage: number
}

function entityNum<E>(field: string): { field: string; read: (entity: E) => number | null } {
  return { field, read: (entity) => num(entity, field) }
}

function opsPerSecond(device: BlockDeviceSample): number | null {
  if (device.readOpsPerSecond === null || device.writeOpsPerSecond === null) return null
  return device.readOpsPerSecond + device.writeOpsPerSecond
}

function blockText(key: 'model' | 'smart') {
  return {
    read: (d: BlockDeviceSample, s: MetricsSample) =>
      s.extended?.blockDeviceText?.find((t) => t.deviceId === d.deviceId)?.[key] ?? '',
  }
}

function gpuText(key: 'driver' | 'model') {
  return {
    read: (g: GpuSample, s: MetricsSample) =>
      s.extended?.gpuText?.find((t) => t.gpuId === g.gpuId)?.[key] ?? '',
  }
}

const BLOCK_SPEC: EntityRowSpec<BlockDeviceSample> = {
  doubles: [
    entityNum('readBytesPerSecond'),
    entityNum('writeBytesPerSecond'),
    { field: 'opsPerSecond', read: opsPerSecond },
    entityNum('readLatencyMs'),
    entityNum('writeLatencyMs'),
    entityNum('queueDepth'),
  ],
  blobs: [blockText('model'), blockText('smart')],
  perPage: 3,
}

const NETWORK_SPEC: EntityRowSpec<NetworkDeviceSample> = {
  doubles: [
    entityNum('receiveBytesPerSecond'),
    entityNum('transmitBytesPerSecond'),
    entityNum('receiveErrorsPerSecond'),
    entityNum('transmitErrorsPerSecond'),
    entityNum('receiveDropsPerSecond'),
    entityNum('transmitDropsPerSecond'),
  ],
  // Link state has no wire field yet; the slot is reserved and written empty.
  blobs: [{ read: () => '' }],
  perPage: 3,
}

const FILESYSTEM_SPEC: EntityRowSpec<FilesystemSample> = {
  doubles: [entityNum('availableBytes'), entityNum('freeInodes')],
  blobs: [],
  perPage: 9,
}

const GPU_SPEC: EntityRowSpec<GpuSample> = {
  doubles: [
    entityNum('utilizationPercent'),
    entityNum('memoryUsedBytes'),
    entityNum('memoryActivityPercent'),
    entityNum('pcieReceiveBytesPerSecond'),
    entityNum('pcieTransmitBytesPerSecond'),
    entityNum('throttlePercent'),
  ],
  blobs: [gpuText('driver'), gpuText('model')],
  perPage: 3,
}

const SIGNAL_SPEC: EntityRowSpec<HardwareSignalSample> = {
  doubles: [{ field: 'value', read: (signal) => signal.value }],
  blobs: [],
  perPage: V7_DOUBLE_SLOTS,
}

/** Per-entity field order (spare = `null`) the read path resolves slots against. */
export const V7_ENTITY_FIELD_ORDER: Readonly<Record<V7EntityFamily, readonly (string | null)[]>> = {
  block: BLOCK_SPEC.doubles.map((d) => d.field),
  network: NETWORK_SPEC.doubles.map((d) => d.field),
  filesystem: FILESYSTEM_SPEC.doubles.map((d) => d.field),
  gpu: GPU_SPEC.doubles.map((d) => d.field),
  'hardware.physical': SIGNAL_SPEC.doubles.map((d) => d.field),
}

export const V7_ENTITIES_PER_PAGE: Readonly<Record<V7EntityFamily, number>> = {
  block: BLOCK_SPEC.perPage,
  network: NETWORK_SPEC.perPage,
  filesystem: FILESYSTEM_SPEC.perPage,
  gpu: GPU_SPEC.perPage,
  'hardware.physical': SIGNAL_SPEC.perPage,
}

export type V7EntityPage = V7RowValues & { page: number; ids: string }

function packEntityPages<E>(
  entities: readonly E[],
  spec: EntityRowSpec<E>,
  idOf: (entity: E) => string,
  sample: MetricsSample
): V7EntityPage[] {
  const pages: V7EntityPage[] = []
  for (let start = 0; start < entities.length; start += spec.perPage) {
    const chunk = entities.slice(start, start + spec.perPage)
    const doubles = new Array<number | null>(V7_DOUBLE_SLOTS).fill(null)
    chunk.forEach((entity, entityIndex) => {
      spec.doubles.forEach((slot, fieldIndex) => {
        doubles[entityIndex * spec.doubles.length + fieldIndex] = slot.read(entity)
      })
    })
    const blobs = chunk.flatMap((entity) => spec.blobs.map((blob) => blob.read(entity, sample)))
    pages.push({ doubles, blobs, page: pages.length, ids: chunk.map(idOf).join(',') })
  }
  return pages
}

/** Pack already-ordered, already-plan-truncated entities of one family into pages. */
export const v7EntityPages = {
  block: (e: readonly BlockDeviceSample[], s: MetricsSample) =>
    packEntityPages(e, BLOCK_SPEC, (d) => d.deviceId, s),
  network: (e: readonly NetworkDeviceSample[], s: MetricsSample) =>
    packEntityPages(e, NETWORK_SPEC, (d) => d.deviceId, s),
  filesystem: (e: readonly FilesystemSample[], s: MetricsSample) =>
    packEntityPages(e, FILESYSTEM_SPEC, (f) => f.filesystemId, s),
  gpu: (e: readonly GpuSample[], s: MetricsSample) =>
    packEntityPages(e, GPU_SPEC, (g) => g.gpuId, s),
  'hardware.physical': (e: readonly HardwareSignalSample[], s: MetricsSample) =>
    packEntityPages(e, SIGNAL_SPEC, (h) => h.signalId, s),
}
