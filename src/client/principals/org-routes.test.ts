import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  environment,
  grant,
  login,
  managed,
  organization,
  principal,
  principalPlacement,
  project,
  server,
  service,
  team,
  teammate,
  tenancy,
  user,
  workspace,
  audit,
} from '../../db/schema.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerOrganizationPrincipalRoutes } from './org-routes.ts'

const dbUrl = getDatabaseUrl()

/** Alias so Sonar's typescript:S2187 sees real tests (see routes.test.ts). */
const test = Deno.test.bind(Deno)

type Db = ReturnType<typeof createDenoDb>

async function withFixtures(
  fn: (ctx: {
    db: Db
    app: Hono<AppEnv>
    cookie: string
    outsiderCookie: string
    memberCookie: string
    organizationId: string
    projectId: string
    environmentId: string
    serverId: string
    otherServerId: string
    tag: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('organization principal route tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerOrganizationPrincipalRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const tag = crypto.randomUUID().slice(0, 8)
  const [org] = await db
    .insert(organization)
    .values({ name: `Org Principals ${tag}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [otherOrg] = await db
    .insert(organization)
    .values({ name: `Other Org Principals ${tag}` })
    .returning({ id: organization.id })
  const [manager] = await db
    .insert(user)
    .values({ email: `org-principals-${tag}@example.com`, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const [outsider] = await db
    .insert(user)
    .values({ email: `org-principals-out-${tag}@example.com`, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const [member] = await db
    .insert(user)
    .values({ email: `org-principals-mem-${tag}@example.com`, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  // A member sees the organization but holds no manage grant.
  const [crew] = await db
    .insert(team)
    .values({ organizationId, name: `Crew ${tag}` })
    .returning({ id: team.id })
  await db.insert(teammate).values({ teamId: crew!.id, userId: member!.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: manager!.id,
    permission: 'organization:manage',
  })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: otherOrg!.id,
    actorType: 'user',
    actorId: outsider!.id,
    permission: 'organization:manage',
  })
  const [ws] = await db
    .insert(workspace)
    .values({ name: `WS ${tag}`, organizationId })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ name: `Project ${tag}`, workspaceId: ws!.id, organizationId })
    .returning({ id: project.id })
  const now = new Date().toISOString()
  const servers = await db
    .insert(server)
    .values([
      { organizationId, name: `Alpha ${tag}`, createdAt: now, updatedAt: now },
      { organizationId, name: `Beta ${tag}`, createdAt: now, updatedAt: now },
    ])
    .returning({ id: server.id })
  const [env] = await db
    .insert(environment)
    .values({
      projectId: proj!.id,
      name: 'production',
      serverId: servers[0]!.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: environment.id })

  const cookieFor = async (userId: string) => {
    const { token } = await createSession(db, userId, {})
    return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  }
  try {
    await fn({
      db,
      app,
      cookie: await cookieFor(manager!.id),
      outsiderCookie: await cookieFor(outsider!.id),
      memberCookie: await cookieFor(member!.id),
      organizationId,
      projectId: proj!.id,
      environmentId: env!.id,
      serverId: servers[0]!.id,
      otherServerId: servers[1]!.id,
      tag,
    })
  } finally {
    await db.delete(principal).where(eq(principal.organizationId, organizationId))
    await db.delete(service).where(eq(service.environmentId, env!.id))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(server).where(
      inArray(
        server.id,
        servers.map((s) => s.id)
      )
    )
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(grant).where(inArray(grant.actorId, [manager!.id, outsider!.id]))
    await db.delete(teammate).where(eq(teammate.teamId, crew!.id))
    await db.delete(team).where(eq(team.id, crew!.id))
    await db.delete(user).where(inArray(user.id, [manager!.id, outsider!.id, member!.id]))
    await db.delete(organization).where(inArray(organization.id, [organizationId, otherOrg!.id]))
  }
}

async function addPrincipal(
  db: Db,
  organizationId: string,
  name: string,
  projectId: string | null
): Promise<string> {
  const [row] = await db
    .insert(principal)
    .values({
      organizationId,
      projectId,
      username: name,
      appliedUsername: name,
    })
    .returning({ id: principal.id })
  return row!.id
}

test('GET /organizations/:id/principals lists forms, servers, project and orphan state', async () => {
  await withFixtures(
    async ({
      db,
      app,
      cookie,
      organizationId,
      projectId,
      environmentId,
      serverId,
      otherServerId,
      tag,
    }) => {
      const kept = await addPrincipal(db, organizationId, `kept_${tag}`, projectId)
      const orphan = await addPrincipal(db, organizationId, `orphan_${tag}`, null)
      const loginOnly = await addPrincipal(db, organizationId, `dbonly_${tag}`, null)
      await db.insert(principalPlacement).values([
        {
          principalId: kept,
          serverId,
          state: 'present',
          uid: 15001,
          gid: 15001,
          home: '/h/k',
          source: 'manual',
        },
        { principalId: orphan, serverId, state: 'present', home: '/h/o', source: 'manual' },
        {
          principalId: orphan,
          serverId: otherServerId,
          state: 'retiring',
          home: '/h/o',
          source: 'manual',
        },
      ])
      const [cluster] = await db
        .insert(managed)
        .values({ environmentId, serverId, name: `DB ${tag}`, engine: 'postgres', status: 'ready' })
        .returning({ id: managed.id })
      await db.insert(login).values([
        {
          recipe: 'app',
          managedId: cluster!.id,
          principalId: loginOnly,
          role: 'user',
          username: `dbonly_${tag}`,
          appliedUsername: `dbonly_${tag}`,
        },
        {
          recipe: 'admin',
          managedId: cluster!.id,
          principalId: null,
          role: 'root',
          username: `postgres_${tag}`,
          appliedUsername: `postgres_${tag}`,
        },
      ])
      const res = await app.request(`/organizations/${organizationId}/principals`, {
        headers: { Cookie: cookie },
      })
      assertEquals(res.status, 200)
      const body = (await res.json()) as {
        principals: Array<{
          id: string
          name: string
          forms: string[]
          projectName: string | null
          servers: Array<{ serverName: string; state: string }>
          logins: Array<{ appliedUsername: string }>
          state: string
          orphaned: boolean
          canDelete: boolean
          usedBy: { logins: number }
        }>
      }
      const byId = new Map(body.principals.map((p) => [p.id, p]))
      assertEquals(body.principals.length, 3)
      const keptRow = byId.get(kept)!
      assertEquals(keptRow.forms, ['system'])
      assertEquals(keptRow.projectName, `Project ${tag}`)
      assertEquals(
        keptRow.servers.map((s) => s.serverName),
        [`Alpha ${tag}`]
      )
      assertEquals([keptRow.orphaned, keptRow.canDelete], [false, false])

      const orphanRow = byId.get(orphan)!
      assertEquals(
        orphanRow.servers.map((s) => [s.serverName, s.state]),
        [
          [`Alpha ${tag}`, 'present'],
          [`Beta ${tag}`, 'retiring'],
        ]
      )
      assertEquals(orphanRow.state, 'retiring')
      assertEquals([orphanRow.orphaned, orphanRow.canDelete], [true, true])

      const loginRow = byId.get(loginOnly)!
      assertEquals(loginRow.forms, ['system', 'database'])
      assertEquals(
        loginRow.logins.map((l) => l.appliedUsername),
        [`dbonly_${tag}`]
      )
      assertEquals(loginRow.usedBy.logins, 1)
      assertEquals([loginRow.orphaned, loginRow.canDelete], [false, false])
    }
  )
})

test('GET /organizations/:id/principals answers 404 to an outsider and 401 without a session', async () => {
  await withFixtures(async ({ app, outsiderCookie, organizationId }) => {
    const outsider = await app.request(`/organizations/${organizationId}/principals`, {
      headers: { Cookie: outsiderCookie },
    })
    assertEquals(outsider.status, 404)
    const anon = await app.request(`/organizations/${organizationId}/principals`)
    assertEquals(anon.status, 401)
    const bad = await app.request('/organizations/not-a-uuid/principals', {
      headers: { Cookie: outsiderCookie },
    })
    assertEquals(bad.status, 404)
  })
})

test('DELETE /organizations/:id/principals/:principalId removes an orphan and retires its placements', async () => {
  await withFixtures(async ({ db, app, cookie, organizationId, serverId, tag }) => {
    const orphan = await addPrincipal(db, organizationId, `gone_${tag}`, null)
    await db
      .insert(principalPlacement)
      .values({ principalId: orphan, serverId, state: 'present', home: '/h/g', source: 'manual' })
    const res = await app.request(`/organizations/${organizationId}/principals/${orphan}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    assertEquals(res.status, 200)
    // The test app has no command queue: the reached server is reported, not queued.
    assertEquals(await res.json(), {
      ok: true,
      reconciled: { queuedServerIds: [], failedServerIds: [serverId] },
    })
    assertEquals((await db.select().from(principal).where(eq(principal.id, orphan))).length, 0)
    const trail = await db.select().from(audit).where(eq(audit.targetId, orphan))
    try {
      assertEquals(trail.length, 1)
      assertEquals(trail[0]!.action, 'principal.delete')
      assertEquals(trail[0]!.targetType, 'principal')
      assertEquals(trail[0]!.organizationId, organizationId)
      const context = trail[0]!.context as { username: string; appliedUsername: string }
      assertEquals([context.username, context.appliedUsername], [`gone_${tag}`, `gone_${tag}`])
    } finally {
      await db.delete(audit).where(eq(audit.targetId, orphan))
    }
    assertEquals(
      (await db.select().from(principalPlacement).where(eq(principalPlacement.principalId, orphan)))
        .length,
      0
    )
  })
})

test('DELETE /organizations/:id/principals/:principalId refuses a principal that is in use, has a project or a login', async () => {
  await withFixtures(
    async ({ db, app, cookie, organizationId, projectId, environmentId, serverId, tag }) => {
      const inProject = await addPrincipal(db, organizationId, `proj_${tag}`, projectId)
      const withLogin = await addPrincipal(db, organizationId, `login_${tag}`, null)
      const [cluster] = await db
        .insert(managed)
        .values({
          environmentId,
          serverId,
          name: `DB2 ${tag}`,
          engine: 'postgres',
          status: 'ready',
        })
        .returning({ id: managed.id })
      await db.insert(login).values({
        recipe: 'app',
        managedId: cluster!.id,
        principalId: withLogin,
        role: 'user',
        username: `login_${tag}`,
        appliedUsername: `login_${tag}`,
      })

      const del = (id: string) =>
        app.request(`/organizations/${organizationId}/principals/${id}`, {
          method: 'DELETE',
          headers: { Cookie: cookie },
        })

      const a = await del(inProject)
      assertEquals(a.status, 409)
      assertEquals(((await a.json()) as { code: string }).code, 'principal_has_project')

      const b = await del(withLogin)
      assertEquals(b.status, 409)
      assertEquals(await b.json(), {
        error: 'principal_in_use',
        code: 'principal_in_use',
        usedBy: { tenancies: 0, bindings: 0, storages: 0, secrets: 0, logins: 1, folders: 0 },
      })

      const rows = await db
        .select({ id: principal.id })
        .from(principal)
        .where(inArray(principal.id, [inProject, withLogin]))
      assertEquals(rows.length, 2)
    }
  )
})

test('the active-organization header does not widen access to another organization', async () => {
  await withFixtures(async ({ db, app, outsiderCookie, organizationId, tag }) => {
    const orphan = await addPrincipal(db, organizationId, `hdr_${tag}`, null)
    const headers = { Cookie: outsiderCookie, 'x-organization-id': organizationId }
    const list = await app.request(`/organizations/${organizationId}/principals`, { headers })
    assertEquals(list.status, 404)
    const del = await app.request(`/organizations/${organizationId}/principals/${orphan}`, {
      method: 'DELETE',
      headers,
    })
    assertEquals(del.status, 404)
    assertEquals((await db.select().from(principal).where(eq(principal.id, orphan))).length, 1)
  })
})

test('DELETE /organizations/:id/principals/:principalId is org-scoped', async () => {
  await withFixtures(async ({ db, app, cookie, outsiderCookie, organizationId, tag }) => {
    const orphan = await addPrincipal(db, organizationId, `scoped_${tag}`, null)
    const outsider = await app.request(`/organizations/${organizationId}/principals/${orphan}`, {
      method: 'DELETE',
      headers: { Cookie: outsiderCookie },
    })
    assertEquals(outsider.status, 404)
    // A principal of this org addressed through a different organization id.
    const [other] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.name, `Other Org Principals ${tag}`))
    const crossed = await app.request(`/organizations/${other!.id}/principals/${orphan}`, {
      method: 'DELETE',
      headers: { Cookie: outsiderCookie },
    })
    assertEquals(crossed.status, 404)
    const missing = await app.request(
      `/organizations/${organizationId}/principals/${crypto.randomUUID()}`,
      { method: 'DELETE', headers: { Cookie: cookie } }
    )
    assertEquals(missing.status, 404)
    assertEquals((await db.select().from(principal).where(eq(principal.id, orphan))).length, 1)
  })
})

test('GET /servers/:id/principals lists placements with state and refuses other organizations', async () => {
  await withFixtures(
    async ({
      db,
      app,
      cookie,
      outsiderCookie,
      organizationId,
      projectId,
      serverId,
      otherServerId,
      tag,
    }) => {
      const a = await addPrincipal(db, organizationId, `on_a_${tag}`, projectId)
      const b = await addPrincipal(db, organizationId, `on_b_${tag}`, null)
      await db.insert(principalPlacement).values([
        {
          principalId: a,
          serverId,
          state: 'pending',
          uid: 15002,
          gid: 15002,
          home: '/h/a',
          source: 'compose',
        },
        {
          principalId: a,
          serverId: otherServerId,
          state: 'present',
          home: '/h/a',
          source: 'compose',
        },
        {
          principalId: b,
          serverId: otherServerId,
          state: 'present',
          home: '/h/b',
          source: 'manual',
        },
      ])
      const res = await app.request(`/servers/${serverId}/principals`, {
        headers: { Cookie: cookie },
      })
      assertEquals(res.status, 200)
      const body = (await res.json()) as {
        serverId: string
        principals: Array<{
          principalId: string
          state: string
          uid: number | null
          source: string
          usedBy: { otherPlacements: number }
        }>
      }
      assertEquals(body.serverId, serverId)
      assertEquals(body.principals.length, 1)
      assertEquals(body.principals[0]!.principalId, a)
      assertEquals(body.principals[0]!.state, 'pending')
      assertEquals(body.principals[0]!.uid, 15002)
      assertEquals(body.principals[0]!.usedBy.otherPlacements, 1)

      assertEquals(
        (
          await app.request(`/servers/${serverId}/principals`, {
            headers: { Cookie: outsiderCookie },
          })
        ).status,
        404
      )
      assertEquals((await app.request(`/servers/${serverId}/principals`)).status, 401)
      assertEquals(
        (
          await app.request(`/servers/${crypto.randomUUID()}/principals`, {
            headers: { Cookie: cookie },
          })
        ).status,
        404
      )
    }
  )
})

test('the principal routes answer 403 to a member who cannot manage the organization', async () => {
  await withFixtures(async ({ db, app, memberCookie, organizationId, serverId, tag }) => {
    const orphan = await addPrincipal(db, organizationId, `member_${tag}`, null)
    const headers = { Cookie: memberCookie }
    const list = await app.request(`/organizations/${organizationId}/principals`, { headers })
    const remove = await app.request(`/organizations/${organizationId}/principals/${orphan}`, {
      method: 'DELETE',
      headers,
    })
    const onServer = await app.request(`/servers/${serverId}/principals`, { headers })
    assertEquals([list.status, remove.status, onServer.status], [403, 403, 403])
    assertEquals((await db.select().from(principal).where(eq(principal.id, orphan))).length, 1)
  })
})

test('DELETE /organizations/:id/principals/:principalId refuses a principal a service runs as', async () => {
  await withFixtures(async ({ db, app, cookie, organizationId, environmentId, tag }) => {
    const busy = await addPrincipal(db, organizationId, `busy_${tag}`, null)
    const [svc] = await db
      .insert(service)
      .values({ name: 'web', environmentId, composeServiceName: 'web' })
      .returning({ id: service.id })
    await db.insert(tenancy).values({ principalId: busy, serviceId: svc!.id })

    const res = await app.request(`/organizations/${organizationId}/principals/${busy}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    assertEquals(res.status, 409)
    assertEquals(await res.json(), {
      error: 'principal_in_use',
      code: 'principal_in_use',
      usedBy: { tenancies: 1, bindings: 0, storages: 0, secrets: 0, logins: 0, folders: 0 },
    })
    assertEquals((await db.select().from(principal).where(eq(principal.id, busy))).length, 1)
  })
})
