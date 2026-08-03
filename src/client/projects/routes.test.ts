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
  server,
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

test('POST /projects empty scaffolds Production once without type', async () => {
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
        type: 'empty',
        workspaceId,
        displayName: 'Empty Project',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)

    const [projectRow] = await db
      .select({ metadata: project.metadata, options: project.options })
      .from(project)
      .where(eq(project.id, body.id))
      .limit(1)
    assertEquals(projectRow?.metadata, null)
    assertEquals(projectRow?.options, null)

    const envs = await db
      .select({ displayName: environment.displayName })
      .from(environment)
      .where(eq(environment.projectId, body.id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.displayName, 'Production')
  })
})

test('POST /projects empty uses org defaultEnvironmentName when set', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        displayName: 'Custom Env Project',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)

    const envs = await db
      .select({ displayName: environment.displayName })
      .from(environment)
      .where(eq(environment.projectId, body.id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.displayName, 'Staging')
  })
})

test('POST /projects docker-compose uses org defaultEnvironmentName when set', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Live' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'docker-compose',
        workspaceId,
        displayName: 'Compose Custom Env',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }

    const envs = await db
      .select({ displayName: environment.displayName })
      .from(environment)
      .where(eq(environment.projectId, body.id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.displayName, 'Live')
  })
})

test('POST /projects/:id/configure reuses custom-named default environment', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        displayName: 'Configure Custom Env',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'docker-compose' }),
    })
    assertEquals(configureRes.status, 200)

    const envs = await db
      .select({ displayName: environment.displayName })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.displayName, 'Staging')
  })
})

test('POST /projects/:id/configure reuses scaffolded env when org default changed', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        displayName: 'Stale Default Project',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const [scaffolded] = await db
      .select({
        id: environment.id,
        displayName: environment.displayName,
      })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(scaffolded?.displayName, 'Staging')

    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Live' } })
      .where(eq(organization.id, organizationId))

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(configureRes.status, 200)

    const envs = await db
      .select({
        id: environment.id,
        displayName: environment.displayName,
      })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.id, scaffolded!.id)
    assertEquals(envs[0]!.displayName, 'Staging')

    const [projectRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)
    assertEquals(projectRow?.metadata, { type: 'managed', code: 'postgres' })

    const vars = await db
      .select({ key: variable.key })
      .from(variable)
      .where(eq(variable.environmentId, scaffolded!.id))
    assertEquals(vars.map((row) => row.key), ['POSTGRES_PASSWORD'])
  })
})

test('POST /projects/:id/configure prefers literal Production over org default match', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        displayName: 'Both Envs Project',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    await db.insert(environment).values({
      projectId: id,
      displayName: 'Staging',
      description: 'Custom default sibling',
    })

    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(configureRes.status, 200)

    const envs = await db
      .select({
        id: environment.id,
        displayName: environment.displayName,
        description: environment.description,
      })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 2)

    const production = envs.find((row) => row.displayName === 'Production')
    const staging = envs.find((row) => row.displayName === 'Staging')
    assertEquals(production != null, true)
    assertEquals(staging != null, true)
    assertEquals(staging!.description, 'Custom default sibling')

    const productionVars = await db
      .select({ key: variable.key })
      .from(variable)
      .where(eq(variable.environmentId, production!.id))
    assertEquals(productionVars.map((row) => row.key), ['POSTGRES_PASSWORD'])

    const stagingVars = await db
      .select({ key: variable.key })
      .from(variable)
      .where(eq(variable.environmentId, staging!.id))
    assertEquals(stagingVars.length, 0)
  })
})

test('POST /projects/:id/configure pins serverId on existing default environment', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        displayName: 'Pin Server On Configure',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const [before] = await db
      .select({ serverId: environment.serverId })
      .from(environment)
      .where(eq(environment.projectId, id))
      .limit(1)
    assertEquals(before?.serverId ?? null, null)

    const now = new Date().toISOString()
    const [insertedServer] = await db
      .insert(server)
      .values({
        organizationId,
        displayName: 'Configure Pin Server',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    const serverId = insertedServer!.id

    try {
      const configureRes = await app.request(`/projects/${id}/configure`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'docker-compose',
          serverId,
        }),
      })
      assertEquals(configureRes.status, 200)

      const [after] = await db
        .select({
          displayName: environment.displayName,
          serverId: environment.serverId,
        })
        .from(environment)
        .where(eq(environment.projectId, id))
        .limit(1)
      assertEquals(after?.displayName, 'Production')
      assertEquals(after?.serverId, serverId)
    } finally {
      await db
        .update(environment)
        .set({ serverId: null })
        .where(eq(environment.projectId, id))
      await db.delete(server).where(eq(server.id, serverId))
    }
  })
})

test('POST /projects/:id/configure sets docker-compose idempotently', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        displayName: 'Configure Me',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'docker-compose' }),
    })
    assertEquals(configureRes.status, 200)
    assertEquals(await configureRes.json(), {
      ok: true,
      alreadyConfigured: false,
    })

    const [after] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)
    const metadata = after?.metadata as { type?: string } | null
    assertEquals(metadata?.type, 'docker-compose')

    const again = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'docker-compose' }),
    })
    assertEquals(again.status, 200)
    assertEquals(await again.json(), { ok: true, alreadyConfigured: true })

    const conflict = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(conflict.status, 409)

    const envs = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
  })
})

test('POST /projects/:id/configure managed postgres reuses Production', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        displayName: 'Managed Later',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(configureRes.status, 200)

    const [projectRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)
    const metadata = projectRow?.metadata as {
      type?: string
      code?: string
    } | null
    assertEquals(metadata?.type, 'managed')
    assertEquals(metadata?.code, 'postgres')

    const envs = await db
      .select({ id: environment.id, displayName: environment.displayName })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.displayName, 'Production')

    const managedForEnv = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, envs[0]!.id))
    assertEquals(managedForEnv.length, 0)
  })
})
