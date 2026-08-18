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
  environment,
  grant,
  organization,
  project,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServiceRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createServiceRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerServiceRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
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

async function withServiceFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    environmentId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping service route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createServiceRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Service Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `svc-route-${crypto.randomUUID()}@example.com`,
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
    .values({ name: 'Service Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Service Route Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Service Route Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      environmentId,
    })
  } finally {
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /services rejects a composeServiceName in the body with 400', async () => {
  await withServiceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const createRes = await app.request('/services', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        environmentId,
        displayName: 'web',
        composeServiceName: 'web',
      }),
    })
    assertEquals(createRes.status, 400)
    const body = await createRes.json() as { error: string }
    assertEquals(body.error, 'compose_service_name_read_only')
  })
})

test('POST /services is not supported even without composeServiceName in the body', async () => {
  await withServiceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const createRes = await app.request('/services', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ environmentId, displayName: 'web' }),
    })
    assertEquals(createRes.status, 400)
    const body = await createRes.json() as { error: string }
    assertEquals(body.error, 'service_create_not_supported')
  })
})

test('PATCH /services/:id rejects a composeServiceName in the body and leaves the stored value unchanged', async () => {
  await withServiceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const [inserted] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'web',
        composeServiceName: 'web',
      })
      .returning({ id: service.id })
    const id = inserted!.id

    const patchRes = await app.request(`/services/${id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ composeServiceName: 'api' }),
    })
    assertEquals(patchRes.status, 400)
    const body = await patchRes.json() as { error: string }
    assertEquals(body.error, 'compose_service_name_read_only')

    const [stored] = await db
      .select({ composeServiceName: service.composeServiceName })
      .from(service)
      .where(eq(service.id, id))
      .limit(1)
    assertEquals(stored?.composeServiceName, 'web')
  })
})

test('PATCH /services/:id still strips metadata.composeServiceName without rejecting the request', async () => {
  await withServiceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const [inserted] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'web',
        composeServiceName: 'web',
      })
      .returning({ id: service.id })
    const id = inserted!.id

    const patchRes = await app.request(`/services/${id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: { note: 'patched', composeServiceName: 'ignored' },
      }),
    })
    assertEquals(patchRes.status, 200)

    const [stored] = await db
      .select({
        composeServiceName: service.composeServiceName,
        metadata: service.metadata,
      })
      .from(service)
      .where(eq(service.id, id))
      .limit(1)
    assertEquals(stored?.composeServiceName, 'web')
    assertEquals(stored?.metadata, { note: 'patched' })
  })
})
