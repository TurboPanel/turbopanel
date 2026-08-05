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
  grant,
  member,
  organization,
  principal,
  project,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { principalHomeDir } from '../../lib/naming.ts'
import { DEFAULT_PRINCIPAL_SHELL } from '../../lib/principal-options.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerProjectPrincipalRoutes } from './routes.ts'
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
    .values({ displayName: 'Principal Route Test Org' })
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

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Principal Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Principal Route Project',
      workspaceId,
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
    })
  } finally {
    await db.delete(principal).where(eq(principal.projectId, projectId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
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
