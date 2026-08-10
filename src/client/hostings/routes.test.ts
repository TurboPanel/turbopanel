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
  environment,
  grant,
  hosting,
  ip,
  membership,
  organization,
  project,
  service,
  workspace,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerHostingRoutes } from './routes.ts'
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

test('PATCH /hostings rejects public bind with non-public ip scope', async () => {
  if (!dbUrl) {
    console.warn('Skipping hosting route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerHostingRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Hosting IP Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `host-ip-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, name: 'P', createdAt: now, updatedAt: now })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'E', createdAt: now, updatedAt: now })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })

  const [privateIp] = await db
    .insert(ip)
    .values({
      organizationId,
      address: '10.0.0.1',
      allocation: 'dedicated',
      scope: 'datacenter',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: ip.id })

  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      name: 'Site',
      options: { bind: 'public' },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/hostings/${host!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ipId: privateIp!.id }),
  })

  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.error, 'hosting_bind_scope_mismatch')

  await db.delete(hosting).where(eq(hosting.id, host!.id))
  await db.delete(ip).where(eq(ip.id, privateIp!.id))
  await db.delete(service).where(eq(service.id, svc!.id))
  await db.delete(environment).where(eq(environment.id, env!.id))
  await db.delete(project).where(eq(project.id, proj!.id))
  await db.delete(workspace).where(eq(workspace.id, ws!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('PATCH /hostings returns 404 when ipId belongs to another org', async () => {
  if (!dbUrl) return

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerHostingRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Host Org A' })
    .returning({ id: organization.id })
  const [orgB] = await db
    .insert(organization)
    .values({ name: 'Host Org B' })
    .returning({ id: organization.id })

  const [u] = await db
    .insert(user)
    .values({ email: `host-xorg-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId: orgA!.id, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId: orgA!.id, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, name: 'P', createdAt: now, updatedAt: now })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'E', createdAt: now, updatedAt: now })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })

  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      name: 'Site',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })

  const [foreignIp] = await db
    .insert(ip)
    .values({
      organizationId: orgB!.id,
      address: '203.0.113.55',
      allocation: 'dedicated',
      scope: 'public',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: ip.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/hostings/${host!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ipId: foreignIp!.id }),
  })

  assertEquals(res.status, 404)

  await db.delete(hosting).where(eq(hosting.id, host!.id))
  await db.delete(ip).where(eq(ip.id, foreignIp!.id))
  await db.delete(service).where(eq(service.id, svc!.id))
  await db.delete(environment).where(eq(environment.id, env!.id))
  await db.delete(project).where(eq(project.id, proj!.id))
  await db.delete(workspace).where(eq(workspace.id, ws!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
  await db.delete(organization).where(eq(organization.id, orgB!.id))
})
