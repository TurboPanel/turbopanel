import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  binding,
  container,
  deployment,
  environment,
  grant,
  hosting,
  organization,
  project,
  server,
  service,
  user,
  variable,
  workspace,
} from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerEnvironmentRoutes } from './routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createEnvironmentRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerEnvironmentRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, secrets }
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string
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
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping environment route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createEnvironmentRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Environment Route Test Org' })
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

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Environment Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Environment Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Environment Route Project',
      workspaceId,
      organizationId,
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
    const envIds = (
      await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.projectId, projectId))
    ).map((row) => row.id)
    if (envIds.length > 0) {
      const svcIds = (
        await db
          .select({ id: service.id })
          .from(service)
          .where(inArray(service.environmentId, envIds))
      ).map((row) => row.id)
      if (svcIds.length > 0) {
        await db.delete(container).where(inArray(container.serviceId, svcIds))
        await db.delete(hosting).where(inArray(hosting.serviceId, svcIds))
        await db.delete(binding).where(inArray(binding.serviceId, svcIds))
        await db.delete(service).where(inArray(service.id, svcIds))
      }
    }
    await db.delete(deployment).where(eq(deployment.serverId, serverId))
    await db.delete(environment).where(eq(environment.projectId, projectId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST/PATCH /environments strip metadata.serverId from stored JSONB', async () => {
  await withEnvironmentFixtures(
    async ({ db, app, secrets, userId, organizationId, projectId, serverId }) => {
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
          name: 'Env Metadata Strip',
          serverId,
          metadata: { serverId, note: 'keep-me' },
        }),
      })
      assertEquals(createRes.status, 200)
      const { id } = (await createRes.json()) as { ok: true; id: string }

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
      const getBody = (await getRes.json()) as {
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
    }
  )
})

test('POST /environments reconciles service rows from the project base compose when created without options', async () => {
  await withEnvironmentFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    await db
      .update(project)
      .set({
        options: {
          compose: {
            version: 1,
            data: {
              services: {
                web: { image: 'nginx:latest' },
                api: { image: 'node:22' },
              },
            },
            presentation: { keyOrder: ['services'], comments: {} },
          },
        },
      })
      .where(eq(project.id, projectId))

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
        name: 'Env Base Compose Reconcile',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = (await createRes.json()) as { ok: true; id: string }

    const rows = await db
      .select({ composeServiceName: service.composeServiceName })
      .from(service)
      .where(eq(service.environmentId, id))
    const names = rows.map((row) => row.composeServiceName).sort((a, b) => a.localeCompare(b))
    assertEquals(names, ['api', 'web'])

    await db.delete(service).where(eq(service.environmentId, id))
  })
})

type EnvironmentTestContext = Parameters<Parameters<typeof withEnvironmentFixtures>[0]>[0]

async function sendJson(
  ctx: EnvironmentTestContext,
  cookie: string,
  method: string,
  path: string,
  body: unknown
): Promise<Response> {
  return await ctx.app.request(path, {
    method,
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: ctx.organizationId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function storedOptions(
  ctx: EnvironmentTestContext,
  id: string
): Promise<Record<string, unknown> | null> {
  const [row] = await ctx.db
    .select({ options: environment.options })
    .from(environment)
    .where(eq(environment.id, id))
    .limit(1)
  return (row?.options ?? null) as Record<string, unknown> | null
}

test('POST /environments defaults a new environment to the sequential strategy', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const res = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'Env Default Strategy',
    })
    assertEquals(res.status, 200)
    const { id } = (await res.json()) as { id: string }
    assertEquals(await storedOptions(ctx, id), { deployStrategy: 'sequential' })
  })
})

test('POST /environments keeps a strategy the caller chose, and null means unset', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const chosen = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'Env Chosen Strategy',
      options: { deployStrategy: 'inplace', migrations: 'none' },
    })
    assertEquals(chosen.status, 200)
    const chosenId = ((await chosen.json()) as { id: string }).id
    assertEquals(await storedOptions(ctx, chosenId), {
      deployStrategy: 'inplace',
      migrations: 'none',
    })

    // `null` means "unset", so the new-environment default applies.
    const cleared = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'Env Null Strategy',
      options: { deployStrategy: null },
    })
    assertEquals(cleared.status, 200)
    const clearedId = ((await cleared.json()) as { id: string }).id
    assertEquals(await storedOptions(ctx, clearedId), { deployStrategy: 'sequential' })
  })
})

test('POST /environments refuses invalid deploy settings with a reason', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const res = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'Env Bad Strategy',
      options: { deployStrategy: 'rolling' },
    })
    assertEquals(res.status, 400)
    assertEquals(await res.json(), {
      error: 'deploy_options_invalid',
      message: 'deployStrategy must be one of inplace, sequential, bluegreen',
    })
  })
})

test('PATCH /environments validates deploy settings and keeps stored ones the body omits', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const created = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'Env Patch Strategy',
      options: { deployStrategy: 'bluegreen', migrations: 'compatible', drainSeconds: 5 },
    })
    const { id } = (await created.json()) as { id: string }

    // The compose editor sends only `compose`; the stored settings survive.
    const composeOnly = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: { compose: { version: 1, data: {}, presentation: { keyOrder: [], comments: {} } } },
    })
    assertEquals(composeOnly.status, 200)
    const afterCompose = await storedOptions(ctx, id)
    assertEquals(afterCompose?.deployStrategy, 'bluegreen')
    assertEquals(afterCompose?.migrations, 'compatible')
    assertEquals(afterCompose?.drainSeconds, 5)
    assertEquals('compose' in (afterCompose ?? {}), true)

    // Named keys replace; `null` clears; the rest stay.
    const changed = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: { deployStrategy: 'sequential', migrations: null },
    })
    assertEquals(changed.status, 200)
    assertEquals(await storedOptions(ctx, id), { deployStrategy: 'sequential', drainSeconds: 5 })

    // Invalid values are refused and nothing is written.
    const bad = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: { rollbackWindowMinutes: 100000 },
    })
    assertEquals(bad.status, 400)
    assertEquals(await bad.json(), {
      error: 'deploy_options_invalid',
      message: 'rollbackWindowMinutes must be an integer from 0 to 1440',
    })
    assertEquals(await storedOptions(ctx, id), { deployStrategy: 'sequential', drainSeconds: 5 })
  })
})

// A service-free overlay (only a project name), so the environment has nothing to block its delete.
const EMPTY_OVERLAY = {
  version: 1,
  data: { name: 'staging-stack' },
  presentation: { keyOrder: ['name'], comments: {} },
}

const WEB_OVERLAY = {
  version: 1,
  data: { services: { web: { image: 'nginx:1.27' } } },
  presentation: { keyOrder: ['services'], comments: {} },
}

async function environmentRow(ctx: EnvironmentTestContext, id: string) {
  const [row] = await ctx.db
    .select({
      name: environment.name,
      description: environment.description,
    })
    .from(environment)
    .where(eq(environment.id, id))
    .limit(1)
  return row
}

async function createEnvironmentWith(
  ctx: EnvironmentTestContext,
  cookie: string,
  fields: Record<string, unknown>
): Promise<string> {
  const created = await sendJson(ctx, cookie, 'POST', '/environments', {
    projectId: ctx.projectId,
    ...fields,
  })
  assertEquals(created.status, 200)
  return ((await created.json()) as { id: string }).id
}

function deleteEnvironmentRequest(
  ctx: EnvironmentTestContext,
  cookie: string,
  id: string
): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(`/environments/${id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: ctx.organizationId },
    })
  )
}

test('an environment is added with an overlay, renamed with the overlay kept, and deleted with its variables', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const id = await createEnvironmentWith(ctx, cookie, {
      name: 'Staging',
      description: 'first',
      options: { compose: EMPTY_OVERLAY },
    })
    assertEquals((await environmentRow(ctx, id))?.name, 'Staging')
    assertEquals(
      ((await storedOptions(ctx, id))?.compose as typeof EMPTY_OVERLAY).data,
      EMPTY_OVERLAY.data
    )

    const renamed = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      name: 'Pre-production',
      description: 'second',
    })
    assertEquals(renamed.status, 200)
    assertEquals(await environmentRow(ctx, id), { name: 'Pre-production', description: 'second' })
    // Renaming is not an overlay edit: the overlay survives.
    assertEquals(
      ((await storedOptions(ctx, id))?.compose as typeof EMPTY_OVERLAY).data,
      EMPTY_OVERLAY.data
    )

    await ctx.db
      .insert(variable)
      .values({ environmentId: id, key: 'STAGE_ONLY', value: 'x', isSecret: false })

    const removed = await deleteEnvironmentRequest(ctx, cookie, id)
    assertEquals(removed.status, 200)
    assertEquals(await environmentRow(ctx, id), undefined)
    const leftovers = await ctx.db
      .select({ id: variable.id })
      .from(variable)
      .where(eq(variable.environmentId, id))
    assertEquals(leftovers.length, 0)
  })
})

async function createEnvironmentWithWeb(
  ctx: EnvironmentTestContext,
  cookie: string,
  name: string
): Promise<{ id: string; serviceId: string }> {
  const id = await createEnvironmentWith(ctx, cookie, {
    name,
    options: { compose: WEB_OVERLAY },
  })
  const [svc] = await ctx.db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, id))
  return { id, serviceId: svc!.id }
}

async function countRows(
  ctx: EnvironmentTestContext,
  environmentId: string,
  serviceId: string
): Promise<{ services: number; containers: number; hostings: number; bindings: number }> {
  const services = await ctx.db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const containers = await ctx.db
    .select({ id: container.id })
    .from(container)
    .where(eq(container.serviceId, serviceId))
  const hostings = await ctx.db
    .select({ id: hosting.id })
    .from(hosting)
    .where(eq(hosting.serviceId, serviceId))
  const bindings = await ctx.db
    .select({ id: binding.id })
    .from(binding)
    .where(eq(binding.serviceId, serviceId))
  return {
    services: services.length,
    containers: containers.length,
    hostings: hostings.length,
    bindings: bindings.length,
  }
}

function addContainer(ctx: EnvironmentTestContext, serviceId: string, status: string) {
  return ctx.db.insert(container).values({
    serviceId,
    serverId: ctx.serverId,
    containerId: `cid-${crypto.randomUUID()}`,
    containerName: `web-${crypto.randomUUID()}`,
    status,
    composeServiceName: 'web',
  })
}

test('an environment with a running container is refused with environment_running and nothing is removed', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id, serviceId } = await createEnvironmentWithWeb(ctx, cookie, 'Running')
    await addContainer(ctx, serviceId, 'running')

    const refused = await deleteEnvironmentRequest(ctx, cookie, id)
    assertEquals(refused.status, 409)
    assertEquals(await refused.json(), { error: 'environment_running' })
    assertEquals((await environmentRow(ctx, id))?.name, 'Running')
    assertEquals((await countRows(ctx, id, serviceId)).containers, 1)
  })
})

test('an environment with a deploy in progress is refused with environment_running', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id } = await createEnvironmentWithWeb(ctx, cookie, 'Deploying')
    await ctx.db
      .insert(deployment)
      .values({ environmentId: id, serverId: ctx.serverId, status: 'applying' })

    const refused = await deleteEnvironmentRequest(ctx, cookie, id)
    assertEquals(refused.status, 409)
    assertEquals(await refused.json(), { error: 'environment_running' })
    assertEquals((await environmentRow(ctx, id))?.name, 'Deploying')

    // A finished deploy no longer blocks.
    await ctx.db
      .update(deployment)
      .set({ status: 'applied' })
      .where(eq(deployment.environmentId, id))
    assertEquals((await deleteEnvironmentRequest(ctx, cookie, id)).status, 200)
    assertEquals(await environmentRow(ctx, id), undefined)
  })
})

test('a stopped environment is deleted with its services, containers, hostings, bindings and variables', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id, serviceId } = await createEnvironmentWithWeb(ctx, cookie, 'Stopped')
    const sibling = await createEnvironmentWithWeb(ctx, cookie, 'Sibling')
    await addContainer(ctx, serviceId, 'exited')
    await ctx.db
      .insert(hosting)
      .values({ serviceId, domain: `stopped-${crypto.randomUUID()}.example.com` })
    await ctx.db
      .insert(variable)
      .values({ environmentId: id, key: 'GONE', value: 'x', isSecret: false })
    await ctx.db
      .insert(deployment)
      .values({ environmentId: id, serverId: ctx.serverId, status: 'applied' })
    const before = await countRows(ctx, id, serviceId)
    assertEquals([before.services, before.containers, before.hostings], [1, 1, 1])

    const removed = await deleteEnvironmentRequest(ctx, cookie, id)
    assertEquals(removed.status, 200)
    assertEquals(await environmentRow(ctx, id), undefined)
    assertEquals(await countRows(ctx, id, serviceId), {
      services: 0,
      containers: 0,
      hostings: 0,
      bindings: 0,
    })
    const vars = await ctx.db
      .select({ id: variable.id })
      .from(variable)
      .where(eq(variable.environmentId, id))
    assertEquals(vars.length, 0)
    const deployments = await ctx.db
      .select({ id: deployment.id })
      .from(deployment)
      .where(eq(deployment.environmentId, id))
    assertEquals(deployments.length, 0)
    // The sibling environment is untouched.
    assertEquals((await environmentRow(ctx, sibling.id))?.name, 'Sibling')
    assertEquals((await countRows(ctx, sibling.id, sibling.serviceId)).services, 1)
  })
})

test('a never-deployed environment with services deletes', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id, serviceId } = await createEnvironmentWithWeb(ctx, cookie, 'Fresh')
    assertEquals((await deleteEnvironmentRequest(ctx, cookie, id)).status, 200)
    assertEquals((await countRows(ctx, id, serviceId)).services, 0)
  })
})

test('environment delete: another organization gets 404 and a member without manage gets 403, nothing removed', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id } = await createEnvironmentWithWeb(ctx, cookie, 'Protected')

    const [otherOrg] = await ctx.db
      .insert(organization)
      .values({ name: 'Other Delete Org' })
      .returning({ id: organization.id })
    const [other] = await ctx.db
      .insert(user)
      .values({
        email: `other-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      })
      .returning({ id: user.id })
    const [reader] = await ctx.db
      .insert(user)
      .values({
        email: `reader-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      })
      .returning({ id: user.id })
    try {
      await ctx.db.insert(grant).values([
        {
          entityType: 'organization',
          entityId: otherOrg!.id,
          actorType: 'user',
          actorId: other!.id,
          permission: 'organization:manage',
        },
        {
          entityType: 'organization',
          entityId: ctx.organizationId,
          actorType: 'user',
          actorId: reader!.id,
          permission: 'organization:read',
        },
      ])
      const otherCookie = await sessionCookie(ctx.db, ctx.secrets, other!.id)
      const crossOrg = await ctx.app.request(`/environments/${id}`, {
        method: 'DELETE',
        headers: { Cookie: otherCookie, [ORG_ID_HEADER]: otherOrg!.id },
      })
      assertEquals(crossOrg.status, 404)

      const readerCookie = await sessionCookie(ctx.db, ctx.secrets, reader!.id)
      const denied = await deleteEnvironmentRequest(ctx, readerCookie, id)
      assertEquals(denied.status, 403)
      assertEquals((await environmentRow(ctx, id))?.name, 'Protected')
    } finally {
      await ctx.db.delete(grant).where(inArray(grant.actorId, [other!.id, reader!.id]))
      await ctx.db.delete(user).where(inArray(user.id, [other!.id, reader!.id]))
      await ctx.db.delete(organization).where(eq(organization.id, otherOrg!.id))
    }
  })
})

test('an environment moves to another server only by an explicit pin change, and a server outside the organization is refused', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const now = new Date().toISOString()
    const [second] = await ctx.db
      .insert(server)
      .values({
        organizationId: ctx.organizationId,
        name: 'Second Server',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    const [otherOrg] = await ctx.db
      .insert(organization)
      .values({ name: 'Placement Other Org' })
      .returning({ id: organization.id })
    const [foreign] = await ctx.db
      .insert(server)
      .values({
        organizationId: otherOrg!.id,
        name: 'Foreign Server',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    try {
      const id = await createEnvironmentWith(ctx, cookie, {
        name: 'Placed',
        serverId: ctx.serverId,
      })
      const pinned = async () =>
        (
          await ctx.db
            .select({ serverId: environment.serverId })
            .from(environment)
            .where(eq(environment.id, id))
        )[0]?.serverId

      assertEquals(await pinned(), ctx.serverId)
      // A rename leaves placement alone: nothing moves implicitly.
      await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, { name: 'Placed renamed' })
      assertEquals(await pinned(), ctx.serverId)

      const moved = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
        serverId: second!.id,
      })
      assertEquals(moved.status, 200)
      assertEquals(await pinned(), second!.id)

      const refused = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
        serverId: foreign!.id,
      })
      assertEquals(refused.status, 404)
      assertEquals(await pinned(), second!.id)
      assertEquals(
        (
          await sendJson(ctx, cookie, 'POST', '/environments', {
            projectId: ctx.projectId,
            name: 'Nope',
            serverId: foreign!.id,
          })
        ).status,
        404
      )

      const cleared = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
        serverId: null,
      })
      assertEquals(cleared.status, 200)
      assertEquals(await pinned(), null)
    } finally {
      await ctx.db.delete(environment).where(eq(environment.projectId, ctx.projectId))
      await ctx.db.delete(server).where(eq(server.id, second!.id))
      await ctx.db.delete(server).where(eq(server.id, foreign!.id))
      await ctx.db.delete(organization).where(eq(organization.id, otherOrg!.id))
    }
  })
})
