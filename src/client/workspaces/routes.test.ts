import { assertEquals } from 'jsr:@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
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
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import {
  container,
  environment,
  grant,
  member,
  organization,
  project,
  server,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import {
  WORKSPACE_KIND_SYSTEM,
  WORKSPACE_KIND_USER,
} from '../../lib/db/workspace-kind.ts'
import { SYSTEM_RESOURCE_IMMUTABLE_ERROR } from '../authz/http.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  ensureSystemHierarchy,
  ensureSystemWorkspace,
  SYSTEM_WORKSPACE_DISPLAY_NAME,
} from '../system/hierarchy.ts'
import { registerWorkspaceRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createWorkspaceRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerWorkspaceRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
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

async function cleanupOrgHierarchy(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
): Promise<void> {
  const workspaceRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId))
  const workspaceIds = workspaceRows.map((row) => row.id)

  if (workspaceIds.length > 0) {
    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(inArray(project.workspaceId, workspaceIds))
    const projectIds = projectRows.map((row) => row.id)

    if (projectIds.length > 0) {
      const envRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(inArray(environment.projectId, projectIds))
      const environmentIds = envRows.map((row) => row.id)

      if (environmentIds.length > 0) {
        const serviceRows = await db
          .select({ id: service.id })
          .from(service)
          .where(inArray(service.environmentId, environmentIds))
        const serviceIds = serviceRows.map((row) => row.id)

        if (serviceIds.length > 0) {
          await db
            .delete(container)
            .where(inArray(container.serviceId, serviceIds))
          await db.delete(service).where(inArray(service.id, serviceIds))
        }
        await db
          .delete(environment)
          .where(inArray(environment.id, environmentIds))
      }
      await db.delete(project).where(inArray(project.id, projectIds))
    }
    await db.delete(workspace).where(inArray(workspace.id, workspaceIds))
  }

  await db.delete(server).where(eq(server.organizationId, organizationId))
}

async function withWorkspaceFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serverId: string
    systemWorkspaceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping workspace route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createWorkspaceRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Workspace Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `workspace-route-${crypto.randomUUID()}@example.com`,
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

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Workspace Route Test Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const hierarchy = await ensureSystemHierarchy(db, { organizationId, serverId })

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serverId,
      systemWorkspaceId: hierarchy.workspaceId,
    })
  } finally {
    await cleanupOrgHierarchy(db, organizationId)
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('GET /workspaces returns System before Default for same-transaction install order', async () => {
  if (!dbUrl) {
    console.warn('Skipping workspace route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createWorkspaceRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Workspace Install Order Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `workspace-install-order-${crypto.randomUUID()}@example.com`,
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

  // Mirror install transaction insert order: System then Default Workspace.
  await db.transaction(async (tx) => {
    await ensureSystemWorkspace(tx, organizationId)
    await tx.insert(workspace).values({
      organizationId,
      name: 'Default Workspace',
      kind: WORKSPACE_KIND_USER,
    })
  })

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const list = await app.request('/workspaces', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(list.status, 200)
    const body = await list.json() as {
      workspaces: Array<{ displayName: string; kind: string }>
    }
    assertEquals(body.workspaces.length, 2)
    assertEquals(body.workspaces[0]?.displayName, SYSTEM_WORKSPACE_DISPLAY_NAME)
    assertEquals(body.workspaces[0]?.kind, WORKSPACE_KIND_SYSTEM)
    assertEquals(body.workspaces[1]?.displayName, 'Default Workspace')
    assertEquals(body.workspaces[1]?.kind, WORKSPACE_KIND_USER)
  } finally {
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('POST /workspaces rejects duplicate display names case-insensitively', async () => {
  await withWorkspaceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const first = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Team Space' }),
    })
    assertEquals(first.status, 200)

    const duplicate = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: '  team space  ' }),
    })
    assertEquals(duplicate.status, 409)
    assertEquals(await duplicate.json(), { error: 'workspace_name_in_use' })
  })
})

test('PATCH /workspaces/:id rejects renaming onto another workspace name', async () => {
  await withWorkspaceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createA = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Workspace A' }),
    })
    assertEquals(createA.status, 200)

    const createB = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Workspace B' }),
    })
    assertEquals(createB.status, 200)
    const { id: workspaceBId } = await createB.json() as { id: string }

    const rename = await app.request(`/workspaces/${workspaceBId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'workspace a' }),
    })
    assertEquals(rename.status, 409)
    assertEquals(await rename.json(), { error: 'workspace_name_in_use' })
  })
})

test('workspace reads expose kind and system workspace is immutable', async () => {
  await withWorkspaceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    systemWorkspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const list = await app.request('/workspaces', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(list.status, 200)
    const listBody = await list.json() as {
      workspaces: Array<{ id: string; kind: string }>
    }
    const systemRow = listBody.workspaces.find((row) => row.id === systemWorkspaceId)
    if (!systemRow) throw new TypeError('expected system workspace in list')
    assertEquals(systemRow.kind, WORKSPACE_KIND_SYSTEM)

    const detail = await app.request(`/workspaces/${systemWorkspaceId}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(detail.status, 200)
    const detailBody = await detail.json() as { workspace: { kind: string } }
    assertEquals(detailBody.workspace.kind, WORKSPACE_KIND_SYSTEM)

    const create = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'X', kind: 'system' }),
    })
    assertEquals(create.status, 200)
    const { id: createdId } = await create.json() as { id: string }
    const [created] = await db
      .select({ kind: workspace.kind })
      .from(workspace)
      .where(eq(workspace.id, createdId))
      .limit(1)
    assertEquals(created?.kind, 'user')

    const namedSystem = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'System' }),
    })
    assertEquals(namedSystem.status, 409)
    assertEquals(await namedSystem.json(), { error: 'workspace_name_in_use' })

    const renameOntoSystem = await app.request(`/workspaces/${createdId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'System' }),
    })
    assertEquals(renameOntoSystem.status, 409)
    assertEquals(await renameOntoSystem.json(), { error: 'workspace_name_in_use' })

    const patch = await app.request(`/workspaces/${systemWorkspaceId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Renamed System' }),
    })
    assertEquals(patch.status, 403)
    assertEquals(await patch.json(), { error: SYSTEM_RESOURCE_IMMUTABLE_ERROR })

    const del = await app.request(`/workspaces/${systemWorkspaceId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(del.status, 403)
    assertEquals(await del.json(), { error: SYSTEM_RESOURCE_IMMUTABLE_ERROR })
  })
})
