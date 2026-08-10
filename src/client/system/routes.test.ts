import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  command,
  grant,
  membership,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { ensureSystemHierarchy } from './hierarchy.ts'
import { registerSystemRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createMockCell(serverId: string): DaemonCell {
  const noopAsync = async () => {}
  return {
    attachDaemonSocket: async () => ({
      connectionId: 'conn',
      lease: {
        holder: 'conn',
        token: 'conn',
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: false,
    }),
    putSnapshot: async (patch) => ({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: false,
      ...patch,
    }),
    enqueue: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'queued' as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: noopAsync,
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'done' as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: async () => [],
    ackOutbox: noopAsync,
    prune: async () => [],
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: noopAsync,
  }
}

function createTrackingRegistry(): DaemonCellRegistry {
  const cells = new Map<string, DaemonCell>()
  return {
    getCell(serverId: string): DaemonCell {
      let cell = cells.get(serverId)
      if (!cell) {
        cell = createMockCell(serverId)
        cells.set(serverId, cell)
      }
      return cell
    },
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
  }
}

function createRecordingCommandQueue(): CommandQueue & {
  envelopes: CommandEnvelope[]
} {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: async (envelope) => {
      envelopes.push(envelope)
    },
  }
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

async function withSystemRouteFixtures(
  options: {
    withSystemOperateGrant?: boolean
    withCommandQueue?: boolean
    withRegistry?: boolean
    provisionHierarchy?: boolean
  },
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serverId: string
    commandQueue: ReturnType<typeof createRecordingCommandQueue> | undefined
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping system route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const commandQueue = options.withCommandQueue === false
    ? undefined
    : createRecordingCommandQueue()
  const registry = options.withRegistry === false ? undefined : createTrackingRegistry()

  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (registry) c.set('daemonCellRegistry', registry)
    if (commandQueue) c.set('commandQueue', commandQueue)
    return next()
  })
  registerSystemRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const email = `system-route-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'System Route Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(membership).values({ organizationId, userId })

  if (options.withSystemOperateGrant !== false) {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'system:operate',
      allow: true,
    })
  }

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'System Route Server',
      options: { hosting: { enabled: true } },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  if (options.provisionHierarchy !== false) {
    await ensureSystemHierarchy(db, { organizationId, serverId })
  }

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serverId,
      commandQueue,
    })
  } finally {
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(membership).where(and(
      eq(membership.userId, userId),
      eq(membership.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /servers/:id/system/:component/restart queues system.reconcile', async () => {
  await withSystemRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(
      `/servers/${serverId}/system/hosting-ingress/restart`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      commandId: string
      status: string
      serverId: string
    }
    assertEquals(body.ok, true)
    assertEquals(body.status, 'queued')
    assertEquals(body.serverId, serverId)
    assertEquals(typeof body.commandId, 'string')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertEquals(commandQueue!.envelopes[0]?.type, 'system.reconcile')
  })
})

test('POST /servers/:id/system/:component/restart returns 400 for unknown component', async () => {
  await withSystemRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(
      `/servers/${serverId}/system/database/restart`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )

    assertEquals(res.status, 400)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'unknown_system_component')
  })
})

test('POST /servers/:id/system/:component/restart returns 404 when hierarchy is missing', async () => {
  await withSystemRouteFixtures({ provisionHierarchy: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(
      `/servers/${serverId}/system/hosting-ingress/restart`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )

    assertEquals(res.status, 404)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'system_component_not_provisioned')
    assertEquals(commandQueue!.envelopes.length, 0)
  })
})

test('POST /servers/:id/system/:component/restart returns 403 without system:operate', async () => {
  await withSystemRouteFixtures({ withSystemOperateGrant: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(
      `/servers/${serverId}/system/hosting-ingress/restart`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )

    assertEquals(res.status, 403)
    assertEquals(commandQueue!.envelopes.length, 0)
  })
})

test('POST /servers/:id/system/:component/restart returns 503 without dispatch infra', async () => {
  await withSystemRouteFixtures({
    withCommandQueue: false,
    withRegistry: true,
  }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(
      `/servers/${serverId}/system/hosting-ingress/restart`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )

    assertEquals(res.status, 503)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'Command queue unavailable')
  })
})
