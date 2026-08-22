/**
 * Host-free coverage for server metrics route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { AnalyticsEngineServerMetricsStore } from '../../daemon/metrics/analytics-engine/store.ts'
import { ClickHouseServerMetricsStore } from '../../daemon/metrics/clickhouse/store.ts'
import { DisabledServerMetricsStore } from '../../daemon/metrics/disabled-store.ts'
import type { StatusHistoryResult } from '../../daemon/metrics/types.ts'
import {
  resolveStoreBackendKind,
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
      Object.create(AnalyticsEngineServerMetricsStore.prototype),
      'deno',
    ),
    'analytics-engine',
  )
  assertEquals(
    resolveStoreBackendKind(
      Object.create(ClickHouseServerMetricsStore.prototype),
      'workers',
    ),
    'clickhouse',
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
  assertEquals(resolveStoreBackendKind(unknownStore, 'deno'), 'clickhouse')
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
  assertEquals(metricsBackendUnavailableResponse('clickhouse'), {
    ok: false,
    error: 'metrics_backend_unavailable',
    backend: 'clickhouse',
  })
})

test('connection history payload and cacheability', () => {
  const empty: StatusHistoryResult = {
    kind: 'clickhouse',
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
      backend: 'clickhouse',
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
    },
  )
  assertEquals(metricsQueryErrorMessage(new Error('down')), 'down')
  assertEquals(metricsQueryErrorMessage('oops'), 'oops')
})
