import { assertEquals, assertThrows } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSample } from '../../../../contracts/metrics-contract.ts'
import {
  BLOCK_METRIC_FIELDS,
  BLOCK_SAMPLES_TABLE,
  buildSchemaStatements,
  DATABASE_PROXY_METRIC_FIELDS,
  COMMON_METADATA_COLUMNS,
  DATABASE_PROXY_SAMPLES_TABLE,
  DOCKER_SAMPLES_TABLE,
  DOCKER_USAGE_METRIC_FIELDS,
  dockerSamplesInsertColumns,
  DUCKDB_SCHEMA_MARKER_VERSION,
  V12_DOCKER_COLUMNS,
  V12_HOST_COLUMNS,
  V12_SIZE_COLUMNS,
  V12_INGRESS_COLUMNS,
  entityMetricColumnName,
  FILESYSTEM_METRIC_FIELDS,
  FILESYSTEM_SAMPLES_TABLE,
  GPU_METRIC_FIELDS,
  GPU_SAMPLES_TABLE,
  HARDWARE_SIGNAL_SAMPLES_TABLE,
  HOST_TEXT_FIELDS,
  HOST_TEXT_SAMPLES_TABLE,
  hostTextSamplesInsertColumns,
  BLOCK_TEXT_FIELDS,
  GPU_TEXT_FIELDS,
  HOST_METRIC_FIELD_REFS,
  HOST_SAMPLES_TABLE,
  hostMetricColumnName,
  hostSamplesInsertColumns,
  INGRESS_METRIC_FIELDS,
  INGRESS_SAMPLES_TABLE,
  MEMORY_DIAGNOSTICS_METRIC_FIELDS,
  MEMORY_DIAGNOSTICS_SAMPLES_TABLE,
  memoryDiagnosticsSamplesInsertColumns,
  METRIC_EVENTS_TABLE,
  STORAGE_ENGINE_METRIC_FIELDS,
  STORAGE_SAMPLES_TABLE,
  storageSamplesInsertColumns,
  storageSamplesMetricFields,
  NETWORK_METRIC_FIELDS,
  NETWORK_SAMPLES_TABLE,
  STATUS_EVENTS_TABLE,
} from './schema.ts'

it('DuckDB schema marker is 12', () => {
  assertEquals(DUCKDB_SCHEMA_MARKER_VERSION, 12)
})

it('the DDL carries every extended numeric column', () => {
  assertEquals(V12_HOST_COLUMNS.length, 7)
  assertEquals(V12_DOCKER_COLUMNS.length, 8)
  assertEquals(V12_INGRESS_COLUMNS, ['ext_tls_cert_soonest_expiry_days'])
  const ddl = buildSchemaStatements().join('\n')
  for (const column of [...V12_HOST_COLUMNS, ...V12_DOCKER_COLUMNS, ...V12_INGRESS_COLUMNS]) {
    assertEquals(ddl.includes(`${column} DOUBLE`), true, column)
  }
})

it('hostMetricColumnName prefixes by group, avoiding cross-group collisions', () => {
  assertEquals(hostMetricColumnName('cpu', 'pressureSomePercent'), 'cpu_pressure_some_percent')
  assertEquals(
    hostMetricColumnName('memory', 'pressureSomePercent'),
    'memory_pressure_some_percent'
  )
  assertEquals(hostMetricColumnName('cpu', 'busyPercent'), 'cpu_busy_percent')
  assertThrows(() => hostMetricColumnName('cpu', 'nope'), TypeError, 'unknown host metrics field')
})

it('entityMetricColumnName maps camelCase fields to snake_case', () => {
  assertEquals(entityMetricColumnName('receiveBytesPerSecond'), 'receive_bytes_per_second')
  assertEquals(entityMetricColumnName('queueDepth'), 'queue_depth')
})

it('HOST_METRIC_FIELD_REFS has exactly the 22 stored entries covering every host group, no duplicates', () => {
  assertEquals(HOST_METRIC_FIELD_REFS.length, 22)
  const columns = HOST_METRIC_FIELD_REFS.map((ref) => hostMetricColumnName(ref.group, ref.field))
  assertEquals(new Set(columns).size, columns.length)
  for (const column of columns) {
    assertEquals(/^[a-z][a-z0-9_]*$/.test(column), true, column)
  }
})

it('every leaf metric of a real v5 sample maps to a known host column', () => {
  const sample = buildMetricsSample({
    metadata: {
      version: 6,
      sampledAt: new Date().toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: 1,
        userPercent: 1,
        systemPercent: 1,
        iowaitPercent: 1,
        stealPercent: 1,
        softirqPercent: 1,
        pressureSomePercent: 1,
        saturatedCoreCount: 1,
        procsRunning: 1,
        procsBlocked: 1,
        processCount: 1,
      },
      kernel: { fileHandlesUsedPercent: 1, conntrackUsedPercent: 1 },
      memory: {
        usedBytes: 1,
        cachedFilesBytes: null,
        swapUsedBytes: 1,
        pressureSomePercent: 1,
        pressureFullPercent: 1,
        swapInBytesPerSecond: 1,
        swapOutBytesPerSecond: 1,
        majorPageFaultsPerSecond: 1,
      },
      storage: {
        ioPressureSomePercent: 1,
        ioPressureFullPercent: 1,
        diskReadBytesPerSecond: 1,
        diskWriteBytesPerSecond: 1,
        diskLatencyMs: 1.8,
        rootFilesystemAvailableBytes: 1,
        rootFilesystemFreeInodes: 1,
      },
      network: { tcpRetransmitPercent: 1, softnetDropsPerSecond: 1 },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  })
  const columnSet = new Set(hostSamplesInsertColumns())
  const stored = new Set(HOST_METRIC_FIELD_REFS.map((ref) => `${ref.group}.${ref.field}`))
  for (const group of ['cpu', 'kernel', 'memory', 'storage', 'network'] as const) {
    for (const field of Object.keys(sample.host[group])) {
      // A leaf the registry stores has a column; one it does not store has none.
      assertEquals(
        columnSet.has(hostMetricColumnName(group, field)),
        stored.has(`${group}.${field}`)
      )
    }
  }
})

it('buildSchemaStatements emits idempotent DDL for every v5 table', () => {
  const statements = buildSchemaStatements()
  const joined = statements.join('\n')
  assertEquals(
    statements.every(
      (sql) =>
        sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')
    ),
    true
  )
  for (const table of [
    HOST_SAMPLES_TABLE,
    HOST_TEXT_SAMPLES_TABLE,
    NETWORK_SAMPLES_TABLE,
    FILESYSTEM_SAMPLES_TABLE,
    BLOCK_SAMPLES_TABLE,
    GPU_SAMPLES_TABLE,
    MEMORY_DIAGNOSTICS_SAMPLES_TABLE,
    HARDWARE_SIGNAL_SAMPLES_TABLE,
    INGRESS_SAMPLES_TABLE,
    DATABASE_PROXY_SAMPLES_TABLE,
    STORAGE_SAMPLES_TABLE,
    DOCKER_SAMPLES_TABLE,
    METRIC_EVENTS_TABLE,
    STATUS_EVENTS_TABLE,
  ]) {
    assertEquals(joined.includes(`CREATE TABLE IF NOT EXISTS ${table}`), true, table)
    assertEquals(joined.includes(`ON ${table} (server_id, `), true, table)
  }
  // No positional AE layout ever leaks into DuckDB.
  assertEquals(/\bdouble\d+\b/.test(joined), false)
  assertEquals(/\bblob\d+\b/.test(joined), false)
  assertEquals(joined.includes('index1'), false)
  // No v3 marker columns survive the cutover.
  assertEquals(joined.includes(' parts '), false)
  assertEquals(joined.includes('hardware_profile_generation'), false)
  // The sequence number and the generations are not stored.
  assertEquals(joined.includes('topology_generation'), false)
  assertEquals(joined.includes('boot_generation'), false)
  assertEquals(joined.includes('sequence'), false)
  // Per-entity index shape.
  assertEquals(
    joined.includes(`ON ${NETWORK_SAMPLES_TABLE} (server_id, device_id, sampled_at)`),
    true
  )
  assertEquals(joined.includes(`ON ${GPU_SAMPLES_TABLE} (server_id, gpu_id, sampled_at)`), true)
  assertEquals(joined.includes(`ON ${METRIC_EVENTS_TABLE} (server_id, "at")`), true)
  assertEquals(joined.includes(`ON ${STATUS_EVENTS_TABLE} (server_id, "at")`), true)
  // Every host metric key gets a nullable DOUBLE column.
  for (const ref of HOST_METRIC_FIELD_REFS) {
    assertEquals(
      joined.includes(`${hostMetricColumnName(ref.group, ref.field)} DOUBLE`),
      true,
      `${ref.group}.${ref.field}`
    )
  }
  // Long-form hardware-signal table: kind + value, not one column per signal kind.
  assertEquals(joined.includes('kind VARCHAR NOT NULL'), true)
  assertEquals(joined.includes('value DOUBLE'), true)
  // The diagnostics CPU half is not stored.
  assertEquals(joined.includes('cpu_diagnostics_'), false)
  // Host facts and device facts are text columns.
  assertEquals(joined.includes('loadavg VARCHAR'), true)
  assertEquals(joined.includes('smart VARCHAR'), true)
  assertEquals(joined.includes('driver VARCHAR'), true)
  for (const field of MEMORY_DIAGNOSTICS_METRIC_FIELDS) {
    assertEquals(
      joined.includes(`${entityMetricColumnName(field)} DOUBLE`),
      true,
      `diagnostics.${field}`
    )
  }
  // v6 dropped the sample-level collection-mode column outright.
  assertEquals(joined.includes('collection_mode'), false)
  // The seven meminfo gauges v6 dropped have no column anywhere.
  for (const dropped of [
    'page_tables_bytes',
    'kernel_stack_bytes',
    'commit_limit_bytes',
    'active_anon_bytes',
    'inactive_anon_bytes',
    'active_file_bytes',
    'inactive_file_bytes',
  ]) {
    // `ext_commit_limit_bytes` is the v12 size column, not the dropped diagnostics gauge.
    assertEquals(new RegExp(`(?<![a-z_])${dropped}`).test(joined), false, dropped)
  }
})

it('memoryDiagnosticsSamplesInsertColumns is a singleton (no entity id column) holding the one stored reading', () => {
  const columns = memoryDiagnosticsSamplesInsertColumns()
  assertEquals(MEMORY_DIAGNOSTICS_METRIC_FIELDS, ['committedAsBytes'])
  assertEquals(columns, [...COMMON_METADATA_COLUMNS, 'committed_as_bytes'])
})

it('hostSamplesInsertColumns lists common metadata then every stored host metric column', () => {
  const columns = hostSamplesInsertColumns()
  assertEquals(
    columns.length,
    COMMON_METADATA_COLUMNS.length +
      HOST_METRIC_FIELD_REFS.length +
      V12_HOST_COLUMNS.length +
      V12_INGRESS_COLUMNS.length +
      V12_SIZE_COLUMNS.length
  )
  assertEquals(columns.slice(0, 4), ['server_id', 'sampled_at', 'received_at', 'interval_seconds'])
  assertEquals(columns.includes('cpu_busy_percent'), true)
  assertEquals(columns.includes('memory_pressure_some_percent'), true)
  // Values neither edition stores have no column.
  assertEquals(columns.includes('cpu_process_count'), false)
  assertEquals(columns.includes('cpu_diagnostics_average_frequency_m_hz'), false)
})

it('server_host_text_samples has one text column per host fact', () => {
  const columns = hostTextSamplesInsertColumns()
  assertEquals(HOST_TEXT_FIELDS.length, 28)
  assertEquals(
    columns.slice(COMMON_METADATA_COLUMNS.length),
    HOST_TEXT_FIELDS.map(entityMetricColumnName)
  )
  assertEquals(columns.includes('top_cpu'), true)
  assertEquals(columns.includes('unhealthy_containers'), true)
})

it('device tables carry their text facts after their numbers', () => {
  assertEquals(BLOCK_TEXT_FIELDS, ['model', 'smart'])
  assertEquals(GPU_TEXT_FIELDS, ['driver', 'model'])
  assertEquals(BLOCK_METRIC_FIELDS.includes('opsPerSecond'), true)
  assertEquals(BLOCK_METRIC_FIELDS.includes('readOpsPerSecond'), false)
  assertEquals(NETWORK_METRIC_FIELDS.includes('problemsPerSecond'), true)
  assertEquals(NETWORK_METRIC_FIELDS.includes('linkSpeedMbps'), true)
})

it('every entity family declares a non-empty, unique field list', () => {
  for (const fields of [
    NETWORK_METRIC_FIELDS,
    FILESYSTEM_METRIC_FIELDS,
    BLOCK_METRIC_FIELDS,
    GPU_METRIC_FIELDS,
    INGRESS_METRIC_FIELDS,
    DATABASE_PROXY_METRIC_FIELDS,
  ]) {
    assertEquals(fields.length > 0, true)
    assertEquals(new Set(fields).size, fields.length)
  }
})

// ---------------------------------------------------------------------------
// managed.storage / managed.docker — the two v6 host-wide storage tables.
// ---------------------------------------------------------------------------

it('server_storage_samples carries the stored totals and the per-engine census, nothing about Docker', () => {
  const columns = storageSamplesMetricFields().map(entityMetricColumnName)
  assertEquals(columns.slice(0, 3), [
    'hosting_used_bytes',
    'backup_used_bytes',
    'backup_free_bytes',
  ])
  // The instance counts of the three engines, flattened `<engine><Field>`.
  assertEquals(columns.includes('postgres_instances_running'), true)
  assertEquals(columns.includes('mariadb_instances_healthy'), true)
  assertEquals(STORAGE_ENGINE_METRIC_FIELDS.length, 6)
  // The connection counts and the values neither edition stores have no column.
  assertEquals(columns.includes('mariadb_connections_max'), false)
  assertEquals(columns.includes('docker_used_bytes'), false)
  assertEquals(
    columns.some((column) => column.startsWith('docker_')),
    false
  )
  assertEquals(new Set(columns).size, columns.length)
})

it('storageSamplesInsertColumns is metadata + metrics, with no topology id columns', () => {
  const columns = storageSamplesInsertColumns()
  assertEquals(columns, [
    ...COMMON_METADATA_COLUMNS,
    ...storageSamplesMetricFields().map(entityMetricColumnName),
  ])
})

it('server_docker_samples mirrors the AE managed.docker family exactly, unprefixed', () => {
  const columns = dockerSamplesInsertColumns()
  assertEquals(columns.slice(COMMON_METADATA_COLUMNS.length), [
    ...DOCKER_USAGE_METRIC_FIELDS.map(entityMetricColumnName),
    ...V12_DOCKER_COLUMNS,
  ])
  assertEquals(DOCKER_USAGE_METRIC_FIELDS.length, 4)
  assertEquals(columns.includes('layers_bytes'), true)
  assertEquals(columns.includes('docker_layers_bytes'), false)
})

it('the storage and docker tables carry no entity id column, like the router table', () => {
  const joined = buildSchemaStatements().join('\n')
  const storageDdl = joined.slice(
    joined.indexOf(`CREATE TABLE IF NOT EXISTS ${STORAGE_SAMPLES_TABLE}`)
  )
  assertEquals(storageDdl.includes('source_id'), false)
  const dockerDdl = joined.slice(
    joined.indexOf(`CREATE TABLE IF NOT EXISTS ${DOCKER_SAMPLES_TABLE}`),
    joined.indexOf(`CREATE INDEX IF NOT EXISTS idx_${DOCKER_SAMPLES_TABLE}`)
  )
  assertEquals(dockerDdl.includes('source_id'), false)
  assertEquals(dockerDdl.includes('gpu_id'), false)
})
