import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  datacenter,
  grant,
  member,
  network,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerNetworkRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

test('POST /networks requires dockerNetworkName for kind=docker', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ displayName: 'Docker Net Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `docker-net-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const cookie = await sessionCookie(db, secrets, userId)
  const missing = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      options: {},
    }),
  })
  assertEquals(missing.status, 400)
  assertEquals((await missing.json()).error, 'docker_network_name_required')

  const created = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      options: { dockerNetworkName: '  turbopanel-shared  ' },
    }),
  })
  assertEquals(created.status, 200)
  const createdBody = await created.json() as { ok: true; id: string }
  assertEquals(createdBody.ok, true)

  await db.delete(network).where(eq(network.id, createdBody.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(member).where(eq(member.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /networks rejects datacenterId and serverId together', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ displayName: 'Net Test Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-test-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

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
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, displayName: 'DC1', createdAt: now, updatedAt: now })
    .returning({ id: datacenter.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, displayName: 'Host1', createdAt: now, updatedAt: now })
    .returning({ id: server.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'server',
      datacenterId: dc!.id,
      serverId: srv!.id,
    }),
  })

  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.error, 'network_single_scope_conflict')

  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(member).where(eq(member.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('GET /networks returns 403 for org member without organization:manage', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ displayName: 'Net List Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-list-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(member).values({ organizationId, userId })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/networks', {
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })

  assertEquals(res.status, 403)

  await db.delete(member).where(eq(member.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})
