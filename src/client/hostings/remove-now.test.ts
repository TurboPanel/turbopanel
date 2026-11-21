import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, type Db, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import {
  audit,
  carrier,
  deployment,
  doorway,
  environment,
  grant,
  hosting,
  hostname,
  organization,
  project,
  server,
  service,
  tunnel,
  user,
  workspace,
} from '../../db/schema.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { DeployRequestAuth } from '../environments/deploy-routes.ts'
import type { HostingApplyDeps } from './letsencrypt-apply.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerHostingRoutes } from './routes.ts'
import { registerHostingRemoveNowRoute } from './remove-now-route.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()
const test = Deno.test.bind(Deno)

const NAME = 'shop.example.net'
const LIVE_QUEUE = { send: () => Promise.resolve() } as unknown as CommandQueue

type DeployCall = { environmentId: string; auth: DeployRequestAuth }

type Fixture = {
  db: Db
  organizationId: string
  userId: string
  /** Two environments of one organization, each with a service. */
  first: { environmentId: string; serviceId: string }
  second: { environmentId: string; serviceId: string }
  calls: DeployCall[]
  call: (method: string, path: string, body?: unknown) => Promise<Response>
  cleanup: () => Promise<void>
}

async function setup(): Promise<Fixture> {
  const db = createDenoDb()
  const calls: DeployCall[] = []
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  const applyDeps: HostingApplyDeps = {
    commandQueue: LIVE_QUEUE,
    // Stands in for the deploy pipeline: records the call and marks the deployment queued.
    runDeploy: async (_c, _db, _queue, environmentId, auth) => {
      calls.push({ environmentId, auth })
      await db
        .update(deployment)
        .set({ status: 'pending', updatedAt: new Date().toISOString() })
        .where(eq(deployment.environmentId, environmentId))
      return Response.json({ commandId: crypto.randomUUID() })
    },
  }
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const routeOpts = { secrets, runtime: 'deno' as const, signupEnvOverride: undefined }
  registerHostingRemoveNowRoute(app, routeOpts, { applyDeps: () => applyDeps })
  registerHostingRoutes(app, routeOpts, { applyDeps: () => applyDeps })

  const [org] = await db
    .insert(organization)
    .values({ name: 'Remove Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [u] = await db
    .insert(user)
    .values({ email: `rm-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })
  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const projectIds: string[] = []
  async function makeEnvironment(label: string) {
    const [proj] = await db
      .insert(project)
      .values({ workspaceId: ws!.id, organizationId, name: label, createdAt: now, updatedAt: now })
      .returning({ id: project.id })
    projectIds.push(proj!.id)
    const [env] = await db
      .insert(environment)
      .values({ projectId: proj!.id, name: 'e', createdAt: now, updatedAt: now })
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
    return { environmentId: env!.id, serviceId: svc!.id }
  }
  const first = await makeEnvironment('A')
  const second = await makeEnvironment('B')

  const { token } = await createSession(db, userId, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return {
    db,
    organizationId,
    userId,
    first,
    second,
    calls,
    call: async (method, path, body) =>
      app.request(path, {
        method,
        headers: { cookie, [ORG_ID_HEADER]: organizationId, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    async cleanup() {
      await db.delete(audit).where(eq(audit.organizationId, organizationId))
      await db.delete(doorway).where(eq(doorway.routingOrganizationId, organizationId))
      await db.delete(tunnel).where(eq(tunnel.routingOrganizationId, organizationId))
      await db.delete(carrier).where(eq(carrier.organizationId, organizationId))
      for (const env of [first, second]) {
        await db.delete(deployment).where(eq(deployment.environmentId, env.environmentId))
        await db.delete(hosting).where(eq(hosting.serviceId, env.serviceId))
        await db.delete(service).where(eq(service.id, env.serviceId))
        await db.delete(environment).where(eq(environment.id, env.environmentId))
      }
      await db.delete(server).where(eq(server.organizationId, organizationId))
      for (const id of projectIds) await db.delete(project).where(eq(project.id, id))
      await db.delete(workspace).where(eq(workspace.id, ws!.id))
      await db.delete(grant).where(eq(grant.actorId, userId))
      await db.delete(user).where(eq(user.id, userId))
      await db.delete(organization).where(eq(organization.id, organizationId))
      await endDbConnection(db)
    },
  }
}

/** A hosting of `serviceId` that serves `NAME`, made from the compose file unless `owner` says otherwise. */
async function makeHosting(
  f: Fixture,
  serviceId: string,
  metadata: Record<string, unknown> | null
): Promise<string> {
  const now = new Date().toISOString()
  const [row] = await f.db
    .insert(hosting)
    .values({
      serviceId,
      name: 'Site',
      options: { hostnames: [NAME] },
      metadata,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })
  await f.db.insert(hostname).values({
    hostingId: row!.id,
    routingOrganizationId: f.organizationId,
    hostname: NAME,
  })
  return row!.id
}

const COMPOSE_OWNED = {
  composeOwned: true,
  composeServiceName: 's',
  composeRoute: `${NAME} /`,
}

/** A server that finished a deploy of the environment just now (after every edit). */
async function deployedOn(f: Fixture, environmentId: string, connected: boolean) {
  const now = new Date().toISOString()
  const [srv] = await f.db
    .insert(server)
    .values({
      organizationId: f.organizationId,
      name: `rm-${crypto.randomUUID().slice(0, 8)}`,
      isConnected: connected,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const finished = new Date(Date.now() + 1).toISOString()
  await f.db.insert(deployment).values({
    environmentId,
    serverId: srv!.id,
    desiredGeneration: 1,
    appliedGeneration: 1,
    status: 'applied',
    finishedAt: finished,
    createdAt: finished,
    updatedAt: finished,
  })
}

/** A doorway (an organization tunnel's name) linked to `hostingId`. */
async function linkDoorway(f: Fixture, hostingId: string): Promise<string> {
  const [car] = await f.db
    .insert(carrier)
    .values({ organizationId: f.organizationId, provider: 'cloudflare', name: 'c' })
    .returning({ id: carrier.id })
  const [tun] = await f.db
    .insert(tunnel)
    .values({
      organizationId: f.organizationId,
      routingOrganizationId: f.organizationId,
      carrierId: car!.id,
      provider: 'cloudflare',
      name: 't',
    })
    .returning({ id: tunnel.id })
  const [door] = await f.db
    .insert(doorway)
    .values({
      routingOrganizationId: f.organizationId,
      tunnelId: tun!.id,
      hostname: NAME,
      hostingId,
    })
    .returning({ id: doorway.id })
  return door!.id
}

async function nameHolders(f: Fixture): Promise<number> {
  const rows = await f.db
    .select({ id: hostname.id })
    .from(hostname)
    .where(eq(hostname.routingOrganizationId, f.organizationId))
  return rows.length
}

test('remove-now: the name is released at once, the route is dropped without a deploy, and another project can take it', async () => {
  if (!dbUrl) return skipWithoutDatabase('hosting remove-now route tests')
  const f = await setup()
  try {
    const id = await makeHosting(f, f.first.serviceId, COMPOSE_OWNED)
    const doorwayId = await linkDoorway(f, id)
    await deployedOn(f, f.first.environmentId, true)

    // Held: another project cannot take the name.
    const blocked = await f.call('POST', '/hostings', {
      serviceId: f.second.serviceId,
      name: 'Other',
      options: { hostnames: [NAME] },
    })
    assertEquals(blocked.status, 409)

    const res = await f.call('POST', `/hostings/${id}/remove-now`)
    assertEquals(res.status, 200)
    assertEquals(await res.json(), {
      ok: true,
      outcome: 'removed',
      hostnames: [NAME],
      serverUpdate: 'queued',
    })
    assertEquals(f.calls.length, 1)
    assertEquals(f.calls[0]?.environmentId, f.first.environmentId)
    assertEquals(f.calls[0]?.auth.hostingsOnly, true)
    assertEquals(f.calls[0]?.auth.actorId, f.userId)

    assertEquals((await f.db.select().from(hosting).where(eq(hosting.id, id))).length, 0)
    assertEquals(await nameHolders(f), 0)
    // The doorway keeps its own name but no longer points at a site.
    const [door] = await f.db
      .select({ hostingId: doorway.hostingId })
      .from(doorway)
      .where(eq(doorway.id, doorwayId))
    assertEquals(door?.hostingId, null)

    const again = await f.call('POST', '/hostings', {
      serviceId: f.second.serviceId,
      name: 'Other',
      options: { hostnames: [NAME] },
    })
    assertEquals(again.status, 200)
  } finally {
    await f.cleanup()
  }
})

test('remove-now: with the server offline the name is still released and no run is queued', async () => {
  if (!dbUrl) return skipWithoutDatabase('hosting remove-now route tests')
  const f = await setup()
  try {
    const id = await makeHosting(f, f.first.serviceId, COMPOSE_OWNED)
    await deployedOn(f, f.first.environmentId, false)
    const res = await f.call('POST', `/hostings/${id}/remove-now`)
    assertEquals(res.status, 200)
    assertEquals(((await res.json()) as { serverUpdate: string }).serverUpdate, 'server_offline')
    assertEquals(f.calls.length, 0)
    assertEquals(await nameHolders(f), 0)
    const again = await f.call('POST', '/hostings', {
      serviceId: f.second.serviceId,
      name: 'Other',
      options: { hostnames: [NAME] },
    })
    assertEquals(again.status, 200)
  } finally {
    await f.cleanup()
  }
})

test('remove-now: an environment never deployed releases the name and queues nothing', async () => {
  if (!dbUrl) return skipWithoutDatabase('hosting remove-now route tests')
  const f = await setup()
  try {
    const id = await makeHosting(f, f.first.serviceId, COMPOSE_OWNED)
    const res = await f.call('POST', `/hostings/${id}/remove-now`)
    assertEquals(res.status, 200)
    assertEquals(((await res.json()) as { serverUpdate: string }).serverUpdate, 'not_deployed')
    assertEquals(f.calls.length, 0)
    assertEquals(await nameHolders(f), 0)
  } finally {
    await f.cleanup()
  }
})

test('remove-now: a hosting the panel made first is handed back, and a panel hosting is refused', async () => {
  if (!dbUrl) return skipWithoutDatabase('hosting remove-now route tests')
  const f = await setup()
  try {
    const adopted = await makeHosting(f, f.first.serviceId, {
      ...COMPOSE_OWNED,
      composeAdopted: true,
    })
    const res = await f.call('POST', `/hostings/${adopted}/remove-now`)
    assertEquals(res.status, 200)
    assertEquals(((await res.json()) as { outcome: string }).outcome, 'handed_back')
    const [kept] = await f.db
      .select({ metadata: hosting.metadata })
      .from(hosting)
      .where(eq(hosting.id, adopted))
    assertEquals(kept?.metadata, {})
    assertEquals(f.calls.length, 0)

    // Now a panel hosting: remove-now is for compose-made rows only.
    const refused = await f.call('POST', `/hostings/${adopted}/remove-now`)
    assertEquals(refused.status, 409)
    assertEquals(
      ((await refused.json()) as { error: string }).error,
      'hosting_not_owned_by_compose'
    )
  } finally {
    await f.cleanup()
  }
})

test('DELETE /hostings/:id: a panel hosting frees its name and drops the route without a deploy', async () => {
  if (!dbUrl) return skipWithoutDatabase('hosting remove-now route tests')
  const f = await setup()
  try {
    const id = await makeHosting(f, f.first.serviceId, null)
    await deployedOn(f, f.first.environmentId, true)
    const res = await f.call('DELETE', `/hostings/${id}`)
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true, serverUpdate: 'queued' })
    assertEquals(f.calls.length, 1)
    assertEquals(f.calls[0]?.auth.hostingsOnly, true)
    assertEquals(await nameHolders(f), 0)
  } finally {
    await f.cleanup()
  }
})

test('DELETE /hostings/:id: with the server offline the name is released and the update waits for the next deploy', async () => {
  if (!dbUrl) return skipWithoutDatabase('hosting remove-now route tests')
  const f = await setup()
  try {
    const id = await makeHosting(f, f.first.serviceId, null)
    await deployedOn(f, f.first.environmentId, false)
    const res = await f.call('DELETE', `/hostings/${id}`)
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true, serverUpdate: 'server_offline' })
    assertEquals(f.calls.length, 0)
    assertEquals(await nameHolders(f), 0)
  } finally {
    await f.cleanup()
  }
})
