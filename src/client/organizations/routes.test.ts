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
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import {
  grant,
  member,
  organization,
  user,
} from '../../lib/db/schema.ts'
import { registerOrganizationRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createOrgRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerOrganizationRoutes(app, { secrets, runtime: 'deno' })
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

async function withOrgFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
  }) => Promise<void>,
  opts?: { withManageGrant?: boolean },
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      'Skipping organization route tests: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const withManageGrant = opts?.withManageGrant !== false
  const db = createDenoDb()
  const { app, secrets } = await createOrgRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Org Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `org-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })
  if (withManageGrant) {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
      allow: true,
    })
  }

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
    })
  } finally {
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

test('GET /organizations/:id/default-environment returns null before write', async () => {
  await withOrgFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(
      `/organizations/${organizationId}/default-environment`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { defaultEnvironmentName: null })
  })
})

test('PUT /organizations/:id/default-environment stores and GET echoes', async () => {
  await withOrgFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const putRes = await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: 'Staging' }),
      },
    )
    assertEquals(putRes.status, 200)
    assertEquals(await putRes.json(), {
      ok: true,
      defaultEnvironmentName: 'Staging',
    })

    const getRes = await app.request(
      `/organizations/${organizationId}/default-environment`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(getRes.status, 200)
    assertEquals(await getRes.json(), { defaultEnvironmentName: 'Staging' })
  })
})

test('PUT /organizations/:id/default-environment rejects invalid names', async () => {
  await withOrgFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: 'Staging' }),
      },
    )

    const illegal = await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: 'bad/name' }),
      },
    )
    assertEquals(illegal.status, 400)

    const blank = await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: '   ' }),
      },
    )
    assertEquals(blank.status, 400)

    const empty = await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: '' }),
      },
    )
    assertEquals(empty.status, 400)

    const tooLong = await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: 'a'.repeat(256) }),
      },
    )
    assertEquals(tooLong.status, 400)

    const getRes = await app.request(
      `/organizations/${organizationId}/default-environment`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(await getRes.json(), { defaultEnvironmentName: 'Staging' })
  })
})

test('PUT /organizations/:id/default-environment null resets to null', async () => {
  await withOrgFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: 'Staging' }),
      },
    )

    const reset = await app.request(
      `/organizations/${organizationId}/default-environment`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultEnvironmentName: null }),
      },
    )
    assertEquals(reset.status, 200)
    assertEquals(await reset.json(), {
      ok: true,
      defaultEnvironmentName: null,
    })

    const getRes = await app.request(
      `/organizations/${organizationId}/default-environment`,
      { headers: { Cookie: cookie } },
    )
    assertEquals(await getRes.json(), { defaultEnvironmentName: null })
  })
})

test('PUT /organizations/:id/default-environment forbids non-managers', async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: 'PUT',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ defaultEnvironmentName: 'Staging' }),
        },
      )
      assertEquals(res.status, 403)
    },
    { withManageGrant: false },
  )
})

test('POST /organizations creates an org owned by the signed-in user', async () => {
  await withOrgFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/organizations', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Second Organization' }),
    })
    assertEquals(res.status, 200)
    const body = await res.json() as { ok: true; id: string }
    assertEquals(body.ok, true)
    assertEquals(typeof body.id, 'string')

    const listRes = await app.request('/organizations', {
      headers: { Cookie: cookie },
    })
    assertEquals(listRes.status, 200)
    const listBody = await listRes.json() as {
      organizations: Array<{ id: string; displayName: string | null }>
    }
    const ids = listBody.organizations.map((org) => org.id)
    assertEquals(ids.includes(organizationId), true)
    assertEquals(ids.includes(body.id), true)

    const ownerGrant = await db
      .select({ id: grant.id })
      .from(grant)
      .where(
        and(
          eq(grant.entityType, 'organization'),
          eq(grant.entityId, body.id),
          eq(grant.actorType, 'user'),
          eq(grant.actorId, userId),
          eq(grant.permission, 'organization:own'),
          eq(grant.allow, true),
        ),
      )
      .limit(1)
    assertEquals(ownerGrant.length, 1)
  })
})
