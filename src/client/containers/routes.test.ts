import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
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
  container,
  environment,
  grant,
  member,
  organization,
  project,
  server,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerContainerRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createContainerRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerContainerRoutes(app, { secrets, runtime: 'deno' })
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

async function withContainerFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serviceId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping container route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createContainerRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Container Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `ctr-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
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

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Container Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Container Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Container Route Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Container Route Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [insertedService] = await db
    .insert(service)
    .values({
      displayName: 'web',
      environmentId,
      composeServiceName: 'web',
    })
    .returning({ id: service.id })
  const serviceId = insertedService!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serviceId,
      serverId,
    })
  } finally {
    await db.delete(container).where(eq(container.serviceId, serviceId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST/PATCH /containers strip promoted keys from stored JSONB', async () => {
  await withContainerFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serviceId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const dockerId = `ctr-${crypto.randomUUID()}`

    const createRes = await app.request('/containers', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceId,
        serverId,
        containerId: dockerId,
        containerName: 'web-1',
        status: 'running',
        composeServiceName: 'web',
        metadata: {
          note: 'keep-me',
          containerId: 'should-not-persist',
        },
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { ok: true; id: string }

    const [storedAfterCreate] = await db
      .select({
        containerId: container.containerId,
        containerName: container.containerName,
        status: container.status,
        composeServiceName: container.composeServiceName,
        metadata: container.metadata,
      })
      .from(container)
      .where(eq(container.id, id))
      .limit(1)
    assertEquals(storedAfterCreate?.containerId, dockerId)
    assertEquals(storedAfterCreate?.containerName, 'web-1')
    assertEquals(storedAfterCreate?.status, 'running')
    assertEquals(storedAfterCreate?.composeServiceName, 'web')
    assertEquals(storedAfterCreate?.metadata, { note: 'keep-me' })

    const getRes = await app.request(`/containers/${id}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(getRes.status, 200)
    const getBody = await getRes.json() as {
      container: {
        containerId: string
        containerName: string
        status: string
        composeServiceName: string
        metadata: { note?: string; containerId?: string }
      }
    }
    assertEquals(getBody.container.containerId, dockerId)
    assertEquals(getBody.container.containerName, 'web-1')
    assertEquals(getBody.container.status, 'running')
    assertEquals(getBody.container.composeServiceName, 'web')
    assertEquals(getBody.container.metadata.note, 'keep-me')
    assertEquals(getBody.container.metadata.containerId, undefined)

    const patchRes = await app.request(`/containers/${id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'exited',
        metadata: {
          note: 'patched',
          status: 'should-not-persist',
        },
      }),
    })
    assertEquals(patchRes.status, 200)

    const [storedAfterPatch] = await db
      .select({
        status: container.status,
        metadata: container.metadata,
      })
      .from(container)
      .where(eq(container.id, id))
      .limit(1)
    assertEquals(storedAfterPatch?.status, 'exited')
    assertEquals(storedAfterPatch?.metadata, { note: 'patched' })
  })
})
