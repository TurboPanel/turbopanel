/**
 * Fixtures for the suites that drive the folder rules through the real routes:
 * an organization with a manager session, one server, one site owner, and the
 * environment, project, folder, service, storage and share routes mounted on
 * one app. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { createSession } from '../client/authn/session-store.ts'
import { ORG_ID_HEADER } from '../client/org-context.ts'
import { registerEnvironmentFolderRoutes } from '../client/environments/folder-routes.ts'
import { registerEnvironmentRoutes } from '../client/environments/routes.ts'
import { registerEnvironmentShareRoutes } from '../client/environments/share-routes.ts'
import { registerOrganizationDirectoryDefaultsRoutes } from '../client/organizations/directory-defaults-routes.ts'
import { registerProjectRoutes } from '../client/projects/routes.ts'
import { registerServiceRoutes } from '../client/services/routes.ts'
import { registerStorageRoutes } from '../client/storage/routes.ts'
import { createDenoDb } from '../db/connection.ts'
import { getDatabaseUrl } from '../db/url.ts'
import {
  command,
  environment,
  folder,
  grant,
  mount,
  organization,
  principal,
  project,
  server,
  service,
  share,
  storage,
  storageCopy,
  tenancy,
  user,
  workspace,
} from '../db/schema.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from './secrets.ts'
import { skipWithoutDatabase } from './require-service.test.support.ts'

const dbUrl = getDatabaseUrl()

export type Db = ReturnType<typeof createDenoDb>

export type Ctx = {
  db: Db
  app: Hono<AppEnv>
  cookie: string
  userId: string
  organizationId: string
  workspaceId: string
  serverId: string
  principalId: string
}

export async function withFolderFixtures(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('folder rule tests')
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
  registerServiceRoutes(app, opts)
  registerStorageRoutes(app, opts)
  registerEnvironmentShareRoutes(app, opts)

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
      userId,
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
      await db.delete(share).where(inArray(share.environmentId, envIds))
      const serviceIds = (
        await db
          .select({ id: service.id })
          .from(service)
          .where(inArray(service.environmentId, envIds))
      ).map((row) => row.id)
      if (serviceIds.length > 0) {
        await db.delete(share).where(inArray(share.serviceId, serviceIds))
        await db.delete(mount).where(inArray(mount.serviceId, serviceIds))
        await db.delete(tenancy).where(inArray(tenancy.serviceId, serviceIds))
      }
    }
    const storageIds = (
      await db
        .select({ id: storage.id })
        .from(storage)
        .where(eq(storage.organizationId, organizationId))
    ).map((row) => row.id)
    if (storageIds.length > 0) {
      await db.delete(share).where(inArray(share.storageId, storageIds))
      await db.delete(mount).where(inArray(mount.storageId, storageIds))
      await db.delete(storageCopy).where(inArray(storageCopy.storageId, storageIds))
      await db.delete(storage).where(inArray(storage.id, storageIds))
    }
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

export async function send(
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

export async function createProject(
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
