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
  member,
  organization,
  project,
  server,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerEnvironmentRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createEnvironmentRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerEnvironmentRoutes(app, { secrets, runtime: 'deno' })
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

async function withEnvironmentFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    projectId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping environment route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createEnvironmentRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Environment Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `env-route-${crypto.randomUUID()}@example.com`,
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
    .values({ displayName: 'Environment Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Environment Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Environment Route Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      serverId,
    })
  } finally {
    await db.delete(environment).where(eq(environment.projectId, projectId))
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

test('POST/PATCH /environments strip metadata.serverId from stored JSONB', async () => {
  await withEnvironmentFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const createRes = await app.request('/environments', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        displayName: 'Env Metadata Strip',
        serverId,
        metadata: { serverId, note: 'keep-me' },
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { ok: true; id: string }

    const [storedAfterCreate] = await db
      .select({
        serverId: environment.serverId,
        metadata: environment.metadata,
      })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)
    assertEquals(storedAfterCreate?.serverId, serverId)
    assertEquals(storedAfterCreate?.metadata, { note: 'keep-me' })

    const getRes = await app.request(`/environments/${id}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(getRes.status, 200)
    const getBody = await getRes.json() as {
      environment: {
        serverId: string
        metadata: { serverId?: string; note?: string }
      }
    }
    assertEquals(getBody.environment.serverId, serverId)
    // `serverId` lives only on the dedicated column — the serialized
    // response never mirrors it back into `metadata`.
    assertEquals(getBody.environment.metadata.serverId, undefined)
    assertEquals(getBody.environment.metadata.note, 'keep-me')

    const patchRes = await app.request(`/environments/${id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: { serverId: crypto.randomUUID(), note: 'patched' },
      }),
    })
    assertEquals(patchRes.status, 200)

    const [storedAfterPatch] = await db
      .select({
        serverId: environment.serverId,
        metadata: environment.metadata,
      })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)
    assertEquals(storedAfterPatch?.serverId, serverId)
    assertEquals(storedAfterPatch?.metadata, { note: 'patched' })
  })
})
