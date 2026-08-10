/**
 * Pure helpers for server metrics routes — query parsing, backend kind, and
 * response shaping without a Hono Context.
 */

import { AnalyticsEngineServerMetricsStore } from '../../daemon/metrics/analytics-engine/store.ts'
import { ClickHouseServerMetricsStore } from '../../daemon/metrics/clickhouse/store.ts'
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

export function resolveStoreBackendKind(
  store: ServerMetricsStore | undefined,
  runtime: AuthRouteOpts['runtime'],
): MetricsBackendKind {
  if (!store) return 'disabled'
  if (store instanceof DisabledServerMetricsStore) return 'disabled'
  if (store instanceof AnalyticsEngineServerMetricsStore) {
    return 'analytics-engine'
  }
  if (store instanceof ClickHouseServerMetricsStore) return 'clickhouse'
  return runtime === 'workers' ? 'analytics-engine' : 'clickhouse'
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
