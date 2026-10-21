/**
 * Turns one authenticated sample into the rows the self-hosted store inserts,
 * one entry per table row, in the column order `schema.ts` declares. Which
 * values are stored is the registry's decision (`../../field-registry.ts`);
 * the column lists in `schema.ts` are cut through it, and this module binds
 * the values in the same order.
 *
 * Nothing here is read back: it only writes. Every missing reading is a real
 * SQL `NULL`, never a sentinel or a coerced zero.
 */

import type {
  BlockDeviceSample,
  MetricsSample,
  NetworkDeviceSample,
} from '../../../../contracts/metrics-contract.ts'
import {
  blockOpsPerSecond,
  dockerReclaimableBytes,
  nicProblemsPerSecond,
  resolveNetworkSlots,
} from '../../shared-derivations.ts'
import type { AuthenticatedMetricsSample, SlotMapping } from '../../types.ts'
import type { DuckDbBindValue } from './database.ts'
import {
  BLOCK_METRIC_FIELDS,
  BLOCK_OPS_FIELD,
  BLOCK_TEXT_FIELDS,
  DATABASE_PROXY_METRIC_FIELDS,
  DOCKER_USAGE_METRIC_FIELDS,
  EXTENDED_DOCKER_STORED_FIELDS,
  EXTENDED_HOST_STORED_FIELDS,
  EXTENDED_INGRESS_STORED_FIELDS,
  EXTENDED_SIZE_STORED_FIELDS,
  FILESYSTEM_METRIC_FIELDS,
  FILESYSTEM_SIZE_FIELDS,
  GPU_METRIC_FIELDS,
  GPU_SIZE_FIELDS,
  GPU_TEXT_FIELDS,
  HOST_METRIC_FIELD_REFS,
  HOST_TEXT_FIELDS,
  INGRESS_METRIC_FIELDS,
  MEMORY_DIAGNOSTICS_METRIC_FIELDS,
  NETWORK_METRIC_FIELDS,
  ROUTER_METRIC_FIELDS,
  STORAGE_ENGINE_STORED_FIELDS,
  STORAGE_FLAT_METRIC_FIELDS,
} from './schema.ts'

export type PendingRowTable =
  | 'host'
  | 'hostText'
  | 'network'
  | 'filesystem'
  | 'block'
  | 'gpu'
  | 'memoryDiagnostics'
  | 'hardwareSignal'
  | 'ingress'
  | 'databaseProxy'
  | 'router'
  | 'storage'
  | 'docker'
  | 'event'
  | 'status'

export type SampleRow = { table: PendingRowTable; values: DuckDbBindValue[] }

type Common = readonly DuckDbBindValue[]

/** DuckDB `TIMESTAMP`-castable UTC string from an ISO timestamp. */
export function toDuckDbTimestamp(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    throw new TypeError(`invalid timestamp: ${iso}`)
  }
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

/** Raw field value off an entity/group object — real value or SQL `NULL`, never a sentinel or coerced `0`. */
function numericField(source: unknown, field: string): number | null {
  return (source as Record<string, number | null>)[field] ?? null
}

/** The size entry of one entity (`extended.filesystemSizes` / `extended.gpuSizes`), by its id. */
function sizeEntry(
  entries: readonly object[] | undefined,
  idField: string,
  id: string
): object | undefined {
  return entries?.find((entry) => (entry as Record<string, unknown>)[idField] === id)
}

/** One v8 `extended` numeric field: the real value, or SQL `NULL` when the section or field is absent (a v6 sample). */
function extendedNumber(source: object | undefined, field: string): number | null {
  return source ? numericField(source, field) : null
}

/** Free text as the hosted store keeps it: the text, or `''` when the sample carries none. */
function textField(source: object | undefined, field: string): string {
  const value = source ? (source as Record<string, unknown>)[field] : undefined
  return typeof value === 'string' ? value : ''
}

function hostRow(input: AuthenticatedMetricsSample, common: Common): SampleRow {
  return {
    table: 'host',
    values: [
      ...common,
      ...HOST_METRIC_FIELD_REFS.map((ref) => numericField(input.host[ref.group], ref.field)),
      ...EXTENDED_HOST_STORED_FIELDS.map((field) => extendedNumber(input.extended?.host, field)),
      ...EXTENDED_INGRESS_STORED_FIELDS.map((field) =>
        extendedNumber(input.extended?.ingress, field)
      ),
      ...EXTENDED_SIZE_STORED_FIELDS.map((field) => extendedNumber(input.extended?.sizes, field)),
    ],
  }
}

function hostTextRow(input: AuthenticatedMetricsSample, common: Common): SampleRow {
  return {
    table: 'hostText',
    values: [...common, ...HOST_TEXT_FIELDS.map((field) => textField(input.extended?.text, field))],
  }
}

/** The error and drop rates a NIC embedded in a host row does not keep apart (only their sum). */
const EMBEDDED_NIC_SPLIT_FIELDS: ReadonlySet<string> = new Set([
  'receiveErrorsPerSecond',
  'transmitErrorsPerSecond',
  'receiveDropsPerSecond',
  'transmitDropsPerSecond',
])

function networkValue(
  network: NetworkDeviceSample,
  field: string,
  embedded: boolean,
  input: MetricsSample
): number | null {
  if (field === 'problemsPerSecond') return embedded ? nicProblemsPerSecond(network) : null
  if (field === 'linkSpeedMbps') {
    return extendedNumber(
      sizeEntry(input.extended?.networkSizes, 'deviceId', network.deviceId),
      'linkSpeedMbps'
    )
  }
  if (embedded && EMBEDDED_NIC_SPLIT_FIELDS.has(field)) return null
  return numericField(network, field)
}

function networkRows(
  input: AuthenticatedMetricsSample,
  common: Common,
  slotMapping: SlotMapping | undefined
): SampleRow[] {
  const { nic0, nic1 } = resolveNetworkSlots(input.networks, slotMapping)
  const embeddedIds = new Set([nic0?.deviceId, nic1?.deviceId])
  return input.networks.map((network) => ({
    table: 'network',
    values: [
      ...common,
      network.deviceId,
      ...NETWORK_METRIC_FIELDS.map((field) =>
        networkValue(network, field, embeddedIds.has(network.deviceId), input)
      ),
    ],
  }))
}

function filesystemRows(input: AuthenticatedMetricsSample, common: Common): SampleRow[] {
  return input.filesystems.map((filesystem) => ({
    table: 'filesystem',
    values: [
      ...common,
      filesystem.filesystemId,
      ...FILESYSTEM_METRIC_FIELDS.map((field) =>
        (FILESYSTEM_SIZE_FIELDS as readonly string[]).includes(field)
          ? extendedNumber(
              sizeEntry(input.extended?.filesystemSizes, 'filesystemId', filesystem.filesystemId),
              field
            )
          : numericField(filesystem, field)
      ),
    ],
  }))
}

function blockValue(device: BlockDeviceSample, field: string): number | null {
  return field === BLOCK_OPS_FIELD ? blockOpsPerSecond(device) : numericField(device, field)
}

function blockRows(input: AuthenticatedMetricsSample, common: Common): SampleRow[] {
  return input.blockDevices.map((device) => {
    const text = sizeEntry(input.extended?.blockDeviceText, 'deviceId', device.deviceId)
    return {
      table: 'block',
      values: [
        ...common,
        device.deviceId,
        ...BLOCK_METRIC_FIELDS.map((field) => blockValue(device, field)),
        ...BLOCK_TEXT_FIELDS.map((field) => textField(text, field)),
      ],
    }
  })
}

function gpuRows(input: AuthenticatedMetricsSample, common: Common): SampleRow[] {
  return input.gpus.map((gpu) => {
    const size = sizeEntry(input.extended?.gpuSizes, 'gpuId', gpu.gpuId)
    const text = sizeEntry(input.extended?.gpuText, 'gpuId', gpu.gpuId)
    return {
      table: 'gpu',
      values: [
        ...common,
        gpu.gpuId,
        ...GPU_METRIC_FIELDS.map((field) =>
          (GPU_SIZE_FIELDS as readonly string[]).includes(field)
            ? extendedNumber(size, field)
            : numericField(gpu, field)
        ),
        ...GPU_TEXT_FIELDS.map((field) => textField(text, field)),
      ],
    }
  })
}

function sourceRows(input: AuthenticatedMetricsSample, common: Common): SampleRow[] {
  const signals: SampleRow[] = input.hardwareSignals.map((signal) => ({
    table: 'hardwareSignal',
    values: [...common, signal.signalId, signal.kind, signal.value ?? null],
  }))
  const ingress: SampleRow[] = input.ingressSources.map((source) => ({
    table: 'ingress',
    values: [
      ...common,
      source.sourceId,
      source.sourceKind,
      ...INGRESS_METRIC_FIELDS.map((field) => numericField(source, field)),
    ],
  }))
  const proxies: SampleRow[] = input.databaseProxies.map((proxy) => ({
    table: 'databaseProxy',
    values: [
      ...common,
      proxy.sourceId,
      proxy.sourceKind,
      ...DATABASE_PROXY_METRIC_FIELDS.map((field) => numericField(proxy, field)),
    ],
  }))
  return [...signals, ...ingress, ...proxies]
}

/** The singleton rows: written once per sample when their section is present. */
function singletonRows(input: AuthenticatedMetricsSample, common: Common): SampleRow[] {
  const rows: SampleRow[] = []
  if (input.diagnostics) {
    const memory = input.diagnostics.memory
    rows.push({
      table: 'memoryDiagnostics',
      values: [...common, ...MEMORY_DIAGNOSTICS_METRIC_FIELDS.map((f) => numericField(memory, f))],
    })
  }
  if (input.router) {
    const router = input.router
    rows.push({
      table: 'router',
      values: [...common, ...ROUTER_METRIC_FIELDS.map((field) => numericField(router, field))],
    })
  }
  if (input.storage) {
    const storage = input.storage
    rows.push({
      table: 'storage',
      values: [
        ...common,
        ...STORAGE_FLAT_METRIC_FIELDS.map((field) => numericField(storage, field)),
        ...STORAGE_ENGINE_STORED_FIELDS.map((entry) =>
          numericField(storage[entry.engine], entry.field)
        ),
      ],
    })
  }
  // The container-health numbers ride with the disk breakdown, and are kept
  // even when the breakdown itself is switched off.
  if (input.dockerUsage || input.extended?.docker) {
    rows.push(dockerRow(input, common))
  }
  return rows
}

function dockerRow(input: AuthenticatedMetricsSample, common: Common): SampleRow {
  const usage = input.dockerUsage
  return {
    table: 'docker',
    values: [
      ...common,
      ...DOCKER_USAGE_METRIC_FIELDS.map((field) => (usage ? numericField(usage, field) : null)),
      ...EXTENDED_DOCKER_STORED_FIELDS.map((field) =>
        field === 'reclaimableBytes'
          ? dockerReclaimableBytes(input.extended?.docker, usage)
          : extendedNumber(input.extended?.docker, field)
      ),
    ],
  }
}

function eventRows(input: AuthenticatedMetricsSample): SampleRow[] {
  return input.events.map((event) => ({
    table: 'event',
    values: [
      input.serverId,
      event.eventId,
      toDuckDbTimestamp(event.at),
      toDuckDbTimestamp(input.receivedAt),
      event.kind,
      event.severity,
      event.entityId ?? null,
      event.source ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
    ],
  }))
}

/**
 * Every row one sample writes: the host row and its text row, one row per
 * device or source, the singleton rows its sections call for, and one row per
 * event. `slotMapping` only decides which NICs the hosted layout embeds in the
 * host row (their errors and drops are kept as one sum there, and here).
 */
export function buildSampleRows(
  input: AuthenticatedMetricsSample,
  slotMapping?: SlotMapping
): SampleRow[] {
  const common: Common = [
    input.serverId,
    toDuckDbTimestamp(input.metadata.sampledAt),
    toDuckDbTimestamp(input.receivedAt),
    Math.round(input.metadata.intervalSeconds),
  ]
  return [
    hostRow(input, common),
    hostTextRow(input, common),
    ...networkRows(input, common, slotMapping),
    ...filesystemRows(input, common),
    ...blockRows(input, common),
    ...gpuRows(input, common),
    ...sourceRows(input, common),
    ...singletonRows(input, common),
    ...eventRows(input),
  ]
}
