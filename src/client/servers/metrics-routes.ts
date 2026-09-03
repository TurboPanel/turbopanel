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
import { organization, server } from '../../lib/db/schema.ts'
import {
  mergeServerHardwareProfile,
  parseServerHardwareProfile,
  parseServerHostResources,
  type ServerHardwareProfile,
  type ServerHardwareProfileUpdate,
} from '../../lib/db/server-metadata.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
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
  computeSensorsAvailable,
  parseRequestedMetrics,
  toHostSeriesChartResponse,
  type HostSeriesChartResponse,
  type HostSummaryChartResponse,
} from '../../daemon/metrics/query/series-response.ts'
import {
  computeDerivedHostValues,
  type DerivedHostValues,
} from '../../daemon/metrics/query/derived-metrics.ts'
import {
  METRICS_LIVE_INTERVAL_SECONDS,
  type FleetHostSnapshotResult,
  type HostMetricKey,
  type MetricsLiveLeaseStartResponse,
  type StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import {
  resolveStoreBackendKind,
  buildCpuLimitsEnvelope,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  parseHardwareProfileBody,
  parseMetricsCapabilities,
  findStaleHardwareProfileSlot,
  hardwareProfileUpdateNeedsValidation,
  metricsBackendUnavailableResponse,
  buildConnectionHistoryPayload,
  connectionHistoryHasCacheableData,
  buildHostSummaryPayload,
  metricsQueryErrorMessage,
  type ConnectionHistoryChartResponse,
  type CpuLimitsEnvelope,
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

/**
 * Server-metadata facts a single-server metrics route needs before it can
 * even build its cache key: the operator-assigned hardware profile (whose
 * `generation` scopes the cache key — see `metricsChartCacheKey`) and the
 * organization id (for the temperature-unit lookup on a cache miss). One
 * lightweight query — never called from `/servers/metrics/latest`, where
 * doing this per fleet server would break the O(1) fleet-read invariant.
 */
async function loadServerHardwareProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  serverId: string,
): Promise<{
  hardwareProfile: ServerHardwareProfile | undefined
  organizationId: string | null
}> {
  const [serverRow] = await db
    .select({ metadata: server.metadata, organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const rawMetadata = serverRow?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {}
  const hardwareProfile = parseServerHardwareProfile(metadata.hardwareProfile)
  const resources = parseServerHostResources(metadata.resources)

  // `hardwareProfile.cpuModel` is only ever written by a host-facts
  // projection this codebase does not have yet — fall back to the raw
  // `/proc/cpuinfo` model name the daemon already reports on every
  // hello/heartbeat (`resources.cpus[0].name`) so CPU-catalog lookups
  // resolve on real hosts instead of only in tests that set cpuModel by
  // hand. Never persisted — a per-request derivation only.
  const detectedCpuModel = resources?.cpus?.[0]?.name
  const effectiveHardwareProfile = hardwareProfile?.cpuModel || !detectedCpuModel
    ? hardwareProfile
    : { ...hardwareProfile, cpuModel: detectedCpuModel }

  return {
    hardwareProfile: effectiveHardwareProfile,
    organizationId: serverRow?.organizationId ?? null,
  }
}

/**
 * Resolve the CPU-headroom + temperature-unit envelope for a single-server
 * route (`/series`, `/summary`) from an already-loaded hardware profile —
 * see {@link loadServerHardwareProfile}.
 */
async function loadCpuLimitsEnvelope(
  db: NonNullable<ReturnType<typeof getDb>>,
  hardwareProfile: ServerHardwareProfile | undefined,
  organizationId: string | null,
): Promise<CpuLimitsEnvelope> {
  let orgOptions = null
  if (organizationId) {
    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    orgOptions = parseOrganizationOptions(orgRow?.options)
  }

  return buildCpuLimitsEnvelope(hardwareProfile, orgOptions)
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
   *
   * Deliberately carries no per-server `cpuLimits` (unlike `/series` and
   * `/summary`) — resolving one would mean a hardware-profile lookup per
   * visible server, breaking the one-query-per-fleet-snapshot invariant
   * this route exists to preserve. A per-server headroom readout belongs on
   * the single-server routes instead.
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
    type FleetHostSnapshotServerWithDerived =
      FleetHostSnapshotResult['servers'][number] & { derived: DerivedHostValues }

    const cached = await cache.get<{
      ok: true
      from: string
      to: string
      backend: typeof backend
      available: boolean
      metrics: HostMetricKey[]
      servers: FleetHostSnapshotServerWithDerived[]
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
      servers: result.servers.map((row): FleetHostSnapshotServerWithDerived => ({
        ...row,
        derived: computeDerivedHostValues(row.values),
      })),
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

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

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

    const { hardwareProfile, organizationId } = await loadServerHardwareProfile(
      db,
      serverId,
    )

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: metricsParsed.metrics,
      resolutionSeconds,
      backend,
      kind: 'series',
      hardwareProfileGeneration: hardwareProfile?.generation,
    })

    const cached = await cache.get<
      HostSeriesChartResponse & CpuLimitsEnvelope & { sensorsAvailable: boolean }
    >(cacheKey)
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

    const envelope = await loadCpuLimitsEnvelope(db, hardwareProfile, organizationId)
    const chartResponse = toHostSeriesChartResponse({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
      cpuLimits: envelope.cpuLimits,
    })
    const payload = {
      ...chartResponse,
      ...envelope,
      sensorsAvailable: computeSensorsAvailable(result.points),
    }

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

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

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

    const { hardwareProfile, organizationId } = await loadServerHardwareProfile(
      db,
      serverId,
    )

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds: summaryResolutionSeconds,
      backend,
      kind: 'summary',
      hardwareProfileGeneration: hardwareProfile?.generation,
    })

    const cached = await cache.get<HostSummaryChartResponse & CpuLimitsEnvelope>(
      cacheKey,
    )
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

    const envelope = await loadCpuLimitsEnvelope(db, hardwareProfile, organizationId)
    const payload = buildHostSummaryPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
      envelope,
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

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

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

    // Only the generation is needed here (no cpuLimits envelope on this
    // route) — the organizationId half of the lookup goes unused.
    const { hardwareProfile } = await loadServerHardwareProfile(db, serverId)

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds,
      backend,
      kind: 'connection',
      hardwareProfileGeneration: hardwareProfile?.generation,
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

    const result = await fetchMetricsCapabilities(registry, serverId)
    if (!result.ok) return c.json(result.body, result.status)
    return c.json({ ok: true, capabilities: result.capabilities })
  })

  /**
   * Persist the operator-assigned hardware profile (sensor/NIC slots,
   * hosting path, drivetemp opt-in). `server.metadata` is the source of
   * truth; the daemon-side state is a cache refreshed by the best-effort
   * push below when the daemon is connected, and by
   * `runHardwareProfileReplaySweep`
   * (`hardware-profile-replay-sweep.ts`) on reconnect when it isn't — an
   * offline save converges automatically once the daemon comes back,
   * without an operator re-save.
   *
   * Any assigned sensor/NIC identity is validated against a fresh
   * capability round trip before persisting — a stale `chip:label` (or NIC
   * name) the daemon no longer reports is rejected with 400 rather than
   * silently accepted. That round trip requires a connected daemon, so a
   * save that assigns an identity while the daemon is offline is rejected
   * with 409; a save that only clears slots or touches hostingPath /
   * drivetempEnabled needs no round trip and proceeds regardless.
   */
  router.put('/servers/:id/metrics/hardware-profile', async (c) => {
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
    const parsed = parseHardwareProfileBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.message }, 400)
    }

    const registry = getDaemonCellRegistry(c)
    if (hardwareProfileUpdateNeedsValidation(parsed.update)) {
      const validationError = await validateHardwareProfileAssignment(
        db,
        registry,
        serverId,
        parsed.update,
      )
      if (validationError) {
        return c.json(validationError.body, validationError.status)
      }
    }

    const persisted = await mergeAndPersistHardwareProfile(
      db,
      serverId,
      parsed.update,
    )
    if (persisted.notFound) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Best-effort push: a disconnected daemon must not block the settings
    // save. Fire-and-forget enqueue (not createRequestAndWait) — the daemon
    // replaces its cached profile when the envelope is delivered.
    const pushed = await pushHardwareProfileUpdate(
      registry,
      serverId,
      persisted.merged,
    )

    return c.json({ ok: true, profile: persisted.merged ?? {}, pushed })
  })
}

type HardwareProfileValidationError = {
  status: 503 | 409 | 400
  body: { error: string }
}

/**
 * Confirms a sensor/NIC identity in `update` still matches a fresh
 * capability round trip before it's allowed to persist. Requires a
 * connected daemon — callers should skip this when the update only clears
 * slots or touches hostingPath / drivetempEnabled.
 */
async function validateHardwareProfileAssignment(
  db: NonNullable<ReturnType<typeof getDb>>,
  registry: ReturnType<typeof getDaemonCellRegistry>,
  serverId: string,
  update: ServerHardwareProfileUpdate,
): Promise<HardwareProfileValidationError | null> {
  if (!registry) {
    return { status: 503, body: { error: 'Daemon cell registry unavailable' } }
  }
  const records = await loadServerStatusRecords(db, registry, [serverId])
  if (!records[0]?.connected) {
    return { status: 409, body: { error: 'server_offline' } }
  }
  const capabilitiesResult = await fetchMetricsCapabilities(registry, serverId)
  if (!capabilitiesResult.ok) {
    return { status: capabilitiesResult.status, body: capabilitiesResult.body }
  }
  const staleSlot = findStaleHardwareProfileSlot(
    update,
    parseMetricsCapabilities(capabilitiesResult.capabilities),
  )
  if (staleSlot) {
    return {
      status: 400,
      body: {
        error:
          `${staleSlot} no longer matches a sensor/interface the daemon reports`,
      },
    }
  }
  return null
}

type HardwareProfilePersistResult =
  | { notFound: true }
  | { notFound: false; merged: ServerHardwareProfile | undefined }

async function mergeAndPersistHardwareProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  serverId: string,
  update: ServerHardwareProfileUpdate,
): Promise<HardwareProfilePersistResult> {
  const rows = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (rows.length === 0) {
    return { notFound: true }
  }

  const rawMetadata = rows[0].metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' &&
      !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {}
  const existing = parseServerHardwareProfile(metadata.hardwareProfile)
  const { profile: merged } = mergeServerHardwareProfile(
    existing,
    update,
    new Date().toISOString(),
  )
  // Patch only the hardwareProfile subtree in SQL — the daemon projects
  // resources / docker / geo onto the same column concurrently, so a full
  // read-modify-write of `metadata` could write back a stale object and
  // drop keys a heartbeat landed between our SELECT and UPDATE.
  await db
    .update(server)
    .set({
      metadata: merged
        ? sql`jsonb_set(COALESCE(${server.metadata}, '{}'::jsonb), '{hardwareProfile}', ${
          JSON.stringify(merged)
        }::jsonb)`
        : sql`COALESCE(${server.metadata}, '{}'::jsonb) - 'hardwareProfile'`,
    })
    .where(eq(server.id, serverId))

  return { notFound: false, merged }
}

async function pushHardwareProfileUpdate(
  registry: ReturnType<typeof getDaemonCellRegistry>,
  serverId: string,
  merged: ServerHardwareProfile | undefined,
): Promise<boolean> {
  if (!registry) return false

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
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'metrics-sensor-overrides-update',
      resultStatus: 'error',
      error: message,
    })
    return false
  }
}

function extractCapabilities(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null
  }
  const capabilities = (result as Record<string, unknown>).capabilities
  return capabilities === undefined ? null : capabilities
}

type MetricsCapabilitiesFetchResult =
  | { ok: true; capabilities: unknown }
  | { ok: false; status: 503; body: { error: string } }

/** Shared `metrics-capabilities-request` round trip for the GET and PUT routes. */
async function fetchMetricsCapabilities(
  registry: NonNullable<ReturnType<typeof getDaemonCellRegistry>>,
  serverId: string,
): Promise<MetricsCapabilitiesFetchResult> {
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
      return {
        ok: false,
        status: 503,
        body: { error: 'timeout waiting for metrics capabilities' },
      }
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
      return { ok: false, status: 503, body: { error } }
    }
    const capabilities = extractCapabilities(record.result)
    if (capabilities === null) {
      return {
        ok: false,
        status: 503,
        body: { error: 'invalid metrics capabilities result' },
      }
    }
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'metrics-capabilities-request',
      pendingStatus: record.status,
      resultStatus: 'done',
    })
    return { ok: true, capabilities }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'metrics-capabilities-request',
      resultStatus: 'error',
      error: message,
    })
    return { ok: false, status: 503, body: { error: message } }
  }
}
