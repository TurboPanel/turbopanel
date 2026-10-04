import { assertEquals, assertMatch } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  tenancy,
  environment,
  grant,
  organization,
  principal,
  project,
  server,
  service,
  user,
  workspace,
} from '../../db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../db/workspace-kind.ts'
import { principalHomeDir } from '../../lib/naming.ts'
import { DEFAULT_PRINCIPAL_SHELL } from '../../features/principals/principal-options.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerOrganizationPrincipalDefaultsRoutes } from '../organizations/principal-defaults-routes.ts'
import { registerOrganizationRoutes } from '../organizations/routes.ts'
import {
  registerOrganizationLimitsRoutes,
  registerProjectPrincipalRoutes,
  registerServerLimitsRoutes,
} from './routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createPrincipalRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerProjectPrincipalRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  registerOrganizationLimitsRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  registerServerLimitsRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  registerOrganizationPrincipalDefaultsRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  registerOrganizationRoutes(app, {
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
  }) => Promise<void>
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
      organizationId,
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
    await db.delete(tenancy).where(eq(tenancy.serviceId, serviceId))
    await db.delete(principal).where(eq(principal.projectId, projectId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /projects/:projectId/principals persists default shell when options omitted', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
    const body = (await res.json()) as {
      ok: boolean
      id: string
      appliedUsername: string
      uid?: number
      gid?: number
    }
    assertEquals(body.ok, true)
    assertEquals(body.uid, undefined)
    assertEquals(body.gid, undefined)
    // Default org toggle on: the host account gets a random `_<11>` suffix.
    assertMatch(body.appliedUsername, /^appuser_[a-z0-9]{11}$/)

    const [row] = await db
      .select({
        options: principal.options,
        provider: principal.provider,
        metadata: principal.metadata,
        username: principal.username,
        appliedUsername: principal.appliedUsername,
      })
      .from(principal)
      .where(eq(principal.id, body.id))
      .limit(1)
    assertEquals(row?.options, { shell: DEFAULT_PRINCIPAL_SHELL, nameScheme: 'partial' })
    assertEquals(row?.provider, 'server')
    assertEquals(row?.username, 'appuser')
    assertEquals(row?.appliedUsername, body.appliedUsername)
    // Home follows the applied login — that's the account on the host.
    assertEquals(row?.metadata, { home: principalHomeDir(body.appliedUsername) })
  })
})

test('POST /projects/:projectId/principals rejects reserved usernames', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
    const body = (await res.json()) as { error: string }
    assertEquals(body.error, 'username_reserved')
  })
})

test('POST /projects/:projectId/principals rejects duplicate usernames in the org', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
    const body = (await second.json()) as { error: string }
    assertEquals(body.error, 'username_in_use')
  })
})

test('POST /projects/:projectId/principals serializes concurrent same-name creates', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
    const loserBody = (await loser.json()) as { error: string }
    assertEquals(loserBody.error, 'username_in_use')

    const rows = await db
      .select({ id: principal.id, username: principal.username })
      .from(principal)
      .where(eq(principal.projectId, projectId))
    assertEquals(rows.length, 1)
  })
})

test('POST /projects/:projectId/principals accepts max-length username and rejects overlong', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    // Default toggle on: 16 chars is the longest short name that still fits
    // the random `_<11>` applied suffix inside the 28-char host limit.
    const longestSuffixed = `u${'a'.repeat(15)}`
    assertEquals(longestSuffixed.length, 16)

    const ok = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: longestSuffixed }),
    })
    assertEquals(ok.status, 200)

    const tooLongForSuffix = `u${'a'.repeat(16)}`
    assertEquals(tooLongForSuffix.length, 17)
    const suffixBad = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: tooLongForSuffix }),
    })
    assertEquals(suffixBad.status, 400)
    assertEquals(await suffixBad.json(), { error: 'username_too_long' })

    // Toggle off: the full 28-char host limit applies to the bare name.
    await db
      .update(organization)
      .set({
        options: { randomizedPrincipalUsernames: false },
      })
      .where(eq(organization.id, organizationId))

    // 28 chars — longest that still fits `<username>-grp` in 32.
    const longest = `u${'a'.repeat(27)}`
    assertEquals(longest.length, 28)
    const okBare = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: longest }),
    })
    assertEquals(okBare.status, 200)

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
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
    const body = (await res.json()) as { error: string }
    assertEquals(body.error, 'Invalid request')
  })
})

test('POST /projects/:projectId/principals rejects non-object options', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
    const body = (await res.json()) as { error: string }
    assertEquals(body.error, 'Invalid request')
  })
})

test('GET /projects/:projectId/principals lists principals with serviceIds', async () => {
  await withPrincipalFixtures(
    async ({ db, app, secrets, userId, organizationId, projectId, serviceId }) => {
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
      const created = (await create.json()) as { id: string }

      const list = await app.request(`/projects/${projectId}/principals`, {
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(list.status, 200)
      const body = (await list.json()) as {
        principals: Array<{ id: string; username: string; serviceIds: string[] }>
      }
      assertEquals(body.principals.length, 1)
      assertEquals(body.principals[0]?.id, created.id)
      assertEquals(body.principals[0]?.username, 'deploy')
      assertEquals(body.principals[0]?.serviceIds, [serviceId])
    }
  )
})

test('POST /projects/:projectId/principals accepts uid and gid override', async () => {
  await withPrincipalFixtures(async ({ app, db, secrets, userId, organizationId, projectId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'customuid', uid: 15001, gid: 15001 }),
    })

    assertEquals(res.status, 200)
    const body = (await res.json()) as { ok: boolean; uid: number; gid: number }
    assertEquals(body.uid, 15001)
    assertEquals(body.gid, 15001)
  })
})

test('POST and DELETE /projects/:projectId/principals/:id/password round-trip', async () => {
  await withPrincipalFixtures(async ({ app, db, secrets, userId, organizationId, projectId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'pwuser' }),
    })
    assertEquals(create.status, 200)
    const created = (await create.json()) as { id: string }
    const passwordUrl = `/projects/${projectId}/principals/${created.id}/password`

    // No body password → generated, returned exactly once.
    const generated = await app.request(passwordUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    assertEquals(generated.status, 200)
    const generatedBody = (await generated.json()) as {
      ok: boolean
      generatedPassword?: string
    }
    assertEquals(generatedBody.ok, true)
    assertEquals(generatedBody.generatedPassword?.length, 20)

    // The row stores the crypt hash, never the plaintext.
    const [afterSet] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, created.id))
    assertEquals(afterSet!.password?.startsWith('$6$'), true)
    assertEquals(afterSet!.password?.includes(generatedBody.generatedPassword!), false)

    const listAfterSet = await app.request(`/projects/${projectId}/principals`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    const listedSet = (await listAfterSet.json()) as {
      principals: Array<{ id: string; passwordAuth: boolean }>
    }
    assertEquals(listedSet.principals[0]?.passwordAuth, true)

    // A supplied password is accepted and nothing comes back to display.
    const explicit = await app.request(passwordUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: 'correct horse battery' }),
    })
    assertEquals(explicit.status, 200)
    const explicitBody = (await explicit.json()) as {
      ok: boolean
      generatedPassword?: string
    }
    assertEquals(explicitBody.generatedPassword, undefined)

    // Disable drops the hash; the list flips back.
    const disable = await app.request(passwordUrl, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(disable.status, 200)
    const [afterClear] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, created.id))
    assertEquals(afterClear!.password, null)

    const listAfterClear = await app.request(`/projects/${projectId}/principals`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    const listedClear = (await listAfterClear.json()) as {
      principals: Array<{ id: string; passwordAuth: boolean }>
    }
    assertEquals(listedClear.principals[0]?.passwordAuth, false)
  })
})

test('POST /projects/:projectId/principals/:id/password rejects a weak or malformed value', async () => {
  await withPrincipalFixtures(async ({ app, db, secrets, userId, organizationId, projectId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    const create = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'pwreject' }),
    })
    const created = (await create.json()) as { id: string }
    const passwordUrl = `/projects/${projectId}/principals/${created.id}/password`

    for (const password of ['short', 'a'.repeat(129), 'has\ncontrol', 42]) {
      const res = await app.request(passwordUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password }),
      })
      assertEquals(res.status, 400, JSON.stringify(password))
      const body = (await res.json()) as { error: string }
      assertEquals(body.error, 'invalid_password')
    }

    // Nothing was stored by any rejected request.
    const [row] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, created.id))
    assertEquals(row!.password, null)
  })
})

test('PATCH /projects/:projectId/principals/:id updates serviceIds', async () => {
  await withPrincipalFixtures(
    async ({ app, db, secrets, userId, organizationId, projectId, serviceId }) => {
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
      const created = (await create.json()) as { id: string }

      const patch = await app.request(`/projects/${projectId}/principals/${created.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ serviceIds: [serviceId] }),
      })
      assertEquals(patch.status, 200)
      const patched = (await patch.json()) as { ok: boolean; serviceIds: string[] }
      assertEquals(patched.ok, true)
      assertEquals(patched.serviceIds, [serviceId])
    }
  )
})

test('PATCH /projects/:projectId/principals/:id requires serviceIds field', async () => {
  await withPrincipalFixtures(async ({ app, db, secrets, userId, organizationId, projectId }) => {
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
    const created = (await create.json()) as { id: string }

    const patch = await app.request(`/projects/${projectId}/principals/${created.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({}),
    })
    assertEquals(patch.status, 400)
  })
})

test('PATCH /projects/:projectId/principals/:id rejects invalid serviceIds', async () => {
  await withPrincipalFixtures(async ({ app, db, secrets, userId, organizationId, projectId }) => {
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
    const created = (await create.json()) as { id: string }

    const patch = await app.request(`/projects/${projectId}/principals/${created.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ serviceIds: ['not-a-uuid'] }),
    })
    assertEquals(patch.status, 400)
    const body = (await patch.json()) as { error: string }
    assertEquals(body.error, 'invalid_service_ids')
  })
})

test('DELETE /projects/:projectId/principals/:id removes principal', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
    const created = (await create.json()) as { id: string }

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
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
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
        organizationId,
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
    const created = (await create.json()) as { id: string }

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
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId }) => {
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
      .values({
        name: 'Foreign Project',
        workspaceId: otherWorkspace!.id,
        organizationId: otherOrg!.id,
      })
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
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId }) => {
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
      .values({ name: 'Platform Project', workspaceId: platformWorkspace!.id, organizationId })
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
    const body = (await res.json()) as { error: string }
    assertEquals(body.error, 'system_resource_immutable')

    await db.delete(project).where(eq(project.id, platformProject!.id))
    await db.delete(workspace).where(eq(workspace.id, platformWorkspace!.id))
  })
})

test('GET and PUT /organizations/:id/resource-limits round-trip limits', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId }) => {
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
    const putBody = (await put.json()) as {
      ok: boolean
      resourceLimits: { maxCpus: number; maxMemoryBytes: number }
    }
    assertEquals(putBody.ok, true)
    assertEquals(putBody.resourceLimits.maxCpus, 4)

    const get = await app.request(`/organizations/${organizationId}/resource-limits`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(get.status, 200)
    const getBody = (await get.json()) as {
      resourceLimits: { maxCpus: number; maxMemoryBytes: number }
    }
    assertEquals(getBody.resourceLimits.maxCpus, 4)
    assertEquals(getBody.resourceLimits.maxMemoryBytes, 8192)

    await db
      .delete(grant)
      .where(
        and(
          eq(grant.actorId, userId),
          eq(grant.entityId, organizationId),
          eq(grant.permission, 'organization:own')
        )
      )
  })
})

test('GET and PUT /servers/:id/resource-limits round-trip limits', async () => {
  await withPrincipalFixtures(async ({ app, db, secrets, userId, organizationId, serverId }) => {
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
    const putBody = (await put.json()) as {
      ok: boolean
      resourceLimits: { maxServicesPerEnvironment: number }
    }
    assertEquals(putBody.resourceLimits.maxServicesPerEnvironment, 10)

    const get = await app.request(`/servers/${serverId}/resource-limits`, { headers })
    assertEquals(get.status, 200)
    const getBody = (await get.json()) as {
      resourceLimits: { maxServicesPerEnvironment: number }
    }
    assertEquals(getBody.resourceLimits.maxServicesPerEnvironment, 10)
  })
})

test('PUT /organizations/:id/resource-limits returns 400 for invalid limits', async () => {
  await withPrincipalFixtures(async ({ app, db, secrets, userId, organizationId }) => {
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

    await db
      .delete(grant)
      .where(
        and(
          eq(grant.actorId, userId),
          eq(grant.entityId, organizationId),
          eq(grant.permission, 'organization:own')
        )
      )
  })
})

// ---------------------------------------------------------------------------
// Principal name schemes (plain / partial / random), org default and lock
// ---------------------------------------------------------------------------

type CreatedPrincipalBody = {
  ok: boolean
  id: string
  appliedUsername: string
  nameScheme: string
}

async function setOrgOptions(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  options: Record<string, unknown>
): Promise<void> {
  await db.update(organization).set({ options }).where(eq(organization.id, organizationId))
}

async function storedPrincipal(db: ReturnType<typeof createDenoDb>, id: string) {
  const [row] = await db
    .select({
      username: principal.username,
      appliedUsername: principal.appliedUsername,
      options: principal.options,
      metadata: principal.metadata,
    })
    .from(principal)
    .where(eq(principal.id, id))
    .limit(1)
  return row
}

test('POST principals: each scheme derives the system name on the server and keeps the typed name', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const headers = {
      Cookie: await sessionCookie(db, secrets, userId),
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    const create = async (body: Record<string, unknown>) =>
      await app.request(`/projects/${projectId}/principals`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

    // No scheme anywhere: the platform default is partial.
    const byDefault = await create({ username: 'dflt' })
    assertEquals(byDefault.status, 200)
    const dflt = (await byDefault.json()) as CreatedPrincipalBody
    assertEquals(dflt.nameScheme, 'partial')
    assertMatch(dflt.appliedUsername, /^dflt_[a-z0-9]{11}$/)

    const plainRes = await create({ username: 'plainone', nameScheme: 'plain' })
    const plain = (await plainRes.json()) as CreatedPrincipalBody
    assertEquals(plain.nameScheme, 'plain')
    assertEquals(plain.appliedUsername, 'plainone')

    // A client-supplied system name is ignored: the server derives it.
    const partialRes = await create({
      username: 'partone',
      nameScheme: 'partial',
      appliedUsername: 'evil',
    })
    const partial = (await partialRes.json()) as CreatedPrincipalBody
    assertMatch(partial.appliedUsername, /^partone_[a-z0-9]{11}$/)

    const randomRes = await create({ username: 'randone', nameScheme: 'random' })
    assertEquals(randomRes.status, 200)
    const random = (await randomRes.json()) as CreatedPrincipalBody
    assertEquals(random.nameScheme, 'random')
    assertMatch(random.appliedUsername, /^[a-z][a-z0-9]{11}$/)
    assertEquals(random.appliedUsername.includes('rand'), false)

    // Stored: display name stays typed, scheme on options, home follows the system name.
    const row = await storedPrincipal(db, random.id)
    assertEquals(row?.username, 'randone')
    assertEquals(row?.appliedUsername, random.appliedUsername)
    assertEquals(row?.options, { shell: DEFAULT_PRINCIPAL_SHELL, nameScheme: 'random' })
    assertEquals(row?.metadata, { home: principalHomeDir(random.appliedUsername) })

    // The list route reports both names and the scheme.
    const list = await app.request(`/projects/${projectId}/principals`, { headers })
    const listed = (
      (await list.json()) as {
        principals: { username: string; appliedUsername: string; nameScheme: string }[]
      }
    ).principals
    const listedRandom = listed.find((entry) => entry.username === 'randone')
    assertEquals(listedRandom?.nameScheme, 'random')
    assertEquals(listedRandom?.appliedUsername, random.appliedUsername)

    // Unknown scheme names are a 400 with a stable code.
    const bad = await create({ username: 'badscheme', nameScheme: 'full' })
    assertEquals(bad.status, 400)
    assertEquals(await bad.json(), { error: 'invalid_name_scheme' })
  })
})

test('POST principals: length limits follow the scheme (28 plain/random, 16 partial)', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const headers = {
      Cookie: await sessionCookie(db, secrets, userId),
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    const create = async (username: string, nameScheme: string) =>
      await app.request(`/projects/${projectId}/principals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ username, nameScheme }),
      })

    const longest = `u${'a'.repeat(27)}`
    assertEquals((await create(longest, 'plain')).status, 200)
    // Random keeps no trace of the typed name, so the typed name has the full room.
    assertEquals((await create(`v${'a'.repeat(27)}`, 'random')).status, 200)
    const tooLongForPartial = await create(`w${'a'.repeat(16)}`, 'partial')
    assertEquals(tooLongForPartial.status, 400)
    assertEquals(await tooLongForPartial.json(), { error: 'username_too_long' })
    assertEquals((await create(`x${'a'.repeat(28)}`, 'plain')).status, 400)
  })
})

test('POST principals: org default scheme and the legacy boolean fallback', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const headers = {
      Cookie: await sessionCookie(db, secrets, userId),
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    const create = async (username: string) =>
      (await (
        await app.request(`/projects/${projectId}/principals`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ username }),
        })
      ).json()) as CreatedPrincipalBody

    // Legacy `false` still means plain; legacy `true` still means partial.
    await setOrgOptions(db, organizationId, { randomizedPrincipalUsernames: false })
    const legacyOff = await create('legacyoff')
    assertEquals([legacyOff.nameScheme, legacyOff.appliedUsername], ['plain', 'legacyoff'])
    await setOrgOptions(db, organizationId, { randomizedPrincipalUsernames: true })
    assertEquals((await create('legacyon')).nameScheme, 'partial')

    // The new key wins over the legacy boolean.
    await setOrgOptions(db, organizationId, {
      principalNameScheme: 'random',
      randomizedPrincipalUsernames: false,
    })
    const random = await create('newkey')
    assertEquals(random.nameScheme, 'random')
    assertMatch(random.appliedUsername, /^[a-z][a-z0-9]{11}$/)
  })
})

test('principal-defaults: lock refuses another scheme at create, allows the locked one, never renames', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const headers = {
      Cookie: await sessionCookie(db, secrets, userId),
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    const create = async (body: Record<string, unknown>) =>
      await app.request(`/projects/${projectId}/principals`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    const putDefaults = async (body: Record<string, unknown>) =>
      await app.request(`/organizations/${organizationId}/principal-defaults`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      })

    // An existing principal created before any policy.
    const before = (await (
      await create({ username: 'before', nameScheme: 'partial' })
    ).json()) as CreatedPrincipalBody

    const locked = await putDefaults({ nameScheme: 'plain', schemeLocked: true })
    assertEquals(locked.status, 200)
    assertEquals(await locked.json(), {
      ok: true,
      nameScheme: 'plain',
      effectiveNameScheme: 'plain',
      schemeLocked: true,
      randomizedUsernames: null,
      effectiveRandomizedUsernames: false,
    })

    const refused = await create({ username: 'sneaky', nameScheme: 'random' })
    assertEquals(refused.status, 409)
    assertEquals(await refused.json(), { error: 'principal_scheme_locked' })
    const none = await db
      .select({ id: principal.id })
      .from(principal)
      .where(and(eq(principal.projectId, projectId), eq(principal.username, 'sneaky')))
    assertEquals(none.length, 0)

    // Asking for the locked scheme, or nothing, works and yields plain.
    const same = (await (
      await create({ username: 'same', nameScheme: 'plain' })
    ).json()) as CreatedPrincipalBody
    assertEquals(same.appliedUsername, 'same')
    const implicit = (await (await create({ username: 'implicit' })).json()) as CreatedPrincipalBody
    assertEquals([implicit.nameScheme, implicit.appliedUsername], ['plain', 'implicit'])

    // Turning the lock off lets a person pick again; turning it on again is fine.
    assertEquals((await putDefaults({ schemeLocked: false })).status, 200)
    const free = await create({ username: 'free', nameScheme: 'random' })
    assertEquals(free.status, 200)
    assertEquals((await putDefaults({ schemeLocked: true })).status, 200)
    assertEquals((await create({ username: 'again', nameScheme: 'random' })).status, 409)

    // Existing principals are never renamed by any of this.
    const after = await storedPrincipal(db, before.id)
    assertEquals(after?.appliedUsername, before.appliedUsername)
    assertEquals(after?.username, 'before')
    assertEquals((after?.options as { nameScheme?: string }).nameScheme, 'partial')

    const read = await app.request(`/organizations/${organizationId}/principal-defaults`, {
      headers,
    })
    assertEquals(read.status, 200)
    const readBody = (await read.json()) as { schemeLocked: boolean; effectiveNameScheme: string }
    assertEquals([readBody.schemeLocked, readBody.effectiveNameScheme], [true, 'plain'])
  })
})

test('principal-defaults: lock on the default scheme locks that default; invalid bodies are 400', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const headers = {
      Cookie: await sessionCookie(db, secrets, userId),
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }
    const putDefaults = async (body: unknown) =>
      await app.request(`/organizations/${organizationId}/principal-defaults`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      })

    // Lock alone (no explicit scheme) locks the effective default, partial.
    assertEquals((await putDefaults({ schemeLocked: true })).status, 200)
    const refused = await app.request(`/projects/${projectId}/principals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'nope', nameScheme: 'random' }),
    })
    assertEquals(refused.status, 409)

    for (const bad of [
      {},
      { nameScheme: 'full' },
      { schemeLocked: 'yes' },
      { randomizedUsernames: 'yes' },
    ]) {
      assertEquals((await putDefaults(bad)).status, 400)
    }

    // Legacy shorthand still writes through to the new key and retires the old one.
    await setOrgOptions(db, organizationId, { randomizedPrincipalUsernames: true })
    const legacy = await putDefaults({ randomizedUsernames: false })
    assertEquals(legacy.status, 200)
    const [org] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
    assertEquals(org?.options, { principalNameScheme: 'plain' })

    // null clears the scheme back to the platform default (partial), lock intact.
    assertEquals((await putDefaults({ schemeLocked: true })).status, 200)
    const cleared = await putDefaults({ nameScheme: null })
    assertEquals(await cleared.json(), {
      ok: true,
      nameScheme: null,
      effectiveNameScheme: 'partial',
      schemeLocked: true,
      randomizedUsernames: null,
      effectiveRandomizedUsernames: true,
    })
  })
})

test('principal-defaults: only an owner or manager may read or set them; other orgs cannot', async () => {
  await withPrincipalFixtures(async ({ db, app, secrets, organizationId }) => {
    const insertUser = async () => {
      const [row] = await db
        .insert(user)
        .values({
          email: `scheme-${crypto.randomUUID()}@example.com`,
          isEmailVerified: true,
          role: 'user',
        })
        .returning({ id: user.id })
      return row!.id
    }
    const memberId = await insertUser()
    const outsiderId = await insertUser()
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Scheme Outsider Org' })
      .returning({ id: organization.id })
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: otherOrg!.id,
      actorType: 'user',
      actorId: outsiderId,
      permission: 'organization:manage',
    })
    // A plain member of the org: no manage grant.
    const url = `/organizations/${organizationId}/principal-defaults`
    const attempt = async (actor: string, orgHeader: string, method: string) =>
      await app.request(url, {
        method,
        headers: {
          Cookie: await sessionCookie(db, secrets, actor),
          [ORG_ID_HEADER]: orgHeader,
          'Content-Type': 'application/json',
        },
        ...(method === 'PUT'
          ? { body: JSON.stringify({ nameScheme: 'random', schemeLocked: true }) }
          : {}),
      })

    for (const actor of [memberId, outsiderId]) {
      assertEquals((await attempt(actor, organizationId, 'PUT')).status, 403)
      assertEquals((await attempt(actor, organizationId, 'GET')).status, 403)
    }
    // The outsider manages their own org only: not this one, even with its own org header.
    assertEquals((await attempt(outsiderId, otherOrg!.id, 'PUT')).status, 403)

    const [org] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
    assertEquals(org?.options ?? null, null)

    await db.delete(grant).where(eq(grant.actorId, outsiderId))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
    await db.delete(user).where(eq(user.id, memberId))
    await db.delete(user).where(eq(user.id, outsiderId))
  })
})
