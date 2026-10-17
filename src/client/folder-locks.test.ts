/**
 * The naming locks that the folder table drives: environment rename and delete,
 * the project slug, and the organization folder-name setting. Needs a database.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertMatch } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { createDenoDb } from '../db/connection.ts'
import { getDatabaseUrl } from '../db/url.ts'
import {
  command,
  environment,
  folder,
  grant,
  organization,
  principal,
  project,
  server,
  service,
  user,
  workspace,
} from '../db/schema.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './authn/crypto.ts'
import { createSession } from './authn/session-store.ts'
import { ORG_ID_HEADER } from './org-context.ts'
import { registerEnvironmentFolderRoutes } from './environments/folder-routes.ts'
import { registerEnvironmentRoutes } from './environments/routes.ts'
import { registerOrganizationDirectoryDefaultsRoutes } from './organizations/directory-defaults-routes.ts'
import { registerProjectRoutes } from './projects/routes.ts'

const test = Deno.test.bind(Deno)
const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Ctx = {
  db: Db
  app: Hono<AppEnv>
  cookie: string
  organizationId: string
  workspaceId: string
  serverId: string
  principalId: string
}

async function withFixtures(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('folder lock tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  const opts = { secrets, runtime: 'deno', signupEnvOverride: undefined } as const
  registerOrganizationDirectoryDefaultsRoutes(app, opts)
  registerEnvironmentRoutes(app, opts)
  registerEnvironmentFolderRoutes(app, opts)
  registerProjectRoutes(app, opts)

  const [org] = await db
    .insert(organization)
    .values({ name: 'Folder Lock Test Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [account] = await db
    .insert(user)
    .values({
      email: `folder-lock-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = account!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Folder Lock Workspace', organizationId })
    .returning({ id: workspace.id })
  const now = new Date().toISOString()
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Alpha', createdAt: now, updatedAt: now })
    .returning({ id: server.id })
  const username = `fl_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
  const [owner] = await db
    .insert(principal)
    .values({
      organizationId,
      kind: 'system',
      provider: 'server',
      username,
      appliedUsername: username,
    })
    .returning({ id: principal.id })
  const { token } = await createSession(db, userId, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`

  try {
    await fn({
      db,
      app,
      cookie,
      organizationId,
      workspaceId: ws!.id,
      serverId: srv!.id,
      principalId: owner!.id,
    })
  } finally {
    const projectIds = (
      await db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.organizationId, organizationId))
    ).map((row) => row.id)
    const envIds =
      projectIds.length === 0
        ? []
        : (
            await db
              .select({ id: environment.id })
              .from(environment)
              .where(inArray(environment.projectId, projectIds))
          ).map((row) => row.id)
    await db.delete(folder).where(eq(folder.serverId, srv!.id))
    await db.delete(command).where(eq(command.serverId, srv!.id))
    if (envIds.length > 0) {
      await db.delete(service).where(inArray(service.environmentId, envIds))
      await db.delete(environment).where(inArray(environment.id, envIds))
    }
    await db.delete(principal).where(eq(principal.id, owner!.id))
    if (projectIds.length > 0) await db.delete(project).where(inArray(project.id, projectIds))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

async function send(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await ctx.app.request(path, {
    method,
    headers: {
      Cookie: ctx.cookie,
      [ORG_ID_HEADER]: ctx.organizationId,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function createProject(
  ctx: Ctx,
  name: string
): Promise<{ projectId: string; envId: string }> {
  const created = await send(ctx, 'POST', '/projects', {
    type: 'empty',
    workspaceId: ctx.workspaceId,
    name,
  })
  assertEquals(created.status, 200)
  const projectId = created.json.id as string
  const [env] = await ctx.db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))
  return { projectId, envId: env!.id }
}

async function addServiceFolder(
  ctx: Ctx,
  envId: string,
  slug: string,
  state: 'planned' | 'present' | 'removing' | 'missing' = 'planned'
): Promise<void> {
  const [svc] = await ctx.db
    .insert(service)
    .values({ environmentId: envId, composeServiceName: slug, name: slug, slug })
    .returning({ id: service.id })
  await ctx.db.insert(folder).values({
    serverId: ctx.serverId,
    principalId: ctx.principalId,
    environmentId: envId,
    scope: 'production',
    kind: 'service',
    slug,
    serviceId: svc!.id,
    state,
  })
}

test('a new project gets a slug from its name and a clash gets a suffix', async () => {
  await withFixtures(async (ctx) => {
    const first = await createProject(ctx, 'My Shop & Blog')
    const second = await createProject(ctx, 'my shop blog')
    const rows = await ctx.db
      .select({ id: project.id, slug: project.slug })
      .from(project)
      .where(eq(project.organizationId, ctx.organizationId))
    const bySlug = Object.fromEntries(rows.map((row) => [row.id, row.slug]))
    assertEquals(bySlug[first.projectId], 'my-shop-blog')
    assertEquals(bySlug[second.projectId], 'my-shop-blog-2')
    const read = await send(ctx, 'GET', `/projects/${first.projectId}`)
    assertEquals((read.json.project as { slug: string }).slug, 'my-shop-blog')
  })
})

test('PATCH /projects/:id changes the slug until a folder exists under the project', async () => {
  await withFixtures(async (ctx) => {
    const { projectId, envId } = await createProject(ctx, 'Slug Lock')
    const bad = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'Not A Slug' })
    assertEquals(bad.status, 400)
    const ok = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'renamed' })
    assertEquals(ok.status, 200)

    await addServiceFolder(ctx, envId, 'example.com')
    const locked = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'again' })
    assertEquals(locked.status, 409)
    assertEquals(locked.json.error, 'project_slug_locked')
    // The slug it already has is not a change.
    const same = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'renamed' })
    assertEquals(same.status, 200)
  })
})

test('a project slug already used in the organization is refused', async () => {
  await withFixtures(async (ctx) => {
    await createProject(ctx, 'First One')
    const other = await createProject(ctx, 'Second One')
    const clash = await send(ctx, 'PATCH', `/projects/${other.projectId}`, { slug: 'first-one' })
    assertEquals(clash.status, 409)
    assertEquals(clash.json.error, 'project_slug_in_use')
  })
})

test('renaming an environment follows the name rule and is free while no folder exists', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Free')
    for (const name of ['My Env', 'common', 'Staging', 'tmp']) {
      const refused = await send(ctx, 'PATCH', `/environments/${envId}`, { name })
      assertEquals(refused.status, 400, name)
      assertEquals(refused.json.error, 'invalid_environment_name', name)
    }
    const ok = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging_2' })
    assertEquals(ok.status, 200)
    // Editing something else is not a rename, whatever the name looks like.
    const note = await send(ctx, 'PATCH', `/environments/${envId}`, { description: 'x' })
    assertEquals(note.status, 200)
  })
})

test('an environment with a folder cannot be renamed or deleted and the blocking folders are listed', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Locked')
    await addServiceFolder(ctx, envId, 'example.com', 'present')
    await addServiceFolder(ctx, envId, 'blog.example.com', 'removing')

    const refused = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'environment_name_locked')
    assertEquals(refused.json.total, 2)
    const listed = refused.json.folders as Array<{
      slug: string
      state: string
      serverName: string
      assetName: string
    }>
    assertEquals(listed.map((row) => row.slug).sort(), ['blog.example.com', 'example.com'])
    assertEquals(listed[0]!.serverName, 'Alpha')
    assertMatch(String(refused.json.message), /cannot change/)

    // Writing the same name is not a rename.
    const [row] = await ctx.db
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.id, envId))
    const same = await send(ctx, 'PATCH', `/environments/${envId}`, { name: row!.name })
    assertEquals(same.status, 200)

    const list = await send(ctx, 'GET', `/environments/${envId}/folders`)
    assertEquals(list.status, 200)
    assertEquals(list.json.total, 2)

    const deleted = await send(ctx, 'DELETE', `/environments/${envId}`)
    assertEquals(deleted.status, 409)
    assertEquals(deleted.json.error, 'environment_has_folders')
  })
})

test('missing folders and the common scope do not block a rename; a finished confirmation lifts it', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Lifts')
    await addServiceFolder(ctx, envId, 'gone.example.com', 'missing')
    const [svc] = await ctx.db
      .insert(service)
      .values({ environmentId: envId, composeServiceName: 'shared', slug: 'shared' })
      .returning({ id: service.id })
    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: null,
      scope: 'common',
      kind: 'service',
      slug: 'shared',
      serviceId: svc!.id,
      state: 'present',
    })
    const ok = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(ok.status, 200)

    await ctx.db
      .update(folder)
      .set({ state: 'removing' })
      .where(and(eq(folder.serverId, ctx.serverId), eq(folder.slug, 'gone.example.com')))
    const blocked = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging-2' })
    assertEquals(blocked.status, 409)

    await ctx.db.delete(folder).where(eq(folder.slug, 'gone.example.com'))
    const lifted = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging-2' })
    assertEquals(lifted.status, 200)
  })
})

test('a running deploy holds the environment name', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Running')
    const [row] = await ctx.db
      .insert(command)
      .values({
        serverId: ctx.serverId,
        actorType: 'system',
        actorId: crypto.randomUUID(),
        name: 'environment.deploy',
        status: 'running',
        context: { environmentId: envId },
      })
      .returning({ id: command.id })
    const blocked = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'next' })
    assertEquals(blocked.status, 409)
    assertEquals(blocked.json.error, 'environment_deploy_running')

    await ctx.db.update(command).set({ status: 'succeeded' }).where(eq(command.id, row!.id))
    const ok = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'next' })
    assertEquals(ok.status, 200)
  })
})

test('the folder naming setting defaults to slug, changes freely, then locks with the first folder', async () => {
  await withFixtures(async (ctx) => {
    const path = `/organizations/${ctx.organizationId}/directory-defaults`
    const initial = await send(ctx, 'GET', path)
    assertEquals(initial.json, {
      names: null,
      effectiveNames: 'slug',
      locked: false,
      lockedByFolders: false,
    })

    assertEquals((await send(ctx, 'PUT', path, { names: 'nope' })).status, 400)
    assertEquals((await send(ctx, 'PUT', path, {})).status, 400)
    const both = await send(ctx, 'PUT', path, { names: 'both' })
    assertEquals(both.status, 200)
    assertEquals(both.json.effectiveNames, 'both')
    const uuid = await send(ctx, 'PUT', path, { names: 'uuid' })
    assertEquals(uuid.json.effectiveNames, 'uuid')
    const reset = await send(ctx, 'PUT', path, { names: null })
    assertEquals(reset.json.effectiveNames, 'slug')

    // A hand lock freezes the value until it is cleared.
    assertEquals((await send(ctx, 'PUT', path, { locked: true })).status, 200)
    const frozen = await send(ctx, 'PUT', path, { names: 'uuid' })
    assertEquals(frozen.status, 409)
    assertEquals(frozen.json.error, 'directory_names_locked')
    const unfrozen = await send(ctx, 'PUT', path, { locked: false, names: 'uuid' })
    assertEquals(unfrozen.status, 200)
    assertEquals(unfrozen.json.effectiveNames, 'uuid')

    const { envId } = await createProject(ctx, 'Setting Lock')
    await addServiceFolder(ctx, envId, 'example.com')
    const read = await send(ctx, 'GET', path)
    assertEquals(read.json.locked, true)
    assertEquals(read.json.lockedByFolders, true)
    const refused = await send(ctx, 'PUT', path, { names: 'slug' })
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'directory_names_locked')
    assertEquals((await send(ctx, 'PUT', path, { locked: false })).status, 409)
    // Writing the value already in force is accepted and changes nothing.
    assertEquals((await send(ctx, 'PUT', path, { names: 'uuid' })).status, 200)
  })
})
