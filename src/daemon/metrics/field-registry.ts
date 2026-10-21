/**
 * The one list of every value the metrics stores keep, and where each lives.
 *
 * Both editions store the same readings: the hosted edition (Analytics
 * Engine, positional slots) and the self-hosted edition (DuckDB, named
 * columns). Before this file the two layouts were kept by hand in four places
 * (the contract field lists, `metric-descriptors.ts`, `backends/cloudflare/v8-layout.ts`
 * and `backends/duckdb/schema.ts`) and nothing stopped a value landing in one
 * store only. Now every value is one entry here with a home in each store, and
 * `field-registry.test.ts` fails when either store disagrees with it.
 *
 * Rules the types and tests enforce:
 *  - a contract value is in exactly one of {@link STORED_FIELDS} or
 *    {@link NOT_STORED_FIELDS};
 *  - a stored value has a home in both stores (there is no "null" home);
 *  - both stores hold exactly the registered slots and columns and no others,
 *    except what {@link KNOWN_GAPS} lists. The list only ever shrinks, and the
 *    release goal is that it is empty.
 *
 * Slot positions are written by hand, because positions are the format. The
 * tests check them against the code; they do not choose them.
 *
 * This file imports nothing, so both the Workers build and the Deno build can
 * load it.
 */

/** The host rows written once per sample (the `managed.database` row only while a database runs). */
export type RegistryHostRow =
  'host.system' | 'host.io' | 'host.network' | 'host.web' | 'managed.database'

/** The device rows, written once per page of devices. */
export type RegistryEntityRow = 'block' | 'network' | 'filesystem' | 'gpu' | 'hardware.physical'

/**
 * Where a value sits in the hosted layout.
 *
 * Host rows use the physical number slot (`double`, 1 to 19) or text slot
 * (`blob`, the physical text position, 7 and up). Device rows use the value's
 * position inside one device's group (`entityDouble`, `entityBlob`, both
 * counted from 1), because a device row repeats that group for each device on
 * the page. A device row's own text (`blob`) is one value for the whole row.
 */
export type RegistryHostedHome =
  | { row: RegistryHostRow; double: number }
  | { row: RegistryHostRow; blob: number }
  | { row: RegistryEntityRow; entityDouble: number }
  | { row: RegistryEntityRow; entityBlob: number }
  | { row: RegistryEntityRow; blob: number }

export const REGISTRY_TABLES = {
  host: 'server_host_samples',
  hostText: 'server_host_text_samples',
  network: 'server_network_samples',
  filesystem: 'server_filesystem_samples',
  block: 'server_block_samples',
  gpu: 'server_gpu_samples',
  hardwareSignal: 'server_hardware_signal_samples',
  ingress: 'server_ingress_samples',
  databaseProxy: 'server_database_proxy_samples',
  router: 'server_router_samples',
  storage: 'server_storage_samples',
  docker: 'server_docker_samples',
  memoryDiagnostics: 'server_memory_diagnostics_samples',
} as const

export type RegistryTable = keyof typeof REGISTRY_TABLES

/**
 * The one layout number of the stored metrics, used by both editions: the
 * hosted row stamp (blob3), the hosted dataset name suffix
 * (`turbopanel_server_metrics_v<N>`) and the self-hosted schema marker. It is
 * the control plane's own number: the wire version the daemon speaks
 * (`METRICS_SCHEMA_VERSION`) is a different thing and stays 8.
 *
 * It moves only when a stored layout changes incompatibly (a slot changes
 * meaning, a column is removed or re-typed) and never goes down: a lower number
 * would make an existing self-hosted file look newer than the program and
 * refuse to open. Additive changes (a value in a spare slot, a column added
 * in place) do not move it. 12 because the self-hosted marker was already at
 * 11; rows and files at an earlier number are skipped by the readers and
 * rebuilt (the earlier layouts were only ever on the canary).
 */
export const METRICS_LAYOUT_VERSION = 12 as const

/** Where a value sits in the self-hosted store: a table (a key of {@link REGISTRY_TABLES}) and a column. */
export type RegistryDuckDbHome = { table: RegistryTable; column: string }

/**
 * How often a value is written. Every value is refreshed once a minute: a slow
 * reading (Docker disk use, storage, drive health, host facts) is sent again
 * each minute from its last known value, so no minute has a hole.
 */
export type RegistryCadence = 'every-sample'

export type StoredField = {
  /** Descriptor name (`host.cpu.busyPercent`), `text.<key>` for a host fact, or `<device>.<field>`. */
  id: string
  kind: 'number' | 'text'
  cadence: RegistryCadence
  hosted: RegistryHostedHome
  /** Further hosted places that repeat the value (a NIC embedded in a host row, the lone extra disk). */
  hostedAlso?: readonly RegistryHostedHome[]
  duckdb: RegistryDuckDbHome
  /**
   * `same`: stored the same way in both. `hosted-text-number`: a number the
   * hosted store keeps as text on a device row (sizes, link speed); the
   * self-hosted store keeps it as a number.
   */
  encoding: 'same' | 'hosted-text-number'
}

export type NotStoredField = {
  id: string
  /** `dropped`: owner decision. `left-out`: named in the audit's left-out column. `not-named`: not named there. */
  why: 'dropped' | 'left-out' | 'not-named'
  note: string
}

function field(
  kind: StoredField['kind'],
  id: string,
  hosted: RegistryHostedHome,
  table: RegistryTable,
  column: string,
  extra: Partial<StoredField>
): StoredField {
  return {
    id,
    kind,
    cadence: 'every-sample',
    hosted,
    duckdb: { table, column },
    encoding: 'same',
    ...extra,
  }
}

function num(
  id: string,
  hosted: RegistryHostedHome,
  table: RegistryTable,
  column: string,
  extra: Partial<StoredField> = {}
): StoredField {
  return field('number', id, hosted, table, column, extra)
}

function text(
  id: string,
  hosted: RegistryHostedHome,
  table: RegistryTable,
  column: string,
  extra: Partial<StoredField> = {}
): StoredField {
  return field('text', id, hosted, table, column, extra)
}

/**
 * Every value both stores keep. Numbers first (in descriptor order), then the
 * device sizes and facts, then the host facts that ride as text.
 */
export const STORED_FIELDS: readonly StoredField[] = [
  num('host.cpu.busyPercent', { row: 'host.system', double: 1 }, 'host', 'cpu_busy_percent'),
  num('host.cpu.userPercent', { row: 'host.system', double: 2 }, 'host', 'cpu_user_percent'),
  num('host.cpu.systemPercent', { row: 'host.system', double: 3 }, 'host', 'cpu_system_percent'),
  num('host.cpu.iowaitPercent', { row: 'host.system', double: 4 }, 'host', 'cpu_iowait_percent'),
  num('host.cpu.stealPercent', { row: 'host.system', double: 5 }, 'host', 'cpu_steal_percent'),
  num('host.cpu.softirqPercent', { row: 'host.system', double: 6 }, 'host', 'cpu_softirq_percent'),
  num(
    'host.cpu.pressureSomePercent',
    { row: 'host.system', double: 8 },
    'host',
    'cpu_pressure_some_percent'
  ),
  num(
    'host.kernel.fileHandlesUsedPercent',
    { row: 'host.web', double: 17 },
    'host',
    'kernel_file_handles_used_percent'
  ),
  num(
    'host.kernel.conntrackUsedPercent',
    { row: 'host.web', double: 16 },
    'host',
    'kernel_conntrack_used_percent'
  ),
  num('host.memory.usedBytes', { row: 'host.system', double: 12 }, 'host', 'memory_used_bytes'),
  num(
    'host.memory.cachedFilesBytes',
    { row: 'host.system', double: 13 },
    'host',
    'memory_cached_files_bytes'
  ),
  num(
    'host.memory.swapUsedBytes',
    { row: 'host.system', double: 14 },
    'host',
    'memory_swap_used_bytes'
  ),
  num(
    'host.memory.pressureSomePercent',
    { row: 'host.system', double: 10 },
    'host',
    'memory_pressure_some_percent'
  ),
  num(
    'host.memory.pressureFullPercent',
    { row: 'host.system', double: 11 },
    'host',
    'memory_pressure_full_percent'
  ),
  num(
    'host.storage.ioPressureSomePercent',
    { row: 'host.io', double: 1 },
    'host',
    'storage_io_pressure_some_percent'
  ),
  num(
    'host.storage.ioPressureFullPercent',
    { row: 'host.io', double: 2 },
    'host',
    'storage_io_pressure_full_percent'
  ),
  num(
    'host.storage.diskReadBytesPerSecond',
    { row: 'host.io', double: 3 },
    'host',
    'storage_disk_read_bytes_per_second'
  ),
  num(
    'host.storage.diskWriteBytesPerSecond',
    { row: 'host.io', double: 4 },
    'host',
    'storage_disk_write_bytes_per_second'
  ),
  num(
    'host.storage.diskLatencyMs',
    { row: 'host.io', double: 5 },
    'host',
    'storage_disk_latency_ms'
  ),
  num(
    'host.storage.rootFilesystemAvailableBytes',
    { row: 'host.io', double: 8 },
    'host',
    'storage_root_filesystem_available_bytes'
  ),
  num(
    'host.storage.rootFilesystemFreeInodes',
    { row: 'host.io', double: 10 },
    'host',
    'storage_root_filesystem_free_inodes'
  ),
  num(
    'host.network.tcpRetransmitPercent',
    { row: 'host.network', double: 1 },
    'host',
    'network_tcp_retransmit_percent'
  ),
  num(
    'network.receiveBytesPerSecond',
    { row: 'network', entityDouble: 1 },
    'network',
    'receive_bytes_per_second',
    {
      hostedAlso: [
        { row: 'host.network', double: 2 },
        { row: 'host.network', double: 5 },
      ],
    }
  ),
  num(
    'network.transmitBytesPerSecond',
    { row: 'network', entityDouble: 2 },
    'network',
    'transmit_bytes_per_second',
    {
      hostedAlso: [
        { row: 'host.network', double: 3 },
        { row: 'host.network', double: 6 },
      ],
    }
  ),
  num(
    'network.receiveErrorsPerSecond',
    { row: 'network', entityDouble: 3 },
    'network',
    'receive_errors_per_second'
  ),
  num(
    'network.transmitErrorsPerSecond',
    { row: 'network', entityDouble: 4 },
    'network',
    'transmit_errors_per_second'
  ),
  num(
    'network.receiveDropsPerSecond',
    { row: 'network', entityDouble: 5 },
    'network',
    'receive_drops_per_second'
  ),
  num(
    'network.transmitDropsPerSecond',
    { row: 'network', entityDouble: 6 },
    'network',
    'transmit_drops_per_second'
  ),
  num(
    'filesystem.availableBytes',
    { row: 'filesystem', entityDouble: 1 },
    'filesystem',
    'available_bytes',
    { hostedAlso: [{ row: 'host.io', double: 12 }] }
  ),
  num(
    'filesystem.freeInodes',
    { row: 'filesystem', entityDouble: 2 },
    'filesystem',
    'free_inodes',
    { hostedAlso: [{ row: 'host.io', double: 14 }] }
  ),
  num(
    'block.readBytesPerSecond',
    { row: 'block', entityDouble: 1 },
    'block',
    'read_bytes_per_second'
  ),
  num(
    'block.writeBytesPerSecond',
    { row: 'block', entityDouble: 2 },
    'block',
    'write_bytes_per_second'
  ),
  num('block.readLatencyMs', { row: 'block', entityDouble: 4 }, 'block', 'read_latency_ms'),
  num('block.writeLatencyMs', { row: 'block', entityDouble: 5 }, 'block', 'write_latency_ms'),
  num('block.queueDepth', { row: 'block', entityDouble: 6 }, 'block', 'queue_depth'),
  num('gpu.utilizationPercent', { row: 'gpu', entityDouble: 1 }, 'gpu', 'utilization_percent'),
  num('gpu.memoryUsedBytes', { row: 'gpu', entityDouble: 2 }, 'gpu', 'memory_used_bytes'),
  num(
    'gpu.memoryActivityPercent',
    { row: 'gpu', entityDouble: 3 },
    'gpu',
    'memory_activity_percent'
  ),
  num(
    'gpu.pcieReceiveBytesPerSecond',
    { row: 'gpu', entityDouble: 4 },
    'gpu',
    'pcie_receive_bytes_per_second'
  ),
  num(
    'gpu.pcieTransmitBytesPerSecond',
    { row: 'gpu', entityDouble: 5 },
    'gpu',
    'pcie_transmit_bytes_per_second'
  ),
  num('gpu.throttlePercent', { row: 'gpu', entityDouble: 6 }, 'gpu', 'throttle_percent'),
  num(
    'hardwareSignal.value',
    { row: 'hardware.physical', entityDouble: 1 },
    'hardwareSignal',
    'value'
  ),
  num('ingress.requests', { row: 'host.web', double: 1 }, 'ingress', 'requests'),
  num('ingress.responses4xx', { row: 'host.web', double: 2 }, 'ingress', 'responses4xx'),
  num('ingress.responses5xx', { row: 'host.web', double: 3 }, 'ingress', 'responses5xx'),
  num('ingress.requestErrors', { row: 'host.web', double: 4 }, 'ingress', 'request_errors'),
  num('ingress.requestBytes', { row: 'host.web', double: 5 }, 'ingress', 'request_bytes'),
  num('ingress.responseBytes', { row: 'host.web', double: 6 }, 'ingress', 'response_bytes'),
  num(
    'ingress.requestDurationSecondsSum',
    { row: 'host.web', double: 7 },
    'ingress',
    'request_duration_seconds_sum'
  ),
  num('ingress.bucket100ms', { row: 'host.web', double: 8 }, 'ingress', 'bucket100ms'),
  num('ingress.bucket500ms', { row: 'host.web', double: 9 }, 'ingress', 'bucket500ms'),
  num('ingress.bucket1s', { row: 'host.web', double: 10 }, 'ingress', 'bucket1s'),
  num('ingress.requestsInFlight', { row: 'host.web', double: 11 }, 'ingress', 'requests_in_flight'),
  num('databaseProxy.queries', { row: 'managed.database', double: 7 }, 'databaseProxy', 'queries'),
  num(
    'databaseProxy.slowQueries',
    { row: 'managed.database', double: 8 },
    'databaseProxy',
    'slow_queries'
  ),
  num(
    'databaseProxy.queryLatencyMsAvg',
    { row: 'managed.database', double: 9 },
    'databaseProxy',
    'query_latency_ms_avg'
  ),
  num(
    'databaseProxy.backendLatencyMsAvg',
    { row: 'managed.database', double: 10 },
    'databaseProxy',
    'backend_latency_ms_avg'
  ),
  num(
    'databaseProxy.activeTransactions',
    { row: 'managed.database', double: 11 },
    'databaseProxy',
    'active_transactions'
  ),
  num(
    'databaseProxy.clientConnections',
    { row: 'managed.database', double: 12 },
    'databaseProxy',
    'client_connections'
  ),
  num(
    'databaseProxy.clientConnectionsAborted',
    { row: 'managed.database', double: 13 },
    'databaseProxy',
    'client_connections_aborted'
  ),
  num(
    'databaseProxy.connectionsRejectedMaxConns',
    { row: 'managed.database', double: 14 },
    'databaseProxy',
    'connections_rejected_max_conns'
  ),
  num(
    'databaseProxy.backendConnections',
    { row: 'managed.database', double: 15 },
    'databaseProxy',
    'backend_connections'
  ),
  num(
    'databaseProxy.connectionErrors',
    { row: 'managed.database', double: 16 },
    'databaseProxy',
    'connection_errors'
  ),
  num(
    'databaseProxy.backendsUp',
    { row: 'managed.database', double: 17 },
    'databaseProxy',
    'backends_up'
  ),
  num(
    'databaseProxy.backendsTotal',
    { row: 'managed.database', double: 18 },
    'databaseProxy',
    'backends_total'
  ),
  num('router.backendsTotal', { row: 'host.web', double: 13 }, 'router', 'backends_total'),
  num('router.backendErrors5xx', { row: 'host.web', double: 14 }, 'router', 'backend_errors5xx'),
  num(
    'router.backendLatencyMsAvg',
    { row: 'host.web', double: 15 },
    'router',
    'backend_latency_ms_avg'
  ),
  num('storage.hostingUsedBytes', { row: 'host.io', double: 16 }, 'storage', 'hosting_used_bytes'),
  num('storage.backupUsedBytes', { row: 'host.io', double: 17 }, 'storage', 'backup_used_bytes'),
  num('storage.backupFreeBytes', { row: 'host.io', double: 18 }, 'storage', 'backup_free_bytes'),
  num(
    'storage.postgresInstancesRunning',
    { row: 'managed.database', double: 1 },
    'storage',
    'postgres_instances_running'
  ),
  num(
    'storage.postgresInstancesHealthy',
    { row: 'managed.database', double: 2 },
    'storage',
    'postgres_instances_healthy'
  ),
  num(
    'storage.mysqlInstancesRunning',
    { row: 'managed.database', double: 3 },
    'storage',
    'mysql_instances_running'
  ),
  num(
    'storage.mysqlInstancesHealthy',
    { row: 'managed.database', double: 4 },
    'storage',
    'mysql_instances_healthy'
  ),
  num(
    'storage.mariadbInstancesRunning',
    { row: 'managed.database', double: 5 },
    'storage',
    'mariadb_instances_running'
  ),
  num(
    'storage.mariadbInstancesHealthy',
    { row: 'managed.database', double: 6 },
    'storage',
    'mariadb_instances_healthy'
  ),
  num('dockerUsage.layersBytes', { row: 'host.network', double: 15 }, 'docker', 'layers_bytes'),
  num(
    'dockerUsage.containersBytes',
    { row: 'host.network', double: 16 },
    'docker',
    'containers_bytes'
  ),
  num('dockerUsage.volumesBytes', { row: 'host.network', double: 17 }, 'docker', 'volumes_bytes'),
  num(
    'dockerUsage.buildCacheBytes',
    { row: 'host.network', double: 18 },
    'docker',
    'build_cache_bytes'
  ),
  num(
    'diagnostics.committedAsBytes',
    { row: 'host.system', double: 18 },
    'memoryDiagnostics',
    'committed_as_bytes'
  ),
  num(
    'extended.host.pidLimitUsedPercent',
    { row: 'host.web', double: 18 },
    'host',
    'ext_pid_limit_used_percent'
  ),
  num(
    'extended.host.irqPressureFullPercent',
    { row: 'host.system', double: 9 },
    'host',
    'ext_irq_pressure_full_percent'
  ),
  num('extended.host.oomKills', { row: 'host.system', double: 17 }, 'host', 'ext_oom_kills'),
  num(
    'extended.host.rootDiskQueueDepth',
    { row: 'host.io', double: 6 },
    'host',
    'ext_root_disk_queue_depth'
  ),
  num(
    'extended.host.rootDiskOpsPerSecond',
    { row: 'host.io', double: 7 },
    'host',
    'ext_root_disk_ops_per_second'
  ),
  num(
    'extended.host.systemdUnitsFailed',
    { row: 'host.web', double: 19 },
    'host',
    'ext_systemd_units_failed'
  ),
  num(
    'extended.host.mdArraysDegraded',
    { row: 'host.io', double: 19 },
    'host',
    'ext_md_arrays_degraded'
  ),
  num(
    'extended.docker.containersRunning',
    { row: 'host.network', double: 8 },
    'docker',
    'ext_containers_running'
  ),
  num(
    'extended.docker.containersUnhealthy',
    { row: 'host.network', double: 9 },
    'docker',
    'ext_containers_unhealthy'
  ),
  num(
    'extended.docker.containersRestarting',
    { row: 'host.network', double: 10 },
    'docker',
    'ext_containers_restarting'
  ),
  num(
    'extended.docker.containerOomEvents',
    { row: 'host.network', double: 11 },
    'docker',
    'ext_container_oom_events'
  ),
  num(
    'extended.docker.containerDieEvents',
    { row: 'host.network', double: 12 },
    'docker',
    'ext_container_die_events'
  ),
  num(
    'extended.docker.containersCpuPercent',
    { row: 'host.network', double: 13 },
    'docker',
    'ext_containers_cpu_percent'
  ),
  num(
    'extended.docker.containersMemoryBytes',
    { row: 'host.network', double: 14 },
    'docker',
    'ext_containers_memory_bytes'
  ),
  num(
    'extended.docker.reclaimableBytes',
    { row: 'host.network', double: 19 },
    'docker',
    'ext_reclaimable_bytes'
  ),
  num(
    'extended.ingress.tlsCertSoonestExpiryDays',
    { row: 'host.web', double: 12 },
    'host',
    'ext_tls_cert_soonest_expiry_days'
  ),
  num(
    'extended.sizes.memoryTotalBytes',
    { row: 'host.system', double: 15 },
    'host',
    'ext_memory_total_bytes'
  ),
  num(
    'extended.sizes.swapTotalBytes',
    { row: 'host.system', double: 16 },
    'host',
    'ext_swap_total_bytes'
  ),
  num(
    'extended.sizes.commitLimitBytes',
    { row: 'host.system', double: 19 },
    'host',
    'ext_commit_limit_bytes'
  ),
  num(
    'extended.sizes.logicalCores',
    { row: 'host.system', double: 7 },
    'host',
    'ext_logical_cores'
  ),
  num(
    'extended.sizes.rootFilesystemTotalBytes',
    { row: 'host.io', double: 9 },
    'host',
    'ext_root_filesystem_total_bytes'
  ),
  num(
    'extended.sizes.rootFilesystemTotalInodes',
    { row: 'host.io', double: 11 },
    'host',
    'ext_root_filesystem_total_inodes'
  ),
  num('block.opsPerSecond', { row: 'block', entityDouble: 3 }, 'block', 'ops_per_second'),
  // The derived sum of one embedded NIC's four error and drop rates (NICs 1 and 2 keep only this).
  num(
    'network.problemsPerSecond',
    { row: 'host.network', double: 4 },
    'network',
    'problems_per_second',
    {
      hostedAlso: [{ row: 'host.network', double: 7 }],
    }
  ),
  // Sizes: the hosted store keeps a device size as text on the device's own row.
  num('network.linkSpeedMbps', { row: 'network', entityBlob: 1 }, 'network', 'link_speed_mbps', {
    encoding: 'hosted-text-number',
    hostedAlso: [{ row: 'host.network', blob: 6 }],
  }),
  num('filesystem.totalBytes', { row: 'filesystem', entityBlob: 1 }, 'filesystem', 'total_bytes', {
    encoding: 'hosted-text-number',
    hostedAlso: [{ row: 'host.io', double: 13 }],
  }),
  num(
    'filesystem.totalInodes',
    { row: 'filesystem', entityBlob: 1 },
    'filesystem',
    'total_inodes',
    {
      encoding: 'hosted-text-number',
      hostedAlso: [{ row: 'host.io', double: 15 }],
    }
  ),
  num('gpu.memoryTotalBytes', { row: 'gpu', entityBlob: 3 }, 'gpu', 'memory_total_bytes', {
    encoding: 'hosted-text-number',
  }),
  // Device facts.
  text('block.model', { row: 'block', entityBlob: 1 }, 'block', 'model'),
  text('block.smart', { row: 'block', entityBlob: 2 }, 'block', 'smart'),
  text('gpu.driver', { row: 'gpu', entityBlob: 1 }, 'gpu', 'driver'),
  text('gpu.model', { row: 'gpu', entityBlob: 2 }, 'gpu', 'model'),
  text('hardwareSignal.kind', { row: 'hardware.physical', blob: 7 }, 'hardwareSignal', 'kind'),
  // Host facts: free text, one column per fact in the self-hosted store.
  text('text.loadavg', { row: 'host.system', blob: 7 }, 'hostText', 'loadavg'),
  text('text.topCpu', { row: 'host.system', blob: 8 }, 'hostText', 'top_cpu'),
  text('text.cpuModel', { row: 'host.system', blob: 9 }, 'hostText', 'cpu_model'),
  text('text.topMem', { row: 'host.system', blob: 10 }, 'hostText', 'top_mem'),
  text('text.lastOom', { row: 'host.system', blob: 11 }, 'hostText', 'last_oom'),
  text('text.kernel', { row: 'host.system', blob: 12 }, 'hostText', 'kernel'),
  text('text.os', { row: 'host.system', blob: 13 }, 'hostText', 'os'),
  text('text.bootId', { row: 'host.system', blob: 14 }, 'hostText', 'boot_id'),
  text('text.virt', { row: 'host.system', blob: 15 }, 'hostText', 'virt'),
  text('text.cloudProvider', { row: 'host.system', blob: 16 }, 'hostText', 'cloud_provider'),
  text('text.agentVersion', { row: 'host.system', blob: 17 }, 'hostText', 'agent_version'),
  text('text.timeSync', { row: 'host.system', blob: 18 }, 'hostText', 'time_sync'),
  text('text.pendingUpdates', { row: 'host.system', blob: 19 }, 'hostText', 'pending_updates'),
  text('text.rebootRequired', { row: 'host.system', blob: 20 }, 'hostText', 'reboot_required'),
  text('text.fsReadOnly', { row: 'host.io', blob: 7 }, 'hostText', 'fs_read_only'),
  text('text.raidState', { row: 'host.io', blob: 8 }, 'hostText', 'raid_state'),
  text(
    'text.unhealthyContainers',
    { row: 'host.network', blob: 7 },
    'hostText',
    'unhealthy_containers'
  ),
  text('text.dockerVersion', { row: 'host.network', blob: 8 }, 'hostText', 'docker_version'),
  text('text.fpmBusiest', { row: 'host.web', blob: 7 }, 'hostText', 'fpm_busiest'),
  text('text.topSites', { row: 'host.web', blob: 8 }, 'hostText', 'top_sites'),
  text('text.caddyVersion', { row: 'host.web', blob: 9 }, 'hostText', 'caddy_version'),
  text('text.certSoonest', { row: 'host.web', blob: 10 }, 'hostText', 'cert_soonest'),
  text('text.traefikVersion', { row: 'host.web', blob: 11 }, 'hostText', 'traefik_version'),
  text('text.unhealthyBackends', { row: 'host.web', blob: 12 }, 'hostText', 'unhealthy_backends'),
  text('text.phpVersions', { row: 'host.web', blob: 13 }, 'hostText', 'php_versions'),
  text('text.webEngines', { row: 'host.web', blob: 14 }, 'hostText', 'web_engines'),
  text('text.failedUnits', { row: 'host.web', blob: 15 }, 'hostText', 'failed_units'),
  text('text.dbVersions', { row: 'managed.database', blob: 7 }, 'hostText', 'db_versions'),
]

/**
 * Contract values kept on the wire (so an older screen asking for one gets an
 * empty answer, not an unknown-name error) but stored in neither store. Both
 * stores read them as empty.
 */
export const NOT_STORED_FIELDS: readonly NotStoredField[] = [
  {
    id: 'host.cpu.saturatedCoreCount',
    why: 'dropped',
    note: 'Owner decision, 7 Oct (pegged cores)',
  },
  {
    id: 'host.cpu.procsRunning',
    why: 'left-out',
    note: '"pressure covers blocked tasks, and PID-limit % covers the count"',
  },
  {
    id: 'host.cpu.procsBlocked',
    why: 'left-out',
    note: '"pressure covers blocked tasks, and PID-limit % covers the count"',
  },
  {
    id: 'host.cpu.processCount',
    why: 'left-out',
    note: '"pressure covers blocked tasks, and PID-limit % covers the count"',
  },
  { id: 'host.memory.swapInBytesPerSecond', why: 'left-out', note: '"Swap in/out rates"' },
  { id: 'host.memory.swapOutBytesPerSecond', why: 'left-out', note: '"Swap in/out rates"' },
  { id: 'host.memory.majorPageFaultsPerSecond', why: 'dropped', note: 'Owner decision, 7 Oct' },
  {
    id: 'host.network.softnetDropsPerSecond',
    why: 'left-out',
    note: '"Softnet drops: rare on hosting traffic; live view"',
  },
  { id: 'block.readOpsPerSecond', why: 'left-out', note: '"split ops" (the sum is kept as ops/s)' },
  { id: 'block.writeOpsPerSecond', why: 'left-out', note: '"split ops"' },
  {
    id: 'block.utilizationPercent',
    why: 'left-out',
    note: '"Utilisation %" (misleads on NVMe and virtual disks)',
  },
  { id: 'ingress.responses2xx', why: 'dropped', note: 'Owner decision, 7 Oct' },
  {
    id: 'ingress.responses3xx',
    why: 'left-out',
    note: '"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"',
  },
  {
    id: 'ingress.bucket10ms',
    why: 'left-out',
    note: '"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"',
  },
  {
    id: 'ingress.bucket50ms',
    why: 'left-out',
    note: '"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"',
  },
  {
    id: 'ingress.bucket5s',
    why: 'left-out',
    note: '"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"',
  },
  {
    id: 'ingress.upstreamsHealthy',
    why: 'left-out',
    note: '"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"',
  },
  {
    id: 'ingress.upstreamsTotal',
    why: 'left-out',
    note: '"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"',
  },
  {
    id: 'ingress.retries',
    why: 'left-out',
    note: '"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"',
  },
  {
    id: 'databaseProxy.clientConnectionsCreated',
    why: 'left-out',
    note: '"ProxySQL \'created\' counters and byte totals"',
  },
  {
    id: 'databaseProxy.backendConnectionsCreated',
    why: 'left-out',
    note: '"ProxySQL \'created\' counters and byte totals"',
  },
  {
    id: 'databaseProxy.backendConnectionsAborted',
    why: 'left-out',
    note: '"ProxySQL \'created\' counters and byte totals"',
  },
  {
    id: 'databaseProxy.bytesFromBackends',
    why: 'left-out',
    note: '"ProxySQL \'created\' counters and byte totals"',
  },
  {
    id: 'databaseProxy.bytesToBackends',
    why: 'left-out',
    note: '"ProxySQL \'created\' counters and byte totals"',
  },
  { id: 'router.backendsUp', why: 'dropped', note: 'Owner decision, 7 Oct' },
  {
    id: 'router.servicesTotal',
    why: 'left-out',
    note: '"Service/router totals, reloads, open connections, retries"',
  },
  {
    id: 'router.routersTotal',
    why: 'left-out',
    note: '"Service/router totals, reloads, open connections, retries"',
  },
  {
    id: 'router.retries',
    why: 'left-out',
    note: '"Service/router totals, reloads, open connections, retries"',
  },
  { id: 'router.backendRequests', why: 'dropped', note: 'Owner decision, 7 Oct' },
  { id: 'router.httpOpenConnections', why: 'left-out', note: 'Owner decision, 7 Oct' },
  { id: 'router.configReloads', why: 'left-out', note: 'Owner decision, 7 Oct' },
  {
    id: 'router.configLastReloadAgeSeconds',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'router.tlsCertSoonestExpiryDays',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  { id: 'storage.dockerUsedBytes', why: 'dropped', note: 'Owner decision, 7 Oct' },
  { id: 'storage.logsUsedBytes', why: 'dropped', note: 'Owner decision, 7 Oct' },
  { id: 'storage.hostingFreeBytes', why: 'dropped', note: 'Owner decision, 7 Oct' },
  { id: 'storage.logsFreeBytes', why: 'left-out', note: '"Logs free" (disk space line)' },
  {
    id: 'storage.postgresConnectionsUsed',
    why: 'left-out',
    note: '"Per-engine connection counts"',
  },
  { id: 'storage.postgresConnectionsMax', why: 'left-out', note: '"Per-engine connection counts"' },
  { id: 'storage.mysqlConnectionsUsed', why: 'left-out', note: '"Per-engine connection counts"' },
  { id: 'storage.mysqlConnectionsMax', why: 'left-out', note: '"Per-engine connection counts"' },
  { id: 'storage.mariadbConnectionsUsed', why: 'left-out', note: '"Per-engine connection counts"' },
  { id: 'storage.mariadbConnectionsMax', why: 'left-out', note: '"Per-engine connection counts"' },
  { id: 'dockerUsage.imagesCount', why: 'left-out', note: '"Image, volume and container counts"' },
  {
    id: 'dockerUsage.imagesReclaimableBytes',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'dockerUsage.containersCount',
    why: 'left-out',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'dockerUsage.volumesCount',
    why: 'left-out',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'dockerUsage.volumesReclaimableBytes',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'dockerUsage.buildCacheReclaimableBytes',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.averageFrequencyMHz',
    why: 'left-out',
    note: '"Clock speeds: meaningless on VMs"',
  },
  {
    id: 'diagnostics.minimumFrequencyMHz',
    why: 'left-out',
    note: '"Clock speeds: meaningless on VMs"',
  },
  {
    id: 'diagnostics.maximumFrequencyMHz',
    why: 'left-out',
    note: '"Clock speeds: meaningless on VMs"',
  },
  {
    id: 'diagnostics.contextSwitchesPerSecond',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.interruptsPerSecond',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.forksPerSecond',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.cpuIrqPercent',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.memoryFreeBytes',
    why: 'left-out',
    note: '"MemFree, Cached, AnonPages repeat used/cache"',
  },
  {
    id: 'diagnostics.cachedBytes',
    why: 'left-out',
    note: '"MemFree, Cached, AnonPages repeat used/cache"',
  },
  {
    id: 'diagnostics.anonPagesBytes',
    why: 'left-out',
    note: '"MemFree, Cached, AnonPages repeat used/cache"',
  },
  {
    id: 'diagnostics.slabReclaimableBytes',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  { id: 'diagnostics.slabUnreclaimableBytes', why: 'dropped', note: 'Owner decision, 7 Oct' },
  {
    id: 'diagnostics.dirtyBytes',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.writebackBytes',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.shmemBytes',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.pageScanDirectPerSecond',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.pageScanKswapdPerSecond',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'diagnostics.compactionStallsPerSecond',
    why: 'not-named',
    note: 'Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows',
  },
  {
    id: 'extended.host.mdArraysResyncing',
    why: 'left-out',
    note: '"RAID resyncing as a number: the text already shows progress"',
  },
]

export const STORED_FIELD_IDS: ReadonlySet<string> = new Set(STORED_FIELDS.map((f) => f.id))
export const NOT_STORED_FIELD_IDS: ReadonlySet<string> = new Set(NOT_STORED_FIELDS.map((f) => f.id))

/**
 * The values both stores carry besides the readings: the machine and the sample
 * time. The received time is supplied by the platform on both (Analytics
 * Engine's own timestamp, a column in DuckDB).
 */
export const ENVELOPE_FIELDS = [
  { id: 'serverId', duckdb: 'server_id' },
  { id: 'sampledAt', duckdb: 'sampled_at' },
  { id: 'receivedAt', duckdb: 'received_at' },
  { id: 'intervalSeconds', duckdb: 'interval_seconds' },
] as const

/** Columns that name a device or source, not a reading. */
export const STRUCTURAL_COLUMNS: Readonly<Record<RegistryTable, readonly string[]>> = {
  host: [],
  hostText: [],
  network: ['device_id'],
  filesystem: ['filesystem_id'],
  block: ['device_id'],
  gpu: ['gpu_id'],
  hardwareSignal: ['signal_id'],
  ingress: ['source_id', 'source_kind'],
  databaseProxy: ['source_id', 'source_kind'],
  router: [],
  storage: [],
  docker: [],
  memoryDiagnostics: [],
}

/**
 * How often each row is written. Event rows and status rows are written when
 * something happens, which is not periodic by nature; every other row is
 * written every sample, including the minutes a slow reading is carried over.
 */
export const ROW_CADENCE: Readonly<Record<string, 'every-sample' | 'when-it-happens'>> = {
  'host.system': 'every-sample',
  'host.io': 'every-sample',
  'host.network': 'every-sample',
  'host.web': 'every-sample',
  'managed.database': 'every-sample',
  block: 'every-sample',
  network: 'every-sample',
  filesystem: 'every-sample',
  gpu: 'every-sample',
  'hardware.physical': 'every-sample',
  events: 'when-it-happens',
  status: 'when-it-happens',
}

/**
 * Where a store still differs from the registry. Each list names the exact
 * difference, and the tests fail if the real difference is anything else, so a
 * new gap cannot appear unseen. The lists only shrink; when they are all empty
 * both editions hold the same readings.
 */
export const KNOWN_GAPS: {
  /** Registered values the self-hosted store has no column for yet. */
  duckdbMissing: readonly string[]
  /** Registered values the hosted store has no slot for yet. */
  hostedMissing: readonly string[]
  /** Self-hosted columns (`table.column`) the registry does not list. */
  duckdbExtraColumns: readonly string[]
} = {
  duckdbMissing: [],
  hostedMissing: [],
  duckdbExtraColumns: [],
}
