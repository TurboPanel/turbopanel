/**
 * DuckDB metrics schema DDL for the v5 contract — the DuckDB backend's own
 * private field map, independent of `../cloudflare/field-map.ts`'s AE
 * positional layout.
 *
 * v5 replaces v3's single wide `server_metric_samples` table with one table
 * per entity family (host, network, filesystem, block, GPU, hardware signal,
 * ingress, database proxy) plus a discrete events table, mirroring
 * `contract.ts`'s per-entity grouping. Every metric column is a real
 * nullable `DOUBLE` with a real SQL `NULL` for "missing" — no positional
 * `doubleN`/`blobN` slots, no missing-metric sentinel, and (unlike v3) no
 * `parts` marker column: v5 has no `MetricPart` allowlist, so a family's
 * table simply has no row for a sample that never reported that family.
 *
 * `diagnostics` is v6's single merged depth family. Only its committed-memory
 * reading is stored (it has a place in the hosted layout); the others are not
 * stored by either edition. That one reading lives in the singleton
 * `server_memory_diagnostics_samples` table, left-joined on
 * `(server_id, sampled_at)`.
 *
 * v5 deleted every per-core table. `server_cpu_hotspot_samples` (the 4
 * busiest cores per sample) and `server_cpu_core_samples` (live-only, one
 * row per online core) are both gone, along with the contract families that
 * fed them — a 64-core host now costs exactly the same storage as a 2-core
 * one.
 */

import {
  type BlockDeviceSample,
  EXTENDED_DOCKER_FIELD_NAMES,
  EXTENDED_HOST_FIELD_NAMES,
  EXTENDED_INGRESS_FIELD_NAMES,
  EXTENDED_SIZE_FIELD_NAMES,
  type DatabaseProxySample,
  type DiagnosticsMemorySample,
  type DockerUsageSample,
  type FilesystemSample,
  type GpuSample,
  type HostCpuMetrics,
  type HostKernelMetrics,
  type HostMemoryMetrics,
  type HostMetrics,
  type HostNetworkMetrics,
  type HostStorageMetrics,
  type IngressSourceSample,
  type NetworkDeviceSample,
  type RouterSample,
  METRICS_TEXT_FIELD_NAMES,
  STORAGE_ENGINE_KEYS,
  STORAGE_FLAT_FIELD_NAMES,
  storageEngineFieldName,
  type StorageEngineSample,
} from '../../../../contracts/metrics-contract.ts'
import { STORED_FIELD_IDS } from '../../field-registry.ts'

/** Hot raw-sample tables (recent, un-archived rows). */
export const HOST_SAMPLES_TABLE = 'server_host_samples'
export const NETWORK_SAMPLES_TABLE = 'server_network_samples'
export const FILESYSTEM_SAMPLES_TABLE = 'server_filesystem_samples'
export const BLOCK_SAMPLES_TABLE = 'server_block_samples'
export const GPU_SAMPLES_TABLE = 'server_gpu_samples'
export const HARDWARE_SIGNAL_SAMPLES_TABLE = 'server_hardware_signal_samples'
export const INGRESS_SAMPLES_TABLE = 'server_ingress_samples'
export const DATABASE_PROXY_SAMPLES_TABLE = 'server_database_proxy_samples'
export const ROUTER_SAMPLES_TABLE = 'server_router_samples'
export const STORAGE_SAMPLES_TABLE = 'server_storage_samples'
export const DOCKER_SAMPLES_TABLE = 'server_docker_samples'
export const MEMORY_DIAGNOSTICS_SAMPLES_TABLE = 'server_memory_diagnostics_samples'
export const HOST_TEXT_SAMPLES_TABLE = 'server_host_text_samples'
export const METRIC_EVENTS_TABLE = 'server_metric_events'

/** Connection-status transition table — untouched by the v5 cutover. */
export const STATUS_EVENTS_TABLE = 'server_status_events'

/**
 * Latest host facts (the short text a wire version 8 sample carries beside its numbers):
 * one row per server, replaced as newer samples arrive. Not a time series, so
 * it is never archived to Parquet and needs no retention. Added with
 * `CREATE TABLE IF NOT EXISTS`, so an existing file at the current marker (10) simply gains it. (A marker-9 file is discarded, not upgraded.)
 */
export const HOST_FACTS_TABLE = 'server_host_facts'

/**
 * Sidecar version written after a successful open. The current DuckDB store
 * is **12** — the only supported on-disk layout. `openDuckDb` discards
 * `metrics.duckdb`, `parquet/`, `tmp/`, and `schema-version` when the marker
 * holds an older version number, then creates the current store (a missing,
 * corrupt, or newer marker beside existing data fails the open instead).
 * There is no in-place migration and no supported path for older files. The
 * number never goes down: a lower one would make an existing file look
 * "newer" and refuse to open.
 *
 * Every DDL statement is `CREATE TABLE IF NOT EXISTS`, so without a marker
 * bump an existing file would silently keep its old columns and reject or
 * misread every insert; each layout change is therefore a hard cut (the old
 * file is discarded, the new one starts empty). Marker 12 makes the store hold
 * exactly the readings the hosted store holds (`../../field-registry.ts`):
 * the columns for values neither store keeps are gone, the host and device
 * facts that ride as text on the hosted store are columns here
 * (`server_host_text_samples` and text columns on the device tables), and the
 * sequence and generation columns, which nothing reads, are gone.
 */
export { METRICS_LAYOUT_VERSION as DUCKDB_SCHEMA_MARKER_VERSION } from '../../field-registry.ts'

// ---------------------------------------------------------------------------
// Field ordering — hand-declared `Record<keyof T, true>` literals so a
// missing or renamed `contract.ts` field fails the TypeScript build
// instead of silently dropping a column. `Object.keys()` on each literal
// gives a stable, deterministic field order (object literal insertion order).
// ---------------------------------------------------------------------------

/**
 * The fields of one scope the registry says both stores keep, in the order
 * given. Every column list below is cut through this, so a value the registry
 * does not store has no column, and `field-registry.test.ts` checks the result.
 */
function stored(scope: string, fields: readonly string[]): string[] {
  return fields.filter((field) => STORED_FIELD_IDS.has(`${scope}.${field}`))
}

export type HostMetricGroup = keyof HostMetrics

/** Exhaustive over `HostMetrics`'s keys — a group added/removed there fails this literal to compile. */
const HOST_GROUP_MARKERS: Record<HostMetricGroup, true> = {
  cpu: true,
  kernel: true,
  memory: true,
  storage: true,
  network: true,
}

export const HOST_METRIC_GROUPS: readonly HostMetricGroup[] = Object.keys(
  HOST_GROUP_MARKERS
) as HostMetricGroup[]

export type HostFieldRef = { group: HostMetricGroup; field: string }

const HOST_CPU_FIELDS: Record<keyof HostCpuMetrics, true> = {
  busyPercent: true,
  userPercent: true,
  systemPercent: true,
  iowaitPercent: true,
  stealPercent: true,
  softirqPercent: true,
  pressureSomePercent: true,
  saturatedCoreCount: true,
  procsRunning: true,
  procsBlocked: true,
  processCount: true,
}

const HOST_KERNEL_FIELDS: Record<keyof HostKernelMetrics, true> = {
  fileHandlesUsedPercent: true,
  conntrackUsedPercent: true,
}

const HOST_MEMORY_FIELDS: Record<keyof HostMemoryMetrics, true> = {
  usedBytes: true,
  cachedFilesBytes: true,
  swapUsedBytes: true,
  pressureSomePercent: true,
  pressureFullPercent: true,
  swapInBytesPerSecond: true,
  swapOutBytesPerSecond: true,
  majorPageFaultsPerSecond: true,
}

const HOST_STORAGE_FIELDS: Record<keyof HostStorageMetrics, true> = {
  ioPressureSomePercent: true,
  ioPressureFullPercent: true,
  diskReadBytesPerSecond: true,
  diskWriteBytesPerSecond: true,
  diskLatencyMs: true,
  rootFilesystemAvailableBytes: true,
  rootFilesystemFreeInodes: true,
}

const HOST_NETWORK_FIELDS: Record<keyof HostNetworkMetrics, true> = {
  tcpRetransmitPercent: true,
  softnetDropsPerSecond: true,
}

const HOST_GROUP_FIELD_RECORDS: Record<HostMetricGroup, Record<string, true>> = {
  cpu: HOST_CPU_FIELDS,
  kernel: HOST_KERNEL_FIELDS,
  memory: HOST_MEMORY_FIELDS,
  storage: HOST_STORAGE_FIELDS,
  network: HOST_NETWORK_FIELDS,
}

/**
 * Every `HostMetrics` leaf field the registry stores, in declared group order.
 * The contract has 31 (11 + 2 + 7 + 9 + 2); the others are not stored by either
 * edition. Group coverage is compile-time exhaustive
 * (`HOST_GROUP_MARKERS` above is typed `Record<keyof HostMetrics, true>`);
 * field coverage within each group is compile-time exhaustive via that
 * group's own `Record<keyof T, true>` literal (`HOST_CPU_FIELDS` etc.) — a
 * field or group added to `contract.ts` without a matching entry fails
 * the TypeScript build rather than silently missing a column.
 */
export const HOST_METRIC_FIELD_REFS: readonly HostFieldRef[] = HOST_METRIC_GROUPS.flatMap((group) =>
  stored(`host.${group}`, Object.keys(HOST_GROUP_FIELD_RECORDS[group])).map((field) => ({
    group,
    field,
  }))
)

const NETWORK_FIELDS: Record<keyof Omit<NetworkDeviceSample, 'deviceId'>, true> = {
  receiveBytesPerSecond: true,
  transmitBytesPerSecond: true,
  receiveErrorsPerSecond: true,
  transmitErrorsPerSecond: true,
  receiveDropsPerSecond: true,
  transmitDropsPerSecond: true,
}
/**
 * Two stored NIC values are not wire fields: the sum of the four error and drop
 * rates (the only form the hosted store keeps for a NIC embedded in a host row)
 * and the negotiated link speed from `extended.networkSizes`.
 */
export const NETWORK_DERIVED_FIELDS = ['problemsPerSecond', 'linkSpeedMbps'] as const
export const NETWORK_METRIC_FIELDS: readonly string[] = stored('network', [
  ...Object.keys(NETWORK_FIELDS),
  ...NETWORK_DERIVED_FIELDS,
])

/**
 * The root filesystem never gets a row here: its capacity is carried
 * exclusively by `server_host_samples`'s `storage_root_filesystem_available_bytes`/
 * `storage_root_filesystem_free_inodes` columns (`HOST_STORAGE_FIELDS` above
 * — `rootFilesystemAvailableBytes`/`rootFilesystemFreeInodes` are ordinary
 * host-table gauges, not a duplicate of filesystem-table data), because the
 * collector (`turbopaneld`'s `collector/filesystem.ts`) never emits the
 * root-tagged topology entry into `sample.filesystems[]` in the first place.
 * A server's semantic filesystem picture is this table's non-root rows
 * joined against the topology snapshot's `FilesystemTopology.roles` (hosting/
 * docker/application/custom) for labeling — never a synthetic root row here.
 */
const FILESYSTEM_FIELDS: Record<keyof Omit<FilesystemSample, 'filesystemId'>, true> = {
  availableBytes: true,
  freeInodes: true,
}
/**
 * Sizes the daemon sends in `extended.filesystemSizes`, stored beside each
 * filesystem's readings so a percentage is taken against the size at that moment.
 */
export const FILESYSTEM_SIZE_FIELDS = ['totalBytes', 'totalInodes'] as const
export const FILESYSTEM_METRIC_FIELDS: readonly string[] = stored('filesystem', [
  ...Object.keys(FILESYSTEM_FIELDS),
  ...FILESYSTEM_SIZE_FIELDS,
])

const BLOCK_FIELDS: Record<keyof Omit<BlockDeviceSample, 'deviceId'>, true> = {
  readBytesPerSecond: true,
  writeBytesPerSecond: true,
  readOpsPerSecond: true,
  writeOpsPerSecond: true,
  readLatencyMs: true,
  writeLatencyMs: true,
  utilizationPercent: true,
  queueDepth: true,
}
/** A drive's combined read plus write operations per second: stored as one sum, like the hosted store. */
export const BLOCK_OPS_FIELD = 'opsPerSecond'
export const BLOCK_METRIC_FIELDS: readonly string[] = stored('block', [
  ...Object.keys(BLOCK_FIELDS),
  BLOCK_OPS_FIELD,
])
/** A drive's text facts, from `extended.blockDeviceText`. */
export const BLOCK_TEXT_FIELDS = ['model', 'smart'] as const

const GPU_FIELDS: Record<keyof Omit<GpuSample, 'gpuId'>, true> = {
  utilizationPercent: true,
  memoryUsedBytes: true,
  memoryActivityPercent: true,
  pcieReceiveBytesPerSecond: true,
  pcieTransmitBytesPerSecond: true,
  throttlePercent: true,
}
/** The GPU's memory size from `extended.gpuSizes`, stored beside its readings. */
export const GPU_SIZE_FIELDS = ['memoryTotalBytes'] as const
export const GPU_METRIC_FIELDS: readonly string[] = stored('gpu', [
  ...Object.keys(GPU_FIELDS),
  ...GPU_SIZE_FIELDS,
])
/** A GPU's text facts, from `extended.gpuText`. */
export const GPU_TEXT_FIELDS = ['driver', 'model'] as const

const INGRESS_FIELDS: Record<keyof Omit<IngressSourceSample, 'sourceId' | 'sourceKind'>, true> = {
  requests: true,
  responses2xx: true,
  responses3xx: true,
  responses4xx: true,
  responses5xx: true,
  requestErrors: true,
  requestBytes: true,
  responseBytes: true,
  requestDurationSecondsSum: true,
  bucket10ms: true,
  bucket50ms: true,
  bucket100ms: true,
  bucket500ms: true,
  bucket1s: true,
  bucket5s: true,
  requestsInFlight: true,
  upstreamsHealthy: true,
  upstreamsTotal: true,
  retries: true,
}
export const INGRESS_METRIC_FIELDS: readonly string[] = stored(
  'ingress',
  Object.keys(INGRESS_FIELDS)
)

const DATABASE_PROXY_FIELDS: Record<
  keyof Omit<DatabaseProxySample, 'sourceId' | 'sourceKind'>,
  true
> = {
  queries: true,
  slowQueries: true,
  queryLatencyMsAvg: true,
  backendLatencyMsAvg: true,
  activeTransactions: true,
  clientConnections: true,
  clientConnectionsCreated: true,
  clientConnectionsAborted: true,
  connectionsRejectedMaxConns: true,
  backendConnections: true,
  backendConnectionsCreated: true,
  backendConnectionsAborted: true,
  connectionErrors: true,
  backendsUp: true,
  backendsTotal: true,
  bytesFromBackends: true,
  bytesToBackends: true,
}
export const DATABASE_PROXY_METRIC_FIELDS: readonly string[] = stored(
  'databaseProxy',
  Object.keys(DATABASE_PROXY_FIELDS)
)

/**
 * The shared-hosting HTTP router family — host-wide and singleton, so its
 * table carries no entity id column (same shape as
 * `server_memory_diagnostics_samples`). All 12 contract fields get a real
 * column: unlike the Analytics Engine backend there is no 19-slot page to
 * budget against here, so this list has no spare-slot concept at all.
 */
const ROUTER_FIELDS: Record<keyof RouterSample, true> = {
  backendsUp: true,
  backendsTotal: true,
  servicesTotal: true,
  routersTotal: true,
  retries: true,
  backendErrors5xx: true,
  backendLatencyMsAvg: true,
  backendRequests: true,
  httpOpenConnections: true,
  configReloads: true,
  configLastReloadAgeSeconds: true,
  tlsCertSoonestExpiryDays: true,
}
export const ROUTER_METRIC_FIELDS: readonly string[] = stored('router', Object.keys(ROUTER_FIELDS))

/**
 * The memory half of `diagnostics` — 12 fields on the wire, of which only
 * `committedAsBytes` is stored.
 */
const MEMORY_DIAGNOSTICS_FIELDS: Record<keyof DiagnosticsMemorySample, true> = {
  memoryFreeBytes: true,
  cachedBytes: true,
  anonPagesBytes: true,
  slabReclaimableBytes: true,
  slabUnreclaimableBytes: true,
  dirtyBytes: true,
  writebackBytes: true,
  shmemBytes: true,
  committedAsBytes: true,
  pageScanDirectPerSecond: true,
  pageScanKswapdPerSecond: true,
  compactionStallsPerSecond: true,
}
export const MEMORY_DIAGNOSTICS_METRIC_FIELDS: readonly string[] = stored(
  'diagnostics',
  Object.keys(MEMORY_DIAGNOSTICS_FIELDS)
)

/**
 * Host-wide managed-storage accounting — singleton per sample, so its table
 * carries no entity id column (same shape as `server_router_samples`).
 *
 * The Docker breakdown is not repeated here: it lives in the separate
 * `server_docker_samples` table, which keeps the hosted `managed.docker` family
 * boundary and is the one place a Docker figure is stored.
 *
 * The nested per-engine groups flatten to `<engine><Field>` before
 * snake_casing, which is what yields `postgres_instances_running` and keeps
 * every column name unique inside the single wide table.
 */
const STORAGE_ENGINE_FIELD_MARKERS: Record<keyof StorageEngineSample, true> = {
  instancesRunning: true,
  instancesHealthy: true,
  connectionsUsed: true,
  connectionsMax: true,
}

/**
 * Every stored per-engine column, flattened — derived from the compile-time
 * exhaustive marker record above crossed with the contract's engine list, so
 * a field added to `StorageEngineSample` fails the TypeScript build rather
 * than silently missing three columns. The connection counts are not stored.
 */
export const STORAGE_ENGINE_STORED_FIELDS: readonly {
  engine: (typeof STORAGE_ENGINE_KEYS)[number]
  field: keyof StorageEngineSample
  flat: string
}[] = STORAGE_ENGINE_KEYS.flatMap((engine) =>
  (Object.keys(STORAGE_ENGINE_FIELD_MARKERS) as (keyof StorageEngineSample)[]).map((field) => ({
    engine,
    field,
    flat: storageEngineFieldName(engine, field),
  }))
).filter((entry) => STORED_FIELD_IDS.has(`storage.${entry.flat}`))

export const STORAGE_ENGINE_METRIC_FIELDS: readonly string[] = STORAGE_ENGINE_STORED_FIELDS.map(
  (entry) => entry.flat
)

/** The stored ones of `StorageSample`'s seven flat (non-engine) field names, in contract order. */
export const STORAGE_FLAT_METRIC_FIELDS: readonly string[] = stored(
  'storage',
  STORAGE_FLAT_FIELD_NAMES
)

/** The Docker disk breakdown fields the registry stores (`server_docker_samples`). */
const DOCKER_USAGE_FIELDS: Record<keyof DockerUsageSample, true> = {
  layersBytes: true,
  imagesCount: true,
  imagesReclaimableBytes: true,
  containersBytes: true,
  containersCount: true,
  volumesBytes: true,
  volumesCount: true,
  volumesReclaimableBytes: true,
  buildCacheBytes: true,
  buildCacheReclaimableBytes: true,
}
export const DOCKER_USAGE_METRIC_FIELDS: readonly string[] = stored(
  'dockerUsage',
  Object.keys(DOCKER_USAGE_FIELDS)
)

/** The host facts that ride as text, one column each in `server_host_text_samples`. */
export const HOST_TEXT_FIELDS: readonly string[] = METRICS_TEXT_FIELD_NAMES

function snakeCase(field: string): string {
  return field.replaceAll(/([A-Z])/g, '_$1').toLowerCase()
}

/**
 * DuckDB column name for a host metric field, prefixed by its group —
 * `host.cpu.pressureSomePercent` and `host.memory.pressureSomePercent` both
 * snake_case to `pressure_some_percent` on their own, so the group prefix
 * (`cpu_pressure_some_percent` / `memory_pressure_some_percent`) is what
 * keeps every host column name unique within the single wide table.
 */
export function hostMetricColumnName(group: HostMetricGroup, field: string): string {
  if (!(field in HOST_GROUP_FIELD_RECORDS[group])) {
    throw new TypeError(`unknown host metrics field: ${group}.${field}`)
  }
  return `${group}_${snakeCase(field)}`
}

/** DuckDB column name for a per-entity metric field — plain snake_case (no group collision within a single-family table). */
export function entityMetricColumnName(field: string): string {
  return snakeCase(field)
}

/** DuckDB column name for one of the v12 `extended` numeric fields (`oomKills` -> `ext_oom_kills`). */
export function extendedColumnName(field: string): string {
  return `ext_${snakeCase(field)}`
}

/**
 * v12 numeric columns, in DDL / insert order: `extended.host` and the host-wide
 * certificate days from `extended.ingress` on `server_host_samples`,
 * `extended.docker` on `server_docker_samples`.
 */
export const EXTENDED_HOST_STORED_FIELDS: readonly string[] = stored(
  'extended.host',
  EXTENDED_HOST_FIELD_NAMES
)
export const EXTENDED_DOCKER_STORED_FIELDS: readonly string[] = stored(
  'extended.docker',
  EXTENDED_DOCKER_FIELD_NAMES
)
export const EXTENDED_INGRESS_STORED_FIELDS: readonly string[] = stored(
  'extended.ingress',
  EXTENDED_INGRESS_FIELD_NAMES
)
export const EXTENDED_SIZE_STORED_FIELDS: readonly string[] = stored(
  'extended.sizes',
  EXTENDED_SIZE_FIELD_NAMES
)
export const V12_HOST_COLUMNS: readonly string[] =
  EXTENDED_HOST_STORED_FIELDS.map(extendedColumnName)
export const V12_DOCKER_COLUMNS: readonly string[] =
  EXTENDED_DOCKER_STORED_FIELDS.map(extendedColumnName)
export const V12_INGRESS_COLUMNS: readonly string[] =
  EXTENDED_INGRESS_STORED_FIELDS.map(extendedColumnName)
/** The sizes every sample carries (`extended.sizes`), as `ext_*` columns on `server_host_samples`. */
export const V12_SIZE_COLUMNS: readonly string[] =
  EXTENDED_SIZE_STORED_FIELDS.map(extendedColumnName)

// ---------------------------------------------------------------------------
// Common metadata columns shared by every family table except
// `server_metric_events` (leaner, event-shaped) and `server_status_events`
// (untouched v3 shape). The sequence number and the topology and boot
// generations are not stored: nothing reads them, and the hosted store does not
// keep them either (see `../../field-registry.ts`).
// ---------------------------------------------------------------------------

export const COMMON_METADATA_COLUMNS = [
  'server_id',
  'sampled_at',
  'received_at',
  'interval_seconds',
] as const

const COMMON_METADATA_COLUMN_DEFS = [
  'server_id UUID NOT NULL',
  'sampled_at TIMESTAMP NOT NULL',
  'received_at TIMESTAMP NOT NULL',
  'interval_seconds SMALLINT NOT NULL',
]

function indent(lines: readonly string[]): string {
  return lines.map((line) => `    ${line}`).join(',\n')
}

function doubleColumns(names: readonly string[]): string[] {
  return names.map((name) => `${name} DOUBLE`)
}

function hostSamplesTableDdl(): string {
  const metricColumns = HOST_METRIC_FIELD_REFS.map(
    (ref) => `${hostMetricColumnName(ref.group, ref.field)} DOUBLE`
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${HOST_SAMPLES_TABLE} (`,
    indent([
      ...COMMON_METADATA_COLUMN_DEFS,
      ...metricColumns,
      ...doubleColumns(V12_HOST_COLUMNS),
      ...doubleColumns(V12_INGRESS_COLUMNS),
      ...doubleColumns(V12_SIZE_COLUMNS),
    ]),
    `)`,
  ].join('\n')
}

/** DDL for the host facts: one row per sample, one text column per fact. */
function hostTextSamplesTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${HOST_TEXT_SAMPLES_TABLE} (`,
    indent([
      ...COMMON_METADATA_COLUMN_DEFS,
      ...HOST_TEXT_FIELDS.map((field) => `${entityMetricColumnName(field)} VARCHAR`),
    ]),
    `)`,
  ].join('\n')
}

/**
 * DDL for a per-entity family table: common metadata + entity id column(s) +
 * nullable DOUBLE metric columns + VARCHAR text columns.
 */
function entitySamplesTableDdl(
  table: string,
  idColumnDefs: readonly string[],
  metricFields: readonly string[],
  extraDoubleColumns: readonly string[] = [],
  textFields: readonly string[] = []
): string {
  const metricColumns = [
    ...doubleColumns(metricFields.map(entityMetricColumnName)),
    ...doubleColumns(extraDoubleColumns),
    ...textFields.map((field) => `${entityMetricColumnName(field)} VARCHAR`),
  ]
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...idColumnDefs, ...metricColumns]),
    `)`,
  ].join('\n')
}

function networkSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    NETWORK_SAMPLES_TABLE,
    ['device_id VARCHAR NOT NULL'],
    NETWORK_METRIC_FIELDS
  )
}

function filesystemSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    FILESYSTEM_SAMPLES_TABLE,
    ['filesystem_id VARCHAR NOT NULL'],
    FILESYSTEM_METRIC_FIELDS
  )
}

function blockSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    BLOCK_SAMPLES_TABLE,
    ['device_id VARCHAR NOT NULL'],
    BLOCK_METRIC_FIELDS,
    [],
    BLOCK_TEXT_FIELDS
  )
}

function gpuSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    GPU_SAMPLES_TABLE,
    ['gpu_id VARCHAR NOT NULL'],
    GPU_METRIC_FIELDS,
    [],
    GPU_TEXT_FIELDS
  )
}

/** Singleton per sample (no entity id column) — one row per sample when `router` is present. */
function routerSamplesTableDdl(): string {
  return entitySamplesTableDdl(ROUTER_SAMPLES_TABLE, [], ROUTER_METRIC_FIELDS)
}

/**
 * Singleton per sample (no entity id column) — one row per sample when
 * `storage` is present: the used and free byte totals, then the per-engine
 * census.
 */
function storageSamplesTableDdl(): string {
  return entitySamplesTableDdl(STORAGE_SAMPLES_TABLE, [], storageSamplesMetricFields())
}

/**
 * Singleton per sample (no entity id column) — one row per sample when
 * `dockerUsage` survives the capability plan. Its own table so the hosted
 * `managed.docker` family boundary stays reproducible on this backend.
 */
function dockerSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    DOCKER_SAMPLES_TABLE,
    [],
    DOCKER_USAGE_METRIC_FIELDS,
    V12_DOCKER_COLUMNS
  )
}

/** Singleton per sample (no entity id column) — one row per sample when `diagnostics` is present. */
function memoryDiagnosticsSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    MEMORY_DIAGNOSTICS_SAMPLES_TABLE,
    [],
    MEMORY_DIAGNOSTICS_METRIC_FIELDS
  )
}

/** Long-form table: one row per (sample, signal), `kind` + `value` columns rather than one column per signal kind. */
function hardwareSignalSamplesTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${HARDWARE_SIGNAL_SAMPLES_TABLE} (`,
    indent([
      ...COMMON_METADATA_COLUMN_DEFS,
      'signal_id VARCHAR NOT NULL',
      'kind VARCHAR NOT NULL',
      'value DOUBLE',
    ]),
    `)`,
  ].join('\n')
}

function ingressSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    INGRESS_SAMPLES_TABLE,
    ['source_id VARCHAR NOT NULL', 'source_kind VARCHAR NOT NULL'],
    INGRESS_METRIC_FIELDS
  )
}

function databaseProxySamplesTableDdl(): string {
  return entitySamplesTableDdl(
    DATABASE_PROXY_SAMPLES_TABLE,
    ['source_id VARCHAR NOT NULL', 'source_kind VARCHAR NOT NULL'],
    DATABASE_PROXY_METRIC_FIELDS
  )
}

/** Discrete event rows (`METRIC_EVENT_KINDS`) — leaner shape than the sample tables, no interval column. */
function metricEventsTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${METRIC_EVENTS_TABLE} (`,
    indent([
      'server_id UUID NOT NULL',
      'event_id VARCHAR NOT NULL',
      `"at" TIMESTAMP NOT NULL`,
      'received_at TIMESTAMP NOT NULL',
      'kind VARCHAR NOT NULL',
      'severity VARCHAR NOT NULL',
      'entity_id VARCHAR',
      'source VARCHAR',
      'payload VARCHAR',
    ]),
    `)`,
  ].join('\n')
}

/** Latest-only facts row: `facts` holds the JSON the reader parses (`query/host-facts.ts`). */
function hostFactsTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${HOST_FACTS_TABLE} (`,
    indent([
      'server_id UUID PRIMARY KEY',
      'sampled_at TIMESTAMP NOT NULL',
      'facts VARCHAR NOT NULL',
    ]),
    `)`,
  ].join('\n')
}

function statusEventsTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${STATUS_EVENTS_TABLE} (`,
    indent([
      'server_id UUID NOT NULL',
      `"at" TIMESTAMP NOT NULL`,
      'connected BOOLEAN NOT NULL',
      'reason VARCHAR NOT NULL',
    ]),
    `)`,
  ].join('\n')
}

/** `(server_id, sampled_at)` + `(server_id, <entity id>, sampled_at)` indexes for a per-entity family table. */
function entityIndexes(table: string, idColumn: string): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${table}_server_time ON ${table} (server_id, sampled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_entity ON ${table} (server_id, ${idColumn}, sampled_at)`,
  ]
}

function serverTimeIndex(table: string): string {
  return `CREATE INDEX IF NOT EXISTS idx_${table}_server_time ON ${table} (server_id, sampled_at)`
}

/**
 * Ordered idempotent DDL for every table plus the range-scan indexes queries
 * scan on: `(server_id, <time column>)` for every family table, plus
 * `(server_id, <entity id>, sampled_at)` for the per-entity families.
 */
export function buildSchemaStatements(): string[] {
  return [
    hostSamplesTableDdl(),
    serverTimeIndex(HOST_SAMPLES_TABLE),
    hostTextSamplesTableDdl(),
    serverTimeIndex(HOST_TEXT_SAMPLES_TABLE),
    networkSamplesTableDdl(),
    ...entityIndexes(NETWORK_SAMPLES_TABLE, 'device_id'),
    filesystemSamplesTableDdl(),
    ...entityIndexes(FILESYSTEM_SAMPLES_TABLE, 'filesystem_id'),
    blockSamplesTableDdl(),
    ...entityIndexes(BLOCK_SAMPLES_TABLE, 'device_id'),
    gpuSamplesTableDdl(),
    ...entityIndexes(GPU_SAMPLES_TABLE, 'gpu_id'),
    memoryDiagnosticsSamplesTableDdl(),
    serverTimeIndex(MEMORY_DIAGNOSTICS_SAMPLES_TABLE),
    hardwareSignalSamplesTableDdl(),
    ...entityIndexes(HARDWARE_SIGNAL_SAMPLES_TABLE, 'signal_id'),
    ingressSamplesTableDdl(),
    ...entityIndexes(INGRESS_SAMPLES_TABLE, 'source_id'),
    databaseProxySamplesTableDdl(),
    ...entityIndexes(DATABASE_PROXY_SAMPLES_TABLE, 'source_id'),
    routerSamplesTableDdl(),
    serverTimeIndex(ROUTER_SAMPLES_TABLE),
    storageSamplesTableDdl(),
    serverTimeIndex(STORAGE_SAMPLES_TABLE),
    dockerSamplesTableDdl(),
    serverTimeIndex(DOCKER_SAMPLES_TABLE),
    metricEventsTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${METRIC_EVENTS_TABLE}_server_time ON ${METRIC_EVENTS_TABLE} (server_id, "at")`,
    statusEventsTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${STATUS_EVENTS_TABLE}_server_time ON ${STATUS_EVENTS_TABLE} (server_id, "at")`,
    hostFactsTableDdl(),
  ]
}

// ---------------------------------------------------------------------------
// Insert column lists (base + entity id(s) + metrics, in DDL order) — the
// single source of truth `store.ts` builds its parameterized INSERTs from.
// ---------------------------------------------------------------------------

export function hostSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    ...HOST_METRIC_FIELD_REFS.map((ref) => hostMetricColumnName(ref.group, ref.field)),
    ...V12_HOST_COLUMNS,
    ...V12_INGRESS_COLUMNS,
    ...V12_SIZE_COLUMNS,
  ]
}

export function hostTextSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, ...HOST_TEXT_FIELDS.map(entityMetricColumnName)]
}

export function networkSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'device_id',
    ...NETWORK_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function filesystemSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'filesystem_id',
    ...FILESYSTEM_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function blockSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'device_id',
    ...BLOCK_METRIC_FIELDS.map(entityMetricColumnName),
    ...BLOCK_TEXT_FIELDS.map(entityMetricColumnName),
  ]
}

export function gpuSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'gpu_id',
    ...GPU_METRIC_FIELDS.map(entityMetricColumnName),
    ...GPU_TEXT_FIELDS.map(entityMetricColumnName),
  ]
}

export function memoryDiagnosticsSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    ...MEMORY_DIAGNOSTICS_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function hardwareSignalSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, 'signal_id', 'kind', 'value']
}

export function ingressSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'source_id',
    'source_kind',
    ...INGRESS_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function databaseProxySamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'source_id',
    'source_kind',
    ...DATABASE_PROXY_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function routerSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, ...ROUTER_METRIC_FIELDS.map(entityMetricColumnName)]
}

/**
 * `server_storage_samples`' metric fields, in DDL order: the stored flat
 * totals, then the stored per-engine census. The single source of truth the
 * DDL and `store.ts`'s parameterized INSERT both derive from, so a column can
 * never be declared in one order and bound in another.
 */
export function storageSamplesMetricFields(): string[] {
  return [...STORAGE_FLAT_METRIC_FIELDS, ...STORAGE_ENGINE_METRIC_FIELDS]
}

export function storageSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, ...storageSamplesMetricFields().map(entityMetricColumnName)]
}

export function dockerSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    ...DOCKER_USAGE_METRIC_FIELDS.map(entityMetricColumnName),
    ...V12_DOCKER_COLUMNS,
  ]
}

export function metricEventsInsertColumns(): string[] {
  return [
    'server_id',
    'event_id',
    `"at"`,
    'received_at',
    'kind',
    'severity',
    'entity_id',
    'source',
    'payload',
  ]
}

// ---------------------------------------------------------------------------
// Module-load invariant: no duplicate `group.field` entry in
// `HOST_METRIC_FIELD_REFS` (which would silently drop or double-count a
// column). Full coverage of every `HostMetrics` leaf is guaranteed at
// compile time instead: `HOST_GROUP_MARKERS` is `Record<keyof HostMetrics, true>`
// (every group covered), and each group's own `Record<keyof T, true>`
// literal (`HOST_CPU_FIELDS` etc.) covers every field within it — a field or
// group added to `contract.ts` without a matching literal entry fails the
// TypeScript build. Whether a field is stored is the registry's decision, and
// `field-registry.test.ts` checks the columns against it.
// ---------------------------------------------------------------------------

function assertHostFieldRefsCoverContract(): void {
  const declared = new Set(HOST_METRIC_FIELD_REFS.map((ref) => `${ref.group}.${ref.field}`))
  if (declared.size !== HOST_METRIC_FIELD_REFS.length) {
    throw new TypeError('HOST_METRIC_FIELD_REFS has duplicate group.field entries')
  }
}
assertHostFieldRefsCoverContract()
