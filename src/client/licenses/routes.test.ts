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
  license,
  member,
  organization,
  user,
} from '../../lib/db/schema.ts'
import { registerLicenseRoutes } from './routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'

import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

async function createLicenseTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerLicenseRoutes(app, { secrets, runtime: 'deno' })
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
    managerId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping license route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createLicenseTestApp(db)

  const managerEmail = `license-route-manager-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ displayName: 'License Route Test Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedManager = await db
    .insert(user)
    .values({ email: managerEmail, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const managerId = insertedManager[0]!.id

  await db.insert(member).values({ organizationId, userId: managerId })

  // The acting user is only an organization *manager*, never an owner.
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: managerId,
    permission: 'organization:manage',
    allow: true,
  })

  try {
    await fn({ db, app, secrets, managerId, organizationId })
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(member).where(eq(member.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, managerId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('POST /licenses is forbidden for an organization manager', async () => {
  await withTestFixtures(async ({ db, app, secrets, managerId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, managerId)
    const res = await app.request('/licenses', {
      method: 'POST',
      headers: {
        ...orgRequestHeaders(cookie, organizationId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    if (res.status !== 403) {
      throw new Error(`expected 403 creating a license as org manager, got ${res.status}`)
    }

    const rows = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.organizationId, organizationId))
    if (rows.length !== 0) {
      throw new Error('org manager must not be able to create a license')
    }
  })
})

test('DELETE /licenses/:id is forbidden for an organization manager', async () => {
  await withTestFixtures(async ({ db, app, secrets, managerId, organizationId }) => {
    const [existingLicense] = await db
      .insert(license)
      .values({ organizationId, token: `test-hash-${crypto.randomUUID()}` })
      .returning({ id: license.id })

    const cookie = await sessionCookie(db, secrets, managerId)
    const res = await app.request(`/licenses/${existingLicense!.id}`, {
      method: 'DELETE',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    if (res.status !== 403) {
      throw new Error(`expected 403 revoking a license as org manager, got ${res.status}`)
    }

    const rows = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(and(
        eq(license.id, existingLicense!.id),
        eq(license.organizationId, organizationId),
      ))
      .limit(1)
    if (rows[0]?.revokedAt) {
      throw new Error('org manager must not be able to revoke a license')
    }
  })
})
