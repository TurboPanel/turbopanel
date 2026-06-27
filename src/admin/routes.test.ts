import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import type { DaemonCell, DaemonCellRegistry } from '../daemon/cell/contracts.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../client/authn/crypto.ts'
import { createSession } from '../client/authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../client/authn/secrets.ts'
import { user } from '../lib/db/schema.ts'
import { eq } from 'drizzle-orm'
import { ADMIN_API_PREFIX } from '../surfaces.ts'
import { registerAdminRoutes } from './routes.ts'

const dbUrl = getDatabaseUrl()
const TEST_SECRET = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6'

function createMockCell(
  serverId: string,
  purgedIds: string[],
  failIds: Set<string>,
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
      if (failIds.has(serverId)) {
        throw new Error(`purge failed for ${serverId}`)
      }
      purgedIds.push(serverId)
    },
  }
}

function createTrackingRegistry(failIds: Set<string> = new Set()): {
  registry: DaemonCellRegistry
  purgedIds: string[]
} {
  const purgedIds: string[] = []
  const cells = new Map<string, DaemonCell>()

  const registry: DaemonCellRegistry = {
    getCell(serverId: string): DaemonCell {
      let cell = cells.get(serverId)
      if (!cell) {
        cell = createMockCell(serverId, purgedIds, failIds)
        cells.set(serverId, cell)
      }
      return cell
    },
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async (serverId: string) => {
      await registry.getCell(serverId).purge()
    },
  }

  return { registry, purgedIds }
}

async function createAdminTestApp(registry: DaemonCellRegistry) {
  const secretsConfig = parseSecretsEnv(TEST_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', createDenoDb())
    c.set('daemonCellRegistry', registry)
    return next()
  })
  registerAdminRoutes(app, {
    secrets,
    runtime: 'deno',
    devSurface: false,
  })
  return { app, secrets }
}

async function adminSessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function withRoleUser(
  role: 'admin' | 'superadmin',
  fn: (ctx: {
    app: Hono<AppEnv>
    cookie: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping admin route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `admin-cell-purge-${role}-${crypto.randomUUID()}@example.com`
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  const { registry } = createTrackingRegistry()
  const { app, secrets } = await createAdminTestApp(registry)
  const cookie = await adminSessionCookie(db, secrets, userId)

  try {
    await fn({ app, cookie })
  } finally {
    await db.delete(user).where(eq(user.id, userId))
  }
}

Deno.test('POST /api/admin/v1/cells/:serverId/purge returns 403 for admin role', async () => {
  await withRoleUser('admin', async ({ app, cookie }) => {
    const serverId = crypto.randomUUID()
    const res = await app.request(`${ADMIN_API_PREFIX}/cells/${serverId}/purge`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })

    assertEquals(res.status, 403)
  })
})

Deno.test('POST /api/admin/v1/cells/:serverId/purge purges a cell for superadmin', async () => {
  await withRoleUser('superadmin', async ({ app, cookie }) => {
    const serverId = crypto.randomUUID()
    const res = await app.request(`${ADMIN_API_PREFIX}/cells/${serverId}/purge`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body, { ok: true, serverId, purged: true })
  })
})

Deno.test('POST /api/admin/v1/cells/purge-batch returns 403 for admin role', async () => {
  await withRoleUser('admin', async ({ app, cookie }) => {
    const res = await app.request(`${ADMIN_API_PREFIX}/cells/purge-batch`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serverIds: [crypto.randomUUID()] }),
    })

    assertEquals(res.status, 403)
  })
})

Deno.test('POST /api/admin/v1/cells/purge-batch reports per-id results for superadmin', async () => {
  await withRoleUser('superadmin', async ({ app, cookie }) => {
    const okId = crypto.randomUUID()
    const failId = crypto.randomUUID()
    const failIds = new Set([failId])
    const { registry, purgedIds } = createTrackingRegistry(failIds)

    const secretsConfig = parseSecretsEnv(TEST_SECRET, undefined, 'deno')
    const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
    const batchApp = new Hono<AppEnv>()
    batchApp.use('*', (c, next) => {
      c.set('db', createDenoDb())
      c.set('daemonCellRegistry', registry)
      return next()
    })
    registerAdminRoutes(batchApp, {
      secrets,
      runtime: 'deno',
      devSurface: false,
    })

    const res = await batchApp.request(`${ADMIN_API_PREFIX}/cells/purge-batch`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serverIds: [okId, failId] }),
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.ok, true)
    assertEquals(body.results.length, 2)
    assertEquals(body.results[0], { serverId: okId, ok: true })
    assertEquals(body.results[1].serverId, failId)
    assertEquals(body.results[1].ok, false)
    assertEquals(typeof body.results[1].error, 'string')
    assertEquals(purgedIds, [okId])
  })
})
