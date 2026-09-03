/**
 * Host-free coverage for server metrics route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { CloudflareAnalyticsEngineServerMetricsStore } from '../../daemon/metrics/backends/cloudflare/store.ts'
import { DuckDbParquetServerMetricsStore } from '../../daemon/metrics/backends/duckdb/store.ts'
import { DisabledServerMetricsStore } from '../../daemon/metrics/disabled-store.ts'
import type { StatusHistoryResult } from '../../daemon/metrics/types.ts'
import {
  resolveStoreBackendKind,
  buildCpuLimitsEnvelope,
  parseHardwareProfileBody,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  metricsBackendUnavailableResponse,
  buildConnectionHistoryPayload,
  connectionHistoryHasCacheableData,
  buildHostSummaryPayload,
  metricsQueryErrorMessage,
} from './metrics-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-01-01T01:00:00.000Z'

test('resolveStoreBackendKind covers store types and runtime fallbacks', () => {
  assertEquals(resolveStoreBackendKind(undefined, 'deno'), 'disabled')
  assertEquals(
    resolveStoreBackendKind(new DisabledServerMetricsStore(), 'workers'),
    'disabled',
  )
  assertEquals(
    resolveStoreBackendKind(
      Object.create(CloudflareAnalyticsEngineServerMetricsStore.prototype),
      'deno',
    ),
    'analytics-engine',
  )
  assertEquals(
    resolveStoreBackendKind(
      Object.create(DuckDbParquetServerMetricsStore.prototype),
      'deno',
    ),
    'duckdb',
  )
  // Workers bundles cannot import DuckDB — non-AE stores fall back by runtime.
  assertEquals(
    resolveStoreBackendKind(
      Object.create(DuckDbParquetServerMetricsStore.prototype),
      'workers',
    ),
    'analytics-engine',
  )

  const unknownStore = {
    writeHostSample() {},
    writeStatusEvent() {},
    async queryHostSeries() {
      return {
        kind: 'disabled' as const,
        available: false,
        serverId: 'srv-1',
        metrics: [],
        points: [],
        resolutionSeconds: null,
        gapCount: 0,
        sampleCount: 0,
      }
    },
    async queryHostSummary() {
      return {
        kind: 'disabled' as const,
        available: false,
        serverId: 'srv-1',
        sampleCount: 0,
        latestAt: null,
      }
    },
    async queryStatusHistory() {
      return {
        kind: 'disabled' as const,
        available: false,
        serverId: 'srv-1',
        initialConnected: null,
        uptimeSeconds: 0,
        downtimeSeconds: 0,
        unknownSeconds: 0,
        uptimePercent: null,
        truncated: false,
        events: [],
      }
    },
    async queryFleetHostSnapshot() {
      return {
        kind: 'disabled' as const,
        available: false,
        metrics: [],
        servers: [],
      }
    },
  }
  assertEquals(resolveStoreBackendKind(unknownStore, 'workers'), 'analytics-engine')
  assertEquals(resolveStoreBackendKind(unknownStore, 'deno'), 'duckdb')
})

test('parseIsoTimestampQuery requires valid ISO timestamps', () => {
  assertEquals(parseIsoTimestampQuery(undefined, 'from'), {
    ok: false,
    message: 'from is required',
  })
  assertEquals(parseIsoTimestampQuery('   ', 'to'), {
    ok: false,
    message: 'to is required',
  })
  assertEquals(parseIsoTimestampQuery('not-iso', 'from'), {
    ok: false,
    message: 'from must be a valid ISO timestamp',
  })
  const ok = parseIsoTimestampQuery(FROM, 'from')
  if (!ok.ok) throw new TypeError('expected valid from timestamp')
  assertEquals(ok.iso, FROM)
  assertEquals(ok.ms, Date.parse(FROM))
})

test('parseOptionalResolution ignores blanks and non-finite values', () => {
  assertEquals(parseOptionalResolution(undefined), undefined)
  assertEquals(parseOptionalResolution(''), undefined)
  assertEquals(parseOptionalResolution('  '), undefined)
  assertEquals(parseOptionalResolution('nope'), undefined)
  assertEquals(parseOptionalResolution('60'), 60)
})

test('metricsBackendUnavailableResponse is stable', () => {
  assertEquals(metricsBackendUnavailableResponse('duckdb'), {
    ok: false,
    error: 'metrics_backend_unavailable',
    backend: 'duckdb',
  })
})

test('connection history payload and cacheability', () => {
  const empty: StatusHistoryResult = {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    initialConnected: null,
    uptimeSeconds: 0,
    downtimeSeconds: 0,
    unknownSeconds: 0,
    uptimePercent: null,
    truncated: false,
    events: [],
  }
  assertEquals(connectionHistoryHasCacheableData(empty), false)

  const withUptime = { ...empty, uptimeSeconds: 10 }
  assertEquals(connectionHistoryHasCacheableData(withUptime), true)

  const withEvents = {
    ...empty,
    events: [{ at: FROM, connected: true, reason: 'connect' as const }],
  }
  assertEquals(connectionHistoryHasCacheableData(withEvents), true)

  assertEquals(
    buildConnectionHistoryPayload({
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      result: withUptime,
    }),
    {
      ok: true,
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      backend: 'duckdb',
      available: true,
      initialConnected: null,
      uptimeSeconds: 10,
      downtimeSeconds: 0,
      unknownSeconds: 0,
      uptimePercent: null,
      truncated: false,
      events: [],
    },
  )
})

test('buildHostSummaryPayload and metricsQueryErrorMessage', () => {
  assertEquals(
    buildHostSummaryPayload({
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      result: {
        kind: 'disabled',
        available: false,
        sampleCount: 0,
        latestAt: null,
      },
      envelope: {
        cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' },
        temperatureUnit: 'celsius',
      },
    }),
    {
      ok: true,
      serverId: 'srv-1',
      from: FROM,
      to: TO,
      backend: 'disabled',
      available: false,
      sampleCount: 0,
      latestAt: null,
      cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' },
      temperatureUnit: 'celsius',
    },
  )
  assertEquals(metricsQueryErrorMessage(new Error('down')), 'down')
  assertEquals(metricsQueryErrorMessage('oops'), 'oops')
})

test('buildCpuLimitsEnvelope resolves thermal limits and temperature unit from resolved inputs', () => {
  assertEquals(
    buildCpuLimitsEnvelope(
      { cpuModel: 'AMD EPYC 7763' },
      { temperatureUnit: 'fahrenheit' },
    ),
    {
      cpuLimits: { tdpWatts: 280, tjMaxCelsius: 95, source: 'catalog-exact' },
      temperatureUnit: 'fahrenheit',
    },
  )
})

test('buildCpuLimitsEnvelope falls back cleanly when nothing is resolved', () => {
  assertEquals(
    buildCpuLimitsEnvelope(undefined, undefined),
    {
      cpuLimits: { tdpWatts: null, tjMaxCelsius: null, source: 'none' },
      temperatureUnit: 'celsius',
    },
  )
})

test('parseHardwareProfileBody accepts cpu override fields in range, and null clears', () => {
  const accepted = parseHardwareProfileBody({
    cpuTdpWattsOverride: 240,
    cpuTjMaxCelsiusOverride: 95,
  })
  assertEquals(accepted, {
    ok: true,
    update: { cpuTdpWattsOverride: 240, cpuTjMaxCelsiusOverride: 95 },
  })

  const cleared = parseHardwareProfileBody({
    cpuTdpWattsOverride: null,
    cpuTjMaxCelsiusOverride: null,
  })
  assertEquals(cleared, {
    ok: true,
    update: { cpuTdpWattsOverride: null, cpuTjMaxCelsiusOverride: null },
  })
})

test('parseHardwareProfileBody rejects cpuTdpWattsOverride out of range or non-finite', () => {
  assertEquals(parseHardwareProfileBody({ cpuTdpWattsOverride: 0 }).ok, false)
  assertEquals(parseHardwareProfileBody({ cpuTdpWattsOverride: -10 }).ok, false)
  assertEquals(
    parseHardwareProfileBody({ cpuTdpWattsOverride: 1001 }).ok,
    false,
  )
  assertEquals(
    parseHardwareProfileBody({ cpuTdpWattsOverride: Number.NaN }).ok,
    false,
  )
  assertEquals(
    parseHardwareProfileBody({ cpuTdpWattsOverride: '200' }).ok,
    false,
  )
})

test('parseHardwareProfileBody rejects cpuTjMaxCelsiusOverride out of the plausible silicon range', () => {
  assertEquals(
    parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 39 }).ok,
    false,
  )
  assertEquals(
    parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 131 }).ok,
    false,
  )
  assertEquals(
    parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 40 }),
    { ok: true, update: { cpuTjMaxCelsiusOverride: 40 } },
  )
  assertEquals(
    parseHardwareProfileBody({ cpuTjMaxCelsiusOverride: 130 }),
    { ok: true, update: { cpuTjMaxCelsiusOverride: 130 } },
  )
})
