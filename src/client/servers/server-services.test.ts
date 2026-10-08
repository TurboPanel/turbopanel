import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  backup,
  binding,
  container,
  environment,
  grant,
  managed,
  network,
  organization,
  principal,
  project,
  replica,
  server,
  service,
  team,
  teammate,
  user,
  workspace,
} from '../../db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../db/workspace-kind.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerRoutes } from './routes.ts'
import { SERVER_SERVICES_LIST_CAP, type ServerServicesResponse } from './server-services.ts'
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
    const pinnedEnvs = await db
      .select({ id: environment.id, projectId: environment.projectId })
      .from(environment)
      .where(eq(environment.serverId, serverId))
    const containerEnvs = await db
      .select({ id: environment.id, projectId: environment.projectId })
      .from(container)
      .innerJoin(service, eq(service.id, container.serviceId))
      .innerJoin(environment, eq(environment.id, service.environmentId))
      .where(eq(container.serverId, serverId))
    const envById = new Map<string, string>()
    for (const env of [...pinnedEnvs, ...containerEnvs]) {
      envById.set(env.id, env.projectId)
    }
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(replica).where(eq(replica.serverId, serverId))
    await db.delete(network).where(eq(network.serverId, serverId))
    const envIds = [...envById.keys()]
    if (envIds.length > 0) {
      const services = await db
        .select({ id: service.id })
        .from(service)
        .where(inArray(service.environmentId, envIds))
      const serviceIds = services.map((row) => row.id)
      if (serviceIds.length > 0) {
        await db.delete(binding).where(inArray(binding.serviceId, serviceIds))
        await db.delete(service).where(inArray(service.id, serviceIds))
      }
      const managedRows = await db
        .select({ id: managed.id })
        .from(managed)
        .where(inArray(managed.environmentId, envIds))
      const managedIds = managedRows.map((row) => row.id)
      if (managedIds.length > 0) {
        await db.delete(backup).where(inArray(backup.managedId, managedIds))
        await db.delete(principal).where(inArray(principal.managedId, managedIds))
        await db.delete(managed).where(inArray(managed.id, managedIds))
      }
      await db.delete(environment).where(inArray(environment.id, envIds))
      const projectIds = [...new Set(envById.values())]
      for (const projectId of projectIds) {
        await db.delete(project).where(eq(project.id, projectId))
      }
    }
    await db.delete(managed).where(eq(managed.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
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
      removal: { canRemove: true, online: false, canForget: true, reasons: [] },
      apps: { items: [], more: 0 },
      databases: [],
      databaseUsers: { items: [], more: 0 },
      backups: { items: [], more: 0 },
      networks: { items: [], more: 0 },
      ipCount: 0,
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
    assertEquals(body.removal.online, false)
    assertEquals(body.removal.canForget, false)
    assertEquals(body.removal.reasons, [
      {
        kind: 'container',
        count: 1,
        message: 'One container is still on this server: stop or move the apps first.',
      },
      {
        kind: 'environment',
        count: 2,
        message: '2 app environments are still placed on this server.',
      },
      {
        kind: 'managed',
        count: 1,
        message: 'Database "App Data" has its only copy on this server. Delete the database first.',
      },
    ])
    assertEquals(body.apps, {
      items: [
        {
          serviceId: web!.id,
          name: 'web',
          project: 'Shop',
          environment: 'Production',
          containers: {
            items: [{ name: 'shop-web-1', status: 'running', role: 'service' }],
            more: 0,
          },
          domains: { items: [], more: 0 },
        },
      ],
      more: 0,
    })
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
    assertEquals(body.databaseUsers, { items: [], more: 0 })
    assertEquals(body.backups, { items: [], more: 0 })
    assertEquals(body.runtimes, [])
  })
})

test('GET /servers/:id/services omits system-workspace apps and databases', async () => {
  await withServicesFixtures(async (ctx) => {
    const [sysWorkspace] = await ctx.db
      .insert(workspace)
      .values({
        name: 'TurboPanel',
        organizationId: ctx.organizationId,
        kind: WORKSPACE_KIND_TURBOPANEL,
      })
      .returning({ id: workspace.id })
    const [sysProject] = await ctx.db
      .insert(project)
      .values({
        name: 'System',
        workspaceId: sysWorkspace!.id,
        organizationId: ctx.organizationId,
      })
      .returning({ id: project.id })
    const [sysEnv] = await ctx.db
      .insert(environment)
      .values({
        name: 'Production',
        projectId: sysProject!.id,
        serverId: ctx.serverId,
      })
      .returning({ id: environment.id })
    const [sysService] = await ctx.db
      .insert(service)
      .values({
        name: 'proxysql',
        environmentId: sysEnv!.id,
        composeServiceName: 'proxysql',
      })
      .returning({ id: service.id })
    await ctx.db.insert(container).values({
      serviceId: sysService!.id,
      serverId: ctx.serverId,
      containerName: 'system-proxysql-1',
      composeServiceName: 'proxysql',
      status: 'running',
      role: 'ingress',
    })
    const [sysManaged] = await ctx.db
      .insert(managed)
      .values({
        environmentId: sysEnv!.id,
        serverId: ctx.serverId,
        name: 'System Data',
        engine: 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    await ctx.db.insert(replica).values({
      managedId: sysManaged!.id,
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
    assertEquals(body.apps, { items: [], more: 0 })
    assertEquals(body.databases, [])
    assertEquals(body.removal.canRemove, true)
    assertEquals(body.removal.reasons, [])
  })
})

test('GET /servers/:id/services groups two database bindings on one app', async () => {
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
    const suffix = crypto.randomUUID().slice(0, 8)
    const [shopUser] = await ctx.db
      .insert(principal)
      .values({
        organizationId: ctx.organizationId,
        kind: 'database',
        provider: 'postgres',
        username: `shop_${suffix}`,
        appliedUsername: `shop_${suffix}`,
        managedId: cluster!.id,
      })
      .returning({ id: principal.id })
    const [ordersUser] = await ctx.db
      .insert(principal)
      .values({
        organizationId: ctx.organizationId,
        kind: 'database',
        provider: 'postgres',
        username: `orders_${suffix}`,
        appliedUsername: `orders_${suffix}`,
        managedId: cluster!.id,
      })
      .returning({ id: principal.id })
    await ctx.db.insert(binding).values({
      principalId: shopUser!.id,
      serviceId: web!.id,
      databaseName: 'appdb',
      keyPrefix: 'DATABASE',
      isEmitEngineDefaults: true,
    })
    await ctx.db.insert(binding).values({
      principalId: ordersUser!.id,
      serviceId: web!.id,
      databaseName: 'orders',
      keyPrefix: 'ORDERS',
      isEmitEngineDefaults: false,
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
    assertEquals(body.databaseUsers, {
      items: [
        {
          serviceId: web!.id,
          serviceName: 'web',
          databases: ['appdb', 'orders'],
        },
      ],
      more: 0,
    })
  })
})

test('GET /servers/:id/services caps networks and offers Host is gone when the host is offline', async () => {
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
      status: 'exited',
      role: 'service',
    })
    const now = new Date().toISOString()
    await ctx.db.insert(network).values(
      Array.from({ length: SERVER_SERVICES_LIST_CAP + 1 }, (_, i) => ({
        createdAt: now,
        updatedAt: now,
        organizationId: ctx.organizationId,
        serverId: ctx.serverId,
        kind: 'docker' as const,
        name: `leftover-net-${String(i).padStart(2, '0')}`,
        options: { dockerNetworkName: `leftover-net-${String(i).padStart(2, '0')}` },
      }))
    )

    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const res = await ctx.app.request(`/servers/${ctx.serverId}/services`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: ctx.organizationId,
      },
    })
    assertEquals(res.status, 200)
    const body = (await res.json()) as ServerServicesResponse
    assertEquals(body.networks.items.length, SERVER_SERVICES_LIST_CAP)
    assertEquals(body.networks.more, 1)
    assertEquals(body.removal.online, false)
    assertEquals(body.removal.canForget, true)
    assertEquals(body.removal.reasons[0], {
      kind: 'network',
      count: SERVER_SERVICES_LIST_CAP + 1,
      message: `${SERVER_SERVICES_LIST_CAP + 1} networks are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.`,
    })
    assertEquals(
      body.removal.reasons.some(
        (reason) =>
          reason.kind === 'container' && reason.message.includes('Delete server → Host is gone')
      ),
      true
    )
  })
})
