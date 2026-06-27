import { assertEquals } from 'jsr:@std/assert'
import { stub } from 'jsr:@std/testing@1/mock'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  grant,
  member,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import * as hierarchyDelete from '../hierarchy-delete.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerRoutes } from './routes.ts'

const dbUrl = getDatabaseUrl()
const TEST_SECRET = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6'

function createMockCell(
  serverId: string,
  purgedIds: string[],
  failPurge = false,
): DaemonCell {
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
    heartbeat: noopAsync,
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
    prune: async () => false,
    purge: async () => {
      if (failPurge) {
        throw new Error(`purge failed for ${serverId}`)
      }
      purgedIds.push(serverId)
    },
  }
}

function createTrackingRegistry(options?: {
  failPurgeIds?: Set<string>
}): DaemonCellRegistry & { purgedIds: string[] } {
  const purgedIds: string[] = []
  const failPurgeIds = options?.failPurgeIds ?? new Set<string>()
  const cells = new Map<string, DaemonCell>()

  return {
    purgedIds,
    getCell(serverId: string): DaemonCell {
      let cell = cells.get(serverId)
      if (!cell) {
        cell = createMockCell(serverId, purgedIds, failPurgeIds.has(serverId))
        cells.set(serverId, cell)
      }
      return cell
    },
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async (serverId: string) => {
      await this.getCell(serverId).purge()
    },
  }
}

async function createServerRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  registry?: DaemonCellRegistry,
) {
  const secretsConfig = parseSecretsEnv(TEST_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (registry) {
      c.set('daemonCellRegistry', registry)
    }
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'deno' })
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

async function withServerDeleteFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serverId: string
    registry: DaemonCellRegistry & { purgedIds: string[] }
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-delete-test-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Server Delete Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    subjectType: 'user',
    subjectId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      displayName: 'Delete Me',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serverId,
      registry,
    })
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.subjectId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('DELETE /servers/:id deletes the row and purges the daemon cell', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body, { ok: true, serverId })

    const remaining = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remaining.length, 0)
    assertEquals(registry.purgedIds, [serverId])
  })
})

Deno.test('DELETE /servers/:id returns 404 for a missing server', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    await db.delete(server).where(eq(server.id, serverId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 404)
  })
})

Deno.test('DELETE /servers/:id returns 409 when child resources block deletion', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const runHierarchyDeleteStub = stub(
      hierarchyDelete,
      'runHierarchyDelete',
      () => Promise.resolve('has_children' as const),
    )

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/servers/${serverId}`, {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 409)
      const body = await res.json()
      assertEquals(body.error, hierarchyDelete.HIERARCHY_DELETE_HAS_CHILDREN_ERROR)
      assertEquals(registry.purgedIds.length, 0)

      const remaining = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.id, serverId))
      assertEquals(remaining.length, 1)
    } finally {
      runHierarchyDeleteStub.restore()
    }
  })
})

Deno.test('DELETE /servers/:id returns 503 when daemon cell registry is unavailable', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createServerRoutesTestApp(db)

  const email = `server-delete-no-registry-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Server Delete No Registry Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    subjectType: 'user',
    subjectId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      displayName: 'Registry Missing',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 503)
    const body = await res.json()
    assertEquals(body.error, 'Daemon cell registry unavailable')

    const remaining = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remaining.length, 1)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.subjectId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

Deno.test('DELETE /servers/:id returns 500 when purge fails after row delete', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const serverId = crypto.randomUUID()
  const registry = createTrackingRegistry({ failPurgeIds: new Set([serverId]) })
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-delete-purge-fail-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Server Delete Purge Fail Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    subjectType: 'user',
    subjectId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  await db.insert(server).values({
    id: serverId,
    createdAt: now,
    updatedAt: now,
    organizationId,
    displayName: 'Purge Fail',
  })

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 500)
    const body = await res.json()
    assertEquals(body.ok, false)
    assertEquals(body.serverId, serverId)
    assertEquals(body.deleted, true)
    assertEquals(typeof body.error, 'string')
    assertEquals(body.error.includes('purge failed'), true)

    const remaining = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remaining.length, 0)
    assertEquals(registry.purgedIds.length, 0)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.subjectId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})
