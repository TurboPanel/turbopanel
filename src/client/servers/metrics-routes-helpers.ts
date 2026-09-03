/**
 * Pure helpers for server metrics routes — query parsing, backend kind, and
 * response shaping without a Hono Context.
 */

import { CloudflareAnalyticsEngineServerMetricsStore } from '../../daemon/metrics/backends/cloudflare/store.ts'
import { DisabledServerMetricsStore } from '../../daemon/metrics/disabled-store.ts'
import type {
  MetricsBackendKind,
  ServerMetricsStore,
  StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  type EffectiveCpuThermalLimits,
  HARDWARE_PROFILE_NIC_KEYS,
  HARDWARE_PROFILE_SENSOR_SLOT_KEYS,
  resolveEffectiveCpuThermalLimits,
  type ServerHardwareProfile,
  type ServerHardwareProfileUpdate,
  type ServerSensorSlotAssignment,
} from '../../lib/db/server-metadata.ts'
import {
  type OrganizationOptions,
  resolveTemperatureUnit,
  type TemperatureUnit,
} from '../../lib/organization-options.ts'

export type IsoTimestampParseResult =
  { ok: true; ms: number; iso: string } | { ok: false; message: string }

/** Max characters accepted for one hardware-profile chip/label/NIC/path value. */
export const MAX_HARDWARE_PROFILE_FIELD_CHARS = 512

export type HardwareProfileBodyParse =
  { ok: true; update: ServerHardwareProfileUpdate } | { ok: false; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type SlotFieldParse =
  { ok: true; value: ServerSensorSlotAssignment | null } | { ok: false; message: string }

/** One sensor-slot field: `null` unassigns, `{chip,label}` pins an identity. */
function parseSlotField(key: string, value: unknown): SlotFieldParse {
  if (value === null) return { ok: true, value: null }
  if (!isRecord(value)) {
    return {
      ok: false,
      message: `${key} must be an object with chip/label, or null`,
    }
  }
  const chip = typeof value.chip === 'string' ? value.chip.trim() : ''
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  if (!chip || !label) {
    return { ok: false, message: `${key} requires non-empty chip and label` }
  }
  if (
    chip.length > MAX_HARDWARE_PROFILE_FIELD_CHARS ||
    label.length > MAX_HARDWARE_PROFILE_FIELD_CHARS
  ) {
    return { ok: false, message: `${key} chip/label exceeds max length` }
  }
  return { ok: true, value: { chip, label } }
}

type NicFieldParse = { ok: true; value: string | null } | { ok: false; message: string }

/** One NIC-binding field: `null` unassigns, a non-blank string names an interface. */
function parseNicField(key: string, value: unknown): NicFieldParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return { ok: false, message: `${key} must be a string or null` }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: `${key} must not be blank` }
  }
  if (trimmed.length > MAX_HARDWARE_PROFILE_FIELD_CHARS) {
    return { ok: false, message: `${key} exceeds max length` }
  }
  return { ok: true, value: trimmed }
}

const KNOWN_HARDWARE_PROFILE_KEYS = new Set<string>([
  ...HARDWARE_PROFILE_SENSOR_SLOT_KEYS,
  ...HARDWARE_PROFILE_NIC_KEYS,
  'hostingPath',
  'drivetempEnabled',
  'cpuTdpWattsOverride',
  'cpuTjMaxCelsiusOverride',
])

/** Generous ceiling — well above any real single-socket CPU's TDP. */
const CPU_TDP_WATTS_MAX = 1000
/** Plausible silicon junction-temperature range. */
const CPU_TJ_MAX_CELSIUS_MIN = 40
const CPU_TJ_MAX_CELSIUS_MAX = 130

type NumberFieldParse = { ok: true; value: number | null } | { ok: false; message: string }

/** `cpuTdpWattsOverride`: `null` clears it, a finite positive number under the ceiling pins it. */
function parseCpuTdpWattsField(value: unknown): NumberFieldParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      ok: false,
      message: 'cpuTdpWattsOverride must be a finite number or null',
    }
  }
  if (value <= 0 || value > CPU_TDP_WATTS_MAX) {
    return {
      ok: false,
      message: `cpuTdpWattsOverride must be greater than 0 and at most ${CPU_TDP_WATTS_MAX}`,
    }
  }
  return { ok: true, value }
}

/** `cpuTjMaxCelsiusOverride`: `null` clears it, a value within the plausible silicon range pins it. */
function parseCpuTjMaxCelsiusField(value: unknown): NumberFieldParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      ok: false,
      message: 'cpuTjMaxCelsiusOverride must be a finite number or null',
    }
  }
  if (value < CPU_TJ_MAX_CELSIUS_MIN || value > CPU_TJ_MAX_CELSIUS_MAX) {
    return {
      ok: false,
      message: `cpuTjMaxCelsiusOverride must be between ${CPU_TJ_MAX_CELSIUS_MIN} and ${CPU_TJ_MAX_CELSIUS_MAX}`,
    }
  }
  return { ok: true, value }
}

type HardwareProfileFieldResult = { ok: true } | { ok: false; message: string }

/** Rejects any key not in {@link KNOWN_HARDWARE_PROFILE_KEYS} so a typo cannot silently no-op. */
function findUnknownHardwareProfileField(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (!KNOWN_HARDWARE_PROFILE_KEYS.has(key)) return key
  }
  return null
}

function applySensorSlotFields(
  body: Record<string, unknown>,
  update: ServerHardwareProfileUpdate
): HardwareProfileFieldResult {
  for (const key of HARDWARE_PROFILE_SENSOR_SLOT_KEYS) {
    const value = body[key]
    if (value === undefined) continue
    const parsed = parseSlotField(key, value)
    if (!parsed.ok) return parsed
    update[key] = parsed.value
  }
  return { ok: true }
}

function applyNicFields(
  body: Record<string, unknown>,
  update: ServerHardwareProfileUpdate
): HardwareProfileFieldResult {
  for (const key of HARDWARE_PROFILE_NIC_KEYS) {
    const value = body[key]
    if (value === undefined) continue
    const parsed = parseNicField(key, value)
    if (!parsed.ok) return parsed
    update[key] = parsed.value
  }
  return { ok: true }
}

type HostingPathParse = { ok: true; value: string | null } | { ok: false; message: string }

/** `hostingPath`: `null` clears it, an absolute path without whitespace pins it. */
function parseHostingPathField(value: unknown): HostingPathParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return { ok: false, message: 'hostingPath must be a string or null' }
  }
  if (value.length > MAX_HARDWARE_PROFILE_FIELD_CHARS) {
    return { ok: false, message: 'hostingPath exceeds max length' }
  }
  const trimmed = value.trim()
  if (trimmed.length > 0 && (!trimmed.startsWith('/') || /[\s\p{Cc}]/u.test(trimmed))) {
    return {
      ok: false,
      message: 'hostingPath must be an absolute path without whitespace',
    }
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : null }
}

type DrivetempEnabledParse = { ok: true; value: boolean | null } | { ok: false; message: string }

function parseDrivetempEnabledField(value: unknown): DrivetempEnabledParse {
  if (value !== null && typeof value !== 'boolean') {
    return { ok: false, message: 'drivetempEnabled must be a boolean or null' }
  }
  return { ok: true, value }
}

type SimpleUpdateKey =
  'hostingPath' | 'drivetempEnabled' | 'cpuTdpWattsOverride' | 'cpuTjMaxCelsiusOverride'

/** Applies one `undefined`-skippable, independently-parsed field to `update`. */
function applyOptionalField<K extends SimpleUpdateKey>(
  value: unknown,
  key: K,
  parse: (
    value: unknown
  ) => { ok: true; value: ServerHardwareProfileUpdate[K] } | { ok: false; message: string },
  update: ServerHardwareProfileUpdate
): HardwareProfileFieldResult {
  if (value === undefined) return { ok: true }
  const parsed = parse(value)
  if (!parsed.ok) return parsed
  update[key] = parsed.value
  return { ok: true }
}

/**
 * Parse `PUT /servers/:id/metrics/hardware-profile`. Sensor slots accept the
 * `{chip,label}` object shape or `null`; NIC bindings and `hostingPath`
 * accept a string or `null`; `drivetempEnabled` accepts a boolean or `null`.
 * `undefined` (an absent field) leaves that setting untouched. Unknown
 * fields are rejected so a typo cannot silently no-op.
 */
export function parseHardwareProfileBody(body: unknown): HardwareProfileBodyParse {
  if (!isRecord(body)) {
    return {
      ok: false,
      message: 'expected a JSON object of hardware-profile fields',
    }
  }
  const unknownField = findUnknownHardwareProfileField(body)
  if (unknownField) {
    return { ok: false, message: `unknown hardware-profile field: ${unknownField}` }
  }

  const update: ServerHardwareProfileUpdate = {}

  const slotResult = applySensorSlotFields(body, update)
  if (!slotResult.ok) return slotResult

  const nicResult = applyNicFields(body, update)
  if (!nicResult.ok) return nicResult

  const simpleFieldAppliers: Array<() => HardwareProfileFieldResult> = [
    () => applyOptionalField(body.hostingPath, 'hostingPath', parseHostingPathField, update),
    () =>
      applyOptionalField(
        body.drivetempEnabled,
        'drivetempEnabled',
        parseDrivetempEnabledField,
        update
      ),
    () =>
      applyOptionalField(
        body.cpuTdpWattsOverride,
        'cpuTdpWattsOverride',
        parseCpuTdpWattsField,
        update
      ),
    () =>
      applyOptionalField(
        body.cpuTjMaxCelsiusOverride,
        'cpuTjMaxCelsiusOverride',
        parseCpuTjMaxCelsiusField,
        update
      ),
  ]
  for (const applyField of simpleFieldAppliers) {
    const result = applyField()
    if (!result.ok) return result
  }

  return { ok: true, update }
}

/** One sensor identity as reported by `metrics-capabilities-request`. */
export type CapabilitySensorCandidate = { chip: string; label: string }

type CapabilityGpuDevice = {
  chip: string
  temperature: CapabilitySensorCandidate[]
  power: CapabilitySensorCandidate[]
}

/** Narrowed subset of the daemon's `metrics-capabilities-result` payload used for validation. */
export type ParsedMetricsCapabilities = {
  cpuTemperature: CapabilitySensorCandidate[]
  cpuPower: CapabilitySensorCandidate[]
  cpuFan: CapabilitySensorCandidate[]
  gpuFan: CapabilitySensorCandidate[]
  boardTemperature: CapabilitySensorCandidate[]
  ambient1Temperature: CapabilitySensorCandidate[]
  ambient2Temperature: CapabilitySensorCandidate[]
  disk1Temperature: CapabilitySensorCandidate[]
  disk2Temperature: CapabilitySensorCandidate[]
  systemFan1: CapabilitySensorCandidate[]
  systemFan2: CapabilitySensorCandidate[]
  gpuDevices: CapabilityGpuDevice[]
  networkInterfaceNames: Set<string>
}

function parseCandidateList(value: unknown): CapabilitySensorCandidate[] {
  if (!Array.isArray(value)) return []
  const out: CapabilitySensorCandidate[] = []
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.chip === 'string' && typeof entry.label === 'string') {
      out.push({ chip: entry.chip, label: entry.label })
    }
  }
  return out
}

function parseGpuDeviceList(value: unknown): CapabilityGpuDevice[] {
  if (!Array.isArray(value)) return []
  const out: CapabilityGpuDevice[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.chip !== 'string') continue
    out.push({
      chip: entry.chip,
      temperature: parseCandidateList(entry.temperature),
      power: parseCandidateList(entry.power),
    })
  }
  return out
}

function parseNetworkInterfaceNames(value: unknown): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(value)) return names
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.name === 'string') names.add(entry.name)
  }
  return names
}

/** Narrow the daemon's opaque `capabilities` result for identity validation. */
export function parseMetricsCapabilities(value: unknown): ParsedMetricsCapabilities {
  const record = isRecord(value) ? value : {}
  const sensors = isRecord(record.sensors) ? record.sensors : {}
  return {
    cpuTemperature: parseCandidateList(sensors.cpuTemperature),
    cpuPower: parseCandidateList(sensors.cpuPower),
    cpuFan: parseCandidateList(sensors.cpuFan),
    gpuFan: parseCandidateList(sensors.gpuFan),
    boardTemperature: parseCandidateList(sensors.boardTemperature),
    ambient1Temperature: parseCandidateList(sensors.ambient1Temperature),
    ambient2Temperature: parseCandidateList(sensors.ambient2Temperature),
    disk1Temperature: parseCandidateList(sensors.disk1Temperature),
    disk2Temperature: parseCandidateList(sensors.disk2Temperature),
    systemFan1: parseCandidateList(sensors.systemFan1),
    systemFan2: parseCandidateList(sensors.systemFan2),
    gpuDevices: parseGpuDeviceList(sensors.gpuDevices),
    networkInterfaceNames: parseNetworkInterfaceNames(record.networkInterfaces),
  }
}

function slotMatches(
  candidates: CapabilitySensorCandidate[],
  slot: ServerSensorSlotAssignment
): boolean {
  return candidates.some((c) => c.chip === slot.chip && c.label === slot.label)
}

function gpuDeviceMatches(
  devices: CapabilityGpuDevice[],
  slot: ServerSensorSlotAssignment
): boolean {
  return devices.some(
    (device) =>
      device.chip === slot.chip &&
      (device.temperature.some((c) => c.label === slot.label) ||
        device.power.some((c) => c.label === slot.label))
  )
}

/**
 * Find the first assigned slot/NIC in `update` that does not match a
 * daemon-reported candidate. Every sensor-slot key in
 * {@link HARDWARE_PROFILE_SENSOR_SLOT_KEYS} is cross-checked against its
 * matching flat candidate pool on `capabilities`, except `gpuDevice`, which
 * is cross-referenced against `capabilities.gpuDevices` via
 * {@link gpuDeviceMatches} instead. Returns `null` when every assigned
 * identity is valid (or nothing was assigned).
 */
export function findStaleHardwareProfileSlot(
  update: ServerHardwareProfileUpdate,
  capabilities: ParsedMetricsCapabilities
): string | null {
  for (const key of HARDWARE_PROFILE_SENSOR_SLOT_KEYS) {
    const slot = update[key]
    if (!slot) continue
    if (key === 'gpuDevice') {
      if (!gpuDeviceMatches(capabilities.gpuDevices, slot)) return key
      continue
    }
    if (!slotMatches(capabilities[key], slot)) return key
  }
  if (update.nic1 && !capabilities.networkInterfaceNames.has(update.nic1)) {
    return 'nic1'
  }
  if (update.nic2 && !capabilities.networkInterfaceNames.has(update.nic2)) {
    return 'nic2'
  }
  return null
}

/** True when `update` assigns at least one identity that needs capability validation. */
export function hardwareProfileUpdateNeedsValidation(update: ServerHardwareProfileUpdate): boolean {
  return (
    HARDWARE_PROFILE_SENSOR_SLOT_KEYS.some((key) => Boolean(update[key])) ||
    HARDWARE_PROFILE_NIC_KEYS.some((key) => Boolean(update[key]))
  )
}

export function resolveStoreBackendKind(
  store: ServerMetricsStore | undefined,
  runtime: AuthRouteOpts['runtime']
): MetricsBackendKind {
  if (!store) return 'disabled'
  if (store instanceof DisabledServerMetricsStore) return 'disabled'
  if (store instanceof CloudflareAnalyticsEngineServerMetricsStore) {
    return 'analytics-engine'
  }
  // Deno → DuckDB (or unavailable DuckDB). Workers bundles must not import the
  // native DuckDB store — runtime is the only discriminator left here.
  return runtime === 'workers' ? 'analytics-engine' : 'duckdb'
}

export function parseIsoTimestampQuery(
  raw: string | undefined,
  field: string
): IsoTimestampParseResult {
  if (!raw || raw.trim() === '') {
    return { ok: false, message: `${field} is required` }
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    return { ok: false, message: `${field} must be a valid ISO timestamp` }
  }
  return { ok: true, ms, iso: new Date(ms).toISOString() }
}

export function parseOptionalResolution(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

export function metricsBackendUnavailableResponse(backend: MetricsBackendKind): {
  ok: false
  error: 'metrics_backend_unavailable'
  backend: MetricsBackendKind
} {
  return {
    ok: false,
    error: 'metrics_backend_unavailable',
    backend,
  }
}

export type ConnectionHistoryChartResponse = {
  ok: true
  serverId: string
  from: string
  to: string
  backend: MetricsBackendKind
  available: boolean
  initialConnected: boolean | null
  uptimeSeconds: number
  downtimeSeconds: number
  unknownSeconds: number
  uptimePercent: number | null
  truncated: boolean
  events: StatusHistoryResult['events']
}

export function buildConnectionHistoryPayload(
  params: Readonly<{
    serverId: string
    from: string
    to: string
    result: StatusHistoryResult
  }>
): ConnectionHistoryChartResponse {
  const { result } = params
  return {
    ok: true,
    serverId: params.serverId,
    from: params.from,
    to: params.to,
    backend: result.kind,
    available: result.available,
    initialConnected: result.initialConnected,
    uptimeSeconds: result.uptimeSeconds,
    downtimeSeconds: result.downtimeSeconds,
    unknownSeconds: result.unknownSeconds,
    uptimePercent: result.uptimePercent,
    truncated: result.truncated,
    events: result.events,
  }
}

/** True when connection history has something worth caching. */
export function connectionHistoryHasCacheableData(result: StatusHistoryResult): boolean {
  return result.events.length > 0 || result.uptimeSeconds > 0 || result.downtimeSeconds > 0
}

export type CpuLimitsEnvelope = {
  cpuLimits: EffectiveCpuThermalLimits
  temperatureUnit: TemperatureUnit
}

/**
 * Compose the CPU-headroom + display-unit envelope shared by `/series` and
 * `/summary` — a pure function over already-resolved profile/org-options
 * inputs, no Hono `Context`. `/servers/metrics/latest` (fleet snapshot)
 * deliberately does not call this: attaching per-server `cpuLimits` there
 * would require N per-server hardware-profile lookups, breaking the O(1)
 * fleet-read invariant (see `AGENTS.md`).
 */
export function buildCpuLimitsEnvelope(
  hardwareProfile: ServerHardwareProfile | undefined,
  orgOptions: OrganizationOptions | null | undefined
): CpuLimitsEnvelope {
  return {
    cpuLimits: resolveEffectiveCpuThermalLimits(hardwareProfile),
    temperatureUnit: resolveTemperatureUnit(orgOptions ?? {}),
  }
}

export function buildHostSummaryPayload(
  params: Readonly<{
    serverId: string
    from: string
    to: string
    result: {
      kind: MetricsBackendKind
      available: boolean
      sampleCount: number
      latestAt: string | null
    }
    envelope: CpuLimitsEnvelope
  }>
) {
  return {
    ok: true as const,
    serverId: params.serverId,
    from: params.from,
    to: params.to,
    backend: params.result.kind,
    available: params.result.available,
    sampleCount: params.result.sampleCount,
    latestAt: params.result.latestAt,
    cpuLimits: params.envelope.cpuLimits,
    temperatureUnit: params.envelope.temperatureUnit,
  }
}

export function metricsQueryErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
