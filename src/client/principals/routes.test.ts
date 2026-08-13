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
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  steward,
  environment,
  grant,
  organization,
  principal,
  project,
  server,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../lib/db/workspace-kind.ts'
import { principalHomeDir } from '../../lib/naming.ts'
import { DEFAULT_PRINCIPAL_SHELL } from '../../lib/principal-options.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  registerOrganizationLimitsRoutes,
  registerProjectPrincipalRoutes,
  registerServerLimitsRoutes,
} from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createPrincipalRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerProjectPrincipalRoutes(app, { secrets, runtime: 'deno' })
  registerOrganizationLimitsRoutes(app, { secrets, runtime: 'deno' })
  registerServerLimitsRoutes(app, { secrets, runtime: 'deno' })
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

async function withPrincipalFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    projectId: string
    environmentId: string
    serviceId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping principal route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createPrincipalRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Principal Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `principal-route-${crypto.randomUUID()}@example.com`,
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
    .values({ name: 'Principal Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Principal Route Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Principal Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      projectId,
      name: 'Production',
      serverId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [insertedService] = await db
    .insert(service)
    .values({
      environmentId,
      name: 'Web',
      composeServiceName: 'web',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })
  const serviceId = insertedService!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serviceId,
      serverId,
    })
  } finally {
    await db.delete(steward).where(eq(steward.serviceId, serviceId))
    await db.delete(principal).where(eq(principal.projectId, projectId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /projects/:projectId/principals persists default shell when options omitted', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'appuser' }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      id: string
      uid?: number
      gid?: number
    }
    assertEquals(body.ok, true)
    assertEquals(body.uid, undefined)
    assertEquals(body.gid, undefined)

    const [row] = await db
      .select({
        options: principal.options,
        provider: principal.provider,
        metadata: principal.metadata,
        username: principal.username,
      })
      .from(principal)
      .where(eq(principal.id, body.id))
      .limit(1)
    assertEquals(row?.options, { shell: DEFAULT_PRINCIPAL_SHELL })
    assertEquals(row?.provider, 'server')
    assertEquals(row?.metadata, { home: principalHomeDir('appuser') })
  })
})

test('POST /projects/:projectId/principals rejects reserved usernames', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'www-data' }),
    })

    assertEquals(res.status, 400)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'username_reserved')
  })
})

test('POST /projects/:projectId/principals rejects duplicate usernames in the org', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const first = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'AppUser' }),
    })
    assertEquals(first.status, 200)

    const second = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: '  appuser  ' }),
    })
    assertEquals(second.status, 409)
    const body = await second.json() as { error: string }
    assertEquals(body.error, 'username_in_use')
  })
})

test('POST /projects/:projectId/principals serializes concurrent same-name creates', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const [first, second] = await Promise.all([
      app.request(`/projects/${projectId}/principals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'RaceUser' }),
      }),
      app.request(`/projects/${projectId}/principals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: '  raceuser  ' }),
      }),
    ])

    const statuses = [first.status, second.status].sort((a, b) => a - b)
    assertEquals(statuses, [200, 409])

    const winner = first.status === 200 ? first : second
    const loser = first.status === 409 ? first : second
    assertEquals(winner.status, 200)
    assertEquals(loser.status, 409)
    const loserBody = await loser.json() as { error: string }
    assertEquals(loserBody.error, 'username_in_use')

    const rows = await db
      .select({ id: principal.id, username: principal.username })
      .from(principal)
      .where(eq(principal.projectId, projectId))
    assertEquals(rows.length, 1)
  })
})

test('POST /projects/:projectId/principals accepts max-length username and rejects overlong', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    // 28 chars — longest that still fits `<username>-grp` in 32.
    const longest = `u${'a'.repeat(27)}`
    assertEquals(longest.length, 28)

    const ok = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: longest }),
    })
    assertEquals(ok.status, 200)

    const overlong = `u${'a'.repeat(28)}`
    assertEquals(overlong.length, 29)
    const bad = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: overlong }),
    })
    assertEquals(bad.status, 400)
  })
})

test('POST /projects/:projectId/principals rejects invalid shell', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'appuser', options: { shell: 'bash' } }),
    })

    assertEquals(res.status, 400)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'Invalid request')
  })
})

test('POST /projects/:projectId/principals rejects non-object options', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'appuser', options: 'nologin' }),
    })

    assertEquals(res.status, 400)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'Invalid request')
  })
})

test('GET /projects/:projectId/principals lists principals with serviceIds', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    serviceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'deploy', serviceIds: [serviceId] }),
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { id: string }

    const list = await app.request(`/projects/${projectId}/principals`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(list.status, 200)
    const body = await list.json() as {
      principals: Array<{ id: string; username: string; serviceIds: string[] }>
    }
    assertEquals(body.principals.length, 1)
    assertEquals(body.principals[0]?.id, created.id)
    assertEquals(body.principals[0]?.username, 'deploy')
    assertEquals(body.principals[0]?.serviceIds, [serviceId])
  })
})

test('POST /projects/:projectId/principals accepts uid and gid override', async () => {
  await withPrincipalFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'customuid', uid: 10001, gid: 10001 }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; uid: number; gid: number }
    assertEquals(body.uid, 10001)
    assertEquals(body.gid, 10001)
  })
})

test('PATCH /projects/:projectId/principals/:id updates serviceIds', async () => {
  await withPrincipalFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
    projectId,
    serviceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'patchme' }),
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { id: string }

    const patch = await app.request(`/projects/${projectId}/principals/${created.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ serviceIds: [serviceId] }),
    })
    assertEquals(patch.status, 200)
    const patched = await patch.json() as { ok: boolean; serviceIds: string[] }
    assertEquals(patched.ok, true)
    assertEquals(patched.serviceIds, [serviceId])
  })
})

test('PATCH /projects/:projectId/principals/:id requires serviceIds field', async () => {
  await withPrincipalFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'nopatch' }),
    })
    const created = await create.json() as { id: string }

    const patch = await app.request(`/projects/${projectId}/principals/${created.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({}),
    })
    assertEquals(patch.status, 400)
  })
})

test('PATCH /projects/:projectId/principals/:id rejects invalid serviceIds', async () => {
  await withPrincipalFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'badsvc' }),
    })
    const created = await create.json() as { id: string }

    const patch = await app.request(`/projects/${projectId}/principals/${created.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ serviceIds: ['not-a-uuid'] }),
    })
    assertEquals(patch.status, 400)
    const body = await patch.json() as { error: string }
    assertEquals(body.error, 'invalid_service_ids')
  })
})

test('DELETE /projects/:projectId/principals/:id removes principal', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'deleteme' }),
    })
    const created = await create.json() as { id: string }

    const del = await app.request(`/projects/${projectId}/principals/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(del.status, 200)
    assertEquals(await del.json(), { ok: true })

    const rows = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.id, created.id))
    assertEquals(rows.length, 0)
  })
})

test('DELETE /projects/:projectId/principals/:id returns 404 when principal belongs to another project', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const workspaceRow = await db
      .select({ id: project.workspaceId })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
    const [otherProject] = await db
      .insert(project)
      .values({
        name: 'Other Principal Project',
        workspaceId: workspaceRow[0]!.id,
      })
      .returning({ id: project.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'foreign' }),
    })
    const created = await create.json() as { id: string }

    const del = await app.request(`/projects/${otherProject!.id}/principals/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(del.status, 404)

    await db.delete(principal).where(eq(principal.id, created.id))
    await db.delete(project).where(eq(project.id, otherProject!.id))
  })
})

test('POST /projects/:projectId/principals returns 404 for project in another org', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Principal Org' })
      .returning({ id: organization.id })
    const [otherWorkspace] = await db
      .insert(workspace)
      .values({ name: 'Foreign WS', organizationId: otherOrg!.id })
      .returning({ id: workspace.id })
    const [otherProject] = await db
      .insert(project)
      .values({ name: 'Foreign Project', workspaceId: otherWorkspace!.id })
      .returning({ id: project.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${otherProject!.id}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'nope' }),
    })
    assertEquals(res.status, 404)

    await db.delete(project).where(eq(project.id, otherProject!.id))
    await db.delete(workspace).where(eq(workspace.id, otherWorkspace!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('POST /projects/:projectId/principals rejects mutations on turbopanel workspace projects', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [platformWorkspace] = await db
      .insert(workspace)
      .values({
        name: 'Platform WS',
        organizationId,
        kind: WORKSPACE_KIND_TURBOPANEL,
      })
      .returning({ id: workspace.id })
    const [platformProject] = await db
      .insert(project)
      .values({ name: 'Platform Project', workspaceId: platformWorkspace!.id })
      .returning({ id: project.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${platformProject!.id}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'blocked' }),
    })
    assertEquals(res.status, 403)
    const body = await res.json() as { error: string }
    assertEquals(body.error, 'system_resource_immutable')

    await db.delete(project).where(eq(project.id, platformProject!.id))
    await db.delete(workspace).where(eq(workspace.id, platformWorkspace!.id))
  })
})

test('GET and PUT /organizations/:id/resource-limits round-trip limits', async () => {
  await withPrincipalFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
    })

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const getEmpty = await app.request(`/organizations/${organizationId}/resource-limits`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(getEmpty.status, 200)
    assertEquals(await getEmpty.json(), { resourceLimits: {} })

    const put = await app.request(`/organizations/${organizationId}/resource-limits`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ resourceLimits: { maxCpus: 4, maxMemoryBytes: 8192 } }),
    })
    assertEquals(put.status, 200)
    const putBody = await put.json() as {
      ok: boolean
      resourceLimits: { maxCpus: number; maxMemoryBytes: number }
    }
    assertEquals(putBody.ok, true)
    assertEquals(putBody.resourceLimits.maxCpus, 4)

    const get = await app.request(`/organizations/${organizationId}/resource-limits`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(get.status, 200)
    const getBody = await get.json() as {
      resourceLimits: { maxCpus: number; maxMemoryBytes: number }
    }
    assertEquals(getBody.resourceLimits.maxCpus, 4)
    assertEquals(getBody.resourceLimits.maxMemoryBytes, 8192)

    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
      eq(grant.permission, 'organization:own'),
    ))
  })
})

test('GET and PUT /servers/:id/resource-limits round-trip limits', async () => {
  await withPrincipalFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const getEmpty = await app.request(`/servers/${serverId}/resource-limits`, { headers })
    assertEquals(getEmpty.status, 200)
    assertEquals(await getEmpty.json(), { resourceLimits: {} })

    const put = await app.request(`/servers/${serverId}/resource-limits`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ resourceLimits: { maxServicesPerEnvironment: 10 } }),
    })
    assertEquals(put.status, 200)
    const putBody = await put.json() as {
      ok: boolean
      resourceLimits: { maxServicesPerEnvironment: number }
    }
    assertEquals(putBody.resourceLimits.maxServicesPerEnvironment, 10)

    const get = await app.request(`/servers/${serverId}/resource-limits`, { headers })
    assertEquals(get.status, 200)
    const getBody = await get.json() as {
      resourceLimits: { maxServicesPerEnvironment: number }
    }
    assertEquals(getBody.resourceLimits.maxServicesPerEnvironment, 10)
  })
})

test('PUT /organizations/:id/resource-limits returns 400 for invalid limits', async () => {
  await withPrincipalFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
    })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/organizations/${organizationId}/resource-limits`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ resourceLimits: 'bad' }),
    })
    assertEquals(res.status, 400)

    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
      eq(grant.permission, 'organization:own'),
    ))
  })
})
