import { assertEquals, assertExists } from '@std/assert'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { it } from "@std/testing/bdd";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import {
  grant,
  organization,
  server,
  setting,
  user,
} from '../../lib/db/schema.ts'
import type {
  DaemonCell,
  DaemonCellRegistry,
  PendingRequestRecord,
} from '../../daemon/cell/contracts.ts'
import type { DaemonOutboundEnvelope } from '../../daemon/cell/protocol.ts'
import {
  SERVER_METRICS_LIVE_MAX_MINUTES_KEY,
  setServerMetricsLiveMaxMinutes,
} from '../../lib/settings/server-metrics-settings.ts'
import { DisabledServerMetricsStore } from '../../daemon/metrics/disabled-store.ts'
import type {
  FleetHostSnapshotQuery,
  FleetHostSnapshotResult,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
  StatusHistoryQuery,
  StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import {
  FLEET_USAGE_METRICS,
  registerServerMetricsRoutes,
} from './metrics-routes.ts'
import { resetDenoMetricsChartCacheForTests } from '../../daemon/metrics/query/cache.ts'
import { MAX_METRICS_POINTS } from '../../daemon/metrics/query/resolution.ts'

import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

type MetricsRouteJsonBody = {
  ok?: boolean
  error?: string
  backend?: string
  metrics?: string[]
  points?: Array<{
    values: Record<string, number | null>
    derived?: Record<string, number | null>
    sampleCount?: number
  }>
  from?: string
  available?: boolean
  resolutionSeconds?: number
  sampleCount?: number
  latestAt?: string
  serverId?: string
  initialConnected?: boolean
  uptimeSeconds?: number
  downtimeSeconds?: number
  unknownSeconds?: number
  uptimePercent?: number
  truncated?: boolean
  events?: Array<{ reason?: string }>
  cpuLimits?: {
    tdpWatts: number | null
    tjMaxCelsius: number | null
    source: string
  }
  temperatureUnit?: string
  sensorsAvailable?: boolean
  generationBreaks?: number[]
  hardwareProfileGenerations?: number[]
}

async function readMetricsJson(res: Response): Promise<MetricsRouteJsonBody> {
  return await res.json() as MetricsRouteJsonBody
}

const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-01-01T01:00:00.000Z'

function createFakeMetricsStore(
  handlers?: {
    queryHostSeries?: (input: HostSeriesQuery) => Promise<HostSeriesResult>
    queryHostSummary?: (input: HostSummaryQuery) => Promise<HostSummaryResult>
    queryStatusHistory?: (
      input: StatusHistoryQuery,
    ) => Promise<StatusHistoryResult>
    queryFleetHostSnapshot?: (
      input: FleetHostSnapshotQuery,
    ) => Promise<FleetHostSnapshotResult>
  },
): ServerMetricsStore & {
  seriesCalls: HostSeriesQuery[]
  summaryCalls: HostSummaryQuery[]
  connectionCalls: StatusHistoryQuery[]
  fleetCalls: FleetHostSnapshotQuery[]
} {
  const seriesCalls: HostSeriesQuery[] = []
  const summaryCalls: HostSummaryQuery[] = []
  const connectionCalls: StatusHistoryQuery[] = []
  const fleetCalls: FleetHostSnapshotQuery[] = []
  const disabled = new DisabledServerMetricsStore()

  return {
    seriesCalls,
    summaryCalls,
    connectionCalls,
    fleetCalls,
    writeHostSample: () => {},
    writeStatusEvent: () => {},
    queryHostSeries: (input) => {
      seriesCalls.push(input)
      if (handlers?.queryHostSeries) {
        return handlers.queryHostSeries(input)
      }
      return disabled.queryHostSeries(input)
    },
    queryHostSummary: (input) => {
      summaryCalls.push(input)
      if (handlers?.queryHostSummary) {
        return handlers.queryHostSummary(input)
      }
      return disabled.queryHostSummary(input)
    },
    queryStatusHistory: (input) => {
      connectionCalls.push(input)
      if (handlers?.queryStatusHistory) {
        return handlers.queryStatusHistory(input)
      }
      return disabled.queryStatusHistory(input)
    },
    queryFleetHostSnapshot: (input) => {
      fleetCalls.push(input)
      if (handlers?.queryFleetHostSnapshot) {
        return handlers.queryFleetHostSnapshot(input)
      }
      return disabled.queryFleetHostSnapshot(input)
    },
  }
}

async function createMetricsRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  metricsStore?: ServerMetricsStore,
  runtime: 'workers' | 'deno' = 'deno',
  registry?: DaemonCellRegistry,
) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (metricsStore) {
      c.set('serverMetricsStore', metricsStore)
    }
    if (registry) {
      c.set('daemonCellRegistry', registry)
    }
    return next()
  })
  registerServerMetricsRoutes(app, {
    secrets,
    runtime,
    signupEnvOverride: undefined,
  })
  return { app, secrets }
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function withMetricsFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serverId: string
    cookie: string
  }) => Promise<void>,
  metricsStore?: ServerMetricsStore,
  registry?: DaemonCellRegistry,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping metrics route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()
  const { app, secrets } = await createMetricsRoutesTestApp(
    db,
    metricsStore,
    'deno',
    registry,
  )

  const email = `metrics-route-test-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Metrics Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Metrics Test Server',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const cookie = await sessionCookie(db, secrets, userId)

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serverId,
      cookie,
    })
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

it('GET /servers/:id/metrics/series returns 401 without session', async () => {
  await withMetricsFixtures(async ({ app, serverId }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
    )
    assertEquals(res.status, 401)
  })
})

it('GET /servers/:id/metrics/series returns 403 without read access', async () => {
  if (!dbUrl) return

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()
  const { app, secrets } = await createMetricsRoutesTestApp(db)

  const email = `metrics-deny-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Metrics Deny Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id


  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: 'Denied Server' })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const cookie = await sessionCookie(db, secrets, userId)

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 403)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

it('GET /servers/:id/metrics/series rejects unknown metrics', async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=notReal`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 400)
    const body = await readMetricsJson(res)
    assertEquals(body.ok, false)
  })
})

it('GET /servers/:id/metrics/series rejects invalid range', async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${TO}&to=${FROM}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 400)
  })
})

it('GET /servers/:id/metrics/series issues one fan-in queryHostSeries call', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [{
        at: FROM,
        values: {
          cpuIdlePercent: 75,
          memoryTotalBytes: 8_000,
          memoryAvailableBytes: 2_000,
          swapTotalBytes: null,
        },
        sampleCount: 1,
        expectedSampleCount: 5,
      }],
      resolutionSeconds: input.resolutionSeconds ?? 60,
      gapCount: 0,
      sampleCount: 1,
    }),
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const url =
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=cpuIdlePercent,memoryTotalBytes,memoryAvailableBytes,swapTotalBytes`
    const res = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    assertEquals(body.ok, true)
    assertEquals(body.metrics, [
      'cpuIdlePercent',
      'memoryTotalBytes',
      'memoryAvailableBytes',
      'swapTotalBytes',
    ])
    assertEquals(body.points!.length, 1)
    const values = body.points![0]!.values
    assertEquals(values.cpuIdlePercent, 75)
    assertEquals(values.memoryTotalBytes, 8_000)
    assertEquals(values.memoryAvailableBytes, 2_000)
    assertEquals(values.swapTotalBytes, null)
    // Derived presentation values are server-computed — the UI never
    // reimplements CPU busy = 100 − idle, memory used % = (total −
    // available) / total.
    const derived = body.points![0]!.derived!
    assertEquals(derived.cpuUsagePercent, 25)
    assertEquals(derived.memoryUsedBytes, 6_000)
    assertEquals(derived.memoryUsedPercent, 75)
    assertEquals(body.points![0]!.sampleCount, 1)
    assertEquals(fakeStore.seriesCalls.length, 1)
    assertEquals(fakeStore.seriesCalls[0]!.metrics, [
      'cpuIdlePercent',
      'memoryTotalBytes',
      'memoryAvailableBytes',
      'swapTotalBytes',
    ])
    assertEquals(fakeStore.seriesCalls[0]!.resolutionSeconds, 60)

    const cached = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(cached.status, 200)
    assertEquals(fakeStore.seriesCalls.length, 1)
  }, fakeStore)
})

it('GET /servers/:id/metrics/series attaches cpuLimits, temperatureUnit, sensorsAvailable, and generation breaks', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [
        {
          at: FROM,
          values: { cpuIdlePercent: 90 },
          sampleCount: 1,
          partsPresent: ['core', 'sensors'],
          hardwareProfileGeneration: 1,
        },
        {
          at: TO,
          values: { cpuIdlePercent: 80 },
          sampleCount: 1,
          partsPresent: ['core'],
          hardwareProfileGeneration: 2,
        },
      ],
      resolutionSeconds: input.resolutionSeconds ?? 60,
      gapCount: 0,
      sampleCount: 2,
      hardwareProfileGenerations: [1, 2],
    }),
  })

  await withMetricsFixtures(async ({ db, app, serverId, organizationId, cookie }) => {
    await db
      .update(server)
      .set({
        metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
          JSON.stringify({ hardwareProfile: { cpuModel: 'AMD EPYC 7763' } })
        }::jsonb`,
      })
      .where(eq(server.id, serverId))
    await db
      .update(organization)
      .set({
        options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
          JSON.stringify({ temperatureUnit: 'fahrenheit' })
        }::jsonb`,
      })
      .where(eq(organization.id, organizationId))

    const url = `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=cpuIdlePercent`
    const res = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    assertEquals(body.cpuLimits, {
      tdpWatts: 280,
      tjMaxCelsius: 95,
      source: 'catalog-exact',
    })
    assertEquals(body.temperatureUnit, 'fahrenheit')
    assertEquals(body.sensorsAvailable, true)
    assertEquals(body.generationBreaks, [1])
    assertEquals(body.hardwareProfileGenerations, [1, 2])
  }, fakeStore)
})

it('GET /servers/:id/metrics/series does not serve a stale cache entry across a hardware-profile generation bump', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [{ at: FROM, values: { cpuIdlePercent: 90 }, sampleCount: 1 }],
      resolutionSeconds: input.resolutionSeconds ?? 60,
      gapCount: 0,
      sampleCount: 1,
    }),
  })

  await withMetricsFixtures(async ({ db, app, serverId, cookie }) => {
    const url =
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=cpuIdlePercent`

    const first = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(first.status, 200)
    assertEquals(fakeStore.seriesCalls.length, 1)

    // Same request again — served from cache, no new store call.
    const cached = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(cached.status, 200)
    assertEquals(fakeStore.seriesCalls.length, 1)

    // Bump the hardware-profile generation directly (a sensor/NIC
    // reassignment) — via a raw jsonb update, not the PUT route, which
    // needs a connected daemon for identity validation.
    await db
      .update(server)
      .set({
        metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
          JSON.stringify({ hardwareProfile: { generation: 1 } })
        }::jsonb`,
      })
      .where(eq(server.id, serverId))

    // Identical (server, range, metrics) request — must not hit the
    // pre-bump cache entry.
    const afterBump = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(afterBump.status, 200)
    assertEquals(fakeStore.seriesCalls.length, 2)
  }, fakeStore)
})

it('GET /servers/:id/metrics/series resolves cpuLimits from the daemon-reported CPU model when hardwareProfile.cpuModel is unset', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [{ at: FROM, values: { cpuIdlePercent: 90 }, sampleCount: 1 }],
      resolutionSeconds: input.resolutionSeconds ?? 60,
      gapCount: 0,
      sampleCount: 1,
    }),
  })

  await withMetricsFixtures(async ({ db, app, serverId, cookie }) => {
    // No hardwareProfile.cpuModel set — only the raw daemon-reported
    // resources.cpus[0].name (real cpuinfo string, trademark markers and
    // trailing clock text included).
    await db
      .update(server)
      .set({
        metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
          JSON.stringify({
            resources: {
              cpus: [{ name: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz' }],
            },
          })
        }::jsonb`,
      })
      .where(eq(server.id, serverId))

    const url =
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=cpuIdlePercent`
    const res = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    assertEquals(body.cpuLimits, {
      tdpWatts: 205,
      tjMaxCelsius: 105,
      source: 'catalog-exact',
    })
  }, fakeStore)
})

it('GET /servers/metrics/latest requests only v2 fleet usage metrics', async () => {
  const fakeStore = createFakeMetricsStore({
    queryFleetHostSnapshot: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      metrics: [...input.metrics],
      servers: input.serverIds.map((serverId) => ({
        serverId,
        latestAt: TO,
        values: {
          cpuIdlePercent: 60,
          cpuUserPercent: 25,
          cpuSystemPercent: 10,
          cpuIowaitPercent: 5,
          load1: 1.5,
          load5: 1.2,
          load15: 1.0,
          memoryTotalBytes: 16_000,
          memoryAvailableBytes: 4_000,
          swapTotalBytes: 1_000,
          swapFreeBytes: 750,
        },
        sampleCount: 3,
      })),
    }),
  })

  await withMetricsFixtures(async ({ app, organizationId, serverId, cookie }) => {
    const res = await app.request(
      `/servers/metrics/latest?organizationId=${organizationId}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok?: boolean
      available?: boolean
      backend?: string
      metrics?: string[]
      servers?: Array<{
        serverId: string
        values: Record<string, number | null>
        derived: Record<string, number | null>
      }>
    }
    assertEquals(body.ok, true)
    assertEquals(body.available, true)
    assertEquals(body.backend, 'duckdb')
    // The fleet path requests raw v2 keys only — no stored derived metrics.
    assertEquals(body.metrics, [...FLEET_USAGE_METRICS])
    assertEquals(fakeStore.fleetCalls.length, 1)
    assertEquals(fakeStore.fleetCalls[0]!.metrics, [...FLEET_USAGE_METRICS])
    assertEquals(fakeStore.fleetCalls[0]!.serverIds, [serverId])

    const row = body.servers!.find((entry) => entry.serverId === serverId)
    assertExists(row)
    // Derived presentation values are server-computed, not reimplemented by
    // the UI: CPU busy = 100 − idle, used % from total/available (memory)
    // and total/free (swap).
    assertEquals(row!.derived.cpuUsagePercent, 40)
    assertEquals(row!.derived.memoryUsedPercent, 75)
    assertEquals(row!.derived.swapUsedPercent, 25)
  }, fakeStore)
})

it('GET /servers/:id/metrics/series returns available:false for disabled store', async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    assertEquals(body.available, false)
    assertEquals(body.backend, 'disabled')
    assertEquals(body.points, [])
  })
})

it('GET /servers/:id/metrics/series rejects oversized maxPoints', async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&maxPoints=${MAX_METRICS_POINTS + 1}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 400)
    const body = await readMetricsJson(res)
    assertEquals(body.ok, false)
  })
})

it('GET /servers/:id/metrics/series clamps resolution=60 over maximum range', async () => {
  const from = '2026-01-01T00:00:00.000Z'
  const to = '2026-04-01T00:00:00.000Z'
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [],
      resolutionSeconds: input.resolutionSeconds ?? 21600,
      gapCount: 0,
      sampleCount: 0,
    }),
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${from}&to=${to}&resolution=60`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    // 90 days / 1500 max points forces the ladder up to 21600 s buckets.
    assertEquals(body.resolutionSeconds, 21600)
    assertEquals(fakeStore.seriesCalls.length, 1)
    assertEquals(fakeStore.seriesCalls[0]!.resolutionSeconds, 21600)
  }, fakeStore)
})

it('GET /servers/:id/metrics/series cache uses canonical range for exact timestamps', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [{
        at: input.from,
        values: { cpuIdlePercent: 99 },
        sampleCount: 1,
      }],
      resolutionSeconds: input.resolutionSeconds ?? 300,
      gapCount: 0,
      sampleCount: 1,
    }),
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const fromA = '2026-01-01T00:00:30.000Z'
    const fromB = '2026-01-01T00:02:00.000Z'
    const urlA =
      `/servers/${serverId}/metrics/series?from=${fromA}&to=${TO}&metrics=cpuIdlePercent&resolution=300`
    const urlB =
      `/servers/${serverId}/metrics/series?from=${fromB}&to=${TO}&metrics=cpuIdlePercent&resolution=300`

    const first = await app.request(urlA, { headers: { Cookie: cookie } })
    assertEquals(first.status, 200)
    const bodyA = await readMetricsJson(first)
    assertEquals(bodyA.from, '2026-01-01T00:00:00.000Z')

    const second = await app.request(urlB, { headers: { Cookie: cookie } })
    assertEquals(second.status, 200)
    const bodyB = await readMetricsJson(second)
    assertEquals(bodyB.from, '2026-01-01T00:00:00.000Z')
    assertEquals(bodyB.points![0]!.values.cpuIdlePercent, 99)
    assertEquals(fakeStore.seriesCalls.length, 1)
    assertEquals(fakeStore.seriesCalls[0]!.from, '2026-01-01T00:00:00.000Z')
  }, fakeStore)
})

it('GET /servers/:id/metrics/series maps Analytics Engine failures to 503', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: () => Promise.reject(new Error('AE SQL unavailable')),
  })

  if (!dbUrl) return

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()
  const { app, secrets } = await createMetricsRoutesTestApp(
    db,
    fakeStore,
    'workers',
  )

  const email = `metrics-ae-fail-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Metrics AE Fail Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: 'AE Fail Server' })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const cookie = await sessionCookie(db, secrets, userId)

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 503)
    const body = await readMetricsJson(res)
    assertEquals(body.ok, false)
    assertEquals(body.error, 'metrics_backend_unavailable')
    assertEquals(body.backend, 'analytics-engine')
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

it('GET /servers/:id/metrics/series maps backend failures to 503', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: () => Promise.reject(new Error('metrics backend unavailable')),
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 503)
    const body = await readMetricsJson(res)
    assertEquals(body.ok, false)
    assertEquals(body.error, 'metrics_backend_unavailable')
    assertEquals(body.backend, 'duckdb')
  }, fakeStore)
})

it('GET /servers/:id/metrics/summary returns normalized payload', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSummary: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      sampleCount: 12,
      latestAt: TO,
    }),
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/summary?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    assertExists(body.ok)
    assertEquals(body.sampleCount, 12)
    assertEquals(body.latestAt, TO)
    assertEquals(fakeStore.summaryCalls.length, 1)
    // No hardware profile / org override set — falls through to "no limit".
    assertEquals(body.cpuLimits, { tdpWatts: null, tjMaxCelsius: null, source: 'none' })
    assertEquals(body.temperatureUnit, 'celsius')
  }, fakeStore)
})

it('GET /servers/:id/metrics/summary attaches an operator TDP/Tjmax override', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSummary: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      sampleCount: 3,
      latestAt: TO,
    }),
  })

  await withMetricsFixtures(async ({ db, app, serverId, cookie }) => {
    await db
      .update(server)
      .set({
        metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
          JSON.stringify({
            hardwareProfile: {
              cpuModel: 'AMD EPYC 7763',
              cpuTdpWattsOverride: 250,
            },
          })
        }::jsonb`,
      })
      .where(eq(server.id, serverId))

    const res = await app.request(
      `/servers/${serverId}/metrics/summary?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    // Override wins for tdpWatts; tjMaxCelsius falls through to the catalog.
    assertEquals(body.cpuLimits, {
      tdpWatts: 250,
      tjMaxCelsius: 95,
      source: 'override',
    })
  }, fakeStore)
})

it('GET /servers/:id/metrics/summary returns 403 without read access', async () => {
  if (!dbUrl) return

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()
  const { app, secrets } = await createMetricsRoutesTestApp(db)

  const email = `metrics-summary-deny-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Metrics Summary Deny Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id


  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: 'Denied Summary Server' })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const cookie = await sessionCookie(db, secrets, userId)

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/summary?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 403)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

it('GET /servers/:id/metrics/connection returns 401 without session', async () => {
  await withMetricsFixtures(async ({ app, serverId }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`,
    )
    assertEquals(res.status, 401)
  })
})

it('GET /servers/:id/metrics/connection returns 403 without read access', async () => {
  if (!dbUrl) return

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()
  const { app, secrets } = await createMetricsRoutesTestApp(db)

  const email = `metrics-conn-deny-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Metrics Connection Deny Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id


  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: 'Denied Connection Server' })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const cookie = await sessionCookie(db, secrets, userId)

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 403)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

it('GET /servers/:id/metrics/connection rejects invalid range', async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${TO}&to=${FROM}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 400)
  })
})

it('GET /servers/:id/metrics/connection maps backend failures to 503', async () => {
  const fakeStore = createFakeMetricsStore({
    queryStatusHistory: () => Promise.reject(new Error('metrics backend unavailable')),
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 503)
    const body = await readMetricsJson(res)
    assertEquals(body.ok, false)
    assertEquals(body.error, 'metrics_backend_unavailable')
    assertEquals(body.backend, 'duckdb')
  }, fakeStore)
})

it('GET /servers/:id/metrics/connection returns payload and caches on repeat', async () => {
  const fakeStore = createFakeMetricsStore({
    queryStatusHistory: (input) => Promise.resolve({
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      initialConnected: false,
      events: [{
        at: '2026-01-01T00:15:00.000Z',
        connected: true,
        reason: 'connect',
      }],
      uptimeSeconds: 2700,
      downtimeSeconds: 900,
      unknownSeconds: 0,
      uptimePercent: 0.75,
      truncated: false,
    }),
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const url =
      `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`
    const res = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(res.status, 200)
    const body = await readMetricsJson(res)
    assertEquals(body.ok, true)
    assertEquals(body.serverId, serverId)
    assertEquals(body.available, true)
    assertEquals(body.initialConnected, false)
    assertEquals(body.uptimeSeconds, 2700)
    assertEquals(body.downtimeSeconds, 900)
    assertEquals(body.unknownSeconds, 0)
    assertEquals(body.uptimePercent, 0.75)
    assertEquals(body.truncated, false)
    assertEquals(body.events!.length, 1)
    assertEquals(body.events![0]!.reason, 'connect')
    assertEquals(fakeStore.connectionCalls.length, 1)

    const cached = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(cached.status, 200)
    assertEquals(fakeStore.connectionCalls.length, 1)
  }, fakeStore)
})

type FakeCellResponse = {
  status: PendingRequestRecord['status']
  result?: unknown
  error?: string
}

function createFakeDaemonRegistry(
  respond: (outbound: DaemonOutboundEnvelope) => FakeCellResponse,
): DaemonCellRegistry & {
  sent: DaemonOutboundEnvelope[]
  enqueued: DaemonOutboundEnvelope[]
} {
  const sent: DaemonOutboundEnvelope[] = []
  const enqueued: DaemonOutboundEnvelope[] = []

  const buildRecord = (
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    response: FakeCellResponse,
  ): PendingRequestRecord => ({
    serverId,
    requestId: outbound.requestId,
    requestKind: outbound.kind,
    status: response.status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    result: response.result,
    error: response.error,
  })

  const cellFor = (serverId: string): DaemonCell =>
    ({
      createRequestAndWait: (outbound: DaemonOutboundEnvelope) => {
        sent.push(outbound)
        return Promise.resolve(buildRecord(serverId, outbound, respond(outbound)))
      },
      enqueue: (outbound: DaemonOutboundEnvelope) => {
        enqueued.push(outbound)
        return Promise.resolve(
          buildRecord(serverId, outbound, { status: 'queued' }),
        )
      },
    }) as unknown as DaemonCell

  return {
    sent,
    enqueued,
    getCell: cellFor,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

async function markServerConnected(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<void> {
  await db
    .update(server)
    .set({ isConnected: true })
    .where(eq(server.id, serverId))
}

it('POST /servers/:id/metrics/live returns 409 when live metrics are disabled', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await setServerMetricsLiveMaxMinutes(db, 0)
    try {
      await markServerConnected(db, serverId)
      const res = await app.request(`/servers/${serverId}/metrics/live`, {
        method: 'POST',
        headers: { cookie },
      })
      assertEquals(res.status, 409)
      const body = await res.json() as { error?: string }
      assertEquals(body.error, 'live_metrics_disabled')
      assertEquals(registry.sent.length, 0)
    } finally {
      await db
        .delete(setting)
        .where(eq(setting.key, SERVER_METRICS_LIVE_MAX_MINUTES_KEY))
    }
  }, undefined, registry)
})

it('POST /servers/:id/metrics/live starts a lease on a connected daemon', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const before = Date.now()
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'POST',
      headers: { cookie },
    })
    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok?: boolean
      leaseId?: string
      intervalSeconds?: number
      expiresAt?: string
    }
    assertEquals(body.ok, true)
    assertEquals(typeof body.leaseId, 'string')
    assertEquals(body.intervalSeconds, 10)
    // Default cap is 60 minutes.
    const expiresMs = Date.parse(body.expiresAt ?? '')
    assertEquals(expiresMs >= before + 59 * 60_000, true)
    assertEquals(expiresMs <= Date.now() + 61 * 60_000, true)

    assertEquals(registry.sent.length, 1)
    const outbound = registry.sent[0]!
    assertEquals(outbound.kind, 'metrics-live-start')
    if (outbound.kind === 'metrics-live-start') {
      assertEquals(outbound.leaseId, body.leaseId)
      assertEquals(outbound.intervalSeconds, 10)
      assertEquals(outbound.expiresAt, body.expiresAt)
    }
  }, undefined, registry)
})

it('POST /servers/:id/metrics/live renews a lease in place and DELETE returns the daemon to baseline', async () => {
  // Mirror the daemon LiveLeaseManager contract: start() on a known id renews
  // in place (no extra lease), stop() of the last lease returns cadence to
  // baseline immediately.
  const activeLeases = new Set<string>()
  const registry = createFakeDaemonRegistry((outbound) => {
    if (outbound.kind === 'metrics-live-start') {
      activeLeases.add(outbound.leaseId)
    }
    if (outbound.kind === 'metrics-live-stop') {
      activeLeases.delete(outbound.leaseId)
    }
    return { status: 'done' }
  })
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const startRes = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'POST',
      headers: { cookie },
    })
    assertEquals(startRes.status, 200)
    const started = await startRes.json() as { ok?: boolean; leaseId?: string }
    assertEquals(started.ok, true)
    const leaseId = started.leaseId!
    assertEquals(activeLeases.size, 1)

    // Renew: the caller-supplied id is reused and echoed back — no second
    // lease accumulates on the daemon.
    const renewRes = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId }),
    })
    assertEquals(renewRes.status, 200)
    const renewed = await renewRes.json() as { ok?: boolean; leaseId?: string }
    assertEquals(renewed.ok, true)
    assertEquals(renewed.leaseId, leaseId)
    assertEquals(registry.sent.length, 2)
    const renewOutbound = registry.sent[1]!
    assertEquals(renewOutbound.kind, 'metrics-live-start')
    if (renewOutbound.kind === 'metrics-live-start') {
      assertEquals(renewOutbound.leaseId, leaseId)
    }
    assertEquals(activeLeases.size, 1)

    // Explicit stop of that lease leaves no active lease behind — the daemon
    // returns to baseline cadence immediately, renewal or not.
    const stopRes = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId }),
    })
    assertEquals(stopRes.status, 200)
    const stopped = await stopRes.json() as { ok?: boolean }
    assertEquals(stopped.ok, true)
    assertEquals(activeLeases.size, 0)
  }, undefined, registry)
})

it('POST /servers/:id/metrics/live rejects an invalid leaseId', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: '' }),
    })
    assertEquals(res.status, 400)
    assertEquals(registry.sent.length, 0)
  }, undefined, registry)
})

it('POST /servers/:id/metrics/live returns 409 for an offline server', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'POST',
      headers: { cookie },
    })
    assertEquals(res.status, 409)
    const body = await res.json() as { error?: string }
    assertEquals(body.error, 'server_offline')
  }, undefined, registry)
})

it('POST /servers/:id/metrics/live maps a daemon timeout to 503', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'expired' }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'POST',
      headers: { cookie },
    })
    assertEquals(res.status, 503)
  }, undefined, registry)
})

it('DELETE /servers/:id/metrics/live requires a leaseId', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assertEquals(res.status, 400)
  }, undefined, registry)
})

it('DELETE /servers/:id/metrics/live stops a lease on a connected daemon', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: 'lease-1' }),
    })
    assertEquals(res.status, 200)
    const body = await res.json() as { ok?: boolean }
    assertEquals(body.ok, true)
    assertEquals(registry.sent.length, 1)
    const outbound = registry.sent[0]!
    assertEquals(outbound.kind, 'metrics-live-stop')
    if (outbound.kind === 'metrics-live-stop') {
      assertEquals(outbound.leaseId, 'lease-1')
    }
  }, undefined, registry)
})

it('DELETE /servers/:id/metrics/live is a soft success when the daemon is offline', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: 'lease-1' }),
    })
    assertEquals(res.status, 200)
    const body = await res.json() as { ok?: boolean }
    assertEquals(body.ok, true)
    // The daemon-side expiry timer is the safety net; nothing was sent.
    assertEquals(registry.sent.length, 0)
  }, undefined, registry)
})

it('GET /servers/:id/metrics/capabilities proxies the daemon round trip', async () => {
  const registry = createFakeDaemonRegistry(() => ({
    status: 'done',
    result: { capabilities: { sensors: {}, networkInterfaces: [] } },
  }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const res = await app.request(
      `/servers/${serverId}/metrics/capabilities`,
      { headers: { cookie } },
    )
    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok?: boolean
      capabilities?: { sensors?: unknown }
    }
    assertEquals(body.ok, true)
    assertExists(body.capabilities)
    assertEquals(registry.sent[0]!.kind, 'metrics-capabilities-request')
  }, undefined, registry)
})

it('GET /servers/:id/metrics/capabilities maps daemon failure to 503', async () => {
  const registry = createFakeDaemonRegistry(() => ({
    status: 'failed',
    error: 'discovery failed',
  }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const res = await app.request(
      `/servers/${serverId}/metrics/capabilities`,
      { headers: { cookie } },
    )
    assertEquals(res.status, 503)
  }, undefined, registry)
})

it('GET /servers/:id/metrics/capabilities maps a timeout to 503', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'expired' }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const res = await app.request(
      `/servers/${serverId}/metrics/capabilities`,
      { headers: { cookie } },
    )
    assertEquals(res.status, 503)
  }, undefined, registry)
})

const SAMPLE_HARDWARE_CAPABILITIES = {
  sensors: {
    cpuTemperature: [{ chip: 'coretemp', label: 'Package id 0' }],
    cpuPower: [{ chip: 'intel-rapl', label: 'package-0' }],
    cpuFan: [{ chip: 'nct6775', label: 'fan1' }],
    gpuFan: [{ chip: 'amdgpu', label: 'fan1' }],
    boardTemperature: [{ chip: 'nct6775', label: 'board' }],
    ambient1Temperature: [{ chip: 'nct6775', label: 'ambient' }],
    ambient2Temperature: [{ chip: 'nct6775', label: 'ambient2' }],
    disk1Temperature: [{ chip: 'drivetemp', label: 'sda' }],
    disk2Temperature: [{ chip: 'drivetemp', label: 'sdb' }],
    systemFan1: [{ chip: 'nct6775', label: 'sysfan1' }],
    systemFan2: [{ chip: 'nct6775', label: 'sysfan2' }],
    gpuDevices: [
      {
        chip: 'amdgpu',
        temperature: [{ chip: 'amdgpu', label: 'edge' }],
        power: [{ chip: 'amdgpu', label: 'power1' }],
      },
    ],
  },
  networkInterfaces: [{ name: 'eth0' }, { name: 'eth1' }],
}

/** Every canonical sensor-slot key — mirrors `HARDWARE_PROFILE_SENSOR_SLOT_KEYS`. */
const ALL_HARDWARE_PROFILE_SENSOR_SLOT_FIELDS = [
  'cpuTemperature',
  'cpuPower',
  'gpuDevice',
  'gpuFan',
  'disk1Temperature',
  'disk2Temperature',
  'ambient1Temperature',
  'ambient2Temperature',
  'boardTemperature',
  'cpuFan',
  'systemFan1',
  'systemFan2',
]

/** Registry that answers `metrics-capabilities-request` and accepts the push. */
function createHardwareProfileRegistry(
  capabilities: unknown = SAMPLE_HARDWARE_CAPABILITIES,
): DaemonCellRegistry & {
  sent: DaemonOutboundEnvelope[]
  enqueued: DaemonOutboundEnvelope[]
} {
  return createFakeDaemonRegistry((outbound) => {
    if (outbound.kind === 'metrics-capabilities-request') {
      return { status: 'done', result: { capabilities } }
    }
    return { status: 'done' }
  })
}

it('PUT /servers/:id/metrics/hardware-profile rejects unknown fields', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ bogus: 'nope' }),
      },
    )
    assertEquals(res.status, 400)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile validates, persists, and pushes the full profile', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)

    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          cpuTemperature: { chip: 'coretemp', label: 'Package id 0' },
          cpuPower: { chip: 'intel-rapl', label: 'package-0' },
          gpuDevice: { chip: 'amdgpu', label: 'edge' },
          gpuFan: { chip: 'amdgpu', label: 'fan1' },
          disk1Temperature: { chip: 'drivetemp', label: 'sda' },
          ambient1Temperature: { chip: 'nct6775', label: 'ambient' },
          boardTemperature: { chip: 'nct6775', label: 'board' },
          cpuFan: { chip: 'nct6775', label: 'fan1' },
          nic1: 'eth0',
          hostingPath: '/mnt/hosting',
          drivetempEnabled: true,
        }),
      },
    )
    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok?: boolean
      pushed?: boolean
      profile?: Record<string, unknown>
    }
    assertEquals(body.ok, true)
    assertEquals(body.pushed, true)
    assertEquals(body.profile?.cpuTemperature, {
      chip: 'coretemp',
      label: 'Package id 0',
    })
    assertEquals(body.profile?.gpuDevice, { chip: 'amdgpu', label: 'edge' })
    assertEquals(body.profile?.gpuFan, { chip: 'amdgpu', label: 'fan1' })
    assertEquals(body.profile?.disk1Temperature, {
      chip: 'drivetemp',
      label: 'sda',
    })
    assertEquals(body.profile?.nic1, 'eth0')
    assertEquals(body.profile?.hostingPath, '/mnt/hosting')
    assertEquals(body.profile?.drivetempEnabled, true)
    assertEquals(body.profile?.generation, 1)
    assertExists(body.profile?.generationAppliedAt)

    // The capability round trip runs before the push.
    assertEquals(
      registry.sent.some((e) => e.kind === 'metrics-capabilities-request'),
      true,
    )

    // Source of truth: the server row's metadata.
    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const metadata = rows[0]!.metadata as {
      hardwareProfile?: Record<string, unknown>
    }
    assertEquals(metadata.hardwareProfile?.cpuTemperature, {
      chip: 'coretemp',
      label: 'Package id 0',
    })
    assertEquals(metadata.hardwareProfile?.generation, 1)

    // Best-effort fan-out to the daemon (fire-and-forget enqueue) carries the
    // full profile, including generation.
    assertEquals(registry.enqueued.length, 1)
    const outbound = registry.enqueued[0]!
    assertEquals(outbound.kind, 'metrics-sensor-overrides-update')
    if (outbound.kind === 'metrics-sensor-overrides-update') {
      assertEquals(outbound.overrides.cpuTemperature, {
        chip: 'coretemp',
        label: 'Package id 0',
      })
      assertEquals(outbound.overrides.hostingPath, '/mnt/hosting')
      assertEquals(outbound.overrides.generation, 1)
    }
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile sets and clears cpu overrides without a daemon round trip or a generation bump', async () => {
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    // No markServerConnected: cpu overrides carry no identity to validate,
    // so this must succeed against an offline daemon.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          cpuTdpWattsOverride: 250,
          cpuTjMaxCelsiusOverride: 95,
        }),
      },
    )
    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok?: boolean
      profile?: Record<string, unknown>
    }
    assertEquals(body.ok, true)
    assertEquals(body.profile?.cpuTdpWattsOverride, 250)
    assertEquals(body.profile?.cpuTjMaxCelsiusOverride, 95)
    assertEquals(body.profile?.generation, undefined)

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const metadata = rows[0]!.metadata as {
      hardwareProfile?: Record<string, unknown>
    }
    assertEquals(metadata.hardwareProfile?.cpuTdpWattsOverride, 250)

    const clearRes = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ cpuTdpWattsOverride: null }),
      },
    )
    assertEquals(clearRes.status, 200)
    const clearBody = await clearRes.json() as { profile?: Record<string, unknown> }
    assertEquals(clearBody.profile?.cpuTdpWattsOverride, undefined)
    assertEquals(clearBody.profile?.cpuTjMaxCelsiusOverride, 95)
  })
})

it('PUT /servers/:id/metrics/hardware-profile rejects an out-of-range cpu override', async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ cpuTdpWattsOverride: -5 }),
      },
    )
    assertEquals(res.status, 400)
  })
})

it('PUT /servers/:id/metrics/hardware-profile bumps generation only when an identity actually changes', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)

    async function putProfile(payload: unknown) {
      const res = await app.request(
        `/servers/${serverId}/metrics/hardware-profile`,
        {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      assertEquals(res.status, 200)
      return await res.json() as { profile?: { generation?: number } }
    }

    // First assignment: generation 0 -> 1.
    const first = await putProfile({
      cpuTemperature: { chip: 'coretemp', label: 'Package id 0' },
    })
    assertEquals(first.profile?.generation, 1)

    // hostingPath / drivetempEnabled carry no sensor identity — no bump.
    const hostingOnly = await putProfile({
      hostingPath: '/mnt/hosting',
      drivetempEnabled: true,
    })
    assertEquals(hostingOnly.profile?.generation, 1)

    // Re-asserting the identical identity is idempotent — no bump.
    const idempotent = await putProfile({
      cpuTemperature: { chip: 'coretemp', label: 'Package id 0' },
    })
    assertEquals(idempotent.profile?.generation, 1)

    // A NIC binding is also identity-bearing — bumps.
    const nicChange = await putProfile({ nic1: 'eth0' })
    assertEquals(nicChange.profile?.generation, 2)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile persists an explicit unassigned disk-temp slot distinct from unset', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    // Explicitly unassigning a slot that was never configured is itself an
    // identity change (auto-detect -> confirmed absent) and needs no
    // capability round trip since nothing is being pinned.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ disk1Temperature: null }),
      },
    )
    assertEquals(res.status, 200)
    const body = await res.json() as {
      profile?: { disk1Temperature?: unknown; generation?: number }
    }
    assertEquals(body.profile?.disk1Temperature, null)
    assertEquals(body.profile?.generation, 1)

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const metadata = rows[0]!.metadata as {
      hardwareProfile?: { disk1Temperature?: unknown }
    }
    // `null` round-trips distinctly from the key being absent entirely.
    assertEquals('disk1Temperature' in (metadata.hardwareProfile ?? {}), true)
    assertEquals(metadata.hardwareProfile?.disk1Temperature, null)

    // Re-clearing the same slot is idempotent — no further generation bump.
    const again = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ disk1Temperature: null }),
      },
    )
    const againBody = await again.json() as { profile?: { generation?: number } }
    assertEquals(againBody.profile?.generation, 1)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile rejects a stale sensor identity', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          cpuTemperature: { chip: 'coretemp', label: 'no-such-label' },
        }),
      },
    )
    assertEquals(res.status, 400)
    const body = await res.json() as { error?: string }
    assertEquals(body.error?.includes('cpuTemperature'), true)
    // Rejected before persisting — no push either.
    assertEquals(registry.enqueued.length, 0)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile rejects a stale identity for every sensor slot', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)

    for (const field of ALL_HARDWARE_PROFILE_SENSOR_SLOT_FIELDS) {
      const res = await app.request(
        `/servers/${serverId}/metrics/hardware-profile`,
        {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            [field]: { chip: 'bogus-chip', label: 'no-such-label' },
          }),
        },
      )
      assertEquals(res.status, 400, `${field} should be rejected as stale`)
      const body = await res.json() as { error?: string }
      assertEquals(
        body.error?.includes(field),
        true,
        `${field} error should name the field, got: ${body.error}`,
      )
    }
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile requires the daemon online for every sensor slot', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    // No markServerConnected — every sensor-slot key is identity-bearing and
    // must route through hardwareProfileUpdateNeedsValidation's true branch,
    // which requires the daemon online before it can validate at all.
    for (const field of ALL_HARDWARE_PROFILE_SENSOR_SLOT_FIELDS) {
      const res = await app.request(
        `/servers/${serverId}/metrics/hardware-profile`,
        {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            [field]: { chip: 'some-chip', label: 'some-label' },
          }),
        },
      )
      assertEquals(res.status, 409, `${field} should require the daemon online`)
    }
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile rejects a stale NIC binding', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId)
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ nic2: 'eth9' }),
      },
    )
    assertEquals(res.status, 400)
    const body = await res.json() as { error?: string }
    assertEquals(body.error?.includes('nic2'), true)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile returns 409 when assigning an identity while the daemon is offline', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    // No markServerConnected — the daemon is offline.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          cpuTemperature: { chip: 'coretemp', label: 'Package id 0' },
        }),
      },
    )
    assertEquals(res.status, 409)
    const body = await res.json() as { error?: string }
    assertEquals(body.error, 'server_offline')
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile rejects a relative hostingPath without needing the daemon online', async () => {
  const registry = createHardwareProfileRegistry()
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    // No markServerConnected — hostingPath alone needs no capability round
    // trip, so validation failure must still surface as 400, not 409/503.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ hostingPath: 'relative/path' }),
      },
    )
    assertEquals(res.status, 400)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/hardware-profile preserves concurrent daemon-projected metadata', async () => {
  if (!dbUrl) return

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()

  // Simulate a daemon projection (resources / docker / geo) landing between
  // the route's SELECT and UPDATE: intercept the route's update call and merge
  // projected keys into the row first. The route must patch only the
  // hardwareProfile subtree instead of writing back its stale snapshot.
  let injectConcurrentWrite: (() => Promise<void>) | undefined
  type UpdateBuilder = {
    set: (patch: unknown) => { where: (cond: unknown) => Promise<unknown> }
  }
  const racingDb = new Proxy(db as object, {
    get(target, prop) {
      if (prop === 'update') {
        return (table: unknown): UpdateBuilder => {
          const builder = (target as { update: (t: unknown) => UpdateBuilder })
            .update(table)
          return {
            set: (patch: unknown) => ({
              where: async (cond: unknown) => {
                const inject = injectConcurrentWrite
                injectConcurrentWrite = undefined
                await inject?.()
                return await builder.set(patch).where(cond)
              },
            }),
          }
        }
      }
      const value = (target as Record<PropertyKey, unknown>)[prop]
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  }) as typeof db

  const registry = createHardwareProfileRegistry()
  const { app, secrets } = await createMetricsRoutesTestApp(
    racingDb,
    undefined,
    'deno',
    registry,
  )

  const email = `metrics-overrides-race-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Metrics Overrides Race Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: 'Overrides Race Server' })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const cookie = await sessionCookie(db, secrets, userId)

  const projected = {
    resources: { memory: { totalBytes: 1024 } },
    docker: { version: '28.3.3' },
    geo: { city: 'Amsterdam' },
  }

  try {
    injectConcurrentWrite = async () => {
      await db
        .update(server)
        .set({
          metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
            JSON.stringify(projected)
          }::jsonb`,
        })
        .where(eq(server.id, serverId))
    }

    // hostingPath carries no sensor identity, so this exercises the
    // concurrency guard without needing a connected daemon / capability
    // round trip.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ hostingPath: '/mnt/hosting' }),
      },
    )
    assertEquals(res.status, 200)

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const metadata = rows[0]!.metadata as {
      resources?: { memory?: { totalBytes?: number } }
      docker?: { version?: string }
      geo?: { city?: string }
      hardwareProfile?: { hostingPath?: string }
    }
    assertEquals(metadata.resources?.memory?.totalBytes, 1024)
    assertEquals(metadata.docker?.version, '28.3.3')
    assertEquals(metadata.geo?.city, 'Amsterdam')
    assertEquals(metadata.hardwareProfile?.hostingPath, '/mnt/hosting')

    // Clearing the last field drops only the hardwareProfile key.
    const clearRes = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ hostingPath: null }),
      },
    )
    assertEquals(clearRes.status, 200)
    const clearedRows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const clearedMetadata = clearedRows[0]!.metadata as {
      resources?: { memory?: { totalBytes?: number } }
      hardwareProfile?: Record<string, unknown>
    }
    assertEquals(clearedMetadata.resources?.memory?.totalBytes, 1024)
    assertEquals(clearedMetadata.hardwareProfile, undefined)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})
