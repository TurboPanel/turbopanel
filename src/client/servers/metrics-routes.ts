import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { assertCanReadOr403, getOrgId } from '../shared.ts'
import { getDb, getServerMetricsStore } from '../../db.ts'
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
  FleetHostSnapshotResult,
  HostMetricKey,
  StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import {
  resolveStoreBackendKind,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  metricsBackendUnavailableResponse,
  buildConnectionHistoryPayload,
  connectionHistoryHasCacheableData,
  buildHostSummaryPayload,
  metricsQueryErrorMessage,
  type ConnectionHistoryChartResponse,
} from './metrics-routes-helpers.ts'

/** Fixed lookback for the org servers overview usage strip/bars (~1 sample/min). */
export const FLEET_USAGE_LOOKBACK_MS = 10 * 60_000

/** Metrics shown on the org servers overview (CPU stack + load + memory/swap). */
export const FLEET_USAGE_METRICS = [
  'cpuUsagePercent',
  'cpuUserPercent',
  'cpuSystemPercent',
  'cpuIowaitPercent',
  'load1',
  'load5',
  'load15',
  'memoryUsedPercent',
  'memoryUsedBytes',
  'memoryAvailableBytes',
  'swapUsedPercent',
] as const satisfies readonly HostMetricKey[]

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

  router.use('/servers/metrics/*', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/metrics/*', createSessionMiddleware(opts.secrets))

  /**
   * One fleet usage snapshot for the org servers overview.
   * Authz via listVisible — never accept client-supplied serverIds.
   */
  router.get('/servers/metrics/latest', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    const store = getServerMetricsStore(c) ??
      new DisabledServerMetricsStore()
    const backend = resolveStoreBackendKind(store, opts.runtime)
    const toMs = Date.now()
    const fromMs = toMs - FLEET_USAGE_LOOKBACK_MS
    const fromIso = new Date(fromMs).toISOString()
    const toIso = new Date(toMs).toISOString()
    const metrics = [...FLEET_USAGE_METRICS]

    if (visibleIds.length === 0) {
      return c.json({
        ok: true,
        from: fromIso,
        to: toIso,
        backend,
        available: true,
        metrics,
        servers: [],
      })
    }

    const cacheKey = metricsChartCacheKey({
      serverId: `fleet:${organizationId}`,
      fromBucketMs: Math.floor(fromMs / 60_000) * 60_000,
      toBucketMs: Math.floor(toMs / 60_000) * 60_000,
      metrics,
      resolutionSeconds: 60,
      backend,
      kind: 'fleet-latest',
    })
    const cached = await cache.get<{
      ok: true
      from: string
      to: string
      backend: typeof backend
      available: boolean
      metrics: HostMetricKey[]
      servers: FleetHostSnapshotResult['servers']
    }>(cacheKey)
    if (cached) return c.json(cached)

    let result: FleetHostSnapshotResult
    try {
      result = await store.queryFleetHostSnapshot({
        serverIds: visibleIds,
        metrics,
        from: fromIso,
        to: toIso,
      })
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryFleetHostSnapshot failed backend=${backend}: ${message}`,
      )
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    const payload = {
      ok: true as const,
      from: fromIso,
      to: toIso,
      backend: result.kind,
      available: result.available,
      metrics: [...result.metrics],
      servers: result.servers,
    }
    if (result.available && result.servers.some((row) => row.sampleCount > 0)) {
      await cache.set(cacheKey, payload, 45)
    }
    return c.json(payload)
  })

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
      const message = metricsQueryErrorMessage(err)
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

    // Do not cache empty live series — the first sample often lands seconds
    // after the first chart fetch; a 45s empty cache keeps the UI stuck on
    // "No server metrics yet" despite successful daemon POSTs.
    if (payload.sampleCount > 0) {
      const ttlSeconds = resolveChartCacheTtlSeconds({
        toMs: queryRange.toMs,
        nowMs: Date.now(),
        resolutionSeconds,
      })
      await cache.set(cacheKey, payload, ttlSeconds)
    }
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
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryHostSummary failed backend=${backend} serverId=${serverId}: ${message}`,
      )
      return c.json(
        metricsBackendUnavailableResponse(backend),
        503,
      )
    }

    const payload = buildHostSummaryPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
    })

    const ttlSeconds = resolveChartCacheTtlSeconds({
      toMs: queryRange.toMs,
      nowMs: Date.now(),
      resolutionSeconds: summaryResolutionSeconds,
    })
    await cache.set(cacheKey, payload, ttlSeconds)
    return c.json(payload)
  })

  router.get('/servers/:id/metrics/connection', async (c) => {
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

    // Same resolution ladder as /series so cache keys round identically.
    const resolutionSeconds = selectResolutionSeconds({
      fromMs: fromParsed.ms,
      toMs: toParsed.ms,
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
      metrics: [],
      resolutionSeconds,
      backend,
      kind: 'connection',
    })

    const cached = await cache.get<ConnectionHistoryChartResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result: StatusHistoryResult
    try {
      result = await store.queryStatusHistory({
        serverId,
        from: queryRange.fromIso,
        to: queryRange.toIso,
      })
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryStatusHistory failed backend=${backend} serverId=${serverId}: ${message}`,
      )
      return c.json(
        metricsBackendUnavailableResponse(backend),
        503,
      )
    }

    const payload = buildConnectionHistoryPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
    })

    // Skip caching empty live ranges — same guard as series (no sampleCount;
    // treat zero known up/down + empty events as empty).
    if (connectionHistoryHasCacheableData(result)) {
      const ttlSeconds = resolveChartCacheTtlSeconds({
        toMs: queryRange.toMs,
        nowMs: Date.now(),
        resolutionSeconds,
      })
      await cache.set(cacheKey, payload, ttlSeconds)
    }
    return c.json(payload)
  })
}
