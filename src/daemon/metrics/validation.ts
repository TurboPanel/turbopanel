import {
  buildMetricsSample,
  METRIC_EVENT_KINDS,
  type MetricEventKind,
  type MetricEventSeverity,
  type MetricEvent,
  EXTENDED_DOCKER_FIELD_NAMES,
  EXTENDED_HOST_FIELD_NAMES,
  EXTENDED_INGRESS_FIELD_NAMES,
  isMetricsWireVersion,
  MAX_METRICS_TEXT_LENGTH,
  METRICS_TEXT_FIELD_NAMES,
  METRICS_WIRE_VERSIONS,
  type MetricsExtended,
  type MetricsSampleMetadata,
  type MetricsSample,
  type MetricsSampleInput,
  sanitizeFinite,
  STORAGE_ENGINE_FIELD_NAMES,
  STORAGE_ENGINE_KEYS,
  STORAGE_FLAT_FIELD_NAMES,
  storageEngineFieldName,
} from '../../contracts/metrics-contract.ts'
import {
  DIAGNOSTICS_CPU_FIELD_NAMES,
  DIAGNOSTICS_MEMORY_FIELD_NAMES,
  DOCKER_USAGE_FIELD_NAMES,
  type MetricEntityScope,
  ROUTER_FIELD_NAMES,
  sanitizeMetricValue,
} from './metric-descriptors.ts'
import type { AuthenticatedMetricsSample } from './types.ts'

// ---------------------------------------------------------------------------
// Shared validation primitives — version/backend-neutral, this module is
// their sole surviving home after the v3 cutover.
// ---------------------------------------------------------------------------

export const MAX_METRICS_SKEW_MS = 300_000
export const MIN_INTERVAL_SECONDS = 1
export const MAX_INTERVAL_SECONDS = 3600
export const MAX_DIMENSION_LEN = 256
export const METRICS_LOG_COOLDOWN_MS = 5 * 60_000

/** Diagnostic reasons echo caller-supplied text; keep them (and the log map) bounded. */
export const MAX_METRICS_REASON_LEN = 200
export const MAX_METRICS_LOG_KEYS = 1000
/** Generations are stored in 32-bit signed integer columns (DuckDB) and read back as UInt32 (AE). */
export const MAX_GENERATION = 2_147_483_647
/** Buffered events may predate the sample (an OOM kill found on the next tick), but not by weeks. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3_600_000

const rateLimitedLogAt = new Map<string, number>()

function truncateReason(reason: string): string {
  return reason.length > MAX_METRICS_REASON_LEN
    ? `${reason.slice(0, MAX_METRICS_REASON_LEN)}...`
    : reason
}

function evictLogKeys(nowMs: number): void {
  for (const [key, at] of rateLimitedLogAt) {
    if (nowMs - at >= METRICS_LOG_COOLDOWN_MS) rateLimitedLogAt.delete(key)
  }
  while (rateLimitedLogAt.size >= MAX_METRICS_LOG_KEYS) {
    const oldest = rateLimitedLogAt.keys().next()
    if (oldest.done) break
    rateLimitedLogAt.delete(oldest.value)
  }
}

/** Rate-limited diagnostic log — at most once per cooldown per serverId+reason. */
export function rateLimitedMetricsLog(
  serverId: string,
  rawReason: string,
  log: (message: string) => void,
  nowMs = Date.now()
): void {
  const reason = truncateReason(rawReason)
  const key = `${serverId}\0${reason}`
  const last = rateLimitedLogAt.get(key)
  if (last !== undefined && nowMs - last < METRICS_LOG_COOLDOWN_MS) {
    return
  }
  if (last === undefined) evictLogKeys(nowMs)
  rateLimitedLogAt.set(key, nowMs)
  log(reason)
}

/** Test seam: clear rate-limit cooldown map. */
export function resetMetricsRateLimitForTests(): void {
  rateLimitedLogAt.clear()
}

/** UTF-8 byte length of a WebSocket text frame (or ArrayBuffer frame). */
export function metricsPayloadByteLength(raw: string | ArrayBuffer): number {
  if (typeof raw === 'string') {
    return new TextEncoder().encode(raw).byteLength
  }
  return raw.byteLength
}

/**
 * Hard cap on raw v5 metrics frame size (UTF-8 bytes).
 *
 * Worst case: 7 bounded entity arrays (`networks`/`filesystems`/
 * `blockDevices`/`gpus`/`hardwareSignals`/`ingressSources`/`databaseProxies`)
 * × 64 entries (`MAX_METRIC_ENTITY_ARRAY_LENGTH`) × ~250 bytes of JSON per
 * entry (generous for the widest entities — `ingressSources` and
 * `databaseProxies`, both 19 numeric fields plus id/discriminator strings)
 * + the four singleton objects (`diagnostics`, `router`, `storage`,
 * `dockerUsage`) at well under 1 KiB
 * together + 128 events
 * (`MAX_METRIC_EVENTS_PER_SAMPLE`) × ~150 bytes of JSON per event
 * (including a small `payload`) ≈ 7×64×250 + 128×150 = 112,000 + 19,200 ≈
 * 131,200 bytes (~129 KiB). Doubled for headroom (host block, metadata, JSON
 * key repetition, UTF-8 overhead) → 262,144 bytes (256 KiB).
 */
export const MAX_METRICS_PAYLOAD_BYTES = 262_144

/**
 * Defensive pre-construction caps — must stay in sync with the private
 * `MAX_METRIC_ENTITY_ARRAY_LENGTH` / `MAX_METRIC_EVENTS_PER_SAMPLE` constants
 * in `contract.ts`. Rejecting oversized arrays here (with a clear reason)
 * is strictly better than letting `buildMetricsSample` throw a generic
 * `TypeError`, but both layers must agree on the same ceiling.
 */
const MAX_METRIC_ENTITY_ARRAY_LENGTH = 64
const MAX_METRIC_EVENTS_PER_SAMPLE = 128

const MAX_EVENT_PAYLOAD_KEYS = 32

type ValidateFail = { ok: false; reason: string }
type ValidateOk<T> = { ok: true; value: T }
type ValidateResult<T> = ValidateOk<T> | ValidateFail

function fail(reason: string): ValidateFail {
  return { ok: false, reason: truncateReason(`metrics ${reason}`) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): ValidateFail | null {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return fail(`${label}.${key} is not a recognized field`)
    }
  }
  return null
}

/** Bounded non-empty string — used for entity ids, discriminators, and event identity fields. */
function readBoundedString(value: unknown, field: string): ValidateResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${field} must be a non-empty string`)
  }
  if (value.length > MAX_DIMENSION_LEN) {
    return fail(`${field} exceeds max length ${MAX_DIMENSION_LEN}`)
  }
  return { ok: true, value }
}

function readOptionalBoundedString(
  value: unknown,
  field: string
): ValidateResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  return readBoundedString(value, field)
}

function readClosedString<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  reason: string
): ValidateResult<T> {
  if (typeof value !== 'string' || !allowed.has(value)) {
    return fail(reason)
  }
  return { ok: true, value: value as T }
}

function parseSafeNonNegativeInteger(value: unknown, field: string): ValidateResult<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${field} must be a safe non-negative integer`)
  }
  return { ok: true, value }
}

function parseGeneration(value: unknown, field: string): ValidateResult<number> {
  const parsed = parseSafeNonNegativeInteger(value, field)
  if (parsed.ok && parsed.value > MAX_GENERATION) {
    return fail(`${field} must be at most ${MAX_GENERATION}`)
  }
  return parsed
}

function parseTimestamp(
  value: unknown,
  field: string,
  skew: { checkSkew: true | 'event'; nowMs: number }
): ValidateResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${field} must be a non-empty string`)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    return fail(`${field} must be a valid ISO timestamp`)
  }
  if (skew.checkSkew === true && Math.abs(skew.nowMs - ms) > MAX_METRICS_SKEW_MS) {
    return fail(`${field} outside allowed skew window`)
  }
  if (
    skew.checkSkew === 'event' &&
    (ms < skew.nowMs - MAX_EVENT_AGE_MS || ms > skew.nowMs + MAX_METRICS_SKEW_MS)
  ) {
    return fail(`${field} outside allowed event window`)
  }
  return { ok: true, value }
}

function parseIntervalSeconds(value: unknown): ValidateResult<number> {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_INTERVAL_SECONDS ||
    value > MAX_INTERVAL_SECONDS
  ) {
    return fail(
      `metadata.intervalSeconds must be in [${MIN_INTERVAL_SECONDS}, ${MAX_INTERVAL_SECONDS}]`
    )
  }
  return { ok: true, value }
}

function rejectOversizedPayload(payloadBytes: number | undefined): ValidateFail | null {
  if (payloadBytes === undefined || payloadBytes <= MAX_METRICS_PAYLOAD_BYTES) {
    return null
  }
  return fail(`payload exceeds max size ${MAX_METRICS_PAYLOAD_BYTES}`)
}

function parseArray(raw: unknown, field: string, cap: number): ValidateResult<unknown[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} must be an array`)
  }
  if (raw.length > cap) {
    return fail(`${field} has ${raw.length} entries, exceeding the ${cap}-entry cap`)
  }
  return { ok: true, value: raw }
}

// ---------------------------------------------------------------------------
// Envelope / metadata
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'metadata',
  'host',
  'networks',
  'filesystems',
  'blockDevices',
  'gpus',
  'hardwareSignals',
  'ingressSources',
  'databaseProxies',
  'events',
  'diagnostics',
  'router',
  'storage',
  'dockerUsage',
  'extended',
])

function parseEnvelope(raw: unknown): ValidateResult<Record<string, unknown>> {
  if (!isRecord(raw)) return fail('payload must be an object')
  if (raw.type !== 'metrics') return fail('type must be "metrics"')

  if (!isRecord(raw.metadata)) return fail('metadata must be an object')

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      return fail(`${key} is not a recognized field`)
    }
  }
  return { ok: true, value: raw }
}

const ALLOWED_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'sampledAt',
  'intervalSeconds',
  'sequence',
  'topologyGeneration',
  'bootGeneration',
  'durable',
])

function parseMetadata(raw: unknown, nowMs: number): ValidateResult<MetricsSampleMetadata> {
  if (!isRecord(raw)) return fail('metadata must be an object')
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_METADATA_FIELDS.has(key)) {
      return fail(`metadata.${key} is not a recognized metadata field`)
    }
  }
  if (!isMetricsWireVersion(raw.version)) {
    return fail(`metadata.version must be one of ${METRICS_WIRE_VERSIONS.join(', ')}`)
  }
  if (raw.durable !== undefined && typeof raw.durable !== 'boolean') {
    return fail('metadata.durable must be a boolean')
  }
  const sampledAt = parseTimestamp(raw.sampledAt, 'metadata.sampledAt', {
    checkSkew: true,
    nowMs,
  })
  if (!sampledAt.ok) return sampledAt

  const intervalSeconds = parseIntervalSeconds(raw.intervalSeconds)
  if (!intervalSeconds.ok) return intervalSeconds

  const sequence = parseSafeNonNegativeInteger(raw.sequence, 'metadata.sequence')
  if (!sequence.ok) return sequence

  const topologyGeneration = parseGeneration(raw.topologyGeneration, 'metadata.topologyGeneration')
  if (!topologyGeneration.ok) return topologyGeneration

  const bootGeneration = parseGeneration(raw.bootGeneration, 'metadata.bootGeneration')
  if (!bootGeneration.ok) return bootGeneration

  return {
    ok: true,
    value: {
      version: raw.version,
      ...(raw.durable === undefined ? {} : { durable: raw.durable }),
      sampledAt: sampledAt.value,
      intervalSeconds: intervalSeconds.value,
      sequence: sequence.value,
      topologyGeneration: topologyGeneration.value,
      bootGeneration: bootGeneration.value,
    },
  }
}

// ---------------------------------------------------------------------------
// Generic numeric field-group parsing — shared by `host.*` sub-objects and
// the optional `diagnostics` block's two halves. `label` and `scope` are the
// same string for every caller in this file (they mirror
// `metric-descriptors.ts`'s `<entityScope>.<fieldName>` naming), kept as
// separate parameters only because they serve different purposes (error
// messages vs. descriptor lookup).
// ---------------------------------------------------------------------------

function parseFieldGroup(
  raw: unknown,
  label: string,
  scope: MetricEntityScope,
  numericFields: readonly string[]
): ValidateResult<Record<string, number | null>> {
  if (!isRecord(raw)) return fail(`${label} must be an object`)
  const allowed = new Set(numericFields)
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return fail(`${label}.${key} is not a recognized field`)
    }
  }
  const out: Record<string, number | null> = {}
  for (const field of numericFields) {
    const value = Object.hasOwn(raw, field) ? raw[field] : null
    if (value !== null && typeof value !== 'number') {
      return fail(`${label}.${field} must be a number or null`)
    }
    out[field] = sanitizeMetricValue(`${scope}.${field}`, value)
  }
  return { ok: true, value: out }
}

const HOST_CPU_NUMERIC_FIELDS = [
  'busyPercent',
  'userPercent',
  'systemPercent',
  'iowaitPercent',
  'stealPercent',
  'softirqPercent',
  'pressureSomePercent',
  'saturatedCoreCount',
  'procsRunning',
  'procsBlocked',
  'processCount',
] as const

const HOST_KERNEL_NUMERIC_FIELDS = ['fileHandlesUsedPercent', 'conntrackUsedPercent'] as const

const HOST_MEMORY_NUMERIC_FIELDS = [
  'usedBytes',
  'cachedFilesBytes',
  'swapUsedBytes',
  'pressureSomePercent',
  'pressureFullPercent',
  'swapInBytesPerSecond',
  'swapOutBytesPerSecond',
  'majorPageFaultsPerSecond',
] as const

const HOST_STORAGE_NUMERIC_FIELDS = [
  'ioPressureSomePercent',
  'ioPressureFullPercent',
  'diskReadBytesPerSecond',
  'diskWriteBytesPerSecond',
  'diskLatencyMs',
  'rootFilesystemAvailableBytes',
  'rootFilesystemFreeInodes',
] as const

const HOST_NETWORK_NUMERIC_FIELDS = ['tcpRetransmitPercent', 'softnetDropsPerSecond'] as const

const DIAGNOSTICS_CPU_NUMERIC_FIELDS = DIAGNOSTICS_CPU_FIELD_NAMES
const DIAGNOSTICS_MEMORY_NUMERIC_FIELDS = DIAGNOSTICS_MEMORY_FIELD_NAMES

/** `diagnostics`'s two halves — an unknown key at either level is rejected. */
const ALLOWED_DIAGNOSTICS_GROUPS: ReadonlySet<string> = new Set(['cpu', 'memory'])

const ALLOWED_HOST_GROUPS: ReadonlySet<string> = new Set([
  'cpu',
  'kernel',
  'memory',
  'storage',
  'network',
])

function parseHost(raw: unknown): ValidateResult<MetricsSampleInput['host']> {
  if (!isRecord(raw)) return fail('host must be an object')
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_HOST_GROUPS.has(key)) {
      return fail(`host.${key} is not a recognized field`)
    }
  }
  const cpu = parseFieldGroup(raw.cpu, 'host.cpu', 'host.cpu', HOST_CPU_NUMERIC_FIELDS)
  if (!cpu.ok) return cpu
  const kernel = parseFieldGroup(
    raw.kernel,
    'host.kernel',
    'host.kernel',
    HOST_KERNEL_NUMERIC_FIELDS
  )
  if (!kernel.ok) return kernel
  const memory = parseFieldGroup(
    raw.memory,
    'host.memory',
    'host.memory',
    HOST_MEMORY_NUMERIC_FIELDS
  )
  if (!memory.ok) return memory
  const storage = parseFieldGroup(
    raw.storage,
    'host.storage',
    'host.storage',
    HOST_STORAGE_NUMERIC_FIELDS
  )
  if (!storage.ok) return storage
  const network = parseFieldGroup(
    raw.network,
    'host.network',
    'host.network',
    HOST_NETWORK_NUMERIC_FIELDS
  )
  if (!network.ok) return network

  return {
    ok: true,
    // Every field on each group was validated against its exact numeric
    // field list above, so this matches `MetricsSampleInput["host"]`'s
    // shape by construction.
    value: {
      cpu: cpu.value,
      kernel: kernel.value,
      memory: memory.value,
      storage: storage.value,
      network: network.value,
    } as MetricsSampleInput['host'],
  }
}

// ---------------------------------------------------------------------------
// Entity arrays — table-driven so every array shares one parse/sanitize path
// instead of seven near-identical hand-written loops. Canonical-name scopes
// intentionally don't match the array field names 1:1 (`networks` →
// `"network"`, `blockDevices` → `"block"`, `ingressSources` → `"ingress"`,
// `databaseProxies` → `"databaseProxy"`, `hardwareSignals` →
// `"hardwareSignal"`) — see `metric-descriptors.ts`'s entity-scope naming.
// ---------------------------------------------------------------------------

type EntitySpec = {
  arrayField: string
  idField: string
  /** `null` for entity types with no descriptor entry — falls back to plain finite-sanitize. */
  scope: MetricEntityScope | null
  stringFields: readonly string[]
  numericFields: readonly string[]
}

function assignEntityNumericFields(
  spec: EntitySpec,
  raw: Record<string, unknown>,
  label: string,
  out: Record<string, unknown>
): ValidateFail | null {
  for (const field of spec.numericFields) {
    const value = Object.hasOwn(raw, field) ? raw[field] : null
    if (value !== null && typeof value !== 'number') {
      return fail(`${label}.${field} must be a number or null`)
    }
    const numeric = value as number | null
    out[field] = spec.scope
      ? sanitizeMetricValue(`${spec.scope}.${field}`, numeric)
      : sanitizeFinite(numeric)
  }
  return null
}

function parseEntityEntry(
  spec: EntitySpec,
  raw: unknown,
  index: number
): ValidateResult<Record<string, unknown>> {
  const label = `${spec.arrayField}[${index}]`
  if (!isRecord(raw)) return fail(`${label} must be an object`)

  const unknown = rejectUnknownKeys(
    raw,
    new Set([spec.idField, ...spec.stringFields, ...spec.numericFields]),
    label
  )
  if (unknown) return unknown

  const id = readBoundedString(raw[spec.idField], `${label}.${spec.idField}`)
  if (!id.ok) return id

  const out: Record<string, unknown> = { [spec.idField]: id.value }

  for (const field of spec.stringFields) {
    const parsed = readBoundedString(raw[field], `${label}.${field}`)
    if (!parsed.ok) return parsed
    out[field] = parsed.value
  }

  const numeric = assignEntityNumericFields(spec, raw, label, out)
  if (numeric) return numeric

  return { ok: true, value: out }
}

function parseEntityArray<T>(raw: unknown, spec: EntitySpec, cap: number): ValidateResult<T[]> {
  const arr = parseArray(raw, spec.arrayField, cap)
  if (!arr.ok) return arr

  const out: T[] = []
  for (let i = 0; i < arr.value.length; i++) {
    const entry = parseEntityEntry(spec, arr.value[i], i)
    if (!entry.ok) return entry
    // Every key was checked against `spec`'s exact field lists above, so
    // this matches the RawInput<…> shape `buildMetricsSample` expects.
    out.push(entry.value as T)
  }
  return { ok: true, value: out }
}

const NETWORK_SPEC: EntitySpec = {
  arrayField: 'networks',
  idField: 'deviceId',
  scope: 'network',
  stringFields: [],
  numericFields: [
    'receiveBytesPerSecond',
    'transmitBytesPerSecond',
    'receiveErrorsPerSecond',
    'transmitErrorsPerSecond',
    'receiveDropsPerSecond',
    'transmitDropsPerSecond',
  ],
}

const FILESYSTEM_SPEC: EntitySpec = {
  arrayField: 'filesystems',
  idField: 'filesystemId',
  scope: 'filesystem',
  stringFields: [],
  numericFields: ['availableBytes', 'freeInodes'],
}

const BLOCK_DEVICE_SPEC: EntitySpec = {
  arrayField: 'blockDevices',
  idField: 'deviceId',
  scope: 'block',
  stringFields: [],
  numericFields: [
    'readBytesPerSecond',
    'writeBytesPerSecond',
    'readOpsPerSecond',
    'writeOpsPerSecond',
    'readLatencyMs',
    'writeLatencyMs',
    'utilizationPercent',
    'queueDepth',
  ],
}

const GPU_SPEC: EntitySpec = {
  arrayField: 'gpus',
  idField: 'gpuId',
  scope: 'gpu',
  stringFields: [],
  numericFields: [
    'utilizationPercent',
    'memoryUsedBytes',
    'memoryActivityPercent',
    'pcieReceiveBytesPerSecond',
    'pcieTransmitBytesPerSecond',
    'throttlePercent',
  ],
}

const HARDWARE_SIGNAL_SPEC: EntitySpec = {
  arrayField: 'hardwareSignals',
  idField: 'signalId',
  scope: 'hardwareSignal',
  stringFields: ['kind'],
  numericFields: ['value'],
}

const INGRESS_SPEC: EntitySpec = {
  arrayField: 'ingressSources',
  idField: 'sourceId',
  scope: 'ingress',
  stringFields: ['sourceKind'],
  numericFields: [
    'requests',
    'responses2xx',
    'responses3xx',
    'responses4xx',
    'responses5xx',
    'requestErrors',
    'requestBytes',
    'responseBytes',
    'requestDurationSecondsSum',
    'bucket10ms',
    'bucket50ms',
    'bucket100ms',
    'bucket500ms',
    'bucket1s',
    'bucket5s',
    'requestsInFlight',
    'upstreamsHealthy',
    'upstreamsTotal',
    'retries',
  ],
}

const DATABASE_PROXY_SPEC: EntitySpec = {
  arrayField: 'databaseProxies',
  idField: 'sourceId',
  scope: 'databaseProxy',
  stringFields: ['sourceKind'],
  numericFields: [
    'queries',
    'slowQueries',
    'queryLatencyMsAvg',
    'backendLatencyMsAvg',
    'activeTransactions',
    'clientConnections',
    'clientConnectionsCreated',
    'clientConnectionsAborted',
    'connectionsRejectedMaxConns',
    'backendConnections',
    'backendConnectionsCreated',
    'backendConnectionsAborted',
    'connectionErrors',
    'backendsUp',
    'backendsTotal',
    'bytesFromBackends',
    'bytesToBackends',
  ],
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const METRIC_EVENT_KIND_SET: ReadonlySet<string> = new Set(METRIC_EVENT_KINDS)
const EVENT_SEVERITIES: ReadonlySet<string> = new Set(['info', 'warning', 'critical'])
const ALLOWED_EVENT_FIELDS: ReadonlySet<string> = new Set([
  'eventId',
  'at',
  'kind',
  'severity',
  'entityId',
  'source',
  'payload',
])

type EventPayloadScalar = string | number | boolean | null
type EventPayloadRecord = Record<string, EventPayloadScalar>

function parseEventPayloadScalar(
  value: unknown,
  field: string
): ValidateResult<EventPayloadScalar> {
  if (value === null || typeof value === 'boolean') {
    return { ok: true, value }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail(`${field} must be finite`)
    }
    return { ok: true, value }
  }
  if (typeof value === 'string') {
    if (value.length > MAX_DIMENSION_LEN) {
      return fail(`${field} exceeds max length ${MAX_DIMENSION_LEN}`)
    }
    return { ok: true, value }
  }
  return fail(`${field} must be a string, number, boolean, or null`)
}

function parseEventPayload(
  raw: unknown,
  label: string
): ValidateResult<EventPayloadRecord | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!isRecord(raw)) return fail(`${label} must be an object`)

  const keys = Object.keys(raw)
  if (keys.length > MAX_EVENT_PAYLOAD_KEYS) {
    return fail(`${label} has ${keys.length} keys, exceeding the ${MAX_EVENT_PAYLOAD_KEYS}-key cap`)
  }

  const out: EventPayloadRecord = {}
  for (const key of keys) {
    if (key.length > MAX_DIMENSION_LEN) {
      return fail(`${label} key exceeds max length ${MAX_DIMENSION_LEN}`)
    }
    const parsed = parseEventPayloadScalar(raw[key], `${label}.${key}`)
    if (!parsed.ok) return parsed
    out[key] = parsed.value
  }
  return { ok: true, value: out }
}

function assignOptionalEventString(
  event: MetricEvent,
  key: 'entityId' | 'source',
  raw: unknown,
  field: string
): ValidateFail | null {
  const parsed = readOptionalBoundedString(raw, field)
  if (!parsed.ok) return parsed
  if (parsed.value !== undefined) event[key] = parsed.value
  return null
}

function parseEvent(raw: unknown, index: number, nowMs: number): ValidateResult<MetricEvent> {
  const label = `events[${index}]`
  if (!isRecord(raw)) return fail(`${label} must be an object`)
  const unknown = rejectUnknownKeys(raw, ALLOWED_EVENT_FIELDS, label)
  if (unknown) return unknown

  const eventId = readBoundedString(raw.eventId, `${label}.eventId`)
  if (!eventId.ok) return eventId

  // Buffered events legitimately predate `metadata.sampledAt` by more than
  // the skew window (e.g. an OOM kill discovered on the next tick) — only
  // ISO validity plus a generous window ([now - 7 d, now + skew]) is enforced,
  // never the tight `MAX_METRICS_SKEW_MS` window.
  const at = parseTimestamp(raw.at, `${label}.at`, { checkSkew: 'event', nowMs })
  if (!at.ok) return at

  const kind = readClosedString<MetricEventKind>(
    raw.kind,
    METRIC_EVENT_KIND_SET,
    `${label}.kind is not a recognized event kind`
  )
  if (!kind.ok) return kind

  const severity = readClosedString<MetricEventSeverity>(
    raw.severity,
    EVENT_SEVERITIES,
    `${label}.severity must be "info", "warning", or "critical"`
  )
  if (!severity.ok) return severity

  const event: MetricEvent = {
    eventId: eventId.value,
    at: at.value,
    kind: kind.value,
    severity: severity.value,
  }

  const entityId = assignOptionalEventString(event, 'entityId', raw.entityId, `${label}.entityId`)
  if (entityId) return entityId
  const source = assignOptionalEventString(event, 'source', raw.source, `${label}.source`)
  if (source) return source

  const payload = parseEventPayload(raw.payload, `${label}.payload`)
  if (!payload.ok) return payload
  if (payload.value !== undefined) event.payload = payload.value

  return { ok: true, value: event }
}

function parseEvents(raw: unknown, nowMs: number): ValidateResult<MetricEvent[]> {
  const arr = parseArray(raw, 'events', MAX_METRIC_EVENTS_PER_SAMPLE)
  if (!arr.ok) return arr

  const events: MetricEvent[] = []
  for (let i = 0; i < arr.value.length; i++) {
    const event = parseEvent(arr.value[i], i, nowMs)
    if (!event.ok) return event
    events.push(event.value)
  }
  return { ok: true, value: events }
}

// ---------------------------------------------------------------------------
// Top-level validation
// ---------------------------------------------------------------------------

type RequiredEntityArrays = {
  networks: MetricsSampleInput['networks']
  filesystems: MetricsSampleInput['filesystems']
  blockDevices: MetricsSampleInput['blockDevices']
  gpus: MetricsSampleInput['gpus']
  hardwareSignals: MetricsSampleInput['hardwareSignals']
  ingressSources: MetricsSampleInput['ingressSources']
  databaseProxies: MetricsSampleInput['databaseProxies']
}

const REQUIRED_ENTITY_SPECS: readonly {
  key: keyof RequiredEntityArrays
  spec: EntitySpec
}[] = [
  { key: 'networks', spec: NETWORK_SPEC },
  { key: 'filesystems', spec: FILESYSTEM_SPEC },
  { key: 'blockDevices', spec: BLOCK_DEVICE_SPEC },
  { key: 'gpus', spec: GPU_SPEC },
  { key: 'hardwareSignals', spec: HARDWARE_SIGNAL_SPEC },
  { key: 'ingressSources', spec: INGRESS_SPEC },
  { key: 'databaseProxies', spec: DATABASE_PROXY_SPEC },
]

function parseRequiredEntityArrays(
  envelope: Record<string, unknown>
): ValidateResult<RequiredEntityArrays> {
  const out: Record<string, unknown> = {}
  for (const { key, spec } of REQUIRED_ENTITY_SPECS) {
    const parsed = parseEntityArray(envelope[key], spec, MAX_METRIC_ENTITY_ARRAY_LENGTH)
    if (!parsed.ok) return parsed
    out[key] = parsed.value
  }
  return { ok: true, value: out as RequiredEntityArrays }
}

/**
 * Parse the optional `diagnostics` block. Unlike v5's two flat
 * `cpuDetail`/`memoryDetail` objects, the merged v6 family nests its two
 * halves, so unknown keys are rejected at both levels — an unrecognized
 * group name and an unrecognized field inside a group are both errors, never
 * silently dropped.
 *
 * The block is optional but not partial: present means both halves present,
 * matching the OpenAPI schema's `required: ['cpu', 'memory']`. A collector
 * that could read only one source still sends both, with the unreadable
 * half's fields `null` — see the daemon's `collector/diagnostics.ts`.
 */
function parseDiagnostics(
  raw: unknown
): ValidateResult<NonNullable<MetricsSampleInput['diagnostics']>> {
  if (!isRecord(raw)) return fail('diagnostics must be an object')
  const unknownGroup = rejectUnknownKeys(raw, ALLOWED_DIAGNOSTICS_GROUPS, 'diagnostics')
  if (unknownGroup) return unknownGroup

  const cpu = parseFieldGroup(
    raw.cpu,
    'diagnostics.cpu',
    'diagnostics',
    DIAGNOSTICS_CPU_NUMERIC_FIELDS
  )
  if (!cpu.ok) return cpu

  const memory = parseFieldGroup(
    raw.memory,
    'diagnostics.memory',
    'diagnostics',
    DIAGNOSTICS_MEMORY_NUMERIC_FIELDS
  )
  if (!memory.ok) return memory

  return {
    ok: true,
    value: { cpu: cpu.value, memory: memory.value } as NonNullable<
      MetricsSampleInput['diagnostics']
    >,
  }
}

/**
 * Parse the optional `router` block — the host-wide shared-ingress router
 * family. One flat group (unlike `diagnostics`'s two halves), so it reuses
 * `parseFieldGroup` directly: an unrecognized field is an error, and a
 * missing one sanitizes to `null` rather than being silently dropped.
 */
function parseRouter(raw: unknown): ValidateResult<NonNullable<MetricsSampleInput['router']>> {
  const parsed = parseFieldGroup(raw, 'router', 'router', ROUTER_FIELD_NAMES)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    value: parsed.value as NonNullable<MetricsSampleInput['router']>,
  }
}

/**
 * Parse the optional `storage` block — host-wide managed-storage accounting.
 *
 * Three-level shape (seven flat fields plus three nested per-engine groups),
 * so it cannot reuse `parseFieldGroup` wholesale the way `router` does: the
 * engine readings share field names across engines, and their descriptor
 * canonical names are the *flattened* `storage.postgresInstancesRunning`
 * form, not `storage.instancesRunning`. Unknown keys are rejected at both
 * levels, and a missing field sanitizes to `null` rather than being dropped.
 *
 * Like `diagnostics`, the block is optional but not partial: present means
 * all three engine groups present, each with its own (possibly all-`null`)
 * readings.
 */
function parseStorageEngine(
  raw: unknown,
  engine: (typeof STORAGE_ENGINE_KEYS)[number]
): ValidateResult<Record<string, number | null>> {
  if (!isRecord(raw)) return fail(`storage.${engine} must be an object`)
  const unknown = rejectUnknownKeys(
    raw,
    new Set<string>(STORAGE_ENGINE_FIELD_NAMES),
    `storage.${engine}`
  )
  if (unknown) return unknown
  const out: Record<string, number | null> = {}
  for (const field of STORAGE_ENGINE_FIELD_NAMES) {
    const value = Object.hasOwn(raw, field) ? raw[field] : null
    if (value !== null && typeof value !== 'number') {
      return fail(`storage.${engine}.${field} must be a number or null`)
    }
    out[field] = sanitizeMetricValue(`storage.${storageEngineFieldName(engine, field)}`, value)
  }
  return { ok: true, value: out }
}

const ALLOWED_STORAGE_KEYS: ReadonlySet<string> = new Set<string>([
  ...STORAGE_FLAT_FIELD_NAMES,
  ...STORAGE_ENGINE_KEYS,
])

function parseStorage(raw: unknown): ValidateResult<NonNullable<MetricsSampleInput['storage']>> {
  if (!isRecord(raw)) return fail('storage must be an object')
  const unknown = rejectUnknownKeys(raw, ALLOWED_STORAGE_KEYS, 'storage')
  if (unknown) return unknown

  const value: Record<string, unknown> = {}
  for (const field of STORAGE_FLAT_FIELD_NAMES) {
    const entry = Object.hasOwn(raw, field) ? raw[field] : null
    if (entry !== null && typeof entry !== 'number') {
      return fail(`storage.${field} must be a number or null`)
    }
    value[field] = sanitizeMetricValue(`storage.${field}`, entry)
  }
  for (const engine of STORAGE_ENGINE_KEYS) {
    const parsed = parseStorageEngine(raw[engine], engine)
    if (!parsed.ok) return parsed
    value[engine] = parsed.value
  }
  return {
    ok: true,
    value: value as NonNullable<MetricsSampleInput['storage']>,
  }
}

/**
 * Parse the optional `dockerUsage` block — Docker's `GET /system/df`
 * breakdown. One flat group like `router`, so it reuses `parseFieldGroup`
 * directly.
 */
function parseDockerUsage(
  raw: unknown
): ValidateResult<NonNullable<MetricsSampleInput['dockerUsage']>> {
  const parsed = parseFieldGroup(raw, 'dockerUsage', 'dockerUsage', DOCKER_USAGE_FIELD_NAMES)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    value: parsed.value as NonNullable<MetricsSampleInput['dockerUsage']>,
  }
}

const ALLOWED_EXTENDED_FIELDS: ReadonlySet<string> = new Set([
  'host',
  'docker',
  'ingress',
  'text',
  'blockDeviceText',
  'gpuText',
])

/** One flat object of `number | null` readings: unknown keys and non-numbers are rejected. */
function parseOptionalNumberGroup(
  raw: unknown,
  label: string,
  names: readonly string[]
): ValidateResult<Record<string, number | null>> {
  if (!isRecord(raw)) return fail(`${label} must be an object`)
  const unknown = rejectUnknownKeys(raw, new Set(names), label)
  if (unknown) return unknown
  const out: Record<string, number | null> = {}
  for (const name of names) {
    const value = raw[name]
    if (value === undefined) continue
    if (value !== null && typeof value !== 'number') {
      return fail(`${label}.${name} must be a number or null`)
    }
    out[name] = value
  }
  return { ok: true, value: out }
}

/** Free text: strings only, bounded; the contract sanitizer trims and drops empties. */
function parseTextGroup(
  raw: unknown,
  label: string,
  names: readonly string[],
  idField?: string
): ValidateResult<Record<string, string>> {
  if (!isRecord(raw)) return fail(`${label} must be an object`)
  const unknown = rejectUnknownKeys(raw, new Set(idField ? [idField, ...names] : names), label)
  if (unknown) return unknown
  const out: Record<string, string> = {}
  for (const name of idField ? [idField, ...names] : names) {
    const value = raw[name]
    if (value === undefined) continue
    if (typeof value !== 'string') return fail(`${label}.${name} must be a string`)
    const limit = name === idField ? MAX_DIMENSION_LEN : MAX_METRICS_TEXT_LENGTH * 4
    if (value.length > limit) return fail(`${label}.${name} exceeds max length ${limit}`)
    out[name] = value
  }
  if (idField && !out[idField]) return fail(`${label}.${idField} must be a non-empty string`)
  return { ok: true, value: out }
}

function parseTextEntries(
  raw: unknown,
  label: string,
  idField: string,
  names: readonly string[]
): ValidateResult<Record<string, string>[]> {
  const arr = parseArray(raw, label, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  if (!arr.ok) return arr
  const out: Record<string, string>[] = []
  for (let i = 0; i < arr.value.length; i++) {
    const entry = parseTextGroup(arr.value[i], `${label}[${i}]`, names, idField)
    if (!entry.ok) return entry
    out.push(entry.value)
  }
  return { ok: true, value: out }
}

type ExtendedNumberSection = 'host' | 'docker' | 'ingress'
const EXTENDED_NUMBER_SECTIONS: readonly (readonly [ExtendedNumberSection, readonly string[]])[] = [
  ['host', EXTENDED_HOST_FIELD_NAMES],
  ['docker', EXTENDED_DOCKER_FIELD_NAMES],
  ['ingress', EXTENDED_INGRESS_FIELD_NAMES],
]

/** Parse the text-bearing parts of the v7 `extended` section into `out`. */
function parseExtendedText(
  raw: Record<string, unknown>,
  out: Record<string, unknown>
): ValidateResult<true> {
  if (raw.text !== undefined) {
    const parsed = parseTextGroup(raw.text, 'extended.text', METRICS_TEXT_FIELD_NAMES)
    if (!parsed.ok) return parsed
    out.text = parsed.value
  }
  if (raw.blockDeviceText !== undefined) {
    const parsed = parseTextEntries(raw.blockDeviceText, 'extended.blockDeviceText', 'deviceId', [
      'model',
      'smart',
    ])
    if (!parsed.ok) return parsed
    out.blockDeviceText = parsed.value
  }
  if (raw.gpuText !== undefined) {
    const parsed = parseTextEntries(raw.gpuText, 'extended.gpuText', 'gpuId', ['driver', 'model'])
    if (!parsed.ok) return parsed
    out.gpuText = parsed.value
  }
  return { ok: true, value: true }
}

/**
 * Parse the optional v7 `extended` section. Every key is optional and unknown
 * keys are rejected, so a typo cannot silently drop a reading.
 */
function parseExtended(raw: unknown): ValidateResult<MetricsExtended> {
  if (!isRecord(raw)) return fail('extended must be an object')
  const unknown = rejectUnknownKeys(raw, ALLOWED_EXTENDED_FIELDS, 'extended')
  if (unknown) return unknown
  const out: Record<string, unknown> = {}
  for (const [section, names] of EXTENDED_NUMBER_SECTIONS) {
    if (raw[section] === undefined) continue
    const parsed = parseOptionalNumberGroup(raw[section], `extended.${section}`, names)
    if (!parsed.ok) return parsed
    out[section] = parsed.value
  }
  const text = parseExtendedText(raw, out)
  if (!text.ok) return text
  return { ok: true, value: out as MetricsExtended }
}

type OptionalSampleParts = {
  extended?: MetricsExtended
  diagnostics?: NonNullable<MetricsSampleInput['diagnostics']>
  router?: NonNullable<MetricsSampleInput['router']>
  storage?: NonNullable<MetricsSampleInput['storage']>
  dockerUsage?: NonNullable<MetricsSampleInput['dockerUsage']>
}

function parseOptionalSampleParts(
  envelope: Record<string, unknown>
): ValidateResult<OptionalSampleParts> {
  const value: OptionalSampleParts = {}
  if (envelope.diagnostics !== undefined) {
    const parsed = parseDiagnostics(envelope.diagnostics)
    if (!parsed.ok) return parsed
    value.diagnostics = parsed.value
  }
  if (envelope.router !== undefined) {
    const parsed = parseRouter(envelope.router)
    if (!parsed.ok) return parsed
    value.router = parsed.value
  }
  if (envelope.storage !== undefined) {
    const parsed = parseStorage(envelope.storage)
    if (!parsed.ok) return parsed
    value.storage = parsed.value
  }
  if (envelope.dockerUsage !== undefined) {
    const parsed = parseDockerUsage(envelope.dockerUsage)
    if (!parsed.ok) return parsed
    value.dockerUsage = parsed.value
  }
  if (envelope.extended !== undefined) {
    const parsed = parseExtended(envelope.extended)
    if (!parsed.ok) return parsed
    value.extended = parsed.value
  }
  return { ok: true, value }
}

function caughtSampleError(err: unknown): ValidateFail {
  return {
    ok: false,
    reason: err instanceof Error ? err.message : 'metrics sample invalid',
  }
}

/**
 * Validate a raw daemon metrics frame against the v5 wire contract.
 * `serverId` always comes from `ctx` — never from the client payload.
 */
export function validateMetricsSample(
  raw: unknown,
  ctx: {
    serverId: string
    receivedAt: string
    nowMs?: number
    /** Raw frame UTF-8 byte length; rejects when over `MAX_METRICS_PAYLOAD_BYTES`. */
    payloadBytes?: number
  }
):
  | { ok: true; sample: AuthenticatedMetricsSample }
  | {
      ok: false
      reason: string
    } {
  const oversized = rejectOversizedPayload(ctx.payloadBytes)
  if (oversized) return oversized

  const envelope = parseEnvelope(raw)
  if (!envelope.ok) return envelope

  const nowMs = ctx.nowMs ?? Date.now()

  const metadata = parseMetadata(envelope.value.metadata, nowMs)
  if (!metadata.ok) return metadata

  const host = parseHost(envelope.value.host)
  if (!host.ok) return host

  const entities = parseRequiredEntityArrays(envelope.value)
  if (!entities.ok) return entities

  const events = parseEvents(envelope.value.events, nowMs)
  if (!events.ok) return events

  const optionals = parseOptionalSampleParts(envelope.value)
  if (!optionals.ok) return optionals

  let built: MetricsSample
  try {
    built = buildMetricsSample({
      metadata: metadata.value,
      host: host.value,
      ...entities.value,
      events: events.value,
      ...optionals.value,
    })
  } catch (err) {
    return caughtSampleError(err)
  }

  return {
    ok: true,
    sample: {
      ...built,
      serverId: ctx.serverId,
      receivedAt: ctx.receivedAt,
    },
  }
}
