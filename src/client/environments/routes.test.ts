import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { and, eq, inArray, sql } from 'drizzle-orm'
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
  audit,
  grant,
  hosting,
  organization,
  project,
  repository,
  server,
  service,
  user,
  variable,
  workspace,
} from '../../db/schema.ts'
import {
  decideEnvironmentPush,
  environmentBranchBindings,
} from '../../features/git/environment-branch-tracking.ts'
import { makeComposeTag } from '../../features/compose/index.ts'
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
    skipWithoutDatabase('environment route tests')
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
          name: 'env-metadata-strip',
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
        name: 'env-base-compose-reconcile',
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
      name: 'env-default-strategy',
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
      name: 'env-chosen-strategy',
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
      name: 'env-null-strategy',
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
      name: 'env-bad-strategy',
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
      name: 'env-patch-strategy',
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
      name: 'staging',
      description: 'first',
      options: { compose: EMPTY_OVERLAY },
    })
    assertEquals((await environmentRow(ctx, id))?.name, 'staging')
    assertEquals(
      ((await storedOptions(ctx, id))?.compose as typeof EMPTY_OVERLAY).data,
      EMPTY_OVERLAY.data
    )

    const renamed = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      name: 'pre-production',
      description: 'second',
    })
    assertEquals(renamed.status, 200)
    assertEquals(await environmentRow(ctx, id), { name: 'pre-production', description: 'second' })
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
    const { id, serviceId } = await createEnvironmentWithWeb(ctx, cookie, 'running')
    await addContainer(ctx, serviceId, 'running')

    const refused = await deleteEnvironmentRequest(ctx, cookie, id)
    assertEquals(refused.status, 409)
    assertEquals(await refused.json(), { error: 'environment_running' })
    assertEquals((await environmentRow(ctx, id))?.name, 'running')
    assertEquals((await countRows(ctx, id, serviceId)).containers, 1)
  })
})

test('an environment with a deploy in progress is refused with environment_running', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id } = await createEnvironmentWithWeb(ctx, cookie, 'deploying')
    await ctx.db
      .insert(deployment)
      .values({ environmentId: id, serverId: ctx.serverId, status: 'applying' })

    const refused = await deleteEnvironmentRequest(ctx, cookie, id)
    assertEquals(refused.status, 409)
    assertEquals(await refused.json(), { error: 'environment_running' })
    assertEquals((await environmentRow(ctx, id))?.name, 'deploying')

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
    // The first environment is the primary one and cannot be deleted while others exist.
    const sibling = await createEnvironmentWithWeb(ctx, cookie, 'sibling')
    const { id, serviceId } = await createEnvironmentWithWeb(ctx, cookie, 'stopped')
    await addContainer(ctx, serviceId, 'exited')
    await ctx.db.insert(hosting).values({ serviceId })
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
    assertEquals((await environmentRow(ctx, sibling.id))?.name, 'sibling')
    assertEquals((await countRows(ctx, sibling.id, sibling.serviceId)).services, 1)
  })
})

test('a never-deployed environment with services deletes', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id, serviceId } = await createEnvironmentWithWeb(ctx, cookie, 'fresh')
    assertEquals((await deleteEnvironmentRequest(ctx, cookie, id)).status, 200)
    assertEquals((await countRows(ctx, id, serviceId)).services, 0)
  })
})

test('environment delete: another organization gets 404 and a member without manage gets 403, nothing removed', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const { id } = await createEnvironmentWithWeb(ctx, cookie, 'protected')

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
      assertEquals((await environmentRow(ctx, id))?.name, 'protected')
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
        name: 'placed',
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
      await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, { name: 'placed-renamed' })
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
            name: 'nope',
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

function composeDoc(data: Record<string, unknown>) {
  return { version: 1, data, presentation: { keyOrder: Object.keys(data), comments: {} } }
}

async function setProjectBase(ctx: EnvironmentTestContext, services: Record<string, unknown>) {
  await ctx.db
    .update(project)
    .set({ options: { compose: composeDoc({ services }) } })
    .where(eq(project.id, ctx.projectId))
}

type ComposeRefusal = { error: string; issues: Array<{ path: string; message: string }> }

async function assertComposeRefused(res: Response, serviceName: string): Promise<void> {
  assertEquals(res.status, 400)
  const body = (await res.json()) as ComposeRefusal
  assertEquals(body.error, 'compose_invalid')
  const message = body.issues.map((issue) => issue.message).join('\n')
  assertEquals(message.includes(`Service "${serviceName}" must define "image" or "build"`), true)
}

test('PATCH /environments saves changes that only set a field on a service the Base defines', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    await setProjectBase(ctx, { web: { image: 'nginx:alpine' } })
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const id = await createEnvironmentWith(ctx, cookie, { name: 'changes-only' })

    const changes = composeDoc({ services: { web: { command: ['npm', 'start'] } } })
    const saved = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: { compose: changes },
    })
    assertEquals(saved.status, 200)
    const stored = (await storedOptions(ctx, id))?.compose as { data: unknown }
    assertEquals(stored.data, changes.data)
  })
})

test('PATCH /environments still needs an image or build for a service that is new in the environment', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    await setProjectBase(ctx, { web: { image: 'nginx:alpine' } })
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const id = await createEnvironmentWith(ctx, cookie, { name: 'new-service' })
    const before = await storedOptions(ctx, id)

    const bare = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: { compose: composeDoc({ services: { worker: { command: ['node', 'w.js'] } } }) },
    })
    await assertComposeRefused(bare, 'worker')
    // A refused save changes nothing.
    assertEquals(await storedOptions(ctx, id), before)

    const withImage = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: {
        compose: composeDoc({ services: { worker: { image: 'node:22', command: ['node'] } } }),
      },
    })
    assertEquals(withImage.status, 200)
  })
})

test('PATCH /environments refuses changes that leave a service with nothing to run', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    await setProjectBase(ctx, { web: { image: 'nginx:alpine' } })
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const id = await createEnvironmentWith(ctx, cookie, { name: 'reset-image' })

    const reset = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: {
        compose: composeDoc({
          services: { web: { image: { __turbopanelComposeTag: 'reset', value: null } } },
        }),
      },
    })
    await assertComposeRefused(reset, 'web')
  })
})

test('PATCH /environments keeps refusing banned keys and unknown fields in the changes', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    await setProjectBase(ctx, { web: { image: 'nginx:alpine' } })
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const id = await createEnvironmentWith(ctx, cookie, { name: 'banned' })

    const unknown = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: { compose: composeDoc({ services: { web: { imaage: 'nginx' } } }) },
    })
    assertEquals(unknown.status, 400)
    assertEquals(((await unknown.json()) as ComposeRefusal).error, 'compose_invalid')

    const placement = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: {
        compose: composeDoc({
          services: { web: { command: ['x'] } },
          'x-turbopanel': { placement: { serverId: crypto.randomUUID() } },
        }),
      },
    })
    assertEquals(placement.status, 400)
    assertEquals(((await placement.json()) as ComposeRefusal).error, 'compose_invalid')
  })
})

test('PATCH /environments with no Base compose needs the image in the environment', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const id = await createEnvironmentWith(ctx, cookie, { name: 'no-base' })
    const res = await sendJson(ctx, cookie, 'PATCH', `/environments/${id}`, {
      options: { compose: composeDoc({ services: { web: { command: ['npm', 'start'] } } }) },
    })
    await assertComposeRefused(res, 'web')
  })
})

test('POST /environments accepts changes to a Base service and refuses a new bare service', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    await setProjectBase(ctx, { web: { image: 'nginx:alpine' } })
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)

    const ok = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'created-with-changes',
      options: { compose: composeDoc({ services: { web: { command: ['npm', 'start'] } } }) },
    })
    assertEquals(ok.status, 200)

    const refused = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'created-with-a-bare-service',
      options: { compose: composeDoc({ services: { worker: { command: ['node'] } } }) },
    })
    await assertComposeRefused(refused, 'worker')
  })
})

test('a duplicate environment name in a project answers 409 environment_name_in_use on create and rename', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const first = await createEnvironmentWith(ctx, cookie, { name: 'blue' })
    const second = await createEnvironmentWith(ctx, cookie, { name: 'green' })

    const dupCreate = await sendJson(ctx, cookie, 'POST', '/environments', {
      projectId: ctx.projectId,
      name: 'blue',
    })
    assertEquals(dupCreate.status, 409)
    assertEquals(((await dupCreate.json()) as { error: string }).error, 'environment_name_in_use')

    const dupRename = await sendJson(ctx, cookie, 'PATCH', `/environments/${second}`, {
      name: 'blue',
    })
    assertEquals(dupRename.status, 409)
    assertEquals(((await dupRename.json()) as { error: string }).error, 'environment_name_in_use')
    assertEquals((await environmentRow(ctx, second))?.name, 'green')
    assertEquals((await environmentRow(ctx, first))?.name, 'blue')
  })
})

async function sendEnvironmentJson(
  ctx: EnvironmentTestContext,
  cookie: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return await ctx.app.request(path, {
    method,
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: ctx.organizationId,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function createNamedEnvironment(
  ctx: EnvironmentTestContext,
  cookie: string,
  body: Record<string, unknown>
): Promise<{ status: number; id: string; json: Record<string, unknown> }> {
  const res = await sendEnvironmentJson(ctx, cookie, 'POST', '/environments', {
    projectId: ctx.projectId,
    ...body,
  })
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, id: String(json.id ?? ''), json }
}

async function projectEnvironmentFlags(ctx: EnvironmentTestContext) {
  const rows = await ctx.db
    .select({
      name: environment.name,
      isPrimary: environment.isPrimary,
      isPinned: environment.isPinned,
    })
    .from(environment)
    .where(eq(environment.projectId, ctx.projectId))
  return new Map(rows.map((row) => [row.name, row]))
}

type StoredOptions = { compose: { data: Record<string, unknown> & { services: unknown } } }

const SERVICE_COMPOSE = {
  version: 1,
  data: { services: { web: { image: 'nginx:1' } } },
  presentation: { keyOrder: ['services'], comments: {} },
}

test('the first environment is primary and later ones are not', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const first = await createNamedEnvironment(ctx, cookie, { name: 'live' })
    const second = await createNamedEnvironment(ctx, cookie, { name: 'staging' })
    assertEquals([first.status, second.status], [200, 200])
    const flags = await projectEnvironmentFlags(ctx)
    assertEquals(flags.get('live')?.isPrimary, true)
    assertEquals(flags.get('staging')?.isPrimary, false)
    assertEquals(flags.get('staging')?.isPinned, false)

    const detail = await sendEnvironmentJson(ctx, cookie, 'GET', `/environments/${first.id}`)
    const body = (await detail.json()) as { environment: { isPrimary: boolean; pinned: boolean } }
    assertEquals([body.environment.isPrimary, body.environment.pinned], [true, false])
  })
})

test('a new environment starts as a copy of the primary one, unless it is empty', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const primary = await createNamedEnvironment(ctx, cookie, {
      name: 'live',
      options: { compose: SERVICE_COMPOSE },
    })
    assertEquals(primary.status, 200)
    const copy = await createNamedEnvironment(ctx, cookie, { name: 'copy-of-live' })
    const empty = await createNamedEnvironment(ctx, cookie, { name: 'blank', start: 'empty' })
    assertEquals([copy.status, empty.status], [200, 200])

    const rows = await ctx.db
      .select({ name: environment.name, options: environment.options })
      .from(environment)
      .where(eq(environment.projectId, ctx.projectId))
    const byName = new Map(rows.map((row) => [row.name, row.options as StoredOptions]))
    assertEquals(byName.get('copy-of-live')?.compose.data, SERVICE_COMPOSE.data)
    assertEquals(byName.get('blank')?.compose.data.services, makeComposeTag('override', {}))

    // A copy is a copy: later edits to the primary do not reach it.
    const patched = await sendEnvironmentJson(ctx, cookie, 'PATCH', `/environments/${primary.id}`, {
      options: {
        compose: { ...SERVICE_COMPOSE, data: { services: { web: { image: 'nginx:2' } } } },
      },
    })
    assertEquals(patched.status, 200)
    const [copied] = await ctx.db
      .select({ options: environment.options })
      .from(environment)
      .where(eq(environment.id, copy.id))
    assertEquals((copied?.options as StoredOptions).compose.data, SERVICE_COMPOSE.data)
  })
})

test('copy and empty starts keep every environment name rule', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    await createNamedEnvironment(ctx, cookie, {
      name: 'live',
      options: { compose: SERVICE_COMPOSE },
    })
    const before = (await projectEnvironmentFlags(ctx)).size
    for (const start of [undefined, 'copy', 'empty']) {
      for (const name of ['Upper', 'common', 'x'.repeat(33), 'has space', 'tmp']) {
        const res = await createNamedEnvironment(ctx, cookie, {
          name,
          ...(start === undefined ? {} : { start }),
        })
        assertEquals(res.status, 400, `${start}/${name}`)
        assertEquals(res.json.error, 'invalid_environment_name')
      }
    }
    assertEquals((await projectEnvironmentFlags(ctx)).size, before)

    // A duplicate name is still refused, and renaming a copy is checked as before.
    const dup = await createNamedEnvironment(ctx, cookie, { name: 'live' })
    assertEquals([dup.status, dup.json.error], [409, 'environment_name_in_use'])
    const copy = await createNamedEnvironment(ctx, cookie, { name: 'copy-of-live' })
    const bad = await sendEnvironmentJson(ctx, cookie, 'PATCH', `/environments/${copy.id}`, {
      name: 'Bad Name',
    })
    assertEquals(bad.status, 400)
  })
})

test('start must be copy or empty and cannot be combined with options', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const invalid = await createNamedEnvironment(ctx, cookie, { name: 'a', start: 'base' })
    assertEquals([invalid.status, invalid.json.error], [400, 'environment_start_invalid'])
    const both = await createNamedEnvironment(ctx, cookie, {
      name: 'b',
      start: 'copy',
      options: { compose: SERVICE_COMPOSE },
    })
    assertEquals([both.status, both.json.error], [400, 'environment_start_conflict'])
  })
})

test('make primary moves the marker, keeps exactly one and refreshes cached reads', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const first = await createNamedEnvironment(ctx, cookie, { name: 'live' })
    const second = await createNamedEnvironment(ctx, cookie, { name: 'staging' })
    // Prime the cached reads with the old state.
    await sendEnvironmentJson(ctx, cookie, 'GET', `/environments/${first.id}`)
    await sendEnvironmentJson(ctx, cookie, 'GET', '/environments')

    const res = await sendEnvironmentJson(ctx, cookie, 'POST', `/environments/${second.id}/primary`)
    assertEquals(res.status, 200)
    const again = await sendEnvironmentJson(
      ctx,
      cookie,
      'POST',
      `/environments/${second.id}/primary`
    )
    assertEquals(again.status, 200)

    const flags = await projectEnvironmentFlags(ctx)
    assertEquals([flags.get('live')?.isPrimary, flags.get('staging')?.isPrimary], [false, true])

    const detail = await sendEnvironmentJson(ctx, cookie, 'GET', `/environments/${first.id}`)
    assertEquals(
      ((await detail.json()) as { environment: { isPrimary: boolean } }).environment.isPrimary,
      false
    )
    const list = await sendEnvironmentJson(
      ctx,
      cookie,
      'GET',
      `/environments?projectId=${ctx.projectId}`
    )
    const names = ((await list.json()) as { environments: { name: string }[] }).environments.map(
      (row) => row.name
    )
    assertEquals(names, ['staging', 'live'])

    const missing = await sendEnvironmentJson(
      ctx,
      cookie,
      'POST',
      `/environments/${crypto.randomUUID()}/primary`
    )
    assertEquals(missing.status, 404)
  })
})

test('the primary environment cannot be deleted while others exist', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const first = await createNamedEnvironment(ctx, cookie, { name: 'live' })
    const second = await createNamedEnvironment(ctx, cookie, { name: 'staging' })
    const refused = await sendEnvironmentJson(ctx, cookie, 'DELETE', `/environments/${first.id}`)
    assertEquals(refused.status, 409)
    assertEquals(
      ((await refused.json()) as { error: string }).error,
      'primary_environment_cannot_be_deleted'
    )
    await sendEnvironmentJson(ctx, cookie, 'POST', `/environments/${second.id}/primary`)
    const removed = await sendEnvironmentJson(ctx, cookie, 'DELETE', `/environments/${first.id}`)
    assertEquals(removed.status, 200)
    // The last one may go.
    const last = await sendEnvironmentJson(ctx, cookie, 'DELETE', `/environments/${second.id}`)
    assertEquals(last.status, 200)
  })
})

test('pinned environments are listed after the primary one; the body cannot set isPrimary', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    await createNamedEnvironment(ctx, cookie, { name: 'live' })
    const second = await createNamedEnvironment(ctx, cookie, { name: 'staging' })
    const third = await createNamedEnvironment(ctx, cookie, { name: 'review' })
    const pinned = await sendEnvironmentJson(ctx, cookie, 'PATCH', `/environments/${third.id}`, {
      pinned: true,
      isPrimary: true,
    })
    assertEquals(pinned.status, 200)
    const flags = await projectEnvironmentFlags(ctx)
    assertEquals([flags.get('review')?.isPinned, flags.get('review')?.isPrimary], [true, false])

    const list = await sendEnvironmentJson(
      ctx,
      cookie,
      'GET',
      `/environments?projectId=${ctx.projectId}`
    )
    const rows = ((await list.json()) as { environments: { name: string; pinned: boolean }[] })
      .environments
    assertEquals(
      rows.map((row) => row.name),
      ['live', 'review', 'staging']
    )

    const bad = await sendEnvironmentJson(ctx, cookie, 'PATCH', `/environments/${second.id}`, {
      pinned: 'yes',
    })
    assertEquals(bad.status, 400)
    const unpinned = await sendEnvironmentJson(ctx, cookie, 'PATCH', `/environments/${third.id}`, {
      pinned: false,
    })
    assertEquals(unpinned.status, 200)
    assertEquals((await projectEnvironmentFlags(ctx)).get('review')?.isPinned, false)
  })
})

test('the database allows one primary environment per project', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    await ctx.db
      .insert(environment)
      .values({ projectId: ctx.projectId, name: 'one', isPrimary: true })
    let refused = false
    try {
      await ctx.db
        .insert(environment)
        .values({ projectId: ctx.projectId, name: 'two', isPrimary: true })
    } catch {
      refused = true
    }
    assertEquals(refused, true)
  })
})

const PROD_SERVICE_COMPOSE = (sourceId: string) => ({
  version: 1,
  data: {
    services: {
      web: {
        image: 'nginx:1',
        container_name: 'prod-web',
        ports: ['8080:80', '3000'],
        'x-turbopanel': {
          hosting: [{ hostname: 'app.example.com' }],
          source: { sourceId, branch: 'main' },
        },
      },
    },
  },
  presentation: { keyOrder: ['services'], comments: {} },
})

test('a copy leaves out what must be unique, lists it, and has no push deploys', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    const [repo] = await ctx.db
      .insert(repository)
      .values({
        organizationId: ctx.organizationId,
        provider: 'github',
        repositoryUrl: `https://github.com/example/${crypto.randomUUID()}`,
      })
      .returning({ id: repository.id })
    try {
      const primary = await createNamedEnvironment(ctx, cookie, {
        name: 'live',
        options: { compose: PROD_SERVICE_COMPOSE(repo!.id) },
      })
      assertEquals(primary.status, 200)
      assertEquals(primary.json.notCopied, [])
      const copy = await createNamedEnvironment(ctx, cookie, { name: 'staging' })
      assertEquals(copy.status, 200)
      const notCopied = copy.json.notCopied as string[]
      assertEquals(notCopied.length, 6)

      const rows = await ctx.db
        .select({ id: environment.id, options: environment.options })
        .from(environment)
        .where(eq(environment.projectId, ctx.projectId))
      const stored = new Map(rows.map((row) => [row.id, row.options]))
      const web = (stored.get(copy.id) as StoredOptions).compose.data.services as Record<
        string,
        Record<string, unknown>
      >
      const webCopy = web.web!
      assertEquals(webCopy.container_name, undefined)
      assertEquals(webCopy.ports, ['3000'])
      assertEquals(webCopy.expose, ['80'])
      assertEquals((webCopy['x-turbopanel'] as Record<string, unknown>).hosting, undefined)

      // The production environment is untouched.
      assertEquals(
        (stored.get(primary.id) as StoredOptions).compose.data,
        PROD_SERVICE_COMPOSE(repo!.id).data
      )

      // The copy keeps the source, so it is watched, but a push never deploys it.
      const bindings = environmentBranchBindings({
        projectOptions: {
          compose: { version: 1, data: {}, presentation: { keyOrder: [], comments: {} } },
        },
        environmentOptions: stored.get(copy.id),
        sourceId: repo!.id,
        repositoryDefaultBranch: 'main',
      })
      assertEquals(decideEnvironmentPush(bindings, 'main'), 'push_deploys_off')
      const watches = await ctx.db.execute(
        sql`SELECT environment_id::text AS id FROM watch WHERE repository_id = ${repo!.id}::uuid`
      )
      assertEquals(
        (watches as unknown as { id: string }[]).map((row) => row.id).sort(),
        [primary.id, copy.id].sort()
      )
    } finally {
      await ctx.db.execute(sql`DELETE FROM watch WHERE repository_id = ${repo!.id}::uuid`)
      await ctx.db.update(project).set({ repositoryId: null }).where(eq(project.id, ctx.projectId))
      await ctx.db.delete(repository).where(eq(repository.id, repo!.id))
    }
  })
})

test('make primary is audited once, and a member without manage access gets 403', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    await createNamedEnvironment(ctx, cookie, { name: 'live' })
    const second = await createNamedEnvironment(ctx, cookie, { name: 'staging' })
    const [reader] = await ctx.db
      .insert(user)
      .values({
        email: `reader-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      })
      .returning({ id: user.id })
    try {
      await ctx.db.insert(grant).values({
        entityType: 'organization',
        entityId: ctx.organizationId,
        actorType: 'user',
        actorId: reader!.id,
        permission: 'organization:read',
      })
      const readerCookie = await sessionCookie(ctx.db, ctx.secrets, reader!.id)
      const denied = await sendEnvironmentJson(
        ctx,
        readerCookie,
        'POST',
        `/environments/${second.id}/primary`
      )
      assertEquals(denied.status, 403)
      assertEquals((await projectEnvironmentFlags(ctx)).get('staging')?.isPrimary, false)

      const done = await sendEnvironmentJson(
        ctx,
        cookie,
        'POST',
        `/environments/${second.id}/primary`
      )
      assertEquals(done.status, 200)
      await sendEnvironmentJson(ctx, cookie, 'POST', `/environments/${second.id}/primary`)
      const rows = await ctx.db
        .select({ actorUserId: audit.actorUserId, context: audit.context })
        .from(audit)
        .where(and(eq(audit.action, 'environment.primary.set'), eq(audit.targetId, second.id)))
      assertEquals(rows.length, 1)
      assertEquals(rows[0]?.actorUserId, ctx.userId)
    } finally {
      await ctx.db.delete(audit).where(eq(audit.targetId, second.id))
      await ctx.db.delete(grant).where(eq(grant.actorId, reader!.id))
      await ctx.db.delete(user).where(eq(user.id, reader!.id))
    }
  })
})

test('concurrent creates, swaps and deletes keep exactly one primary', async () => {
  await withEnvironmentFixtures(async (ctx) => {
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    // Three creates at once on an empty project: one of them is first.
    const created = await Promise.all(
      ['a', 'b', 'c'].map((name) => createNamedEnvironment(ctx, cookie, { name }))
    )
    assertEquals(
      created.map((row) => row.status),
      [200, 200, 200]
    )
    const primaries = async () =>
      [...(await projectEnvironmentFlags(ctx)).values()].filter((row) => row.isPrimary).length
    assertEquals(await primaries(), 1)

    // Competing swaps leave one primary.
    const swaps = await Promise.all(
      created.map((row) =>
        sendEnvironmentJson(ctx, cookie, 'POST', `/environments/${row.id}/primary`)
      )
    )
    assertEquals(
      swaps.map((res) => res.status),
      [200, 200, 200]
    )
    assertEquals(await primaries(), 1)

    // A delete racing a swap: the delete is refused or the swap wins first;
    // either way one primary remains.
    const flags = await ctx.db
      .select({ id: environment.id, isPrimary: environment.isPrimary })
      .from(environment)
      .where(eq(environment.projectId, ctx.projectId))
    const current = flags.find((row) => row.isPrimary)!
    const other = flags.find((row) => !row.isPrimary)!
    const [del, swap] = await Promise.all([
      sendEnvironmentJson(ctx, cookie, 'DELETE', `/environments/${current.id}`),
      sendEnvironmentJson(ctx, cookie, 'POST', `/environments/${other.id}/primary`),
    ])
    assertEquals(swap.status, 200)
    assertEquals([200, 409].includes(del.status), true)
    assertEquals(await primaries(), 1)
  })
})
