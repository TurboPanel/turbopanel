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

const HOME = /^([\w.]+)@(ed|eb|d|b)(\d+)$/

function parseHome(text: string): RegistryHostedHome {
  const match = HOME.exec(text)
  if (!match) throw new TypeError(`bad hosted home: ${text}`)
  const [, row, kind, n] = match
  const key = { d: 'double', b: 'blob', ed: 'entityDouble', eb: 'entityBlob' }[kind]!
  return { row, [key]: Number(n) } as RegistryHostedHome
}

/** One value per line: `id kind(n|t) row@slot table.column [tn] [+row@slot ...]`. */
function parseStored(table: string): StoredField[] {
  return table
    .trim()
    .split('\n')
    .map((line) => {
      const [id, kind, hosted, db, ...flags] = line.trim().split(/\s+/)
      const [dbTable, column] = db.split('.')
      const also = flags
        .filter((flag) => flag.startsWith('+'))
        .map((flag) => parseHome(flag.slice(1)))
      return {
        id,
        kind: kind === 'n' ? 'number' : 'text',
        cadence: 'every-sample',
        hosted: parseHome(hosted),
        ...(also.length > 0 ? { hostedAlso: also } : {}),
        duckdb: { table: dbTable as RegistryTable, column },
        encoding: flags.includes('tn') ? 'hosted-text-number' : 'same',
      } satisfies StoredField
    })
}

/** One value per line: `id|why|note`. */
function parseNotStored(table: string): NotStoredField[] {
  return table
    .trim()
    .split('\n')
    .map((line) => {
      const [id, why, note] = line.split('|')
      return { id, why: why as NotStoredField['why'], note }
    })
}

/**
 * Every value both stores keep. Numbers first (in descriptor order), then the
 * device sizes and facts, then the host facts that ride as text.
 */
export const STORED_FIELDS: readonly StoredField[] = parseStored(`
host.cpu.busyPercent n host.system@d1 host.cpu_busy_percent
host.cpu.userPercent n host.system@d2 host.cpu_user_percent
host.cpu.systemPercent n host.system@d3 host.cpu_system_percent
host.cpu.iowaitPercent n host.system@d4 host.cpu_iowait_percent
host.cpu.stealPercent n host.system@d5 host.cpu_steal_percent
host.cpu.softirqPercent n host.system@d6 host.cpu_softirq_percent
host.cpu.pressureSomePercent n host.system@d8 host.cpu_pressure_some_percent
host.kernel.fileHandlesUsedPercent n host.web@d17 host.kernel_file_handles_used_percent
host.kernel.conntrackUsedPercent n host.web@d16 host.kernel_conntrack_used_percent
host.memory.usedBytes n host.system@d12 host.memory_used_bytes
host.memory.cachedFilesBytes n host.system@d13 host.memory_cached_files_bytes
host.memory.swapUsedBytes n host.system@d14 host.memory_swap_used_bytes
host.memory.pressureSomePercent n host.system@d10 host.memory_pressure_some_percent
host.memory.pressureFullPercent n host.system@d11 host.memory_pressure_full_percent
host.storage.ioPressureSomePercent n host.io@d1 host.storage_io_pressure_some_percent
host.storage.ioPressureFullPercent n host.io@d2 host.storage_io_pressure_full_percent
host.storage.diskReadBytesPerSecond n host.io@d3 host.storage_disk_read_bytes_per_second
host.storage.diskWriteBytesPerSecond n host.io@d4 host.storage_disk_write_bytes_per_second
host.storage.diskLatencyMs n host.io@d5 host.storage_disk_latency_ms
host.storage.rootFilesystemAvailableBytes n host.io@d8 host.storage_root_filesystem_available_bytes
host.storage.rootFilesystemFreeInodes n host.io@d10 host.storage_root_filesystem_free_inodes
host.network.tcpRetransmitPercent n host.network@d1 host.network_tcp_retransmit_percent
network.receiveBytesPerSecond n network@ed1 network.receive_bytes_per_second +host.network@d2 +host.network@d5
network.transmitBytesPerSecond n network@ed2 network.transmit_bytes_per_second +host.network@d3 +host.network@d6
network.receiveErrorsPerSecond n network@ed3 network.receive_errors_per_second
network.transmitErrorsPerSecond n network@ed4 network.transmit_errors_per_second
network.receiveDropsPerSecond n network@ed5 network.receive_drops_per_second
network.transmitDropsPerSecond n network@ed6 network.transmit_drops_per_second
filesystem.availableBytes n filesystem@ed1 filesystem.available_bytes +host.io@d12
filesystem.freeInodes n filesystem@ed2 filesystem.free_inodes +host.io@d14
block.readBytesPerSecond n block@ed1 block.read_bytes_per_second
block.writeBytesPerSecond n block@ed2 block.write_bytes_per_second
block.readLatencyMs n block@ed4 block.read_latency_ms
block.writeLatencyMs n block@ed5 block.write_latency_ms
block.queueDepth n block@ed6 block.queue_depth
gpu.utilizationPercent n gpu@ed1 gpu.utilization_percent
gpu.memoryUsedBytes n gpu@ed2 gpu.memory_used_bytes
gpu.memoryActivityPercent n gpu@ed3 gpu.memory_activity_percent
gpu.pcieReceiveBytesPerSecond n gpu@ed4 gpu.pcie_receive_bytes_per_second
gpu.pcieTransmitBytesPerSecond n gpu@ed5 gpu.pcie_transmit_bytes_per_second
gpu.throttlePercent n gpu@ed6 gpu.throttle_percent
hardwareSignal.value n hardware.physical@ed1 hardwareSignal.value
ingress.requests n host.web@d1 ingress.requests
ingress.responses4xx n host.web@d2 ingress.responses4xx
ingress.responses5xx n host.web@d3 ingress.responses5xx
ingress.requestErrors n host.web@d4 ingress.request_errors
ingress.requestBytes n host.web@d5 ingress.request_bytes
ingress.responseBytes n host.web@d6 ingress.response_bytes
ingress.requestDurationSecondsSum n host.web@d7 ingress.request_duration_seconds_sum
ingress.bucket100ms n host.web@d8 ingress.bucket100ms
ingress.bucket500ms n host.web@d9 ingress.bucket500ms
ingress.bucket1s n host.web@d10 ingress.bucket1s
ingress.requestsInFlight n host.web@d11 ingress.requests_in_flight
databaseProxy.queries n managed.database@d7 databaseProxy.queries
databaseProxy.slowQueries n managed.database@d8 databaseProxy.slow_queries
databaseProxy.queryLatencyMsAvg n managed.database@d9 databaseProxy.query_latency_ms_avg
databaseProxy.backendLatencyMsAvg n managed.database@d10 databaseProxy.backend_latency_ms_avg
databaseProxy.activeTransactions n managed.database@d11 databaseProxy.active_transactions
databaseProxy.clientConnections n managed.database@d12 databaseProxy.client_connections
databaseProxy.clientConnectionsAborted n managed.database@d13 databaseProxy.client_connections_aborted
databaseProxy.connectionsRejectedMaxConns n managed.database@d14 databaseProxy.connections_rejected_max_conns
databaseProxy.backendConnections n managed.database@d15 databaseProxy.backend_connections
databaseProxy.connectionErrors n managed.database@d16 databaseProxy.connection_errors
databaseProxy.backendsUp n managed.database@d17 databaseProxy.backends_up
databaseProxy.backendsTotal n managed.database@d18 databaseProxy.backends_total
router.backendsTotal n host.web@d13 router.backends_total
router.backendErrors5xx n host.web@d14 router.backend_errors5xx
router.backendLatencyMsAvg n host.web@d15 router.backend_latency_ms_avg
storage.hostingUsedBytes n host.io@d16 storage.hosting_used_bytes
storage.backupUsedBytes n host.io@d17 storage.backup_used_bytes
storage.backupFreeBytes n host.io@d18 storage.backup_free_bytes
storage.postgresInstancesRunning n managed.database@d1 storage.postgres_instances_running
storage.postgresInstancesHealthy n managed.database@d2 storage.postgres_instances_healthy
storage.mysqlInstancesRunning n managed.database@d3 storage.mysql_instances_running
storage.mysqlInstancesHealthy n managed.database@d4 storage.mysql_instances_healthy
storage.mariadbInstancesRunning n managed.database@d5 storage.mariadb_instances_running
storage.mariadbInstancesHealthy n managed.database@d6 storage.mariadb_instances_healthy
dockerUsage.layersBytes n host.network@d15 docker.layers_bytes
dockerUsage.containersBytes n host.network@d16 docker.containers_bytes
dockerUsage.volumesBytes n host.network@d17 docker.volumes_bytes
dockerUsage.buildCacheBytes n host.network@d18 docker.build_cache_bytes
diagnostics.committedAsBytes n host.system@d18 memoryDiagnostics.committed_as_bytes
extended.host.pidLimitUsedPercent n host.web@d18 host.ext_pid_limit_used_percent
extended.host.irqPressureFullPercent n host.system@d9 host.ext_irq_pressure_full_percent
extended.host.oomKills n host.system@d17 host.ext_oom_kills
extended.host.rootDiskQueueDepth n host.io@d6 host.ext_root_disk_queue_depth
extended.host.rootDiskOpsPerSecond n host.io@d7 host.ext_root_disk_ops_per_second
extended.host.systemdUnitsFailed n host.web@d19 host.ext_systemd_units_failed
extended.host.mdArraysDegraded n host.io@d19 host.ext_md_arrays_degraded
extended.docker.containersRunning n host.network@d8 docker.ext_containers_running
extended.docker.containersUnhealthy n host.network@d9 docker.ext_containers_unhealthy
extended.docker.containersRestarting n host.network@d10 docker.ext_containers_restarting
extended.docker.containerOomEvents n host.network@d11 docker.ext_container_oom_events
extended.docker.containerDieEvents n host.network@d12 docker.ext_container_die_events
extended.docker.containersCpuPercent n host.network@d13 docker.ext_containers_cpu_percent
extended.docker.containersMemoryBytes n host.network@d14 docker.ext_containers_memory_bytes
extended.docker.reclaimableBytes n host.network@d19 docker.ext_reclaimable_bytes
extended.ingress.tlsCertSoonestExpiryDays n host.web@d12 host.ext_tls_cert_soonest_expiry_days
extended.sizes.memoryTotalBytes n host.system@d15 host.ext_memory_total_bytes
extended.sizes.swapTotalBytes n host.system@d16 host.ext_swap_total_bytes
extended.sizes.commitLimitBytes n host.system@d19 host.ext_commit_limit_bytes
extended.sizes.logicalCores n host.system@d7 host.ext_logical_cores
extended.sizes.rootFilesystemTotalBytes n host.io@d9 host.ext_root_filesystem_total_bytes
extended.sizes.rootFilesystemTotalInodes n host.io@d11 host.ext_root_filesystem_total_inodes
block.opsPerSecond n block@ed3 block.ops_per_second
network.problemsPerSecond n host.network@d4 network.problems_per_second +host.network@d7
network.linkSpeedMbps n network@eb1 network.link_speed_mbps tn +host.network@b6
filesystem.totalBytes n filesystem@eb1 filesystem.total_bytes tn +host.io@d13
filesystem.totalInodes n filesystem@eb1 filesystem.total_inodes tn +host.io@d15
gpu.memoryTotalBytes n gpu@eb3 gpu.memory_total_bytes tn
block.model t block@eb1 block.model
block.smart t block@eb2 block.smart
gpu.driver t gpu@eb1 gpu.driver
gpu.model t gpu@eb2 gpu.model
hardwareSignal.kind t hardware.physical@b7 hardwareSignal.kind
text.loadavg t host.system@b7 hostText.loadavg
text.topCpu t host.system@b8 hostText.top_cpu
text.cpuModel t host.system@b9 hostText.cpu_model
text.topMem t host.system@b10 hostText.top_mem
text.lastOom t host.system@b11 hostText.last_oom
text.kernel t host.system@b12 hostText.kernel
text.os t host.system@b13 hostText.os
text.bootId t host.system@b14 hostText.boot_id
text.virt t host.system@b15 hostText.virt
text.cloudProvider t host.system@b16 hostText.cloud_provider
text.agentVersion t host.system@b17 hostText.agent_version
text.timeSync t host.system@b18 hostText.time_sync
text.pendingUpdates t host.system@b19 hostText.pending_updates
text.rebootRequired t host.system@b20 hostText.reboot_required
text.fsReadOnly t host.io@b7 hostText.fs_read_only
text.raidState t host.io@b8 hostText.raid_state
text.unhealthyContainers t host.network@b7 hostText.unhealthy_containers
text.dockerVersion t host.network@b8 hostText.docker_version
text.fpmBusiest t host.web@b7 hostText.fpm_busiest
text.topSites t host.web@b8 hostText.top_sites
text.caddyVersion t host.web@b9 hostText.caddy_version
text.certSoonest t host.web@b10 hostText.cert_soonest
text.traefikVersion t host.web@b11 hostText.traefik_version
text.unhealthyBackends t host.web@b12 hostText.unhealthy_backends
text.phpVersions t host.web@b13 hostText.php_versions
text.webEngines t host.web@b14 hostText.web_engines
text.failedUnits t host.web@b15 hostText.failed_units
text.dbVersions t managed.database@b7 hostText.db_versions
`)

/**
 * Contract values kept on the wire (so an older screen asking for one gets an
 * empty answer, not an unknown-name error) but stored in neither store. Both
 * stores read them as empty.
 */
export const NOT_STORED_FIELDS: readonly NotStoredField[] = parseNotStored(`
host.cpu.saturatedCoreCount|dropped|Owner decision, 7 Oct (pegged cores)
host.cpu.procsRunning|left-out|"pressure covers blocked tasks, and PID-limit % covers the count"
host.cpu.procsBlocked|left-out|"pressure covers blocked tasks, and PID-limit % covers the count"
host.cpu.processCount|left-out|"pressure covers blocked tasks, and PID-limit % covers the count"
host.memory.swapInBytesPerSecond|left-out|"Swap in/out rates"
host.memory.swapOutBytesPerSecond|left-out|"Swap in/out rates"
host.memory.majorPageFaultsPerSecond|dropped|Owner decision, 7 Oct
host.network.softnetDropsPerSecond|left-out|"Softnet drops: rare on hosting traffic; live view"
block.readOpsPerSecond|left-out|"split ops" (the sum is kept as ops/s)
block.writeOpsPerSecond|left-out|"split ops"
block.utilizationPercent|left-out|"Utilisation %" (misleads on NVMe and virtual disks)
ingress.responses2xx|dropped|Owner decision, 7 Oct
ingress.responses3xx|left-out|"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"
ingress.bucket10ms|left-out|"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"
ingress.bucket50ms|left-out|"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"
ingress.bucket5s|left-out|"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"
ingress.upstreamsHealthy|left-out|"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"
ingress.upstreamsTotal|left-out|"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"
ingress.retries|left-out|"3xx, the 10 ms / 50 ms / 5 s buckets, upstream health, retries"
databaseProxy.clientConnectionsCreated|left-out|"ProxySQL 'created' counters and byte totals"
databaseProxy.backendConnectionsCreated|left-out|"ProxySQL 'created' counters and byte totals"
databaseProxy.backendConnectionsAborted|left-out|"ProxySQL 'created' counters and byte totals"
databaseProxy.bytesFromBackends|left-out|"ProxySQL 'created' counters and byte totals"
databaseProxy.bytesToBackends|left-out|"ProxySQL 'created' counters and byte totals"
router.backendsUp|dropped|Owner decision, 7 Oct
router.servicesTotal|left-out|"Service/router totals, reloads, open connections, retries"
router.routersTotal|left-out|"Service/router totals, reloads, open connections, retries"
router.retries|left-out|"Service/router totals, reloads, open connections, retries"
router.backendRequests|dropped|Owner decision, 7 Oct
router.httpOpenConnections|left-out|Owner decision, 7 Oct
router.configReloads|left-out|Owner decision, 7 Oct
router.configLastReloadAgeSeconds|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
router.tlsCertSoonestExpiryDays|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
storage.dockerUsedBytes|dropped|Owner decision, 7 Oct
storage.logsUsedBytes|dropped|Owner decision, 7 Oct
storage.hostingFreeBytes|dropped|Owner decision, 7 Oct
storage.logsFreeBytes|left-out|"Logs free" (disk space line)
storage.postgresConnectionsUsed|left-out|"Per-engine connection counts"
storage.postgresConnectionsMax|left-out|"Per-engine connection counts"
storage.mysqlConnectionsUsed|left-out|"Per-engine connection counts"
storage.mysqlConnectionsMax|left-out|"Per-engine connection counts"
storage.mariadbConnectionsUsed|left-out|"Per-engine connection counts"
storage.mariadbConnectionsMax|left-out|"Per-engine connection counts"
dockerUsage.imagesCount|left-out|"Image, volume and container counts"
dockerUsage.imagesReclaimableBytes|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
dockerUsage.containersCount|left-out|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
dockerUsage.volumesCount|left-out|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
dockerUsage.volumesReclaimableBytes|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
dockerUsage.buildCacheReclaimableBytes|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.averageFrequencyMHz|left-out|"Clock speeds: meaningless on VMs"
diagnostics.minimumFrequencyMHz|left-out|"Clock speeds: meaningless on VMs"
diagnostics.maximumFrequencyMHz|left-out|"Clock speeds: meaningless on VMs"
diagnostics.contextSwitchesPerSecond|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.interruptsPerSecond|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.forksPerSecond|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.cpuIrqPercent|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.memoryFreeBytes|left-out|"MemFree, Cached, AnonPages repeat used/cache"
diagnostics.cachedBytes|left-out|"MemFree, Cached, AnonPages repeat used/cache"
diagnostics.anonPagesBytes|left-out|"MemFree, Cached, AnonPages repeat used/cache"
diagnostics.slabReclaimableBytes|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.slabUnreclaimableBytes|dropped|Owner decision, 7 Oct
diagnostics.dirtyBytes|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.writebackBytes|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.shmemBytes|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.pageScanDirectPerSecond|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.pageScanKswapdPerSecond|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
diagnostics.compactionStallsPerSecond|not-named|Not named in the audit; the old diagnostics row and the unkept counts have no place in the four locked rows
extended.host.mdArraysResyncing|left-out|"RAID resyncing as a number: the text already shows progress"
`)

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
  hostedMissing: ['hardwareSignal.kind'],
  duckdbExtraColumns: [],
}
