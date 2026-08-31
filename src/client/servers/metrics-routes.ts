import type { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
} from '../shared.ts'
import { getDaemonCellRegistry, getDb, getServerMetricsStore } from '../../db.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { cellTrace } from '../../logger.ts'
import { server } from '../../lib/db/schema.ts'
import {
  mergeServerMetricsOverrides,
  parseServerMetricsOverrides,
} from '../../lib/db/server-metadata.ts'
import {
  getServerMetricsLiveMaxMinutes,
} from '../../lib/settings/server-metrics-settings.ts'
import { loadServerStatusRecords } from './update-status.ts'
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
import {
  METRICS_LIVE_INTERVAL_SECONDS,
  type FleetHostSnapshotResult,
  type HostMetricKey,
  type MetricsLiveLeaseStartResponse,
  type StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import {
  resolveStoreBackendKind,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  parseSensorOverridesBody,
  metricsBackendUnavailableResponse,
  buildConnectionHistoryPayload,
  connectionHistoryHasCacheableData,
  buildHostSummaryPayload,
  metricsQueryErrorMessage,
  type ConnectionHistoryChartResponse,
} from './metrics-routes-helpers.ts'

/** Fixed lookback for the org servers overview usage strip/bars (~1 sample/min). */
export const FLEET_USAGE_LOOKBACK_MS = 10 * 60_000

/** Correlated round-trip budget for live lease start/stop (cheap daemon work). */
const METRICS_LIVE_TIMEOUT_MS = 5_000

/** Correlated round-trip budget for capability discovery (probes the host). */
const METRICS_CAPABILITIES_TIMEOUT_MS = 10_000

/**
 * Metrics shown on the org servers overview (CPU stack + load + memory/swap).
 * Raw v2 keys only — CPU busy (`100 − cpuIdlePercent`), memory used and swap
 * used are derived by consumers from these fields, never stored or requested
 * as derived metrics.
 */
export const FLEET_USAGE_METRICS = [
  'cpuIdlePercent',
  'cpuUserPercent',
  'cpuSystemPercent',
  'cpuIowaitPercent',
  'load1',
  'load5',
  'load15',
  'memoryTotalBytes',
  'memoryAvailableBytes',
  'swapTotalBytes',
  'swapFreeBytes',
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
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server metrics routes')
  }
  const secrets = opts.secrets
  const cache = createMetricsChartCache(opts.runtime)

  router.use('/servers/metrics/*', createSessionMiddleware(secrets))
  router.use('/servers/:id/metrics/*', createSessionMiddleware(secrets))

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

  /**
   * Start (or explicitly renew) a live-metrics lease. Lease enforcement lives
   * entirely on the daemon: this route only computes the expiry from the
   * admin cap and relays the correlated `metrics-live-start` round trip.
   * An optional `{ leaseId }` body renews that lease in place — the daemon's
   * LiveLeaseManager treats a known id as a renewal, so a later DELETE of the
   * same id returns cadence to baseline immediately.
   */
  router.post('/servers/:id/metrics/live', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const body = await c.req.json().catch(() => null)
    const requestedLeaseId =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { leaseId?: unknown }).leaseId
        : undefined
    if (
      requestedLeaseId !== undefined &&
      (typeof requestedLeaseId !== 'string' || requestedLeaseId.length === 0)
    ) {
      return c.json({ error: 'expected leaseId to be a non-empty string' }, 400)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const maxMinutes = await getServerMetricsLiveMaxMinutes(db)
    if (maxMinutes === 0) {
      return c.json({ error: 'live_metrics_disabled' }, 409)
    }

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }
    const records = await loadServerStatusRecords(db, registry, [serverId])
    if (!records[0]?.connected) {
      return c.json({ error: 'server_offline' }, 409)
    }

    // Renewals reuse the caller's id; only a first-time start mints a new one.
    const leaseId = requestedLeaseId ?? generateRequestId()
    const expiresAt = new Date(Date.now() + maxMinutes * 60_000).toISOString()
    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-live-start',
      deliveryId: generateDeliveryId(),
      requestId,
      leaseId,
      intervalSeconds: METRICS_LIVE_INTERVAL_SECONDS,
      expiresAt,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId,
      kind: 'metrics-live-start',
    })

    try {
      const record = await registry.getCell(serverId).createRequestAndWait(
        envelope,
        METRICS_LIVE_TIMEOUT_MS,
      )
      if (record.status === 'expired') {
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-start',
          pendingStatus: record.status,
          resultStatus: 'timeout',
        })
        return c.json({ error: 'timeout waiting for live lease start' }, 503)
      }
      if (record.status === 'failed') {
        const error = record.error ?? 'failed to start live lease'
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-start',
          pendingStatus: record.status,
          resultStatus: 'failed',
          error,
        })
        return c.json({ error }, 500)
      }
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-start',
        pendingStatus: record.status,
        resultStatus: 'done',
      })
      const payload: MetricsLiveLeaseStartResponse = {
        ok: true,
        leaseId,
        intervalSeconds: METRICS_LIVE_INTERVAL_SECONDS,
        expiresAt,
      }
      return c.json(payload)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-start',
        resultStatus: 'error',
        error: message,
      })
      return c.json({ error: message }, 503)
    }
  })

  /**
   * Stop a live-metrics lease. A disconnected daemon is a soft success — its
   * local expiry timer returns cadence to baseline regardless.
   */
  router.delete('/servers/:id/metrics/live', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const body = await c.req.json().catch(() => null)
    const leaseId = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as { leaseId?: unknown }).leaseId
      : undefined
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
      return c.json({ error: 'expected { leaseId: string }' }, 400)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ ok: true })
    }
    const records = await loadServerStatusRecords(db, registry, [serverId])
    if (!records[0]?.connected) {
      // Daemon offline: the lease died with its socket session (and would
      // expire locally anyway) — nothing to stop.
      return c.json({ ok: true })
    }

    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-live-stop',
      deliveryId: generateDeliveryId(),
      requestId,
      leaseId,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId,
      kind: 'metrics-live-stop',
    })

    try {
      const record = await registry.getCell(serverId).createRequestAndWait(
        envelope,
        METRICS_LIVE_TIMEOUT_MS,
      )
      if (record.status === 'expired') {
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-stop',
          pendingStatus: record.status,
          resultStatus: 'timeout',
        })
        return c.json({ error: 'timeout waiting for live lease stop' }, 503)
      }
      if (record.status === 'failed') {
        const error = record.error ?? 'failed to stop live lease'
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-stop',
          pendingStatus: record.status,
          resultStatus: 'failed',
          error,
        })
        return c.json({ error }, 500)
      }
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-stop',
        pendingStatus: record.status,
        resultStatus: 'done',
      })
      return c.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-stop',
        resultStatus: 'error',
        error: message,
      })
      return c.json({ error: message }, 503)
    }
  })

  /**
   * Capability discovery proxy — opened deliberately from server settings,
   * never polled, so there is no cache in front of the daemon round trip.
   */
  router.get('/servers/:id/metrics/capabilities', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }
    const records = await loadServerStatusRecords(db, registry, [serverId])
    if (!records[0]?.connected) {
      return c.json({ error: 'server_offline' }, 409)
    }

    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-capabilities-request',
      deliveryId: generateDeliveryId(),
      requestId,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId,
      kind: 'metrics-capabilities-request',
    })

    try {
      const record = await registry.getCell(serverId).createRequestAndWait(
        envelope,
        METRICS_CAPABILITIES_TIMEOUT_MS,
      )
      if (record.status === 'expired') {
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-capabilities-request',
          pendingStatus: record.status,
          resultStatus: 'timeout',
        })
        return c.json(
          { error: 'timeout waiting for metrics capabilities' },
          503,
        )
      }
      if (record.status === 'failed') {
        const error = record.error ?? 'failed to fetch metrics capabilities'
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-capabilities-request',
          pendingStatus: record.status,
          resultStatus: 'failed',
          error,
        })
        return c.json({ error }, 503)
      }
      const capabilities = extractCapabilities(record.result)
      if (capabilities === null) {
        return c.json({ error: 'invalid metrics capabilities result' }, 503)
      }
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-capabilities-request',
        pendingStatus: record.status,
        resultStatus: 'done',
      })
      return c.json({ ok: true, capabilities })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-capabilities-request',
        resultStatus: 'error',
        error: message,
      })
      return c.json({ error: message }, 503)
    }
  })

  /**
   * Persist sensor / hosting-path overrides. `server.metadata` is the source
   * of truth; the daemon-side files are a cache refreshed only by the
   * best-effort push below (and there is no reconnect-time re-push yet — if
   * the daemon was offline the operator re-saves once it reconnects).
   */
  router.put('/servers/:id/metrics/sensor-overrides', async (c) => {
    const serverId = c.req.param('id')
    // Operator setting, not a read — require organization:manage.
    const denied = await assertCanManageOr403(c, 'server', serverId)
    if (denied) return denied
    if (!c.get('session')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const body = await c.req.json().catch(() => null)
    const parsed = parseSensorOverridesBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.message }, 400)
    }

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    if (rows.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rawMetadata = rows[0].metadata
    const metadata: Record<string, unknown> =
      rawMetadata && typeof rawMetadata === 'object' &&
        !Array.isArray(rawMetadata)
        ? (rawMetadata as Record<string, unknown>)
        : {}
    const existing = parseServerMetricsOverrides(metadata.metricsOverrides)
    const merged = mergeServerMetricsOverrides(existing, parsed.updates)
    // Patch only the metricsOverrides subtree in SQL — the daemon projects
    // resources / docker / geo onto the same column concurrently, so a full
    // read-modify-write of `metadata` could write back a stale object and
    // drop keys a heartbeat landed between our SELECT and UPDATE.
    await db
      .update(server)
      .set({
        metadata: merged
          ? sql`jsonb_set(COALESCE(${server.metadata}, '{}'::jsonb), '{metricsOverrides}', ${
            JSON.stringify(merged)
          }::jsonb)`
          : sql`COALESCE(${server.metadata}, '{}'::jsonb) - 'metricsOverrides'`,
      })
      .where(eq(server.id, serverId))

    // Best-effort push: a disconnected daemon must not block the settings
    // save. Fire-and-forget enqueue (not createRequestAndWait) — the daemon
    // replaces its override files when the envelope is delivered.
    let pushed = false
    const registry = getDaemonCellRegistry(c)
    if (registry) {
      const requestId = generateRequestId()
      const envelope: DaemonOutboundEnvelope = {
        kind: 'metrics-sensor-overrides-update',
        deliveryId: generateDeliveryId(),
        requestId,
        overrides: merged ?? {},
        at: new Date().toISOString(),
      }
      cellTrace('request-start', {
        requestId,
        serverId,
        kind: 'metrics-sensor-overrides-update',
      })
      try {
        await registry.getCell(serverId).enqueue(envelope)
        cellTrace('request-enqueued', {
          requestId,
          serverId,
          kind: 'metrics-sensor-overrides-update',
          deliveryId: envelope.deliveryId,
        })
        pushed = true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-sensor-overrides-update',
          resultStatus: 'error',
          error: message,
        })
      }
    }

    return c.json({ ok: true, overrides: merged ?? {}, pushed })
  })
}

function extractCapabilities(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null
  }
  const capabilities = (result as Record<string, unknown>).capabilities
  return capabilities === undefined ? null : capabilities
}
