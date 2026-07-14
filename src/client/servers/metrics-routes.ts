import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanReadOr403 } from '../shared.ts'
import { getServerMetricsStore } from '../../db.ts'
import { AnalyticsEngineServerMetricsStore } from '../../daemon/metrics/analytics-engine/store.ts'
import { ClickHouseServerMetricsStore } from '../../daemon/metrics/clickhouse/store.ts'
import { DisabledServerMetricsStore } from '../../daemon/metrics/disabled-store.ts'
import {
  createMetricsChartCache,
  resolveChartCacheTtlSeconds,
  metricsChartCacheKey,
} from '../../daemon/metrics/query/cache.ts'
import {
  canonicalizeMetricsRange,
  parseMaxPoints,
  selectResolutionSeconds,
  validateMetricsRange,
} from '../../daemon/metrics/query/resolution.ts'
import {
  parseRequestedMetrics,
  toHostSeriesChartResponse,
  type HostSeriesChartResponse,
  type HostSummaryChartResponse,
} from '../../daemon/metrics/query/series-response.ts'
import type {
  ServerMetricsStore,
  MetricsBackendKind,
} from '../../daemon/metrics/types.ts'

function resolveStoreBackendKind(
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

function parseIsoTimestampQuery(
  raw: string | undefined,
  field: string,
): { ok: true; ms: number; iso: string } | { ok: false; message: string } {
  if (!raw || raw.trim() === '') {
    return { ok: false, message: `${field} is required` }
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    return { ok: false, message: `${field} must be a valid ISO timestamp` }
  }
  return { ok: true, ms, iso: new Date(ms).toISOString() }
}

function parseOptionalResolution(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

function metricsBackendUnavailableResponse(
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

async function authorizeServerRead(c: Parameters<
  typeof assertCanReadOr403
>[0], serverId: string): Promise<Response | null> {
  const denied = await assertCanReadOr403(c, 'server', serverId)
  if (denied) return denied
  if (!c.get('session')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

export function registerServerMetricsRoutes(
  router: Hono,
  opts: AuthRouteOpts,
) {
  const cache = createMetricsChartCache(opts.runtime)

  router.use('/servers/:id/metrics/*', createSessionMiddleware(opts.secrets))

  router.get('/servers/:id/metrics/series', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const fromParsed = parseIsoTimestampQuery(c.req.query('from'), 'from')
    if (!fromParsed.ok) {
      return c.json({ ok: false, error: fromParsed.message }, 400)
    }
    const toParsed = parseIsoTimestampQuery(c.req.query('to'), 'to')
    if (!toParsed.ok) {
      return c.json({ ok: false, error: toParsed.message }, 400)
    }

    const rangeCheck = validateMetricsRange(fromParsed.ms, toParsed.ms)
    if (!rangeCheck.ok) {
      return c.json({ ok: false, error: rangeCheck.message }, 400)
    }

    const metricsParsed = parseRequestedMetrics(c.req.query('metrics'))
    if (!metricsParsed.ok) {
      return c.json({ ok: false, error: metricsParsed.error }, 400)
    }

    const maxPointsParsed = parseMaxPoints(c.req.query('maxPoints'))
    if (!maxPointsParsed.ok) {
      return c.json({ ok: false, error: maxPointsParsed.message }, 400)
    }

    const store = getServerMetricsStore(c) ??
      new DisabledServerMetricsStore()
    const backend = resolveStoreBackendKind(store, opts.runtime)

    const resolutionSeconds = selectResolutionSeconds({
      fromMs: fromParsed.ms,
      toMs: toParsed.ms,
      requested: parseOptionalResolution(c.req.query('resolution')),
      maxPoints: maxPointsParsed.value,
    })

    const queryRange = canonicalizeMetricsRange(
      fromParsed.ms,
      toParsed.ms,
      resolutionSeconds,
    )

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: metricsParsed.metrics,
      resolutionSeconds,
      backend,
      kind: 'series',
    })

    const cached = await cache.get<HostSeriesChartResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result
    try {
      result = await store.queryHostSeries({
        serverId,
        metrics: metricsParsed.metrics,
        from: queryRange.fromIso,
        to: queryRange.toIso,
        resolutionSeconds,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `metrics queryHostSeries failed backend=${backend} serverId=${serverId}: ${message}`,
      )
      return c.json(
        metricsBackendUnavailableResponse(backend),
        503,
      )
    }

    const payload = toHostSeriesChartResponse({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
    })

    const ttlSeconds = resolveChartCacheTtlSeconds({
      toMs: queryRange.toMs,
      nowMs: Date.now(),
      resolutionSeconds,
    })
    await cache.set(cacheKey, payload, ttlSeconds)
    return c.json(payload)
  })

  router.get('/servers/:id/metrics/summary', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const fromParsed = parseIsoTimestampQuery(c.req.query('from'), 'from')
    if (!fromParsed.ok) {
      return c.json({ ok: false, error: fromParsed.message }, 400)
    }
    const toParsed = parseIsoTimestampQuery(c.req.query('to'), 'to')
    if (!toParsed.ok) {
      return c.json({ ok: false, error: toParsed.message }, 400)
    }

    const rangeCheck = validateMetricsRange(fromParsed.ms, toParsed.ms)
    if (!rangeCheck.ok) {
      return c.json({ ok: false, error: rangeCheck.message }, 400)
    }

    const store = getServerMetricsStore(c) ??
      new DisabledServerMetricsStore()
    const backend = resolveStoreBackendKind(store, opts.runtime)
    const summaryResolutionSeconds = 300
    const queryRange = canonicalizeMetricsRange(
      fromParsed.ms,
      toParsed.ms,
      summaryResolutionSeconds,
    )
    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds: summaryResolutionSeconds,
      backend,
      kind: 'summary',
    })

    const cached = await cache.get<HostSummaryChartResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result
    try {
      result = await store.queryHostSummary({
        serverId,
        from: queryRange.fromIso,
        to: queryRange.toIso,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `metrics queryHostSummary failed backend=${backend} serverId=${serverId}: ${message}`,
      )
      return c.json(
        metricsBackendUnavailableResponse(backend),
        503,
      )
    }

    const payload: HostSummaryChartResponse = {
      ok: true,
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      backend: result.kind,
      available: result.available,
      sampleCount: result.sampleCount,
      latestAt: result.latestAt,
    }

    const ttlSeconds = resolveChartCacheTtlSeconds({
      toMs: queryRange.toMs,
      nowMs: Date.now(),
      resolutionSeconds: summaryResolutionSeconds,
    })
    await cache.set(cacheKey, payload, ttlSeconds)
    return c.json(payload)
  })
}
