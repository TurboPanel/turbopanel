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

export type IsoTimestampParseResult =
  | { ok: true; ms: number; iso: string }
  | { ok: false; message: string }

/** Max characters accepted for one sensor / hosting-path override value. */
export const MAX_METRICS_OVERRIDE_VALUE_CHARS = 512

const METRICS_OVERRIDE_KEYS = [
  'cpuTemperature',
  'gpuTemperature',
  'cpuPower',
  'gpuPower',
  'hostingPath',
] as const

export type MetricsOverrideKey = (typeof METRICS_OVERRIDE_KEYS)[number]

export type SensorOverridesBodyParse =
  | { ok: true; updates: { [K in MetricsOverrideKey]?: string | null } }
  | { ok: false; message: string }

type OverrideValueParse =
  | { ok: true; value: string | null }
  | { ok: false; message: string }

/** One override field: `null` clears, a string sets (blank after trim clears). */
function parseOverrideValue(
  key: MetricsOverrideKey,
  value: unknown,
): OverrideValueParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return { ok: false, message: `${key} must be a string or null` }
  }
  if (value.length > MAX_METRICS_OVERRIDE_VALUE_CHARS) {
    return { ok: false, message: `${key} exceeds max length` }
  }
  const trimmed = value.trim()
  if (
    key === 'hostingPath' && trimmed.length > 0 &&
    (!trimmed.startsWith('/') || /[\s\p{Cc}]/u.test(trimmed))
  ) {
    return {
      ok: false,
      message: 'hostingPath must be an absolute path without whitespace',
    }
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : null }
}

/**
 * Parse `PUT /servers/:id/metrics/sensor-overrides` — each field is an
 * optional string (set) or `null` (clear); unknown fields are rejected so a
 * typo cannot silently no-op.
 */
export function parseSensorOverridesBody(
  body: unknown,
): SensorOverridesBodyParse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'expected a JSON object of override fields' }
  }
  const record = body as Record<string, unknown>
  const known = new Set<string>(METRICS_OVERRIDE_KEYS)
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      return { ok: false, message: `unknown override field: ${key}` }
    }
  }
  const updates: { [K in MetricsOverrideKey]?: string | null } = {}
  for (const key of METRICS_OVERRIDE_KEYS) {
    const value = record[key]
    if (value === undefined) continue
    const parsed = parseOverrideValue(key, value)
    if (!parsed.ok) return parsed
    updates[key] = parsed.value
  }
  return { ok: true, updates }
}

export function resolveStoreBackendKind(
  store: ServerMetricsStore | undefined,
  runtime: AuthRouteOpts['runtime'],
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
  field: string,
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

export function parseOptionalResolution(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

export function metricsBackendUnavailableResponse(
  backend: MetricsBackendKind,
): {
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

export function buildConnectionHistoryPayload(params: Readonly<{
  serverId: string
  from: string
  to: string
  result: StatusHistoryResult
}>): ConnectionHistoryChartResponse {
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
export function connectionHistoryHasCacheableData(
  result: StatusHistoryResult,
): boolean {
  return result.events.length > 0 ||
    result.uptimeSeconds > 0 ||
    result.downtimeSeconds > 0
}

export function buildHostSummaryPayload(params: Readonly<{
  serverId: string
  from: string
  to: string
  result: {
    kind: MetricsBackendKind
    available: boolean
    sampleCount: number
    latestAt: string | null
  }
}>) {
  return {
    ok: true as const,
    serverId: params.serverId,
    from: params.from,
    to: params.to,
    backend: params.result.kind,
    available: params.result.available,
    sampleCount: params.result.sampleCount,
    latestAt: params.result.latestAt,
  }
}

export function metricsQueryErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
