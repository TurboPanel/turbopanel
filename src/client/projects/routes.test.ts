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
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import {
  environment,
  grant,
  managed,
  member,
  organization,
  project,
  service,
  user,
  variable,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerProjectRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createProjectRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerProjectRoutes(app, { secrets, runtime: 'deno' })
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

async function withProjectFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    workspaceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping project route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createProjectRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Project Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `project-route-${crypto.randomUUID()}@example.com`,
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
    .values({ displayName: 'Project Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      workspaceId,
    })
  } finally {
    const leftover = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.workspaceId, workspaceId))
    for (const row of leftover) {
      const envRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.projectId, row.id))
      for (const env of envRows) {
        await db.delete(variable).where(eq(variable.environmentId, env.id))
      }
      await db.delete(variable).where(eq(variable.projectId, row.id))
      for (const env of envRows) {
        await db.delete(managed).where(eq(managed.environmentId, env.id))
        await db.delete(service).where(eq(service.environmentId, env.id))
      }
      await db.delete(environment).where(eq(environment.projectId, row.id))
      await db.delete(project).where(eq(project.id, row.id))
    }
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

test('POST /projects managed postgres scaffolds env without managed row', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'managed',
        code: 'postgres',
        workspaceId,
        displayName: 'Managed Postgres',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)
    const projectId = body.id

    const [projectRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
    const metadata = projectRow?.metadata as {
      type?: string
      code?: string
    } | null
    assertEquals(metadata?.type, 'managed')
    assertEquals(metadata?.code, 'postgres')

    const envs = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, projectId))
    assertEquals(envs.length, 1)

    const managedForEnv = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, envs[0]!.id))
    assertEquals(managedForEnv.length, 0)

    const vars = await db
      .select({ value: variable.value, isSecret: variable.isSecret })
      .from(variable)
      .where(eq(variable.environmentId, envs[0]!.id))
    assertEquals(vars.length, 1)
    assertEquals(vars[0]!.isSecret, true)
    assertEquals(vars[0]!.value?.startsWith('enc.'), true)
  })
})

test('POST /projects managed rejects unknown catalog code', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'managed',
        code: 'nope',
        workspaceId,
        displayName: 'Unknown',
      }),
    })

    assertEquals(res.status, 400)
    assertEquals(await res.json(), { error: 'Unknown catalog code' })
  })
})
