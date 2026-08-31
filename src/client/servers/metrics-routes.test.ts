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
    // v2 stores raw fields only — derived presentation values come from them:
    // CPU busy = 100 − idle, memory used % = (total − available) / total.
    assertEquals(100 - values.cpuIdlePercent!, 25)
    assertEquals(
      ((values.memoryTotalBytes! - values.memoryAvailableBytes!) /
        values.memoryTotalBytes!) * 100,
      75,
    )
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
    // Derived presentation values come from the raw fields: CPU busy =
    // 100 − idle, used % from total/available (memory) and total/free (swap).
    assertEquals(100 - row!.values.cpuIdlePercent!, 40)
    assertEquals(
      ((row!.values.memoryTotalBytes! - row!.values.memoryAvailableBytes!) /
        row!.values.memoryTotalBytes!) * 100,
      75,
    )
    assertEquals(
      ((row!.values.swapTotalBytes! - row!.values.swapFreeBytes!) /
        row!.values.swapTotalBytes!) * 100,
      25,
    )
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

it('PUT /servers/:id/metrics/sensor-overrides rejects unknown fields', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/sensor-overrides`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ bogus: 'nope' }),
      },
    )
    assertEquals(res.status, 400)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/sensor-overrides persists and pushes overrides', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/sensor-overrides`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          cpuTemperature: 'coretemp:Package id 0',
          hostingPath: '/mnt/hosting',
        }),
      },
    )
    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok?: boolean
      pushed?: boolean
      overrides?: Record<string, string>
    }
    assertEquals(body.ok, true)
    assertEquals(body.pushed, true)
    assertEquals(body.overrides?.cpuTemperature, 'coretemp:Package id 0')
    assertEquals(body.overrides?.hostingPath, '/mnt/hosting')

    // Source of truth: the server row's metadata.
    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const metadata = rows[0]!.metadata as {
      metricsOverrides?: Record<string, string>
    }
    assertEquals(
      metadata.metricsOverrides?.cpuTemperature,
      'coretemp:Package id 0',
    )
    assertEquals(metadata.metricsOverrides?.hostingPath, '/mnt/hosting')

    // Best-effort fan-out to the daemon (fire-and-forget enqueue).
    assertEquals(registry.enqueued.length, 1)
    const outbound = registry.enqueued[0]!
    assertEquals(outbound.kind, 'metrics-sensor-overrides-update')
    if (outbound.kind === 'metrics-sensor-overrides-update') {
      assertEquals(outbound.overrides.cpuTemperature, 'coretemp:Package id 0')
      assertEquals(outbound.overrides.hostingPath, '/mnt/hosting')
    }

    // null clears one field and leaves the rest intact.
    const clearRes = await app.request(
      `/servers/${serverId}/metrics/sensor-overrides`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ cpuTemperature: null }),
      },
    )
    assertEquals(clearRes.status, 200)
    const cleared = await clearRes.json() as {
      overrides?: Record<string, string>
    }
    assertEquals(cleared.overrides?.cpuTemperature, undefined)
    assertEquals(cleared.overrides?.hostingPath, '/mnt/hosting')
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/sensor-overrides rejects a relative hostingPath', async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/sensor-overrides`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ hostingPath: 'relative/path' }),
      },
    )
    assertEquals(res.status, 400)
  }, undefined, registry)
})

it('PUT /servers/:id/metrics/sensor-overrides preserves concurrent daemon-projected metadata', async () => {
  if (!dbUrl) return

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()

  // Simulate a daemon projection (resources / docker / geo) landing between
  // the route's SELECT and UPDATE: intercept the route's update call and merge
  // projected keys into the row first. The route must patch only the
  // metricsOverrides subtree instead of writing back its stale snapshot.
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

  const registry = createFakeDaemonRegistry(() => ({ status: 'done' }))
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

    const res = await app.request(
      `/servers/${serverId}/metrics/sensor-overrides`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ cpuTemperature: 'coretemp:Package id 0' }),
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
      metricsOverrides?: Record<string, string>
    }
    assertEquals(metadata.resources?.memory?.totalBytes, 1024)
    assertEquals(metadata.docker?.version, '28.3.3')
    assertEquals(metadata.geo?.city, 'Amsterdam')
    assertEquals(
      metadata.metricsOverrides?.cpuTemperature,
      'coretemp:Package id 0',
    )

    // Clearing the last override drops only the metricsOverrides key.
    const clearRes = await app.request(
      `/servers/${serverId}/metrics/sensor-overrides`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ cpuTemperature: null }),
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
      metricsOverrides?: Record<string, string>
    }
    assertEquals(clearedMetadata.resources?.memory?.totalBytes, 1024)
    assertEquals(clearedMetadata.metricsOverrides, undefined)
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
