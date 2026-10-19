/**
 * Fixtures for the suites that drive Organization CA leaf tracking: an
 * organization with a manager session, two Organization CA generations, and
 * helpers that add servers and leaf rows. The leaf routes are mounted on one
 * app. Needs a database.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { createSession } from '../client/authn/session-store.ts'
import { ORG_ID_HEADER } from '../client/org-context.ts'
import { registerTlsLeafRoutes } from '../client/tls/leaf-routes.ts'
import type { LeafRenewalSweepDeps } from '../client/tls/leaf-renewal-sweep.ts'
import { createDenoDb } from '../db/connection.ts'
import { getDatabaseUrl } from '../db/url.ts'
import { audit, changeover, grant, leaf, organization, server, tls, user } from '../db/schema.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from './secrets.ts'
import { skipWithoutDatabase } from './require-service.test.support.ts'

const dbUrl = getDatabaseUrl()

export type Db = ReturnType<typeof createDenoDb>

export type LeafWorld = {
  db: Db
  app: Hono<AppEnv>
  cookie: string
  userId: string
  organizationId: string
  /** Generation 2 is the active Organization CA, generation 1 the retired one. */
  activeCaId: string
  retiredCaId: string
  deps: LeafRenewalSweepDeps
  addServer: (options?: {
    name?: string
    connected?: boolean
    statusChangedAt?: string | null
  }) => Promise<string>
  addIngressLeaf: (
    serverId: string,
    options?: { generation?: number; notAfter?: string }
  ) => Promise<string>
  addRotation: (state: string, options?: { retireBy?: string | null }) => Promise<string>
  request: (method: string, path: string, body?: unknown, orgId?: string) => Promise<Response>
}

let fingerprintCounter = 0

async function insertCa(
  db: Db,
  organizationId: string,
  generation: number,
  state: 'active' | 'retired'
): Promise<string> {
  fingerprintCounter += 1
  const [row] = await db
    .insert(tls)
    .values({
      organizationId,
      name: 'Organization CA',
      source: 'organization_ca',
      status: 'managed',
      caState: state,
      caGeneration: generation,
      fingerprintSha256: `${generation}-${fingerprintCounter}-${crypto.randomUUID()}`,
      notAfter: new Date(Date.now() + 10 * 365 * 86_400_000).toISOString(),
    })
    .returning({ id: tls.id })
  return row!.id
}

export async function withLeafWorld(fn: (world: LeafWorld) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('Organization CA leaf tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerTlsLeafRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const [org] = await db
    .insert(organization)
    .values({ name: 'Leaf Test Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [account] = await db
    .insert(user)
    .values({
      email: `leaf-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = account!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })
  const { token } = await createSession(db, userId, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const retiredCaId = await insertCa(db, organizationId, 1, 'retired')
  const activeCaId = await insertCa(db, organizationId, 2, 'active')
  const serverIds: string[] = []

  const world: LeafWorld = {
    db,
    app,
    cookie,
    userId,
    organizationId,
    activeCaId,
    retiredCaId,
    deps: { secretsConfig, dataEncryptionSecrets },
    addServer: async (options = {}) => {
      const now = new Date().toISOString()
      const [row] = await db
        .insert(server)
        .values({
          organizationId,
          name: options.name ?? 'Alpha',
          isConnected: options.connected ?? true,
          statusChangedAt: options.statusChangedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: server.id })
      serverIds.push(row!.id)
      return row!.id
    },
    addIngressLeaf: async (serverId, options = {}) => {
      const generation = options.generation ?? 1
      const [row] = await db
        .insert(leaf)
        .values({
          organizationId,
          serverId,
          kind: 'ingress',
          caId: generation === 2 ? activeCaId : retiredCaId,
          caGeneration: generation,
          notAfter: options.notAfter ?? new Date(Date.now() + 60 * 86_400_000).toISOString(),
        })
        .returning({ id: leaf.id })
      return row!.id
    },
    addRotation: async (state, options = {}) => {
      const [row] = await db
        .insert(changeover)
        .values({
          organizationId,
          state,
          fromCaGeneration: 1,
          toCaGeneration: 2,
          results: [],
          retireBy: options.retireBy ?? null,
        })
        .returning({ id: changeover.id })
      return row!.id
    },
    request: (method, path, body, orgId) =>
      Promise.resolve(
        app.request(path, {
          method,
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: orgId ?? organizationId,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      ),
  }

  try {
    await fn(world)
  } finally {
    await db.delete(audit).where(eq(audit.organizationId, organizationId))
    await db.delete(changeover).where(eq(changeover.organizationId, organizationId))
    await db.delete(leaf).where(eq(leaf.organizationId, organizationId))
    await db.delete(tls).where(eq(tls.organizationId, organizationId))
    if (serverIds.length > 0) await db.delete(server).where(inArray(server.id, serverIds))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}
