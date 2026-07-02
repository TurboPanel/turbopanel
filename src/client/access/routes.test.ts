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
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  environment,
  grant,
  managed,
  member,
  organization,
  project,
  team,
  user,
  variable,
  workspace,
} from '../../lib/db/schema.ts'
import { registerAccessRoutes } from './routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'

import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

async function createAccessTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerAccessRoutes(app, { secrets, runtime: 'deno' })
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

function orgRequestHeaders(
  cookie: string,
  organizationId: string,
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
  }
}

async function withTestFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    actorId: string
    targetId: string
    organizationId: string
    workspaceId: string
    teamId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping access route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createAccessTestApp(db)

  const actorEmail = `access-route-actor-${crypto.randomUUID()}@example.com`
  const targetEmail = `access-route-target-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ displayName: 'Access Route Test Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedActor = await db
    .insert(user)
    .values({ email: actorEmail, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const actorId = insertedActor[0]!.id

  const insertedTarget = await db
    .insert(user)
    .values({ email: targetEmail, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const targetId = insertedTarget[0]!.id

  await db.insert(member).values({ organizationId, userId: actorId })
  await db.insert(member).values({ organizationId, userId: targetId })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Access Route Workspace', organizationId })
    .returning({ id: workspace.id })

  const workspaceId = insertedWorkspace!.id

  const [insertedTeam] = await db
    .insert(team)
    .values({ displayName: 'Access Route Team', organizationId })
    .returning({ id: team.id })

  const teamId = insertedTeam!.id

  try {
    await fn({
      db,
      app,
      secrets,
      actorId,
      targetId,
      organizationId,
      workspaceId,
      teamId,
    })
  } finally {
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(grant).where(eq(grant.entityId, teamId))
    await db.delete(grant).where(eq(grant.entityId, workspaceId))
    await db.delete(member).where(eq(member.organizationId, organizationId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, actorId))
    await db.delete(user).where(eq(user.id, targetId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('DELETE /access/:id rejects revoking the sole organization owner', async () => {
  await withTestFixtures(async ({ db, app, secrets, actorId, organizationId }) => {
    const [soleOwnerGrant] = await db
      .insert(grant)
      .values({
        entityType: 'organization',
        entityId: organizationId,
        subjectType: 'user',
        subjectId: actorId,
        permission: 'organization:own',
        allow: true,
      })
      .returning({ id: grant.id })

    const cookie = await sessionCookie(db, secrets, actorId)
    const res = await app.request(`/access/${soleOwnerGrant!.id}`, {
      method: 'DELETE',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    if (res.status !== 409) {
      throw new Error(`expected 409 when revoking sole org owner, got ${res.status}`)
    }
  })
})

Deno.test('DELETE /access/:id allows revoking a non-final organization owner', async () => {
  await withTestFixtures(async ({ db, app, secrets, actorId, targetId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: actorId,
      permission: 'organization:own',
      allow: true,
    })

    const [targetGrant] = await db
      .insert(grant)
      .values({
        entityType: 'organization',
        entityId: organizationId,
        subjectType: 'user',
        subjectId: targetId,
        permission: 'organization:own',
        allow: true,
      })
      .returning({ id: grant.id })

    const cookie = await sessionCookie(db, secrets, actorId)
    const res = await app.request(`/access/${targetGrant!.id}`, {
      method: 'DELETE',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    if (res.status !== 200) {
      throw new Error(`expected 200 when revoking non-final org owner, got ${res.status}`)
    }
  })
})

Deno.test('DELETE /access/:id rejects revoking the sole team owner', async () => {
  await withTestFixtures(async ({ db, app, secrets, actorId, targetId, organizationId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: actorId,
      permission: 'organization:own',
      allow: true,
    })

    const [teamOwnerGrant] = await db
      .insert(grant)
      .values({
        entityType: 'team',
        entityId: teamId,
        subjectType: 'user',
        subjectId: targetId,
        permission: 'team:own',
        allow: true,
      })
      .returning({ id: grant.id })

    const cookie = await sessionCookie(db, secrets, actorId)
    const res = await app.request(`/access/${teamOwnerGrant!.id}`, {
      method: 'DELETE',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    if (res.status !== 409) {
      throw new Error(`expected 409 when revoking sole team owner, got ${res.status}`)
    }
  })
})

Deno.test('GET /access/check honors team-scoped grants without org grants', async () => {
  await withTestFixtures(async ({ db, app, secrets, targetId, organizationId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      subjectType: 'user',
      subjectId: targetId,
      permission: 'team:manage',
      allow: true,
    })

    const cookie = await sessionCookie(db, secrets, targetId)
    const res = await app.request(
      `/access/check?resourceId=${teamId}&permissionKey=team:manage`,
      { headers: orgRequestHeaders(cookie, organizationId) },
    )

    if (res.status !== 200) {
      throw new Error(`expected 200 from access/check, got ${res.status}`)
    }

    const body = await res.json() as { allowed: boolean }
    if (!body.allowed) {
      throw new Error('team:manage grant should allow access/check on team resource')
    }
  })
})

Deno.test('POST /access rejects organization permission on workspace entity', async () => {
  await withTestFixtures(async ({
    db,
    app,
    secrets,
    actorId,
    targetId,
    organizationId,
    workspaceId,
  }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: actorId,
      permission: 'organization:own',
      allow: true,
    })

    const cookie = await sessionCookie(db, secrets, actorId)
    const res = await app.request('/access', {
      method: 'POST',
      headers: {
        ...orgRequestHeaders(cookie, organizationId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subjectKind: 'user',
        subjectId: targetId,
        resourceId: workspaceId,
        effect: 'allow',
        permissionKey: 'organization:own',
      }),
    })

    if (res.status !== 404) {
      throw new Error(`expected 404 for grant on workspace entity, got ${res.status}`)
    }
  })
})

Deno.test('GET /access/check returns boolean for variable and managed resource ids', async () => {
  await withTestFixtures(async ({
    db,
    app,
    secrets,
    actorId,
    organizationId,
    workspaceId,
  }) => {
    const [insertedProject] = await db
      .insert(project)
      .values({ displayName: 'Access Route Project', workspaceId })
      .returning({ id: project.id })

    const projectId = insertedProject!.id

    const [insertedManaged] = await db
      .insert(managed)
      .values({ projectId })
      .returning({ id: managed.id })

    const managedId = insertedManaged!.id

    const [insertedEnvironment] = await db
      .insert(environment)
      .values({ displayName: 'Access Route Env', projectId })
      .returning({ id: environment.id })

    const environmentId = insertedEnvironment!.id

    const [insertedVariable] = await db
      .insert(variable)
      .values({ environmentId, key: 'ACCESS_ROUTE_VAR', value: '1' })
      .returning({ id: variable.id })

    const variableId = insertedVariable!.id

    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: actorId,
      permission: 'organization:manage',
      allow: true,
    })

    const cookie = await sessionCookie(db, secrets, actorId)

    try {
      for (const resourceId of [managedId, variableId]) {
        const res = await app.request(
          `/access/check?resourceId=${resourceId}&permissionKey=organization:manage`,
          { headers: orgRequestHeaders(cookie, organizationId) },
        )

        if (res.status !== 200) {
          throw new Error(
            `expected 200 from access/check for ${resourceId}, got ${res.status}`,
          )
        }

        const body = await res.json() as { allowed: boolean }
        if (!body.allowed) {
          throw new Error(`organization:manage should allow access/check for ${resourceId}`)
        }
      }
    } finally {
      await db.delete(variable).where(eq(variable.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.projectId, projectId))
      await db.delete(managed).where(eq(managed.projectId, projectId))
      await db.delete(project).where(eq(project.id, projectId))
    }
  })
})

Deno.test('GET /access/resource-id rejects unsupported workspace kind', async () => {
  await withTestFixtures(async ({
    db,
    app,
    secrets,
    actorId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, actorId)
    const res = await app.request(
      `/access/resource-id?kind=workspace&itemId=${workspaceId}`,
      { headers: orgRequestHeaders(cookie, organizationId) },
    )

    if (res.status !== 404) {
      throw new Error(`expected 404 for workspace resource-id kind, got ${res.status}`)
    }
  })
})

Deno.test('GET /access/resource-id allows admin session for team kind', async () => {
  await withTestFixtures(async ({ db, app, secrets, organizationId, teamId }) => {
    const adminEmail = `access-route-admin-${crypto.randomUUID()}@example.com`

    const insertedAdmin = await db
      .insert(user)
      .values({ email: adminEmail, isEmailVerified: true, role: 'admin' })
      .returning({ id: user.id })

    const adminId = insertedAdmin[0]!.id

    try {
      await db.insert(member).values({ organizationId, userId: adminId })

      const cookie = await sessionCookie(db, secrets, adminId)
      const res = await app.request(
        `/access/resource-id?kind=team&itemId=${teamId}`,
        { headers: orgRequestHeaders(cookie, organizationId) },
      )

      if (res.status !== 200) {
        throw new Error(`expected 200 for admin team resource-id, got ${res.status}`)
      }

      const body = await res.json() as { resourceId: string; kind: string; itemId: string }
      if (body.resourceId !== teamId || body.kind !== 'team' || body.itemId !== teamId) {
        throw new Error('admin team resource-id response did not echo team identifiers')
      }
    } finally {
      await db.delete(member).where(and(
        eq(member.userId, adminId),
        eq(member.organizationId, organizationId),
      ))
      await db.delete(user).where(eq(user.id, adminId))
    }
  })
})
