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
    projectId: string
    environmentId: string
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
    .values({ name: 'Container Route Test Org' })
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

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Container Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Container Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Container Route Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Container Route Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [insertedService] = await db
    .insert(service)
    .values({
        environmentId,
        name: 'web',
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
      projectId,
      environmentId,
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
          role: 'ingress',
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
        role: string
        composeServiceName: string
        metadata: { note?: string; containerId?: string; role?: string }
      }
    }
    assertEquals(getBody.container.containerId, dockerId)
    assertEquals(getBody.container.containerName, 'web-1')
    assertEquals(getBody.container.status, 'running')
    assertEquals(getBody.container.role, 'service')
    assertEquals(getBody.container.composeServiceName, 'web')
    assertEquals(getBody.container.metadata.note, 'keep-me')
    assertEquals(getBody.container.metadata.containerId, undefined)
    assertEquals(getBody.container.metadata.role, undefined)

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

test('GET /containers?environmentId= returns only matching environment containers', async () => {
  await withContainerFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serviceId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const [otherEnv] = await db
      .insert(environment)
      .values({
        name: 'Other Env',
        projectId,
      })
      .returning({ id: environment.id })
    const otherEnvironmentId = otherEnv!.id

    const [otherService] = await db
      .insert(service)
      .values({
        name: 'api',
      composeServiceName: 'api',
        environmentId: otherEnvironmentId,
      })
      .returning({ id: service.id })
    const otherServiceId = otherService!.id

    try {
      const createMatching = await app.request('/containers', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serviceId,
          serverId,
          containerId: `ctr-match-${crypto.randomUUID()}`,
          containerName: 'web-1',
          status: 'running',
          composeServiceName: 'web',
        }),
      })
      assertEquals(createMatching.status, 200)
      const matching = await createMatching.json() as { ok: true; id: string }

      const createOther = await app.request('/containers', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serviceId: otherServiceId,
          serverId,
          containerId: `ctr-other-${crypto.randomUUID()}`,
          containerName: 'api-1',
          status: 'running',
          composeServiceName: 'api',
        }),
      })
      assertEquals(createOther.status, 200)

      const listRes = await app.request(
        `/containers?environmentId=${environmentId}`,
        {
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
          },
        },
      )
      assertEquals(listRes.status, 200)
      const listBody = await listRes.json() as {
        containers: Array<{ id: string; serviceId: string }>
      }
      assertEquals(listBody.containers.length, 1)
      assertEquals(listBody.containers[0]?.id, matching.id)
      assertEquals(listBody.containers[0]?.serviceId, serviceId)
    } finally {
      await db.delete(container).where(eq(container.serviceId, otherServiceId))
      await db.delete(service).where(eq(service.id, otherServiceId))
      await db.delete(environment).where(eq(environment.id, otherEnvironmentId))
    }
  })
})

test('GET /containers?environmentId= ANDs with status and serverId filters', async () => {
  await withContainerFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serviceId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const now = new Date().toISOString()

    const [otherServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Other Server',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    const otherServerId = otherServer!.id

    try {
      const createRunning = await app.request('/containers', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serviceId,
          serverId,
          containerId: `ctr-running-${crypto.randomUUID()}`,
          containerName: 'web-running',
          status: 'running',
          composeServiceName: 'web',
          ordinal: 1,
        }),
      })
      assertEquals(createRunning.status, 200)
      const running = await createRunning.json() as { ok: true; id: string }

      const createExited = await app.request('/containers', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serviceId,
          serverId,
          containerId: `ctr-exited-${crypto.randomUUID()}`,
          containerName: 'web-exited',
          status: 'exited',
          composeServiceName: 'web',
          ordinal: 2,
        }),
      })
      assertEquals(createExited.status, 200)

      const createOtherServer = await app.request('/containers', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serviceId,
          serverId: otherServerId,
          containerId: `ctr-other-srv-${crypto.randomUUID()}`,
          containerName: 'web-other-srv',
          status: 'running',
          composeServiceName: 'web',
          ordinal: 3,
        }),
      })
      assertEquals(createOtherServer.status, 200)

      const listRes = await app.request(
        `/containers?environmentId=${environmentId}&status=running&serverId=${serverId}`,
        {
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
          },
        },
      )
      assertEquals(listRes.status, 200)
      const listBody = await listRes.json() as {
        containers: Array<{ id: string; status: string; serverId: string }>
      }
      assertEquals(listBody.containers.length, 1)
      assertEquals(listBody.containers[0]?.id, running.id)
      assertEquals(listBody.containers[0]?.status, 'running')
      assertEquals(listBody.containers[0]?.serverId, serverId)
    } finally {
      await db.delete(container).where(eq(container.serverId, otherServerId))
      await db.delete(server).where(eq(server.id, otherServerId))
    }
  })
})

test('GET /containers?environmentId= does not leak containers the caller cannot see', async () => {
  await withContainerFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serviceId,
    serverId,
  }) => {
    const managerCookie = await sessionCookie(db, secrets, userId)

    const createRes = await app.request('/containers', {
      method: 'POST',
      headers: {
        Cookie: managerCookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceId,
        serverId,
        containerId: `ctr-hidden-${crypto.randomUUID()}`,
        containerName: 'web-hidden',
        status: 'running',
        composeServiceName: 'web',
      }),
    })
    assertEquals(createRes.status, 200)

    const [limitedUser] = await db
      .insert(user)
      .values({
        email: `ctr-limited-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      })
      .returning({ id: user.id })
    const limitedUserId = limitedUser!.id


    try {
      const limitedCookie = await sessionCookie(db, secrets, limitedUserId)
      const listRes = await app.request(
        `/containers?environmentId=${environmentId}`,
        {
          headers: {
            Cookie: limitedCookie,
            [ORG_ID_HEADER]: organizationId,
          },
        },
      )
      assertEquals(listRes.status, 200)
      const listBody = await listRes.json() as {
        containers: Array<{ id: string }>
      }
      assertEquals(listBody.containers.length, 0)
    } finally {
      await db.delete(user).where(eq(user.id, limitedUserId))
    }
  })
})
