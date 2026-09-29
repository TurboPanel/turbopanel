import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { assertCanManageOr403, assertCanReadOr403, getOrgId } from '../shared.ts'
import { getDaemonCellRegistry, getDb, getServerMetricsStore } from '../../db/connection.ts'
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
} from '../../contracts/cell-protocol.ts'
import type { PendingRequestRecord } from '../../contracts/cell.ts'
import { cellTrace } from '../../lib/logger.ts'
import type {
  parseServerOptions,
  ServerHardwareProfile,
  ServerHardwareProfileUpdate,
} from '../../features/servers/server-metadata.ts'
import {
  loadOrganizationOptions,
  loadServerHardwareProfile,
  loadServerTierEntitlements,
  mergeAndPersistHardwareProfile,
  pushHardwareProfileUpdate,
  resolveNicSlotLimit,
} from '../../features/servers/hardware-profile.ts'
import {
  type MetricsDeploymentKind,
  metricsDeploymentKindForRuntime,
} from '../../contracts/capability-plan.ts'
import { getServerMetricsLiveMaxMinutes } from '../../features/settings/server-metrics-settings.ts'
import { loadServerStatusRecords } from './update-status.ts'
import {
  createMetricsChartCache,
  metricsChartCacheKey,
  resolveChartCacheTtlSeconds,
} from '../../daemon/metrics/query/cache.ts'
import {
  clearServerLiveSession,
  markServerLiveSessionActive,
  mergeLiveSampleIntoEntitySeries,
  mergeLiveSampleIntoHostSeries,
  mergeLiveSampleIntoHostSummary,
  metricsRangeTailIsNow,
  readLiveSample,
} from '../../daemon/metrics/query/live-session.ts'
import {
  canonicalizeMetricsRange,
  parseMaxPoints,
  selectResolutionSeconds,
  validateMetricsRange,
} from '../../daemon/metrics/query/resolution.ts'
import {
  type HostSummaryChartResponse,
  toHostSeriesChartResponse,
} from '../../daemon/metrics/query/series-response.ts'
import {
  type AuthenticatedMetricsSample,
  type EntitySeriesResult,
  type HostSeriesResult,
  METRICS_LIVE_INTERVAL_SECONDS,
  type MetricsLiveLeaseStartResponse,
  type StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import {
  buildCapacitiesByGeneration,
  buildConnectionHistoryPayload,
  buildCpuLimitsEnvelope,
  buildFleetLatestPayload,
  buildHostSummaryPayload,
  buildMetricEventsPayload,
  buildSeriesRouteResponse,
  buildTopologyContext,
  type ConnectionHistoryChartResponse,
  connectionHistoryHasCacheableData,
  type CpuLimitsEnvelope,
  fabricNetworkSelectionError,
  findInvalidTopologyIdField,
  FLEET_HOST_METRICS,
  fleetHostCapacitiesFromSnapshot,
  hardwareProfileUpdateNeedsTopologyValidation,
  metricEventsHasCacheableData,
  type MetricEventsResponse,
  metricsBackendUnavailableResponse,
  metricsQueryErrorMessage,
  nicSlotLimitViolation,
  parseHardwareProfileBody,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  parseSeriesMetricSelectors,
  querySeriesResults,
  resolveStoreBackendKind,
  seriesCacheMetricsList,
  type TopologyIdValidationSnapshot,
} from './metrics-routes-helpers.ts'
import {
  getLatestTopologyGeneration,
  getLatestTopologyGenerations,
  getTopologyGenerations,
} from '../../features/servers/server-topology-records.ts'

/** Fixed lookback for the org servers overview usage strip/bars (~1 sample/min). */
export const FLEET_USAGE_LOOKBACK_MS = 10 * 60_000

/** Correlated round-trip budget for live lease start/stop (cheap daemon work). */
const METRICS_LIVE_TIMEOUT_MS = 5_000
const METRICS_CAPABILITIES_TIMEOUT_MS = 15_000

async function authorizeServerRead(
  c: Parameters<typeof assertCanReadOr403>[0],
  serverId: string
): Promise<Response | null> {
  const denied = await assertCanReadOr403(c, 'server', serverId)
  if (denied) return denied
  if (!c.get('session')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

/**
 * Parse and validate the `from`/`to` ISO-timestamp query pair shared by
 * every history-range route (`/series`, `/summary`, `/connection`,
 * `/events`) — a bad `from`/`to`, or a range `validateMetricsRange` rejects
 * (too wide, inverted, …), answers the same 400 shape everywhere.
 */
function parseMetricsRangeQuery(
  c: Parameters<typeof assertCanReadOr403>[0]
): { fromMs: number; toMs: number; fromIso: string; toIso: string } | Response {
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
  return {
    fromMs: fromParsed.ms,
    toMs: toParsed.ms,
    fromIso: fromParsed.iso,
    toIso: toParsed.iso,
  }
}

/**
 * `db` presence plus the shared range query, folded into one call — the
 * db-then-range pair is otherwise still a same-shaped block repeated across
 * `/series`, `/summary`, and `/connection`.
 */
function resolveDbAndRange(c: Parameters<typeof assertCanReadOr403>[0]) {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const range = parseMetricsRangeQuery(c)
  if (range instanceof Response) return range
  return { db, range }
}

/** Session + org resolution shared by the one fleet-scoped route below. */
async function resolveSessionOrg(c: Parameters<typeof assertCanReadOr403>[0]) {
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult
  return { session, organizationId: orgResult }
}

type MetricsCellRequestOptions = {
  c: Parameters<typeof assertCanReadOr403>[0]
  registry: NonNullable<ReturnType<typeof getDaemonCellRegistry>>
  serverId: string
  envelope: DaemonOutboundEnvelope
  timeoutMs: number
  timeoutMessage: string
  failedFallbackMessage: string
  onDone: (record: PendingRequestRecord) => Response | Promise<Response>
}

/**
 * Correlated daemon cell round trip shared by the live-lease start/stop and
 * capabilities routes: emits the `request-start` trace, awaits the cell,
 * and turns an `expired`/`failed` record or a thrown error into the same
 * timeout/failure/error `Response` shape every one of them already used.
 * `onDone` builds the success `Response` from the resolved record — trace
 * responsibility on that path stays with the caller (the capabilities route
 * traces a validation failure differently than a clean result).
 */
async function awaitMetricsCellRequest(options: MetricsCellRequestOptions): Promise<Response> {
  const {
    c,
    registry,
    serverId,
    envelope,
    timeoutMs,
    timeoutMessage,
    failedFallbackMessage,
    onDone,
  } = options
  const requestId = envelope.requestId
  const kind = envelope.kind
  cellTrace('request-start', { requestId, serverId, kind })
  try {
    const record = await registry.getCell(serverId).createRequestAndWait(envelope, timeoutMs)
    if (record.status === 'expired') {
      cellTrace('request-result', {
        requestId,
        serverId,
        kind,
        pendingStatus: record.status,
        resultStatus: 'timeout',
      })
      return c.json({ error: timeoutMessage }, 503)
    }
    if (record.status === 'failed') {
      const error = record.error ?? failedFallbackMessage
      cellTrace('request-result', {
        requestId,
        serverId,
        kind,
        pendingStatus: record.status,
        resultStatus: 'failed',
        error,
      })
      return c.json({ error }, 500)
    }
    return onDone(record)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind,
      resultStatus: 'error',
      error: message,
    })
    return c.json({ error: message }, 503)
  }
}

/**
 * Resolve the CPU-headroom + temperature-unit + NIC-slot-limit envelope for
 * a single-server route (`/series`, `/summary`) from an already-loaded
 * hardware profile — see {@link loadServerHardwareProfile}.
 */
async function loadCpuLimitsEnvelope(
  db: NonNullable<ReturnType<typeof getDb>>,
  inputs: Readonly<{
    serverId: string
    hardwareProfile: ServerHardwareProfile | undefined
    organizationId: string | null
    serverOptions: ReturnType<typeof parseServerOptions>
    machineClass: string | null
    latestSnapshot: unknown
    deployment: MetricsDeploymentKind
  }>
): Promise<CpuLimitsEnvelope> {
  const [orgOptions, tier] = await Promise.all([
    loadOrganizationOptions(db, inputs.organizationId),
    loadServerTierEntitlements(db, inputs.serverId, inputs.deployment),
  ])
  const nicSlotLimit = resolveNicSlotLimit({
    machineClass: inputs.machineClass,
    latestSnapshot: inputs.latestSnapshot,
    orgOptions,
    serverOptions: inputs.serverOptions,
    deployment: inputs.deployment,
    tier,
  })
  return buildCpuLimitsEnvelope(inputs.hardwareProfile, orgOptions, nicSlotLimit)
}

/**
 * Splices the cached live sample onto the tail of the stored series.
 *
 * The read of the live sample stays at the call site (it is conditional on
 * the range tail and the resolution); this only decides what to do once it is
 * in hand. With no live sample, or with no host result to splice onto, the
 * stored results pass through untouched.
 */
function applyLiveSampleToSeries(input: {
  storedHostResult: HostSeriesResult | null
  storedEntityResults: EntitySeriesResult[]
  liveSample: AuthenticatedMetricsSample | null
  resolutionSeconds: number
}): {
  hostResult: HostSeriesResult | null
  entityResults: EntitySeriesResult[]
} {
  const { storedHostResult, storedEntityResults, liveSample, resolutionSeconds } = input
  if (!liveSample) {
    return { hostResult: storedHostResult, entityResults: storedEntityResults }
  }
  return {
    hostResult: storedHostResult
      ? mergeLiveSampleIntoHostSeries(storedHostResult, liveSample, resolutionSeconds)
      : storedHostResult,
    entityResults: storedEntityResults.map((entityResult) =>
      mergeLiveSampleIntoEntitySeries(entityResult, liveSample, resolutionSeconds)
    ),
  }
}

export function registerServerMetricsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server metrics routes')
  }
  const secrets = opts.secrets
  const cache = createMetricsChartCache(opts.runtime)
  const deployment = metricsDeploymentKindForRuntime(opts.runtime)

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

    const sessionOrg = await resolveSessionOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { session, organizationId } = sessionOrg

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    const store = getServerMetricsStore(c)
    const backend = resolveStoreBackendKind(store, opts.runtime)
    const toMs = Date.now()
    const fromMs = toMs - FLEET_USAGE_LOOKBACK_MS
    const fromIso = new Date(fromMs).toISOString()
    const toIso = new Date(toMs).toISOString()
    const metrics = [...FLEET_HOST_METRICS]

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
      schemaVersion: 6,
      kind: 'fleet-latest',
    })

    const cached = await cache.get<ReturnType<typeof buildFleetLatestPayload>>(cacheKey)
    if (cached) return c.json(cached)

    if (!store?.queryFleetHostSnapshot) {
      const payload = buildFleetLatestPayload({
        from: fromIso,
        to: toIso,
        backend,
        available: false,
        metrics,
        servers: [],
        capacitiesByServer: new Map(),
      })
      return c.json(payload)
    }

    let result
    try {
      result = await store.queryFleetHostSnapshot({
        serverIds: visibleIds,
        metrics,
        from: fromIso,
        to: toIso,
      })
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(`metrics queryFleetHostSnapshot failed backend=${backend}: ${message}`)
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    // Batched — one query for every visible server's latest topology
    // generation, never N — keeps this route O(1) in server count (see
    // AGENTS.md's fleet-read invariant).
    const topologyByServer = await getLatestTopologyGenerations(db, visibleIds)
    const capacitiesByServer = new Map(
      [...topologyByServer].map(([serverId, record]) => [
        serverId,
        fleetHostCapacitiesFromSnapshot(record.snapshot),
      ])
    )

    const payload = buildFleetLatestPayload({
      from: fromIso,
      to: toIso,
      backend: result.kind,
      available: result.available,
      metrics: result.metrics,
      servers: result.servers,
      capacitiesByServer,
    })
    if (result.available && result.servers.some((row) => row.sampleCount > 0)) {
      await cache.set(cacheKey, payload, 45)
    }
    return c.json(payload)
  })

  router.get('/servers/:id/metrics/series', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const resolved = resolveDbAndRange(c)
    if (resolved instanceof Response) return resolved
    const { db, range } = resolved

    const selectorsParsed = parseSeriesMetricSelectors(c.req.query('metrics'))
    if (!selectorsParsed.ok) {
      return c.json({ ok: false, error: selectorsParsed.error }, 400)
    }
    const selectors = selectorsParsed.value

    const maxPointsParsed = parseMaxPoints(c.req.query('maxPoints'))
    if (!maxPointsParsed.ok) {
      return c.json({ ok: false, error: maxPointsParsed.message }, 400)
    }

    const store = getServerMetricsStore(c)
    const backend = resolveStoreBackendKind(store, opts.runtime)

    const resolutionSeconds = selectResolutionSeconds({
      fromMs: range.fromMs,
      toMs: range.toMs,
      requested: parseOptionalResolution(c.req.query('resolution')),
      maxPoints: maxPointsParsed.value,
    })

    const queryRange = canonicalizeMetricsRange(range.fromMs, range.toMs, resolutionSeconds)

    const { hardwareProfile, organizationId, serverOptions, machineClass } =
      await loadServerHardwareProfile(db, serverId)
    const latestGeneration = await getLatestTopologyGeneration(db, serverId)
    const context = buildTopologyContext(latestGeneration, hardwareProfile)

    const fabricError = fabricNetworkSelectionError(selectors, context.inventory)
    if (fabricError) {
      return c.json({ ok: false, error: fabricError }, 400)
    }

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: seriesCacheMetricsList(selectors),
      resolutionSeconds,
      backend,
      schemaVersion: 6,
      kind: 'series',
      topologyGeneration: context.topologyGeneration ?? undefined,
    })

    const cached = await cache.get<ReturnType<typeof buildSeriesRouteResponse>>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    const seriesQuery = await querySeriesResults({
      store: store,
      backend,
      serverId,
      selectors,
      fromIso: queryRange.fromIso,
      toIso: queryRange.toIso,
      resolutionSeconds,
      context,
    })
    if (!seriesQuery.ok) {
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }
    const { hostResult: storedHostResult, entityResults: storedEntityResults } = seriesQuery

    const liveSample =
      metricsRangeTailIsNow(queryRange.toMs) && resolutionSeconds <= METRICS_LIVE_INTERVAL_SECONDS
        ? await readLiveSample(cache, serverId)
        : null
    const { hostResult, entityResults } = applyLiveSampleToSeries({
      storedHostResult,
      storedEntityResults,
      liveSample,
      resolutionSeconds,
    })

    const envelope = await loadCpuLimitsEnvelope(db, {
      serverId,
      hardwareProfile,
      organizationId,
      serverOptions,
      machineClass,
      latestSnapshot: latestGeneration?.snapshot,
      deployment,
    })
    // Capacity totals are the denominator of every derived percentage, so
    // they must come from the generation each bucket was sampled under — not
    // from today's. Only the generations this range actually spans are
    // fetched, and a range that never crosses a topology change costs one
    // extra indexed lookup.
    const capacitiesByGeneration = buildCapacitiesByGeneration(
      await getTopologyGenerations(db, serverId, hostResult?.topologyGenerations ?? []),
      hardwareProfile
    )
    const hostChartResponse = hostResult
      ? toHostSeriesChartResponse({
          serverId,
          from: queryRange.fromIso,
          to: queryRange.toIso,
          result: hostResult,
          capacities: context.capacities,
          capacitiesByGeneration,
        })
      : null

    const payload = buildSeriesRouteResponse({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      backend,
      resolutionSeconds,
      host: hostChartResponse,
      entities: entityResults,
      context,
      envelope,
    })

    // Do not cache empty live series — the first sample often lands seconds
    // after the first chart fetch; a 45s empty cache keeps the UI stuck on
    // "No server metrics yet" despite successful daemon POSTs.
    const totalSampleCount =
      (hostChartResponse?.sampleCount ?? 0) +
      entityResults.reduce(
        (sum, entity) => sum + entity.entities.reduce((s, e) => s + e.sampleCount, 0),
        0
      )
    if (totalSampleCount > 0) {
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

    const resolved = resolveDbAndRange(c)
    if (resolved instanceof Response) return resolved
    const { db, range } = resolved

    const store = getServerMetricsStore(c)
    const backend = resolveStoreBackendKind(store, opts.runtime)
    const summaryResolutionSeconds = 300
    const queryRange = canonicalizeMetricsRange(range.fromMs, range.toMs, summaryResolutionSeconds)

    const { hardwareProfile, organizationId, serverOptions, machineClass } =
      await loadServerHardwareProfile(db, serverId)
    const latestGeneration = await getLatestTopologyGeneration(db, serverId)

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds: summaryResolutionSeconds,
      backend,
      schemaVersion: 6,
      kind: 'summary',
      topologyGeneration: latestGeneration?.generation,
    })

    const cached = await cache.get<HostSummaryChartResponse & CpuLimitsEnvelope>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result
    try {
      result = store?.queryHostSummary
        ? await store.queryHostSummary({
            serverId,
            from: queryRange.fromIso,
            to: queryRange.toIso,
          })
        : {
            kind: backend,
            available: false,
            serverId,
            sampleCount: 0,
            latestAt: null,
          }
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryHostSummary failed backend=${backend} serverId=${serverId}: ${message}`
      )
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    const liveSample = metricsRangeTailIsNow(queryRange.toMs)
      ? await readLiveSample(cache, serverId)
      : null
    const summaryResult =
      liveSample && result.available ? mergeLiveSampleIntoHostSummary(result, liveSample) : result

    const envelope = await loadCpuLimitsEnvelope(db, {
      serverId,
      hardwareProfile,
      organizationId,
      serverOptions,
      machineClass,
      latestSnapshot: latestGeneration?.snapshot,
      deployment,
    })
    const payload = buildHostSummaryPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result: summaryResult,
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

    const resolved = resolveDbAndRange(c)
    if (resolved instanceof Response) return resolved
    const { db, range } = resolved

    // Status transitions are v6-only: `queryStatusHistory` is optional on
    // `ServerMetricsStore` (only `DisabledServerMetricsStore` omits it),
    // so an unconfigured backend falls back to an inline "disabled" result
    // below rather than reading from a v3 store.
    const store = getServerMetricsStore(c)
    const backend = resolveStoreBackendKind(store, opts.runtime)

    // Same resolution ladder as /series so cache keys round identically.
    const resolutionSeconds = selectResolutionSeconds({
      fromMs: range.fromMs,
      toMs: range.toMs,
    })
    const queryRange = canonicalizeMetricsRange(range.fromMs, range.toMs, resolutionSeconds)

    // Only the generation is needed here (no cpuLimits envelope on this
    // route).
    const latestGeneration = await getLatestTopologyGeneration(db, serverId)

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds,
      backend,
      schemaVersion: 6,
      kind: 'connection',
      topologyGeneration: latestGeneration?.generation,
    })

    const cached = await cache.get<ConnectionHistoryChartResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result: StatusHistoryResult
    try {
      result = store?.queryStatusHistory
        ? await store.queryStatusHistory({
            serverId,
            from: queryRange.fromIso,
            to: queryRange.toIso,
          })
        : {
            kind: backend,
            available: false,
            serverId,
            initialConnected: null,
            events: [],
            uptimeSeconds: 0,
            downtimeSeconds: 0,
            unknownSeconds: 0,
            uptimePercent: null,
            truncated: false,
          }
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryStatusHistory failed backend=${backend} serverId=${serverId}: ${message}`
      )
      return c.json(metricsBackendUnavailableResponse(backend), 503)
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
   * v6-only: hardware-health / lifecycle events (`sample.events`) for a
   * server in a time range. No v3 equivalent — v3 has no discrete event
   * stream, only the fixed host-metrics allowlist. `available: false` (never
   * a 503) when the resolved v6 store has no `queryMetricEvents` (e.g.
   * `DisabledServerMetricsStore` — no backend binding configured).
   */
  router.get('/servers/:id/metrics/events', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const range = parseMetricsRangeQuery(c)
    if (range instanceof Response) return range

    const store = getServerMetricsStore(c)
    const backend = resolveStoreBackendKind(store, opts.runtime)

    if (!store?.queryMetricEvents) {
      return c.json(
        buildMetricEventsPayload({
          serverId,
          from: range.fromIso,
          to: range.toIso,
          result: {
            kind: backend,
            available: false,
            serverId,
            events: [],
            truncated: false,
          },
        })
      )
    }

    // Same resolution ladder as /connection, purely for a stable cache key —
    // metric events are point-in-time rows, never bucketed.
    const resolutionSeconds = selectResolutionSeconds({
      fromMs: range.fromMs,
      toMs: range.toMs,
    })
    const queryRange = canonicalizeMetricsRange(range.fromMs, range.toMs, resolutionSeconds)

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds,
      backend,
      schemaVersion: 6,
      kind: 'events',
    })

    const cached = await cache.get<MetricEventsResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result
    try {
      result = await store.queryMetricEvents({
        serverId,
        from: queryRange.fromIso,
        to: queryRange.toIso,
      })
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryMetricEvents failed backend=${backend} serverId=${serverId}: ${message}`
      )
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    const payload = buildMetricEventsPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
    })

    if (metricEventsHasCacheableData(result)) {
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
   * entirely on the daemon: this route computes the expiry from the admin cap,
   * relays the correlated `metrics-live-start` round trip, and records the
   * lease id on the ingest marker so concurrent viewers keep 10 s samples
   * off the durable store until the last one stops.
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
    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-live-start',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      leaseId,
      intervalSeconds: METRICS_LIVE_INTERVAL_SECONDS,
      expiresAt,
      at: new Date().toISOString(),
    }

    return awaitMetricsCellRequest({
      c,
      registry,
      serverId,
      envelope,
      timeoutMs: METRICS_LIVE_TIMEOUT_MS,
      timeoutMessage: 'timeout waiting for live lease start',
      failedFallbackMessage: 'failed to start live lease',
      onDone: async (record) => {
        cellTrace('request-result', {
          requestId: envelope.requestId,
          serverId,
          kind: envelope.kind,
          pendingStatus: record.status,
          resultStatus: 'done',
        })
        const payload: MetricsLiveLeaseStartResponse = {
          ok: true,
          leaseId,
          intervalSeconds: METRICS_LIVE_INTERVAL_SECONDS,
          expiresAt,
        }
        await markServerLiveSessionActive(cache, serverId, leaseId, maxMinutes * 60)
        return c.json(payload)
      },
    })
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
    const leaseId =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { leaseId?: unknown }).leaseId
        : undefined
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
      return c.json({ error: 'expected { leaseId: string }' }, 400)
    }

    // Drop this lease from the ingest marker even when the daemon round
    // trip fails. Concurrent viewers share the marker: only the last
    // remaining lease clears it (and the live-sample buffer) so ingest
    // keeps buffering until every viewer has stopped.
    await clearServerLiveSession(cache, serverId, leaseId)

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

    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-live-stop',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      leaseId,
      at: new Date().toISOString(),
    }

    return awaitMetricsCellRequest({
      c,
      registry,
      serverId,
      envelope,
      timeoutMs: METRICS_LIVE_TIMEOUT_MS,
      timeoutMessage: 'timeout waiting for live lease stop',
      failedFallbackMessage: 'failed to stop live lease',
      onDone: (record) => {
        cellTrace('request-result', {
          requestId: envelope.requestId,
          serverId,
          kind: envelope.kind,
          pendingStatus: record.status,
          resultStatus: 'done',
        })
        return c.json({ ok: true })
      },
    })
  })

  /**
   * Live capability discovery for the hardware-profile picker: sensor
   * candidate pools with current readings, storage probes, NIC
   * classification, and a `/proc` process-count probe. A correlated daemon
   * round trip — never polled, never served from topology/history.
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

    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-capabilities-request',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
    }

    return awaitMetricsCellRequest({
      c,
      registry,
      serverId,
      envelope,
      timeoutMs: METRICS_CAPABILITIES_TIMEOUT_MS,
      timeoutMessage: 'timeout waiting for capabilities',
      failedFallbackMessage: 'failed to collect capabilities',
      onDone: (record) => {
        const result = record.result
        const capabilities =
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as { capabilities?: unknown }).capabilities
            : undefined
        if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
          cellTrace('request-result', {
            requestId: envelope.requestId,
            serverId,
            kind: envelope.kind,
            pendingStatus: record.status,
            resultStatus: 'invalid',
          })
          return c.json({ error: 'invalid capabilities payload' }, 500)
        }
        cellTrace('request-result', {
          requestId: envelope.requestId,
          serverId,
          kind: envelope.kind,
          pendingStatus: record.status,
          resultStatus: 'done',
        })
        return c.json({ ok: true, capabilities })
      },
    })
  })

  /**
   * Persist the operator-assigned hardware profile (sensor/NIC slots,
   * hosting path, drivetemp opt-in). `server.metadata` is the source of
   * truth; the daemon-side state is a cache refreshed by the best-effort
   * push below when the daemon is connected — an offline save converges
   * automatically once the daemon comes back and pushes its own state, or
   * on the operator's next save, without an operator-triggered replay.
   *
   * Any assigned entity identity is validated against the recorded topology
   * (`validateHardwareProfileTopologyIds`) before persisting — a stale id no
   * longer present in the topology is rejected with 400.
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
    if (hardwareProfileUpdateNeedsTopologyValidation(parsed.update)) {
      const topologyError = await validateHardwareProfileTopologyIds(
        db,
        serverId,
        parsed.update,
        deployment
      )
      if (topologyError) {
        return c.json(topologyError.body, topologyError.status)
      }
    }

    const persisted = await mergeAndPersistHardwareProfile(db, serverId, parsed.update)
    if (persisted.notFound) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Best-effort push: a disconnected daemon must not block the settings
    // save. Fire-and-forget enqueue (not createRequestAndWait) — the daemon
    // replaces its cached profile when the envelope is delivered.
    const pushed = await pushHardwareProfileUpdate(registry, serverId, persisted.merged)

    return c.json({ ok: true, profile: persisted.merged ?? {}, pushed })
  })
}

type HardwareProfileValidationError = {
  status: 503 | 409 | 400
  body: { error: string }
}

/**
 * Confirms a stable topology-id override (`hostingFilesystemId`, or every
 * entry of `nicSlotDeviceIds`) in `update` matches a device/filesystem id
 * in the last topology generation this server reported — and, for NIC
 * slots, that each device is an `uplink` and the list fits the server's
 * effective slot limit — never a live daemon round trip, so this works
 * whether or not the daemon is currently connected.
 */
async function validateHardwareProfileTopologyIds(
  db: NonNullable<ReturnType<typeof getDb>>,
  serverId: string,
  update: ServerHardwareProfileUpdate,
  deployment: MetricsDeploymentKind
): Promise<HardwareProfileValidationError | null> {
  const latest = await getLatestTopologyGeneration(db, serverId)
  const snapshot = latest?.snapshot as TopologyIdValidationSnapshot | undefined
  const invalidField = findInvalidTopologyIdField(update, snapshot)
  if (invalidField === 'nicSlotDeviceIds') {
    return {
      status: 400,
      body: {
        error:
          'nicSlotDeviceIds must only name physical uplinks from the recorded topology ' +
          '(bond/bridge members, VLAN children, tunnels, and container bridges cannot be monitored)',
      },
    }
  }
  if (invalidField) {
    return {
      status: 400,
      body: {
        error: `${invalidField} does not match a device/filesystem in the recorded topology`,
      },
    }
  }

  if ((update.nicSlotDeviceIds?.length ?? 0) > 0) {
    const { organizationId, serverOptions, machineClass } = await loadServerHardwareProfile(
      db,
      serverId
    )
    const orgOptions = await loadOrganizationOptions(db, organizationId)
    const tier = await loadServerTierEntitlements(db, serverId, deployment)
    const limitError = nicSlotLimitViolation(
      update,
      resolveNicSlotLimit({
        machineClass,
        latestSnapshot: latest?.snapshot,
        orgOptions,
        serverOptions,
        deployment,
        tier,
      })
    )
    if (limitError) {
      return { status: 400, body: { error: limitError } }
    }
  }
  return null
}
