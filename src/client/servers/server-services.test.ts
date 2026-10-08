import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  container,
  environment,
  grant,
  managed,
  organization,
  project,
  replica,
  server,
  service,
  team,
  teammate,
  user,
  workspace,
} from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerRoutes } from './routes.ts'
import type { ServerServicesResponse } from './server-services.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

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
  userId: string
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function createApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerServerRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, secrets }
}

async function withServicesFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serverId: string
    workspaceId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('server services route tests')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createApp(db)
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Services Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id
  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `server-services-${crypto.randomUUID()}@example.com`,
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
  const [insertedTeam] = await db
    .insert(team)
    .values({ name: 'Server Services Team', organizationId })
    .returning({ id: team.id })
  const teamId = insertedTeam!.id
  await db.insert(teammate).values({ teamId, userId })
  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Server Services Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id
  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Services Host',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, app, secrets, userId, organizationId, serverId, workspaceId })
  } finally {
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(replica).where(eq(replica.serverId, serverId))
    await db.delete(managed).where(eq(managed.serverId, serverId))
    const envs = await db
      .select({ id: environment.id, projectId: environment.projectId })
      .from(environment)
      .where(eq(environment.serverId, serverId))
    for (const env of envs) {
      await db.delete(service).where(eq(service.environmentId, env.id))
      await db.delete(environment).where(eq(environment.id, env.id))
      await db.delete(project).where(eq(project.id, env.projectId))
    }
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(teammate).where(and(eq(teammate.teamId, teamId), eq(teammate.userId, userId)))
    await db.delete(team).where(eq(team.id, teamId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

test('GET /servers/:id/services returns 404 for another organization server', async () => {
  await withServicesFixtures(async (ctx) => {
    const [otherOrg] = await ctx.db
      .insert(organization)
      .values({ name: 'Other Services Org' })
      .returning({ id: organization.id })
    const otherOrganizationId = otherOrg!.id
    const [otherServer] = await ctx.db
      .insert(server)
      .values({
        organizationId: otherOrganizationId,
        name: 'Other Host',
      })
      .returning({ id: server.id })
    try {
      const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
      const res = await ctx.app.request(`/servers/${otherServer!.id}/services`, {
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: ctx.organizationId,
        },
      })
      assertEquals(res.status, 404)
      assertEquals(await res.json(), { error: 'Not found' })
    } finally {
      await ctx.db.delete(server).where(eq(server.id, otherServer!.id))
      await ctx.db.delete(organization).where(eq(organization.id, otherOrganizationId))
    }
  })
})

test('GET /servers/:id/services returns an empty snapshot for a bare server', async () => {
  await withServicesFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const res = await ctx.app.request(`/servers/${ctx.serverId}/services`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: ctx.organizationId,
      },
    })
    assertEquals(res.status, 200)
    const body = (await res.json()) as ServerServicesResponse
    assertEquals(body, {
      serverId: ctx.serverId,
      removal: { canRemove: true, reasons: [] },
      apps: [],
      databases: [],
      databaseUsers: [],
      backups: [],
      networks: [],
      ipCount: 0,
      hostServices: [],
      runtimes: [],
    })
  })
})

test('GET /servers/:id/services lists a container app and a database replica', async () => {
  await withServicesFixtures(async (ctx) => {
    const [appProject] = await ctx.db
      .insert(project)
      .values({
        name: 'Shop',
        workspaceId: ctx.workspaceId,
        organizationId: ctx.organizationId,
      })
      .returning({ id: project.id })
    const [appEnv] = await ctx.db
      .insert(environment)
      .values({
        name: 'Production',
        projectId: appProject!.id,
        serverId: ctx.serverId,
      })
      .returning({ id: environment.id })
    const [web] = await ctx.db
      .insert(service)
      .values({
        name: 'web',
        environmentId: appEnv!.id,
        composeServiceName: 'web',
      })
      .returning({ id: service.id })
    await ctx.db.insert(container).values({
      serviceId: web!.id,
      serverId: ctx.serverId,
      containerName: 'shop-web-1',
      composeServiceName: 'web',
      status: 'running',
      role: 'service',
    })

    const [dbProject] = await ctx.db
      .insert(project)
      .values({
        name: 'Data',
        workspaceId: ctx.workspaceId,
        organizationId: ctx.organizationId,
        metadata: { type: 'managed' },
      })
      .returning({ id: project.id })
    const [dbEnv] = await ctx.db
      .insert(environment)
      .values({
        name: 'Production',
        projectId: dbProject!.id,
        serverId: ctx.serverId,
      })
      .returning({ id: environment.id })
    const [cluster] = await ctx.db
      .insert(managed)
      .values({
        environmentId: dbEnv!.id,
        serverId: ctx.serverId,
        name: 'App Data',
        engine: 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    await ctx.db.insert(replica).values({
      managedId: cluster!.id,
      serverId: ctx.serverId,
      role: 'primary',
      isReadEligible: false,
      ordinal: 1,
      status: 'ready',
    })

    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const res = await ctx.app.request(`/servers/${ctx.serverId}/services`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: ctx.organizationId,
      },
    })
    assertEquals(res.status, 200)
    const body = (await res.json()) as ServerServicesResponse
    assertEquals(body.serverId, ctx.serverId)
    assertEquals(body.removal.canRemove, false)
    assertEquals(body.removal.reasons, [
      {
        kind: 'container',
        count: 1,
        message: '1 container still runs here: stop or move the apps first',
      },
      {
        kind: 'environment',
        count: 2,
        message: 'Still on this server: an app environment (2)',
      },
      {
        kind: 'managed',
        count: 1,
        message: 'Still on this server: a managed database is still placed on this server',
      },
      {
        kind: 'replica',
        count: 1,
        message: 'Still on this server: a database member is still placed on this server',
      },
    ])
    assertEquals(body.apps, [
      {
        serviceId: web!.id,
        name: 'web',
        project: 'Shop',
        environment: 'Production',
        containers: [{ name: 'shop-web-1', status: 'running', role: 'service' }],
        domains: [],
      },
    ])
    assertEquals(body.databases, [
      {
        managedId: cluster!.id,
        name: 'App Data',
        engine: 'postgres',
        role: 'primary',
        status: 'ready',
        readEligible: false,
        ordinal: 1,
      },
    ])
    assertEquals(body.databaseUsers, [])
    assertEquals(body.backups, [])
    assertEquals(body.hostServices, [])
    assertEquals(body.runtimes, [])
  })
})
