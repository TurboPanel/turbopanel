import { assertEquals, assertExists } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
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
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  grant,
  membership,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import { DisabledServerMetricsStore } from '../../daemon/metrics/disabled-store.ts'
import type {
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
  StatusHistoryQuery,
  StatusHistoryResult,
} from '../../daemon/metrics/types.ts'
import { registerServerMetricsRoutes } from './metrics-routes.ts'
import { resetDenoMetricsChartCacheForTests } from '../../daemon/metrics/query/cache.ts'
import { MAX_METRICS_POINTS } from '../../daemon/metrics/query/resolution.ts'

import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-01-01T01:00:00.000Z'

function createFakeMetricsStore(
  handlers?: {
    queryHostSeries?: (input: HostSeriesQuery) => Promise<HostSeriesResult>
    queryHostSummary?: (input: HostSummaryQuery) => Promise<HostSummaryResult>
    queryStatusHistory?: (
      input: StatusHistoryQuery,
    ) => Promise<StatusHistoryResult>
  },
): ServerMetricsStore & {
  seriesCalls: HostSeriesQuery[]
  summaryCalls: HostSummaryQuery[]
  connectionCalls: StatusHistoryQuery[]
} {
  const seriesCalls: HostSeriesQuery[] = []
  const summaryCalls: HostSummaryQuery[] = []
  const connectionCalls: StatusHistoryQuery[] = []
  const disabled = new DisabledServerMetricsStore()

  return {
    seriesCalls,
    summaryCalls,
    connectionCalls,
    writeHostSample: () => {},
    writeStatusEvent: () => {},
    queryHostSeries: async (input) => {
      seriesCalls.push(input)
      if (handlers?.queryHostSeries) {
        return handlers.queryHostSeries(input)
      }
      return disabled.queryHostSeries(input)
    },
    queryHostSummary: async (input) => {
      summaryCalls.push(input)
      if (handlers?.queryHostSummary) {
        return handlers.queryHostSummary(input)
      }
      return disabled.queryHostSummary(input)
    },
    queryStatusHistory: async (input) => {
      connectionCalls.push(input)
      if (handlers?.queryStatusHistory) {
        return handlers.queryStatusHistory(input)
      }
      return disabled.queryStatusHistory(input)
    },
    queryFleetHostSnapshot: (input) => disabled.queryFleetHostSnapshot(input),
  }
}

async function createMetricsRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  metricsStore?: ServerMetricsStore,
  runtime: 'workers' | 'deno' = 'deno',
) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (metricsStore) {
      c.set('serverMetricsStore', metricsStore)
    }
    return next()
  })
  registerServerMetricsRoutes(app, { secrets, runtime })
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
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping metrics route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  resetDenoMetricsChartCacheForTests()
  const db = createDenoDb()
  const { app, secrets } = await createMetricsRoutesTestApp(db, metricsStore)

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

  await db.insert(membership).values({ organizationId, userId })
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
    await db.delete(membership).where(and(
      eq(membership.organizationId, organizationId),
      eq(membership.userId, userId),
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

  await db.insert(membership).values({ organizationId, userId })

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
    await db.delete(membership).where(and(
      eq(membership.organizationId, organizationId),
      eq(membership.userId, userId),
    ))
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
    const body = await res.json()
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
    queryHostSeries: async (input) => ({
      kind: 'clickhouse',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [{
        at: FROM,
        values: { cpuUsagePercent: 0, memoryUsedBytes: null },
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
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=cpuUsagePercent,memoryUsedBytes`
    const res = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.ok, true)
    assertEquals(body.metrics, ['cpuUsagePercent', 'memoryUsedBytes'])
    assertEquals(body.points.length, 1)
    assertEquals(body.points[0].values.cpuUsagePercent, 0)
    assertEquals(body.points[0].values.memoryUsedBytes, null)
    assertEquals(body.points[0].sampleCount, 1)
    assertEquals(fakeStore.seriesCalls.length, 1)
    assertEquals(fakeStore.seriesCalls[0]!.metrics, [
      'cpuUsagePercent',
      'memoryUsedBytes',
    ])
    assertEquals(fakeStore.seriesCalls[0]!.resolutionSeconds, 60)

    const cached = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(cached.status, 200)
    assertEquals(fakeStore.seriesCalls.length, 1)
  }, fakeStore)
})

it('GET /servers/:id/metrics/series returns available:false for disabled store', async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 200)
    const body = await res.json()
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
    const body = await res.json()
    assertEquals(body.ok, false)
  })
})

it('GET /servers/:id/metrics/series clamps resolution=60 over maximum range', async () => {
  const from = '2026-01-01T00:00:00.000Z'
  const to = '2026-04-01T00:00:00.000Z'
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: async (input) => ({
      kind: 'clickhouse',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [],
      resolutionSeconds: input.resolutionSeconds ?? 86400,
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
    const body = await res.json()
    assertEquals(body.resolutionSeconds, 86400)
    assertEquals(fakeStore.seriesCalls.length, 1)
    assertEquals(fakeStore.seriesCalls[0]!.resolutionSeconds, 86400)
  }, fakeStore)
})

it('GET /servers/:id/metrics/series cache uses canonical range for exact timestamps', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: async (input) => ({
      kind: 'clickhouse',
      available: true,
      serverId: input.serverId,
      metrics: input.metrics,
      points: [{
        at: input.from,
        values: { cpuUsagePercent: 1 },
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
      `/servers/${serverId}/metrics/series?from=${fromA}&to=${TO}&metrics=cpuUsagePercent&resolution=300`
    const urlB =
      `/servers/${serverId}/metrics/series?from=${fromB}&to=${TO}&metrics=cpuUsagePercent&resolution=300`

    const first = await app.request(urlA, { headers: { Cookie: cookie } })
    assertEquals(first.status, 200)
    const bodyA = await first.json()
    assertEquals(bodyA.from, '2026-01-01T00:00:00.000Z')

    const second = await app.request(urlB, { headers: { Cookie: cookie } })
    assertEquals(second.status, 200)
    const bodyB = await second.json()
    assertEquals(bodyB.from, '2026-01-01T00:00:00.000Z')
    assertEquals(bodyB.points[0].values.cpuUsagePercent, 1)
    assertEquals(fakeStore.seriesCalls.length, 1)
    assertEquals(fakeStore.seriesCalls[0]!.from, '2026-01-01T00:00:00.000Z')
  }, fakeStore)
})

it('GET /servers/:id/metrics/series maps Analytics Engine failures to 503', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: async () => {
      throw new Error('AE SQL unavailable')
    },
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

  await db.insert(membership).values({ organizationId, userId })
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
    const body = await res.json()
    assertEquals(body.ok, false)
    assertEquals(body.error, 'metrics_backend_unavailable')
    assertEquals(body.backend, 'analytics-engine')
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(membership).where(and(
      eq(membership.organizationId, organizationId),
      eq(membership.userId, userId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

it('GET /servers/:id/metrics/series maps ClickHouse failures to 503', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: async () => {
      throw new Error('ClickHouse unavailable')
    },
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 503)
    const body = await res.json()
    assertEquals(body.ok, false)
    assertEquals(body.error, 'metrics_backend_unavailable')
    assertEquals(body.backend, 'clickhouse')
  }, fakeStore)
})

it('GET /servers/:id/metrics/summary returns normalized payload', async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSummary: async (input) => ({
      kind: 'clickhouse',
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
    const body = await res.json()
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

  await db.insert(membership).values({ organizationId, userId })

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
    await db.delete(membership).where(and(
      eq(membership.organizationId, organizationId),
      eq(membership.userId, userId),
    ))
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

  await db.insert(membership).values({ organizationId, userId })

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
    await db.delete(membership).where(and(
      eq(membership.organizationId, organizationId),
      eq(membership.userId, userId),
    ))
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
    queryStatusHistory: async () => {
      throw new Error('ClickHouse unavailable')
    },
  })

  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 503)
    const body = await res.json()
    assertEquals(body.ok, false)
    assertEquals(body.error, 'metrics_backend_unavailable')
    assertEquals(body.backend, 'clickhouse')
  }, fakeStore)
})

it('GET /servers/:id/metrics/connection returns payload and caches on repeat', async () => {
  const fakeStore = createFakeMetricsStore({
    queryStatusHistory: async (input) => ({
      kind: 'clickhouse',
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
    const body = await res.json()
    assertEquals(body.ok, true)
    assertEquals(body.serverId, serverId)
    assertEquals(body.available, true)
    assertEquals(body.initialConnected, false)
    assertEquals(body.uptimeSeconds, 2700)
    assertEquals(body.downtimeSeconds, 900)
    assertEquals(body.unknownSeconds, 0)
    assertEquals(body.uptimePercent, 0.75)
    assertEquals(body.truncated, false)
    assertEquals(body.events.length, 1)
    assertEquals(body.events[0].reason, 'connect')
    assertEquals(fakeStore.connectionCalls.length, 1)

    const cached = await app.request(url, { headers: { Cookie: cookie } })
    assertEquals(cached.status, 200)
    assertEquals(fakeStore.connectionCalls.length, 1)
  }, fakeStore)
})
