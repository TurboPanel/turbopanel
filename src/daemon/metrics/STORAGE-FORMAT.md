# Metrics v8 storage format

The one place that says what a stored metrics row looks like: where every number and text value lives on the
hosted store (Cloudflare Analytics Engine) and the self-hosted store (DuckDB), what is nullable, which units
apply, how the format is versioned, and how to add a metric. Internal; not for the public website (the
operator-facing glossary lives in `website/docs/metrics/`).

Source order when two things disagree: the code, then `testing/v8-layout.fixture.json` (pinned by tests), then
this file. `V8-LAYOUT.md` is the generated slot spec for the hosted host rows and is kept next to this file; the
tables below add the contract field, unit, nullability and DuckDB column for each slot.

## At a glance

| Item               | Value                                                                                                                                                                                                                                          | Where                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Hosted dataset     | `turbopanel_server_metrics_v8`, one per environment with a prefix: `testing_`, `staging_`, `live_` (the bare name is the local default)                                                                                                        | `backends/cloudflare/field-map.ts:83`, `wrangler.jsonc` (SERVER_METRICS binding and the read-side var)          |
| Storage stamp      | `8`, written as text in blob3 of every row. Readers accept only this value                                                                                                                                                                     | `AE_STORAGE_VERSION` (`field-map.ts:81`), `AE_SUPPORTED_SCHEMA_VERSIONS` (`backends/cloudflare/sql-api.ts:114`) |
| Wire versions      | `[6, 8]`. 6 is the plain fallback sample (no `extended` section, no `durable` flag). Any other value, including 7, is refused with a version error                                                                                             | `METRICS_WIRE_VERSIONS` (`src/contracts/metrics-contract.ts:41`), checked at `validation.ts:320`                |
| Wire features      | `metrics-v8` and `metrics-v8-sizes`. `metrics-v7` is not advertised. A daemon stamps 6 until the panel it is attached to advertises `metrics-v8`                                                                                               | `DAEMON_WIRE_FEATURES` (`src/lib/version-wire.ts:171-182`)                                                      |
| Rows per sample    | VPS 4, physical 5-6, plus 1 with managed databases, plus 1 per event (16 at most)                                                                                                                                                              | `buildMetricsDataPoints` (`field-map.ts:582`), table at the end of `V8-LAYOUT.md`                               |
| Cap per write call | 250 data points per sample; the lowest-priority rows are dropped and logged past that                                                                                                                                                          | `capToInvocationLimit` (`field-map.ts:659`)                                                                     |
| Self-hosted marker | `10` (`DUCKDB_SCHEMA_MARKER_VERSION`). Any older or unreadable marker discards the file and rebuilds it                                                                                                                                        | `backends/duckdb/schema.ts:99`, `backends/duckdb/database.ts`                                                   |
| Retention          | Hosted: about 3 months (Cloudflare's own retention; the reader's default window is 90 days, `AE_DEFAULT_MAX_RANGE_SECONDS`). Self-hosted: 90 days by default (`DEFAULT_DUCKDB_RETENTION_DAYS`, env `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS`) | `sql-api.ts:167`, `backends/duckdb/store.ts:168`                                                                |

## Rules that never change without a new stamp

1. **Missing is never zero.** The wire contract uses `number | null` for every leaf. On the hosted store `null`
   becomes the sentinel `-1e308` (`AE_MISSING_METRIC_SENTINEL`, `field-map.ts:104`); on DuckDB it is a real SQL
   `NULL`. Readers test presence as `col > -pow(10, 307)` (`aePresentValueSql`, `sql-api.ts:795`), never by
   equality. A delta-sum over an absent family is null, not 0.
2. **Slot positions are the format.** A hosted slot never changes meaning without bumping `AE_STORAGE_VERSION`
   (and with it the dataset, see "Versioning"). Rows with another stamp are skipped, never read with the new
   meaning.
3. **Positional tokens stay inside `backends/cloudflare/`.** `doubleN`, `blobN` and the sentinel are confined there
   by `scripts/check-metrics-boundaries.mjs`; everything else goes through `field-map.ts` and `v8-layout.ts`.
4. **Hosted ingest writes v8 rows for every accepted wire version.** A version 6 sample writes the same rows with
   sentinels and empty text where the data is absent (`v8-layout.ts:12-14`).
5. **Rows name their own devices.** There is no topology generation in any row. Readers find a device by the id in
   blob6, never by a slot number.

## Hosted rows (Analytics Engine)

Every data point has 1 index, 20 doubles and 20 blobs. The writer always fills all 20 of each
(`assertAnalyticsEngineDataPointShape`, `field-map.ts:270`); unused doubles hold the sentinel and unused blobs
are empty strings.

### Index

- `host.system` rows and status rows: `index1 = <serverId>`.
- Every other metrics row: `<serverId>:<family>` (for example `<serverId>:host.io`). Event rows:
  `<serverId>:event`. This keeps one sample's burst of rows from landing on a single index, which Analytics
  Engine samples (`aeIndexForFamily`, `field-map.ts:207`).
- Readers match both spellings (`aeIndexesForFamilies`, `field-map.ts:219`).

### Envelope of a metrics row

| Slot       | Content                                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blob1      | row kind: `metrics`                                                                                                                                                                                                                                                                      |
| blob2      | family: `host.system`, `host.io`, `host.network`, `host.web`, `managed.database`, `block`, `network`, `filesystem`, `gpu`, `hardware.physical`                                                                                                                                           |
| blob3      | storage stamp, `8`                                                                                                                                                                                                                                                                       |
| blob4      | reserved, written empty on every row (it held the topology generation before v8; readers never use one)                                                                                                                                                                                  |
| blob5      | sample time as UTC text `YYYY-MM-DD hh:mm:ss` (`formatAeSampleTime`, `field-map.ts:374`; the one format `toDateTime` parses). Filter on Analytics Engine's own `timestamp` for ranges                                                                                                    |
| blob6      | entity ids, comma joined, in the same order as the row's doubles (entity families). On `host.network`: `nic1=<id>@<Mb/s>;nic2=<id>@<Mb/s>;fs=<id>` (parts left out when absent; the speed follows the last `@`). Empty on the other host rows (`v8HostRowEntityIds`, `v8-layout.ts:211`) |
| blob7-20   | content text, at most 14 blobs (`V8_CONTENT_BLOB_CAPACITY`); device rows append their per-device text entity by entity                                                                                                                                                                   |
| double1-19 | metric values, in slot order                                                                                                                                                                                                                                                             |
| double20   | sample interval in seconds (`metadata.intervalSeconds`), the weight for every aggregate                                                                                                                                                                                                  |

### Envelope of an event row (one per `sample.events` entry)

`buildEventBlobs` (`field-map.ts:421`). Events keep their v6 blob positions, apart from blob3 and the blob5 format.

| Slot       | Content                                                              |
| ---------- | -------------------------------------------------------------------- |
| index1     | `<serverId>:event`                                                   |
| blob1      | `event`                                                              |
| blob2      | event kind (`MetricEventKind`, `METRIC_EVENT_KINDS` in the contract) |
| blob3      | `8`                                                                  |
| blob5      | the event's own time, UTC text                                       |
| blob6      | the enclosing sample's sequence number (text)                        |
| blob7      | reserved, written empty (it held the topology generation)            |
| blob8      | capability-plan generation, empty when unresolved                    |
| blob9      | `0`                                                                  |
| blob10     | `event.source`, empty when absent                                    |
| blob11     | `event.entityId`, empty when absent                                  |
| blob12     | the payload as JSON text (`{}` when none)                            |
| blob13     | `event.eventId`                                                      |
| blob17     | severity                                                             |
| double1-19 | sentinel                                                             |
| double20   | sample interval seconds                                              |

At most 16 events per sample (`MAX_METRIC_EVENTS_PER_SAMPLE`, contract line 951). The wire accepts up to 128
(`validation.ts:136`) and keeps the 16 most severe, then the oldest (`keepMostSevereEvents`, `validation.ts:843`).
The contract constructor enforces 16 again on the sanitized sample (`assertArrayWithinCap`).

### Envelope of a status row (connection transitions)

`buildStatusDataPoint` (`field-map.ts:451`): index1 `<serverId>`, blob1 `status`, blob3 `8`, blob17 the transition
reason, double1 connected (1 or 0), every other double the sentinel. Status rows are history only; the current
connection state is Postgres `server.is_connected`, never this stream.

### Which rows exist

- `host.system`, `host.io`, `host.network`, `host.web`: every sample, on every host. A data point that does not
  apply (no Docker, no RAID, no second NIC) is the sentinel in its slot, so every server shares one layout.
- `managed.database`: only when the sample carries managed-database data (`hasManagedDatabase`, `v8-layout.ts:446`).
- `block`: only when there is more than one drive (one drive is covered by `host.io`). 3 drives per row.
- `network`: NIC 3 and up, 3 per row. NIC 1 and NIC 2 ride on `host.network`.
- `filesystem`: only when there is more than one extra filesystem, 9 per row. Exactly one extra filesystem is
  folded into `host.io` (slots `fs_*`) and writes no `filesystem` row; `host.network` blob6 names it (`fs=<id>`).
- `gpu`: 3 per row, physical machines or real passthrough GPUs only.
- `hardware.physical`: physical machines only, up to 19 signals per row (one double each).
- Entity pages are ordered by the recorded page order when a slot mapping exists, otherwise by sample order
  (`buildEntityPoints`, `field-map.ts:532`). Plan limits cut device counts at ingest on the hosted path
  (`truncateSampleToCapabilityPlan`).

### Host rows: slot by slot

Generated from `V8_HOST_ROW_SPECS` (`v8-layout.ts:378`), the metric descriptors (`metric-descriptors.ts`) and the
DuckDB column helpers (`backends/duckdb/schema.ts`); the column order matches `V8-LAYOUT.md`.

- Contract field is `<scope>.<field>` in `src/contracts/metrics-contract.ts`.
- "Absent means": a metric whose descriptor says `missing-when-unsupported` is shown as "no data" when empty; a
  `legitimate-zero` metric treats 0 as a real reading and an empty slot as a gap.
- Range: percentages are clamped to 0-100; every other value is 0 or more, and an out-of-range finite value is
  stored empty (`sanitizeMetricValue`, `metric-descriptors.ts:1229`).
- Every double1-19 slot is nullable. Only double20 (interval) is always present.
- Counters (`delta` metrics such as requests and OOM kills) are sent as the raw per-interval change (never divided by
  the interval) and bucket with `delta-sum`; gauges bucket with `weighted-average` (or `max`/`last` where noted in
  the descriptor).

#### host.system

| Slot     | Id            | Contract field                         | Unit    | Absent means                                     | Range                                | DuckDB table.column                                    |
| -------- | ------------- | -------------------------------------- | ------- | ------------------------------------------------ | ------------------------------------ | ------------------------------------------------------ |
| double1  | `busy`        | `host.cpu.busyPercent`                 | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.cpu_busy_percent`                 |
| double2  | `user`        | `host.cpu.userPercent`                 | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.cpu_user_percent`                 |
| double3  | `system`      | `host.cpu.systemPercent`               | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.cpu_system_percent`               |
| double4  | `iowait`      | `host.cpu.iowaitPercent`               | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.cpu_iowait_percent`               |
| double5  | `steal`       | `host.cpu.stealPercent`                | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.cpu_steal_percent`                |
| double6  | `softirq`     | `host.cpu.softirqPercent`              | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.cpu_softirq_percent`              |
| double7  | `cores`       | `extended.sizes.logicalCores`          | count   | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_logical_cores`                |
| double8  | `cpuPsi`      | `host.cpu.pressureSomePercent`         | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.cpu_pressure_some_percent`        |
| double9  | `irqPsiFull`  | `extended.host.irqPressureFullPercent` | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.ext_irq_pressure_full_percent`    |
| double10 | `memPsiSome`  | `host.memory.pressureSomePercent`      | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.memory_pressure_some_percent`     |
| double11 | `memPsiFull`  | `host.memory.pressureFullPercent`      | percent | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.memory_pressure_full_percent`     |
| double12 | `used`        | `host.memory.usedBytes`                | bytes   | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.memory_used_bytes`                |
| double13 | `cachedFiles` | `host.memory.cachedFilesBytes`         | bytes   | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.memory_cached_files_bytes`        |
| double14 | `swapUsed`    | `host.memory.swapUsedBytes`            | bytes   | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.memory_swap_used_bytes`           |
| double15 | `memTotal`    | `extended.sizes.memoryTotalBytes`      | bytes   | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_memory_total_bytes`           |
| double16 | `swapTotal`   | `extended.sizes.swapTotalBytes`        | bytes   | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_swap_total_bytes`             |
| double17 | `oomKills`    | `extended.host.oomKills`               | count   | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.ext_oom_kills`                    |
| double18 | `dCommit`     | `diagnostics.committedAsBytes`         | bytes   | Zero is a real reading                           | 0 or more, out of range stored empty | `server_memory_diagnostics_samples.committed_as_bytes` |
| double19 | `commitLimit` | `extended.sizes.commitLimitBytes`      | bytes   | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_commit_limit_bytes`           |
| double20 | interval      | metadata.intervalSeconds               | seconds | never empty                                      | 1 to 3600                            | `interval_seconds` on every table                      |

#### host.io

| Slot     | Id                  | Contract field                                       | Unit           | Absent means                                     | Range                                | DuckDB table.column                                           |
| -------- | ------------------- | ---------------------------------------------------- | -------------- | ------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------- |
| double1  | `ioPsiSome`         | `host.storage.ioPressureSomePercent`                 | percent        | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.storage_io_pressure_some_percent`        |
| double2  | `ioPsiFull`         | `host.storage.ioPressureFullPercent`                 | percent        | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.storage_io_pressure_full_percent`        |
| double3  | `diskRead`          | `host.storage.diskReadBytesPerSecond`                | bytesPerSecond | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.storage_disk_read_bytes_per_second`      |
| double4  | `diskWrite`         | `host.storage.diskWriteBytesPerSecond`               | bytesPerSecond | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.storage_disk_write_bytes_per_second`     |
| double5  | `diskLatency`       | `host.storage.diskLatencyMs`                         | milliseconds   | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.storage_disk_latency_ms`                 |
| double6  | `rootQueue`         | `extended.host.rootDiskQueueDepth`                   | count          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_root_disk_queue_depth`               |
| double7  | `rootOps`           | `extended.host.rootDiskOpsPerSecond`                 | opsPerSecond   | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_root_disk_ops_per_second`            |
| double8  | `rootAvail`         | `host.storage.rootFilesystemAvailableBytes`          | bytes          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.storage_root_filesystem_available_bytes` |
| double9  | `rootTotal`         | `extended.sizes.rootFilesystemTotalBytes`            | bytes          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_root_filesystem_total_bytes`         |
| double10 | `rootInodes`        | `host.storage.rootFilesystemFreeInodes`              | count          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_host_samples.storage_root_filesystem_free_inodes`     |
| double11 | `rootInodesTotal`   | `extended.sizes.rootFilesystemTotalInodes`           | count          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_root_filesystem_total_inodes`        |
| double12 | `fs_availableBytes` | filesystem.availableBytes (the one extra filesystem) | bytes          | Zero is a real reading                           | 0 or more                            | `server_filesystem_samples.available_bytes`                   |
| double13 | `fs_totalBytes`     | extended.filesystemSizes[].totalBytes                | bytes          | Not reported when the size is unknown            | 0 or more                            | `server_filesystem_samples.total_bytes`                       |
| double14 | `fs_freeInodes`     | filesystem.freeInodes                                | count          | Zero is a real reading                           | 0 or more                            | `server_filesystem_samples.free_inodes`                       |
| double15 | `fs_totalInodes`    | extended.filesystemSizes[].totalInodes               | count          | Not reported when unknown                        | 0 or more                            | `server_filesystem_samples.total_inodes`                      |
| double16 | `hostingUsed`       | `storage.hostingUsedBytes`                           | bytes          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_storage_samples.hosting_used_bytes`                   |
| double17 | `backupUsed`        | `storage.backupUsedBytes`                            | bytes          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_storage_samples.backup_used_bytes`                    |
| double18 | `backupFree`        | `storage.backupFreeBytes`                            | bytes          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_storage_samples.backup_free_bytes`                    |
| double19 | `mdDegraded`        | `extended.host.mdArraysDegraded`                     | count          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_md_arrays_degraded`                  |
| double20 | interval            | metadata.intervalSeconds                             | seconds        | never empty                                      | 1 to 3600                            | `interval_seconds` on every table                             |

#### host.network

| Slot     | Id              | Contract field                                                                                              | Unit           | Absent means                                     | Range                                | DuckDB table.column                                              |
| -------- | --------------- | ----------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------- |
| double1  | `tcpRetrans`    | `host.network.tcpRetransmitPercent`                                                                         | percent        | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.network_tcp_retransmit_percent`             |
| double2  | `nic1.rx`       | NIC 1 receiveBytesPerSecond                                                                                 | bytesPerSecond | Zero is a real reading                           | 0 or more                            | `server_network_samples.receive_bytes_per_second`                |
| double3  | `nic1.tx`       | NIC 1 transmitBytesPerSecond                                                                                | bytesPerSecond | Zero is a real reading                           | 0 or more                            | `server_network_samples.transmit_bytes_per_second`               |
| double4  | `nic1.problems` | NIC 1 problems = receive + transmit errors + receive + transmit drops (empty if any of the four is missing) | countPerSecond | Zero is a real reading                           | 0 or more                            | four columns of `server_network_samples` (the sum is not stored) |
| double5  | `nic2.rx`       | NIC 2 receiveBytesPerSecond                                                                                 | bytesPerSecond | Zero is a real reading                           | 0 or more                            | `server_network_samples.receive_bytes_per_second`                |
| double6  | `nic2.tx`       | NIC 2 transmitBytesPerSecond                                                                                | bytesPerSecond | Zero is a real reading                           | 0 or more                            | `server_network_samples.transmit_bytes_per_second`               |
| double7  | `nic2.problems` | NIC 2 problems (as NIC 1)                                                                                   | countPerSecond | Zero is a real reading                           | 0 or more                            | four columns of `server_network_samples` (the sum is not stored) |
| double8  | `ctrRunning`    | `extended.docker.containersRunning`                                                                         | count          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_docker_samples.ext_containers_running`                   |
| double9  | `ctrUnhealthy`  | `extended.docker.containersUnhealthy`                                                                       | count          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_docker_samples.ext_containers_unhealthy`                 |
| double10 | `ctrRestarting` | `extended.docker.containersRestarting`                                                                      | count          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_docker_samples.ext_containers_restarting`                |
| double11 | `ctrOom`        | `extended.docker.containerOomEvents`                                                                        | count          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_docker_samples.ext_container_oom_events`                 |
| double12 | `ctrDie`        | `extended.docker.containerDieEvents`                                                                        | count          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_docker_samples.ext_container_die_events`                 |
| double13 | `ctrCpu`        | `extended.docker.containersCpuPercent`                                                                      | percent        | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_docker_samples.ext_containers_cpu_percent`               |
| double14 | `ctrMem`        | `extended.docker.containersMemoryBytes`                                                                     | bytes          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_docker_samples.ext_containers_memory_bytes`              |
| double15 | `layers`        | `dockerUsage.layersBytes`                                                                                   | bytes          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_docker_samples.layers_bytes`                             |
| double16 | `ctrBytes`      | `dockerUsage.containersBytes`                                                                               | bytes          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_docker_samples.containers_bytes`                         |
| double17 | `volumes`       | `dockerUsage.volumesBytes`                                                                                  | bytes          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_docker_samples.volumes_bytes`                            |
| double18 | `buildCache`    | `dockerUsage.buildCacheBytes`                                                                               | bytes          | Zero is a real reading                           | 0 or more, out of range stored empty | `server_docker_samples.build_cache_bytes`                        |
| double19 | `reclTotal`     | `extended.docker.reclaimableBytes`                                                                          | bytes          | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_docker_samples.ext_reclaimable_bytes`                    |
| double20 | interval        | metadata.intervalSeconds                                                                                    | seconds        | never empty                                      | 1 to 3600                            | `interval_seconds` on every table                                |

#### host.web

| Slot     | Id              | Contract field                              | Unit         | Absent means                                     | Range                                | DuckDB table.column                                       |
| -------- | --------------- | ------------------------------------------- | ------------ | ------------------------------------------------ | ------------------------------------ | --------------------------------------------------------- |
| double1  | `cReq`          | `ingress.requests`                          | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.requests`                         |
| double2  | `c4xx`          | `ingress.responses4xx`                      | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.responses4xx`                     |
| double3  | `c5xx`          | `ingress.responses5xx`                      | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.responses5xx`                     |
| double4  | `cErr`          | `ingress.requestErrors`                     | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.request_errors`                   |
| double5  | `cReqB`         | `ingress.requestBytes`                      | bytes        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.request_bytes`                    |
| double6  | `cRespB`        | `ingress.responseBytes`                     | bytes        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.response_bytes`                   |
| double7  | `cDur`          | `ingress.requestDurationSecondsSum`         | seconds      | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.request_duration_seconds_sum`     |
| double8  | `cB100`         | `ingress.bucket100ms`                       | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.bucket100ms`                      |
| double9  | `cB500`         | `ingress.bucket500ms`                       | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.bucket500ms`                      |
| double10 | `cB1s`          | `ingress.bucket1s`                          | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.bucket1s`                         |
| double11 | `cInFlight`     | `ingress.requestsInFlight`                  | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_ingress_samples.requests_in_flight`               |
| double12 | `cTls`          | `extended.ingress.tlsCertSoonestExpiryDays` | days         | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_ingress_samples.ext_tls_cert_soonest_expiry_days` |
| double13 | `tTotal`        | `router.backendsTotal`                      | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_router_samples.backends_total`                    |
| double14 | `t5xx`          | `router.backendErrors5xx`                   | count        | Zero is a real reading                           | 0 or more, out of range stored empty | `server_router_samples.backend_errors5xx`                 |
| double15 | `tLatency`      | `router.backendLatencyMsAvg`                | milliseconds | Zero is a real reading                           | 0 or more, out of range stored empty | `server_router_samples.backend_latency_ms_avg`            |
| double16 | `conntrack`     | `host.kernel.conntrackUsedPercent`          | percent      | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.kernel_conntrack_used_percent`       |
| double17 | `fileHandles`   | `host.kernel.fileHandlesUsedPercent`        | percent      | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.kernel_file_handles_used_percent`    |
| double18 | `pidLimit`      | `extended.host.pidLimitUsedPercent`         | percent      | Not supported or not reported (never shown as 0) | 0 to 100, clamped                    | `server_host_samples.ext_pid_limit_used_percent`          |
| double19 | `systemdFailed` | `extended.host.systemdUnitsFailed`          | count        | Not supported or not reported (never shown as 0) | 0 or more, out of range stored empty | `server_host_samples.ext_systemd_units_failed`            |
| double20 | interval        | metadata.intervalSeconds                    | seconds      | never empty                                      | 1 to 3600                            | `interval_seconds` on every table                         |

#### managed.database

| Slot     | Id                              | Contract field                              | Unit         | Absent means           | Range                                | DuckDB table.column                                            |
| -------- | ------------------------------- | ------------------------------------------- | ------------ | ---------------------- | ------------------------------------ | -------------------------------------------------------------- |
| double1  | `dbpostgresInstancesRunning`    | `storage.postgresInstancesRunning`          | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_storage_samples.postgres_instances_running`            |
| double2  | `dbpostgresInstancesHealthy`    | `storage.postgresInstancesHealthy`          | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_storage_samples.postgres_instances_healthy`            |
| double3  | `dbmysqlInstancesRunning`       | `storage.mysqlInstancesRunning`             | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_storage_samples.mysql_instances_running`               |
| double4  | `dbmysqlInstancesHealthy`       | `storage.mysqlInstancesHealthy`             | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_storage_samples.mysql_instances_healthy`               |
| double5  | `dbmariadbInstancesRunning`     | `storage.mariadbInstancesRunning`           | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_storage_samples.mariadb_instances_running`             |
| double6  | `dbmariadbInstancesHealthy`     | `storage.mariadbInstancesHealthy`           | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_storage_samples.mariadb_instances_healthy`             |
| double7  | `pxqueries`                     | `databaseProxy.queries`                     | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.queries`                        |
| double8  | `pxslowQueries`                 | `databaseProxy.slowQueries`                 | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.slow_queries`                   |
| double9  | `pxqueryLatencyMsAvg`           | `databaseProxy.queryLatencyMsAvg`           | milliseconds | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.query_latency_ms_avg`           |
| double10 | `pxbackendLatencyMsAvg`         | `databaseProxy.backendLatencyMsAvg`         | milliseconds | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.backend_latency_ms_avg`         |
| double11 | `pxactiveTransactions`          | `databaseProxy.activeTransactions`          | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.active_transactions`            |
| double12 | `pxclientConnections`           | `databaseProxy.clientConnections`           | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.client_connections`             |
| double13 | `pxclientConnectionsAborted`    | `databaseProxy.clientConnectionsAborted`    | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.client_connections_aborted`     |
| double14 | `pxconnectionsRejectedMaxConns` | `databaseProxy.connectionsRejectedMaxConns` | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.connections_rejected_max_conns` |
| double15 | `pxbackendConnections`          | `databaseProxy.backendConnections`          | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.backend_connections`            |
| double16 | `pxconnectionErrors`            | `databaseProxy.connectionErrors`            | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.connection_errors`              |
| double17 | `pxbackendsUp`                  | `databaseProxy.backendsUp`                  | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.backends_up`                    |
| double18 | `pxbackendsTotal`               | `databaseProxy.backendsTotal`               | count        | Zero is a real reading | 0 or more, out of range stored empty | `server_database_proxy_samples.backends_total`                 |
| double19 | spare                           | none                                        | none         | always empty           | none                                 | none                                                           |
| double20 | interval                        | metadata.intervalSeconds                    | seconds      | never empty            | 1 to 3600                            | `interval_seconds` on every table                              |

### Host rows: text blobs

Text is free on Analytics Engine (it costs no number slot and no row), so descriptive text rides on the host rows.
All text is empty when the daemon did not send it (a version 6 daemon sends none). The contract key is
`extended.text.<key>`; the key equals the id except `unhealthyNames`, which is `unhealthyContainers`
(`TEXT_KEYS`, `v8-layout.ts:336`). **DuckDB stores none of this text.**

| Row                | Blobs, from blob7 in order                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.system`      | `loadavg`, `topCpu`, `cpuModel`, `topMem`, `lastOom`, `kernel`, `os`, `bootId`, `virt`, `cloudProvider`, `agentVersion` (the daemon version), `timeSync`, `pendingUpdates`, `rebootRequired` (blob7-20, full) |
| `host.io`          | `fsReadOnly`, `raidState` (blob7-8)                                                                                                                                                                           |
| `host.network`     | `unhealthyNames` (unhealthy container names), `dockerVersion` (blob7-8). blob6 carries the embedded device names, see the envelope                                                                            |
| `host.web`         | `fpmBusiest`, `topSites` (largest sites by disk), `caddyVersion`, `certSoonest`, `traefikVersion`, `unhealthyBackends`, `phpVersions`, `webEngines`, `failedUnits` (blob7-15)                                 |
| `managed.database` | `dbVersions` (blob7)                                                                                                                                                                                          |

Caddy is totals only: there are no per-site traffic fields anywhere in the format.

### Device rows (paged)

Each page holds up to `perPage` devices. A device takes a fixed run of consecutive doubles in the order of blob6
(device 1 first), then its text blobs are appended device by device from blob7. Unused doubles on a page hold
the sentinel. Packing is `packEntityPages` (`v8-layout.ts:622`); the budget is asserted at load
(`assertV8LayoutWithinBudgets`, `field-map.ts:686`).

| Family              | Per page | Doubles per device, in order                                                                                                                                          | Text per device, in order                                       | Unit and nullability                                                                                                                        |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `block` (drives)    | 3        | 6: `readBytesPerSecond`, `writeBytesPerSecond`, `opsPerSecond` (read ops plus write ops; empty if either is missing), `readLatencyMs`, `writeLatencyMs`, `queueDepth` | `model`, `smart` (drive model and SMART result)                 | bytes per second, ops per second, milliseconds, count. All 0 or more, all nullable, 0 is a real reading                                     |
| `network` (NIC 3+)  | 3        | 6: `receiveBytesPerSecond`, `transmitBytesPerSecond`, `receiveErrorsPerSecond`, `transmitErrorsPerSecond`, `receiveDropsPerSecond`, `transmitDropsPerSecond`          | link speed in Mb/s as plain text (from `extended.networkSizes`) | bytes per second, count per second. All nullable                                                                                            |
| `filesystem`        | 9        | 2: `availableBytes`, `freeInodes`                                                                                                                                     | size as `<bytes>/<inodes>` (either side empty when unknown)     | bytes, count. Nullable. The size text comes from `extended.filesystemSizes`                                                                 |
| `gpu`               | 3        | 6: `utilizationPercent`, `memoryUsedBytes`, `memoryActivityPercent`, `pcieReceiveBytesPerSecond`, `pcieTransmitBytesPerSecond`, `throttlePercent`                     | `driver`, `model`, memory size in bytes as plain text           | percent (0-100, clamped; no data when unsupported), bytes, bytes per second. All nullable                                                   |
| `hardware.physical` | 19       | 1: `value` (one signal per double; the signal ids are in blob6, in order)                                                                                             | none                                                            | The unit depends on the signal (temperature, power); the descriptor lists it as `count`. The signal `kind` is not stored on the hosted rows |

The folded extra filesystem and the two embedded NICs use the same contract fields as above, on `host.io` and
`host.network`.

## The field registry

`field-registry.ts` is the single list of every value the two stores keep. Each entry names the value, whether it
is a number or text, and its home in both stores: the hosted row and slot, and the self-hosted table and column.
Contract values the stores do not keep are listed as well, each with the reason (`NOT_STORED_FIELDS`). A contract
value is in exactly one of the two lists.

`field-registry.test.ts` (also `pnpm check:metrics-parity`, no database needed) fails when:

- a descriptor, a host fact or a device fact is missing from the registry, or listed twice;
- the hosted layout uses a number or text slot the registry does not list, or the registry names a slot the layout
  does not fill, or a reading sits in a different slot than the hosted reader looks in;
- the self-hosted schema has a column the registry does not list, or lacks one it does.

`KNOWN_GAPS` in the registry records the differences that still exist, so a new difference cannot appear
unseen. Each list only shrinks; the aim is that all three are empty and both editions then hold the same readings.

## Data points that are not stored

Nine fields stay in the wire contract and the descriptors but have no hosted slot and are masked on DuckDB, so
every reader answers them as empty on both stores and an older screen asking for one gets "no data" instead of an
unknown-metric error (`UNSTORED_V8_HOST_METRICS`, `metric-descriptors.ts:1094`; the DuckDB reader masks them at
`backends/duckdb/store.ts:710` and `:819`; the hosted reader returns the sentinel for any field without a slot,
`hostMetricSelectExpression`, `sql-api.ts:1145`):

| Field                                  | Another way to read it                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| `host.cpu.saturatedCoreCount`          | the top-process text names a hog                                |
| `storage.hostingFreeBytes`             | read from the disk that holds hosting                           |
| `storage.dockerUsedBytes`              | the sum of the four Docker groups                               |
| `router.backendsUp`                    | backends total minus the unhealthy names                        |
| `router.backendRequests`               | the hosting Caddy counts every request first                    |
| `host.memory.majorPageFaultsPerSecond` | memory pressure is the better signal                            |
| `ingress.responses2xx`                 | requests minus 4xx and 5xx                                      |
| `diagnostics.slabUnreclaimableBytes`   | dropped to make room for the sizes (owner decision, 2026-10-07) |
| `storage.logsUsedBytes`                | dropped to make room for the sizes (owner decision, 2026-10-07) |

Other contract fields also have no hosted slot (for example `host.cpu.procsRunning`, the swap in and out rates,
the other `diagnostics.*` figures, `ingress.responses3xx`, the 10 ms, 50 ms and 5 s latency buckets, upstream
counts, the extra ProxySQL counters, the extra router counters, the per-engine connection counts, the Docker
image and container counts, and `extended.host.mdArraysResyncing`). The hosted reader answers them as empty too
(same code path). DuckDB still has a column for each and returns what it holds, because only the nine above are
masked. Anything that compares the two stores must not treat that difference as a bug.

## Self-hosted rows (DuckDB)

State root `resolveMetricsDir()` (`TURBOPANEL_METRICS_DIR`, default `<stateDir>/metrics`): `metrics.duckdb`,
`parquet/`, `tmp/` and the sidecar `schema-version`. Writes are batched in process and flushed in one transaction.
Each completed UTC day is sealed from the hot tables to Parquet under
`parquet/<table>/year=YYYY/month=MM/day=DD/`; reads union the hot tables with the sealed files.

DuckDB uses one typed table per family, not slots. Every metric column is an independently nullable `DOUBLE`
(a real SQL `NULL`, no sentinel) and entity tables carry any number of rows per sample. No free text is stored.
Every table except the two event tables starts with the same seven columns: `server_id UUID`, `sampled_at`,
`received_at`, `interval_seconds SMALLINT`, `sequence BIGINT`, `topology_generation INTEGER` and
`boot_generation INTEGER` (`COMMON_METADATA_COLUMNS`, `schema.ts:505`); the generation columns are still written
and no v8 reader depends on them.

| Table                               | Holds                                                                                                         | Columns | Notes                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `server_host_samples`               | `host.*` groups (`cpu_`, `kernel_`, `memory_`, `storage_`, `network_` prefixes), `ext_*`, `cpu_diagnostics_*` | 58      | The wide row. `ext_*` holds `extended.host` and `extended.sizes` (the sizes every sample carries)            |
| `server_network_samples`            | one row per NIC                                                                                               | 14      | `device_id`, six rates. No link speed                                                                        |
| `server_filesystem_samples`         | one row per extra filesystem                                                                                  | 12      | `available_bytes`, `free_inodes`, `total_bytes`, `total_inodes`                                              |
| `server_block_samples`              | one row per drive                                                                                             | 16      | read and write ops are separate columns; `utilization_percent` is stored here but not on the hosted rows     |
| `server_gpu_samples`                | one row per GPU                                                                                               | 15      | six readings plus `memory_total_bytes`. No driver or model text                                              |
| `server_hardware_signal_samples`    | one row per sensor signal                                                                                     | 10      | `signal_id`, `kind`, `value`                                                                                 |
| `server_ingress_samples`            | one row per ingress source (Caddy)                                                                            | 29      | adds `ext_tls_cert_soonest_expiry_days`                                                                      |
| `server_database_proxy_samples`     | one row per database proxy source (ProxySQL)                                                                  | 26      |                                                                                                              |
| `server_router_samples`             | the shared router, one row per sample                                                                         | 19      |                                                                                                              |
| `server_storage_samples`            | directory usage, the engine census, filesystem ids                                                            | 40      | the four `*_filesystem_id` columns are always `NULL` today                                                   |
| `server_docker_samples`             | Docker usage plus `ext_*` container health                                                                    | 25      | `ext_reclaimable_bytes` falls back to the sum of the three df columns when absent                            |
| `server_memory_diagnostics_samples` | the memory half of `diagnostics`                                                                              | 19      | holds `committed_as_bytes`                                                                                   |
| `server_metric_events`              | metric events                                                                                                 | 10      | `event_id`, `at`, `received_at`, `kind`, `severity`, `topology_generation`, `entity_id`, `source`, `payload` |
| `server_status_events`              | connection transitions                                                                                        | 4       | `at`, `connected`, `reason`                                                                                  |

Column names come from the contract field names in snake case (`hostMetricColumnName`, `entityMetricColumnName`,
`extendedColumnName`, `cpuDiagnosticsHostColumnName` in `schema.ts`); the host-row tables above show the exact
column for every hosted slot. The DDL is `buildSchemaStatements()` (`schema.ts:734`).

### Marker 10 and the rebuild rule

`DUCKDB_SCHEMA_MARKER_VERSION = 10`, mirrored in the `schema-version` file beside the database
(`backends/duckdb/database.ts`):

- Marker equals 10: open normally. Every DDL statement is `CREATE TABLE IF NOT EXISTS`.
- Marker older than 10, missing beside existing data, empty, unparseable or unreadable: the files
  (`metrics.duckdb`, its wal, `parquet/`, `tmp/`, `schema-version`) are discarded and rebuilt, with one log line.
  A transient read error counts as unreadable and rebuilds the file, by design.
- Marker newer than this build: the open fails and nothing is deleted. Rolling back to a build that expects an
  older marker therefore refuses the newer file; the way back is a fix-forward release.
- There is no in-place column upgrade. The marker is a discard-on-mismatch counter, not a migration version.
- The marker is written before the database file is first created, so a crash between the two leaves a current
  marker and no data, and the next open continues.
- History of the counter, from the comment at `schema.ts:80-99`: 9 added the `ext_*` columns, 10 added the sizes
  (the `ext_*` size columns and `total_*` columns on the filesystem and GPU tables).

Because a self-hosted marker bump discards the metrics history of that install, treat it as a release decision
(see "Versioning").

### Retention

Hosted points age out after Cloudflare's roughly 3 months; Analytics Engine has no delete or update. Self-hosted:
expired Parquet partitions and hot rows are pruned at `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS`, default 90.
A size cap on the self-hosted store (5 GiB, oldest days pruned first) is in open pull request #380 and is not on
trunk yet.

## Hardware record and cache keys

The hosted side keeps only the latest hardware facts for a server, one record that is overwritten, never added to:
the Postgres column `server.hardware` (jsonb, in the control plane's database in every deployment). It is not
in `server.metadata`, which only carries the alert stamp `topologyChurnLimitedAt`. Limits (`features/servers/server-topology-records.ts`):

- The snapshot is at most 64 KiB and the generation numbers fit a Postgres integer.
- A resend of the stored generation is rewritten at most once per 30 seconds per server
  (`TOPOLOGY_REWRITE_COOLDOWN_SECONDS`).
- At most 12 generation changes per rolling hour and 24 per rolling day
  (`MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR` / `_PER_DAY`); further changes are dropped and
  `server.metadata.topologyChurnLimitedAt` is stamped.
- "Latest" is by write time, never by the daemon's own number.
- No history of older generations exists, and sizes are not stored here (they ride every sample).

The chart cache key is `tp:metrics:chart:<kind>:<serverId>:<fromBucketMs>:<toBucketMs>:<sorted metrics>:<resolution>:<backend>:v<schemaVersion>`
with an optional last part `hw<ms>` (`query/cache.ts:50-61`). `<ms>` is the epoch time the stored hardware record
was last written (`Date.parse(latestGeneration.updatedAt)`, `client/servers/metrics-routes.ts:484`). It is added
only for responses that carry what that record holds (device inventory, capacities, CPU limits), so a rewrite of
the record invalidates exactly those answers. Charts never depend on it: each sample carries its own sizes and
device ids.

## The contract shared with the daemon

`src/contracts/metrics-contract.ts` exists in this repo and in `turbopaneld` (`src/contracts/metrics-contract.ts`).
Everything below the header docblock (after the first `*/`) must be byte-identical in the two.

- **`contract-twin`** is the CI job (`.github/workflows/build.yml`, job `contract-twin`) that checks out both repos
  side by side and runs `deno test -A --no-check src/contracts/metrics-contract.test.ts` (the byte compare) and
  `scripts/check-contract-drift.mjs`.
- **`pnpm check:contract-drift`** is the same drift check locally. It also compares the hostname rule, the
  machine-key namespace, the update channels, the slot-mapping constants, the folder-name vectors and the
  expand-only field snapshot (`scripts/contract-field-snapshot.json`). It skips (exit 0) when the sibling checkout
  is missing, so a green local run with no sibling proves nothing.
- Change the contract in both repos in the same step. A field already committed to the snapshot may not be removed
  or narrowed; widening needs `expansion: true` on its pin.
- Wire release order for a format change: the panel first, then the daemon (a daemon without the feature falls
  back to the plain version 6 sample).

## Ingest limits

On trunk today (`validation.ts`):

- `metadata.version` must be 6 or 8; `metadata.sampledAt` must be within 5 minutes of the receive time, either
  way (`MAX_METRICS_SKEW_MS = 300_000`); interval 1 to 3600 seconds; entity arrays are capped at 64 each;
  at most 16 events per sample (above, see the event section).
- A sample with `metadata.durable === false` (the daemon's 10 s live sample) feeds the live overlay only and is
  never written to either store. A sample with no flag (every version 6 daemon) is stored.

**Not on trunk yet.** The per-server admission gate is in open pull request #379 (state open and mergeable when
this file was written; re-check it before relying on this list):

- Exactly one stored sample per minute per server. A sample at or before the last stored one is a duplicate or
  replay (409, not retried). A sample less than 50 s after the last one is accepted only from a catch-up bucket of
  5 tokens that refills one a minute (otherwise 429 with `Retry-After`).
- A sample stamped more than 60 s ahead of the receive time is refused (409 in that pull request).
- Events are stored while an hourly budget of 120 lasts (most severe first); the rest are dropped with a log line.
- State: a Durable Object per server when hosted, an in-process map when self-hosted (never Postgres). If the gate
  cannot answer the response is 503 and nothing is stored unmetered.

When #379 lands, move this block above the line and update the status codes to match `api-routes.ts`.

## Versioning and migration rules

The no-wipe rule for the panel's own database applies to Postgres. Metrics storage is disposable history and has a
different, stricter rule: **a layout change is a hard cut, never a dual read.**

1. **Forward-only and additive first.** Do not edit a written slot in place. Prefer a new metric in a slot that was
   always empty (spare double, spare blob): older rows read as "no data" there, which is correct, so no stamp bump
   is needed. This is the reading of the rule at `field-map.ts:72-80`; check it with a reader test.
2. **Any change to what a written slot means** (move, reorder, re-unit, re-purpose) bumps `AE_STORAGE_VERSION`.
   Readers then skip older rows; nothing reads them under the new meaning. If the wire contract also changes
   incompatibly, `METRICS_SCHEMA_VERSION` moves too, which renames the dataset (`..._v<N>`) in every wrangler
   environment, guarded by `backends/cloudflare/wrangler-datasets.test.ts`.
3. **No dual read, no backfill.** Decided: hard cut to v8. Analytics Engine has no update or delete, so old rows
   are simply not read and age out in about 3 months. Rows stamped 7 are dropped.
4. **The three counters move together:** `METRICS_SCHEMA_VERSION` (wire contract), `DUCKDB_SCHEMA_MARKER_VERSION`
   (on-disk layout) and the chart-cache `schemaVersion` token. A new `ext_*` column is a marker bump, because an
   existing file keeps its old columns under `CREATE TABLE IF NOT EXISTS`.
5. **Wire changes are expand-only** (`scripts/contract-field-snapshot.json`), and a new optional field travels in
   the `extended` section so older daemons keep working.
6. **Postgres:** no metrics migration is needed for the format. If a column in the panel database changes, follow
   the normal forward-only migration rules, with a backup first.
7. **Nothing automated touches live, staging or testing** to prove a format change; the owner runs any dataset
   cut. Analytics Engine creates a dataset on its first write, so a read before any write fails with a missing-table
   error; `isMissingDatasetError` (`sql-api.ts:298`) turns exactly that error for one of our own datasets into "no
   data" and every other error still throws. Check the first read of a new dataset after the first deploy.

## How to add a metric

1. **Contract (both repos).** Add the field to `src/contracts/metrics-contract.ts` (the `extended` field-name list
   such as `EXTENDED_HOST_FIELD_NAMES`, or the entity type) in this repo and in `turbopaneld`, byte-identical below
   the header. Make it `number | null`; sanitize via the existing helpers. Update
   `scripts/contract-field-snapshot.json` if the field is pinned.
2. **Descriptor.** Add it to `src/daemon/metrics/metric-descriptors.ts` with its unit, semantic
   (`gauge`/`rate`/`delta`/`psi-percent`), aggregation, reset behaviour, availability (`missing-when-unsupported` or
   `legitimate-zero`), range and sanitize rule. The canonical name is `<entityScope>.<fieldName>`.
3. **Registry and hosted slot.** Add the value to `field-registry.ts` with a home in both stores
   (`STORED_FIELDS`), or with a reason in `NOT_STORED_FIELDS`. Pick a spare slot. In `backends/cloudflare/v8-layout.ts` add the id to `DOUBLE_DEFS` (or
   `TEXT_KEYS` for text) and to `V8_HOST_ROW_SPECS` at that position; for a device row, add it to the matching
   `*_SPEC`. Respect 19 doubles per page and 14 content blobs.
4. **Layout spec.** The spec and fixture are generated: `scripts/metrics-v8-layout/generate.mjs` from the catalogue
   in `scripts/metrics-v8-layout/artifact-model.cjs` and the selection in `scripts/metrics-v8-layout/plan.json`.
   Add the catalogue row and the plan id, then run `node scripts/metrics-v8-layout/generate.mjs` to regenerate
   `testing/v8-layout.fixture.json` and `V8-LAYOUT.md`. Do not hand-edit either.
5. **DuckDB.** Add the column to the right table in `backends/duckdb/schema.ts` (and its insert path in
   `backends/duckdb/store.ts`), and bump `DUCKDB_SCHEMA_MARKER_VERSION` (one marker bump per release, not per
   field). Update the reader mapping (`hostSeriesColumnForDescriptor`) if the scope is new.
6. **Stamp.** Bump `AE_STORAGE_VERSION` only if you moved or re-meant a written slot (rule 2 above).
7. **Tests.** `v8-layout.test.ts` and `v8-layout.fixture.test.ts` (fixture), `field-map.test.ts` (slots and
   envelope), `cross-backend-parity.test.ts` (the two stores agree on one logical sample),
   `metric-descriptors.test.ts` (descriptor and contract agree), `backends/duckdb/schema.test.ts`. New
   `*.test.ts` files must be claimed in `scripts/test-coverage.sh` or `vitest.config.ts`, then
   `pnpm check:test-inventory`.
8. **Daemon.** Collect and send it (`turbopaneld`), behind a wire feature if an older panel would reject it.
9. **Docs.** Update the slot tables in this file (they are generated from the code, see the note above them) and the
   operator glossary in `website/docs/metrics/` if a chart is added.
10. **Gates.** `pnpm check:metrics-boundaries`, `pnpm check:contract-drift` (with the daemon checked out beside this
    repo), `pnpm check:test-inventory`, `pnpm check:vocabulary`, then the project's pre-push gate.

## Where to verify

- Slot meaning: `backends/cloudflare/v8-layout.ts` and `field-map.ts`; pinned by `v8-layout.test.ts` against
  `testing/v8-layout.fixture.json`.
- Reads: `backends/cloudflare/sql-api.ts` (hosted) and `backends/duckdb/store.ts` (self-hosted).
- Parity: `backends/cloudflare/cross-backend-parity.test.ts`, `v8-readers.parity.test.ts`.
- Sizes and how percentages divide by them: the "Sizes ride every sample" section of `AGENTS.md` in this folder.
- Older sections of that `AGENTS.md` (family catalog, v6 envelope table) describe the retired v6 layout and are kept
  only as the read-side reference; where they disagree with this file, this file wins.
