import { assertEquals } from 'jsr:@std/assert'
import { and, eq, sql } from 'drizzle-orm'
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
  grant,
  member,
  organization,
  principal,
  project,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { DEFAULT_PRINCIPAL_SHELL } from '../../lib/principal-options.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerProjectPrincipalRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createPrincipalRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerProjectPrincipalRoutes(app, { secrets, runtime: 'deno' })
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

async function withPrincipalFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    projectId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping principal route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createPrincipalRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Principal Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `principal-route-${crypto.randomUUID()}@example.com`,
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
    .values({ displayName: 'Principal Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Principal Route Project',
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
    })
  } finally {
    await db.delete(principal).where(eq(principal.projectId, projectId))
    await db.delete(project).where(eq(project.id, projectId))
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

test('POST /projects/:projectId/principals persists default shell when options omitted', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const seqRows = (await db.execute(sql`
      SELECT 1 AS ok
      FROM pg_class
      WHERE relname = 'principal_uid_seq' AND relkind = 'S'
    `)) as unknown as Array<{ ok: number }>
    if (seqRows.length === 0) {
      console.warn(
        'Skipping default-shell persist test: principal_uid_seq not applied',
      )
      return
    }

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'appuser' }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)

    const [row] = await db
      .select({ options: principal.options })
      .from(principal)
      .where(eq(principal.id, body.id))
      .limit(1)
    assertEquals(row?.options, { shell: DEFAULT_PRINCIPAL_SHELL })
  })
})

test('POST /projects/:projectId/principals rejects invalid shell', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'appuser', options: { shell: 'bash' } }),
    })

    assertEquals(res.status, 400)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'Invalid request')
  })
})

test('POST /projects/:projectId/principals rejects non-object options', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'appuser', options: 'nologin' }),
    })

    assertEquals(res.status, 400)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'Invalid request')
  })
})
