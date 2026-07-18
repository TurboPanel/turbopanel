import { assertEquals, assertExists, assertThrows } from 'jsr:@std/assert'
import { stub } from '@std/testing/mock'
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
  license,
  member,
  network,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import * as hierarchyDelete from '../hierarchy-delete.ts'
import * as colocated from './colocated.ts'
import {
  colocatedServerDeleteBlockedReason,
  SERVER_HAS_BLOCKERS_CODE,
  SERVER_HAS_BLOCKERS_ERROR,
} from './delete-guards.ts'
import { createLicense } from '../authn/license.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { buildServerDaemonState } from '../../daemon/authn/daemon-state.ts'
import { attachDaemonStateToServer } from '../../daemon/authn/server-identity-db.ts'
import { registerServerRoutes } from './routes.ts'
import type { ServerStatusRecord } from './update-status.ts'
import type { QueryCache } from '../../query-cache/contracts.ts'
import type { ServersListRow } from '../../query-cache/read-models/servers-list.ts'

import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const SERVER_STATUS_RECORD_KEYS: (keyof ServerStatusRecord)[] = [
  'serverId',
  'connected',
  'daemonStatus',
  'lastSeenAt',
  'connectedAt',
  'disconnectedAt',
  'statusChangedAt',
  'hostname',
  'remoteAddress',
  'geo',
  'colocatedWithInstance',
]

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createMockCell(
  serverId: string,
  purgedIds: string[],
  failPurge = false,
  options?: { listRequestsThrows?: boolean },
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
    listRequests: options?.listRequestsThrows
      ? async () => {
        throw new Error('listRequests should not be called')
      }
      : async () => [],
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
    clearUpdateStatus: async () => ({ cleared: 0 }),
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
  listRequestsThrows?: boolean
  getCellThrows?: boolean
  getSnapshotsThrows?: boolean
  listOnlineServerIdsThrows?: boolean
  onlineIds?: string[]
}): DaemonCellRegistry & { purgedIds: string[] } {
  const purgedIds: string[] = []
  const failPurgeIds = options?.failPurgeIds ?? new Set<string>()
  const cells = new Map<string, DaemonCell>()
  const onlineIds = options?.onlineIds ?? []

  return {
    purgedIds,
    getCell(serverId: string): DaemonCell {
      if (options?.getCellThrows) {
        throw new Error('getCell must not be called')
      }
      let cell = cells.get(serverId)
      if (!cell) {
        cell = createMockCell(
          serverId,
          purgedIds,
          failPurgeIds.has(serverId),
          { listRequestsThrows: options?.listRequestsThrows },
        )
        cells.set(serverId, cell)
      }
      return cell
    },
    listOnlineServerIds: options?.listOnlineServerIdsThrows
      ? async () => {
        throw new Error('listOnlineServerIds must not be called')
      }
      : async () => onlineIds,
    getSnapshots: options?.getSnapshotsThrows
      ? async () => {
        throw new Error('getSnapshots must not be called')
      }
      : async () => new Map(),
    purge: async (serverId: string) => {
      await this.getCell(serverId).purge()
    },
  }
}

async function createServerRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  registry?: DaemonCellRegistry,
  queryCache?: QueryCache,
) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (registry) {
      c.set('daemonCellRegistry', registry)
    }
    if (queryCache) {
      c.set('queryCache', queryCache)
    }
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'deno' })
  return { app, secrets }
}

const SERVERS_LIST_SELECT_KEYS = new Set([
  'id',
  'displayName',
  'organizationId',
  'licenseId',
  'options',
  'createdAt',
])

function assertServersListSelectFields(fields: Record<string, unknown>): void {
  const keys = Object.keys(fields)
  const exactColumnSet = keys.length === SERVERS_LIST_SELECT_KEYS.size
    && keys.every((key) => SERVERS_LIST_SELECT_KEYS.has(key))
  if (!exactColumnSet) {
    throw new Error(
      'readDb must only serve the documented servers-list row SELECT column set',
    )
  }
}

/** Cached readDb: only the approved list-row SELECT; presence/colocated must use primary db. */
function createListRowsOnlyReadDb(
  db: ReturnType<typeof createDenoDb>,
): ReturnType<typeof createDenoDb> & { selectCallCount: number } {
  let selectCallCount = 0
  const rejectCachedAccess = (prop: string | symbol): never => {
    throw new Error(
      `readDb must not access ${String(prop)}; only the list-rows SELECT is allowed`,
    )
  }
  const proxy = new Proxy(db, {
    get(_target, prop) {
      if (prop === 'selectCallCount') {
        return selectCallCount
      }
      if (prop === 'select') {
        return (fields: Record<string, unknown>) => {
          selectCallCount += 1
          assertServersListSelectFields(fields)
          return db.select(fields as Parameters<typeof db.select>[0])
        }
      }
      return rejectCachedAccess(prop)
    },
  }) as ReturnType<typeof createDenoDb> & { selectCallCount: number }
  return proxy
}

function createStubDbForCachedReadTests(): ReturnType<typeof createDenoDb> {
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
        }),
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => {
      throw new Error('underlying update must not run')
    },
  } as unknown as ReturnType<typeof createDenoDb>
}

test('createListRowsOnlyReadDb default-denies non-select database access', () => {
  const db = createStubDbForCachedReadTests()
  const readDb = createListRowsOnlyReadDb(db)

  for (const method of [
    'update',
    'delete',
    'transaction',
    'query',
    'selectDistinct',
    'execute',
    'insert',
    '$client',
    'session',
  ] as const) {
    assertThrows(
      () => readDb[method],
      Error,
      'readDb must not access',
    )
  }
})

test('createListRowsOnlyReadDb rejects partial servers-list select columns', async () => {
  const db = createStubDbForCachedReadTests()
  const readDb = createListRowsOnlyReadDb(db)

  assertThrows(
    () => readDb.select({ id: server.id }),
    Error,
    'documented servers-list row SELECT column set',
  )
  assertThrows(
    () => readDb.select({
      id: server.id,
      displayName: server.displayName,
      organizationId: server.organizationId,
      licenseId: license.id,
      options: server.options,
      createdAt: server.createdAt,
      daemon: server.daemon,
    }),
    Error,
    'documented servers-list row SELECT column set',
  )

  const allowedReadDb = createListRowsOnlyReadDb(createStubDbForCachedReadTests())
  await allowedReadDb.select({
    id: server.id,
    displayName: server.displayName,
    organizationId: server.organizationId,
    licenseId: license.id,
    options: server.options,
    createdAt: server.createdAt,
  })
  assertEquals(allowedReadDb.selectCallCount, 1)
})

function createRecordingQueryCache(
  readDb: ReturnType<typeof createDenoDb>,
): QueryCache & {
  readModels: string[]
  store: Map<string, ServersListRow[]>
  loadCallCount: number
} {
  const readModels: string[] = []
  const store = new Map<string, ServersListRow[]>()
  let loadCallCount = 0

  return {
    readModels,
    store,
    get loadCallCount() {
      return loadCallCount
    },
    async getReadModel<T>(opts: {
      readModel: string
      key: string
      ttlSeconds?: number
      load: (readDb: ReturnType<typeof createDenoDb>) => Promise<T>
    }): Promise<T> {
      readModels.push(opts.readModel)
      const cached = store.get(opts.key)
      if (cached !== undefined) {
        return cached as T
      }
      loadCallCount += 1
      const result = await opts.load(readDb)
      store.set(opts.key, result as ServersListRow[])
      return result
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
    actorType: 'user',
    actorId: userId,
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
      eq(grant.actorId, userId),
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

test('DELETE /servers/:id deletes the row and purges the daemon cell', async () => {
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

test('DELETE /servers/:id returns 404 for a missing server', async () => {
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

test('DELETE /servers/:id returns 403 for the co-located control plane server', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const colocatedStub = stub(
      colocated,
      'resolveColocatedServerIdSet',
      () => Promise.resolve(new Set([serverId])),
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

      assertEquals(res.status, 403)
      const body = await res.json()
      assertEquals(body.error, colocatedServerDeleteBlockedReason())
      assertEquals(registry.purgedIds.length, 0)
    } finally {
      colocatedStub.restore()
    }
  })
})

test('DELETE /servers/:id returns 409 when networks block deletion', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const now = new Date().toISOString()
    const [insertedNetwork] = await db
      .insert(network)
      .values({
        createdAt: now,
        updatedAt: now,
        serverId,
      })
      .returning({ id: network.id })

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
      assertEquals(body.error, SERVER_HAS_BLOCKERS_ERROR)
      assertEquals(body.code, SERVER_HAS_BLOCKERS_CODE)
      assertEquals(body.blockers, [{ kind: 'network', count: 1 }])
      assertEquals(registry.purgedIds.length, 0)
    } finally {
      if (insertedNetwork) {
        await db.delete(network).where(eq(network.id, insertedNetwork.id))
      }
    }
  })
})

test('DELETE /servers/:id invalidates the bound license', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const { licenseId } = await createLicense(db, { organizationId })
    await db
      .update(license)
      .set({ serverId, updatedAt: new Date().toISOString() })
      .where(eq(license.id, licenseId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)

    const [licenseRow] = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, licenseId))
      .limit(1)
    assertExists(licenseRow?.revokedAt)

    await db.delete(license).where(eq(license.id, licenseId))
  })
})

test('DELETE /servers/:id invalidates the bound license on Workers runtime', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', registry)
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'workers' })

  const email = `server-delete-workers-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Server Delete Workers Org' })
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
    actorType: 'user',
    actorId: userId,
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
      displayName: 'Workers Delete Me',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const { licenseId } = await createLicense(db, { organizationId })
    await db
      .update(license)
      .set({ serverId, updatedAt: new Date().toISOString() })
      .where(eq(license.id, licenseId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)

    const [licenseRow] = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, licenseId))
      .limit(1)
    assertExists(licenseRow?.revokedAt)

    await db.delete(license).where(eq(license.id, licenseId))
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
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

test('DELETE /servers/:id returns 409 when child resources block deletion', async () => {
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

test('DELETE /servers/:id returns 503 when daemon cell registry is unavailable', async () => {
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
    actorType: 'user',
    actorId: userId,
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
      eq(grant.actorId, userId),
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

test('DELETE /servers/:id returns 500 when purge fails after row delete', async () => {
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
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  const { licenseId } = await createLicense(db, { organizationId })
  await db.insert(server).values({
    id: serverId,
    createdAt: now,
    updatedAt: now,
    organizationId,
    displayName: 'Purge Fail',
  })
  await db
    .update(license)
    .set({ serverId, updatedAt: now })
    .where(eq(license.id, licenseId))

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

    const [licenseRow] = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, licenseId))
      .limit(1)
    assertExists(licenseRow?.revokedAt)

    const remaining = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remaining.length, 0)
    assertEquals(registry.purgedIds.length, 0)
  } finally {
    await db.delete(license).where(eq(license.id, licenseId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
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

test('GET /servers/updates does not call listRequests on the cell', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry({ listRequestsThrows: true })
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-updates-batch-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Server Updates Batch Org' })
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
    actorType: 'user',
    actorId: userId,
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
      displayName: 'Updates Batch',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await attachDaemonStateToServer(db, serverId, {
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp-test',
    })
    const daemonState = buildServerDaemonState({
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp-test',
    })
    daemonState.projection = {
      agent: { commit: 'aaa', buildId: 'b1' },
      update: { status: 'updating', requestId: 'req-1', channel: 'trunk' },
    }
    await db.update(server).set({
      daemon: daemonState,
      updatedAt: new Date().toISOString(),
    }).where(eq(server.id, serverId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers/updates', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.ok, true)
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].serverId, serverId)
    assertEquals(body.servers[0].status, 'updating')
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
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

async function attachConnectedDaemonStatus(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<void> {
  await attachDaemonStateToServer(db, serverId, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp-test',
  })
  const daemonState = buildServerDaemonState({
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp-test',
  })
  const now = new Date().toISOString()
  daemonState.status = {
    connected: true,
    daemonStatus: 'online',
    lastSeenAt: now,
    connectedAt: now,
    disconnectedAt: null,
    statusChangedAt: now,
  }
  await db.update(server).set({
    daemon: daemonState,
    updatedAt: now,
  }).where(eq(server.id, serverId))
}

function assertServerStatusRecordShape(record: Record<string, unknown>): void {
  assertEquals(Object.keys(record).sort(), [...SERVER_STATUS_RECORD_KEYS].sort())
}

test('GET /servers returns Postgres data without calling getSnapshots', async () => {
  await withServerDeleteFixtures(async ({
    db,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const { app: listApp, secrets: listSecrets } = await createServerRoutesTestApp(
      db,
      registry,
    )

    await attachConnectedDaemonStatus(db, serverId)

    const cookie = await sessionCookie(db, listSecrets, userId)
    const res = await listApp.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].id, serverId)
    assertEquals(body.servers[0].connected, true)
    assertEquals(body.servers[0].geo, null)
    assertEquals(body.servers[0].os, null)
    assertEquals(body.servers[0].osDisplay, null)
    assertEquals(body.servers[0].osLogo, null)
  })
})

test('GET /servers includes os, osDisplay, and osLogo from metadata without caching them', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const existing = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    await db
      .update(server)
      .set({
        metadata: {
          ...(existing[0]?.metadata ?? {}),
          hostname: 'os-host',
          os: {
            family: 'linux',
            id: 'debian',
            version: '13',
            versionCodename: 'trixie',
            prettyName: 'Debian GNU/Linux 13 (trixie)',
          },
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(server.id, serverId))

    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    await attachConnectedDaemonStatus(db, serverId)

    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].os, {
      family: 'linux',
      id: 'debian',
      version: '13',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
    })
    assertEquals(body.servers[0].osDisplay, 'Debian 13 (Trixie)')
    assertEquals(body.servers[0].osLogo, 'debian')
    assertEquals(recordingCache.readModels, ['servers-list'])
    const cachedRows = recordingCache.store.values().next().value as
      | ServersListRow[]
      | undefined
    assertEquals(cachedRows?.[0] && 'os' in cachedRows[0], false)
  })
})

test('GET /servers/status returns Postgres data without calling getSnapshots', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const { app: statusApp, secrets: statusSecrets } = await createServerRoutesTestApp(
      db,
      registry,
    )

    await attachConnectedDaemonStatus(db, serverId)

    const cookie = await sessionCookie(db, statusSecrets, userId)
    const res = await statusApp.request('/servers/status', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    assertEquals(res.headers.get('Cache-Control'), 'private, max-age=5')
    const body = await res.json()
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].serverId, serverId)
    assertEquals(body.servers[0].connected, true)
    assertServerStatusRecordShape(body.servers[0])
  })
})

test('GET /servers/:id/status returns Postgres data without calling getSnapshots', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const { app: statusApp, secrets: statusSecrets } = await createServerRoutesTestApp(
      db,
      registry,
    )

    await attachConnectedDaemonStatus(db, serverId)

    const cookie = await sessionCookie(db, statusSecrets, userId)
    const res = await statusApp.request(`/servers/${serverId}/status`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    assertEquals(res.headers.get('Cache-Control'), 'private, max-age=5')
    const body = await res.json()
    assertEquals(body.serverId, serverId)
    assertEquals(body.connected, true)
    assertServerStatusRecordShape(body)
  })
})

test('GET /servers/:id/cell returns 403 for a non-admin session user', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/cell`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 403)
  })
})

test('GET /servers/:id/cell returns data for an admin user', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-cell-admin-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Server Cell Admin Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'admin' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      displayName: 'Cell Admin',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/cell`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.ok, true)
    assertEquals(body.snapshot.serverId, serverId)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('GET /servers uses only the approved servers-list read model cache helper', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    assertEquals(recordingCache.readModels, ['servers-list'])
    assertEquals(recordingCache.loadCallCount, 1)
    assertEquals(readDb.selectCallCount, 1)
  })
})

test('GET /servers — cached payload is list rows only (presence comes from primary db)', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    await attachConnectedDaemonStatus(db, serverId)

    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.servers.length, 1)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)
    assertEquals(recordingCache.readModels, ['servers-list'])
    assertEquals(readDb.selectCallCount, 1)

    const cachedRows = recordingCache.store.values().next().value!
    assertEquals(cachedRows.length, 1)
    assertEquals(cachedRows[0].id, serverId)
    assertEquals('connected' in cachedRows[0], false)
    assertEquals(body.servers[0].connected, true)
  })
})

test('GET /servers — empty visibleIds short-circuits before cache', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const readDb = createListRowsOnlyReadDb(db)
  const recordingCache = createRecordingQueryCache(readDb)
  const { app, secrets } = await createServerRoutesTestApp(db, registry, recordingCache)

  const email = `server-list-no-grant-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'No Grant Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      displayName: 'Hidden Server',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.servers, [])
    assertEquals(recordingCache.readModels.length, 0)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('GET /servers — differing visibleIds produce different cache keys', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    }

    const first = await app.request('/servers', { headers })
    assertEquals(first.status, 200)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)

    const now = new Date().toISOString()
    const [secondServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        displayName: 'Second Server',
      })
      .returning({ id: server.id })

    const second = await app.request('/servers', { headers })
    assertEquals(second.status, 200)
    const secondBody = await second.json()
    assertEquals(secondBody.servers.length, 2)
    assertEquals(recordingCache.store.size, 2)
    assertEquals(recordingCache.loadCallCount, 2)

    await db.delete(server).where(eq(server.id, secondServer!.id))
  })
})

test('GET /servers — presence reflects live data, not cached value', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    }

    const first = await app.request('/servers', { headers })
    assertEquals(first.status, 200)
    const firstBody = await first.json()
    assertEquals(firstBody.servers[0].connected, false)
    assertEquals(recordingCache.loadCallCount, 1)

    await attachConnectedDaemonStatus(db, serverId)

    const second = await app.request('/servers', { headers })
    assertEquals(second.status, 200)
    const secondBody = await second.json()
    assertEquals(secondBody.servers[0].connected, true)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)
  })
})

test('GET /servers does not return stale servers after organization grant revocation', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    }

    const first = await app.request('/servers', { headers })
    assertEquals(first.status, 200)
    const firstBody = await first.json()
    assertEquals(firstBody.servers.length, 1)
    assertEquals(firstBody.servers[0].id, serverId)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)

    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
      eq(grant.entityType, 'organization'),
    ))

    const second = await app.request('/servers', { headers })
    assertEquals(second.status, 200)
    const secondBody = await second.json()
    assertEquals(secondBody.servers, [])
    assertEquals(recordingCache.loadCallCount, 1)
  })
})
