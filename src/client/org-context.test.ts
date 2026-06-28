import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from './authn/crypto.ts'
import { createSession } from './authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './authn/secrets.ts'
import {
  grant,
  member,
  organization,
  team,
  teammate,
  user,
} from '../lib/db/schema.ts'
import { registerOrganizationRoutes } from './organizations/routes.ts'
import {
  canAccessOrganization,
  listAccessibleOrganizations,
  ORG_ID_HEADER,
  resolveOrgId,
} from './org-context.ts'

import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

async function createOrgTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerOrganizationRoutes(app, { secrets, runtime: 'deno' })
  app.get('/resolve-org', async (c) => {
    const userId = c.req.query('userId')
    if (!userId) {
      return c.json({ error: 'userId required' }, 400)
    }
    const result = await resolveOrgId(c, userId)
    if (result instanceof Response) {
      return result
    }
    return c.json({ organizationId: result })
  })
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

async function withTeamSubjectGrantFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    homeOrganizationId: string
    targetOrganizationId: string
    teamId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping org-context tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createOrgTestApp(db)

  const userEmail = `org-context-team-subject-${crypto.randomUUID()}@example.com`

  const [homeOrg] = await db
    .insert(organization)
    .values({ displayName: 'Org Context Home Org' })
    .returning({ id: organization.id })

  const [targetOrg] = await db
    .insert(organization)
    .values({ displayName: 'Org Context Target Org' })
    .returning({ id: organization.id })

  const homeOrganizationId = homeOrg!.id
  const targetOrganizationId = targetOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email: userEmail, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const userId = insertedUser!.id

  await db.insert(member).values({
    organizationId: homeOrganizationId,
    userId,
  })

  const [insertedTeam] = await db
    .insert(team)
    .values({ displayName: 'Org Context Team', organizationId: homeOrganizationId })
    .returning({ id: team.id })

  const teamId = insertedTeam!.id

  await db.insert(teammate).values({ teamId, userId })

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: targetOrganizationId,
    subjectType: 'team',
    subjectId: teamId,
    permission: 'organization:manage',
    allow: true,
  })

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      homeOrganizationId,
      targetOrganizationId,
      teamId,
    })
  } finally {
    await db.delete(grant).where(eq(grant.entityId, targetOrganizationId))
    await db.delete(teammate).where(and(eq(teammate.teamId, teamId), eq(teammate.userId, userId)))
    await db.delete(team).where(eq(team.id, teamId))
    await db.delete(member).where(
      and(eq(member.userId, userId), eq(member.organizationId, homeOrganizationId)),
    )
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, homeOrganizationId))
    await db.delete(organization).where(eq(organization.id, targetOrganizationId))
  }
}

Deno.test('team-scoped subject grant exposes target org via listAccessibleOrganizations', async () => {
  await withTeamSubjectGrantFixtures(async ({
    db,
    userId,
    homeOrganizationId,
    targetOrganizationId,
  }) => {
    const organizations = await listAccessibleOrganizations(db, userId)
    const ids = organizations.map((org) => org.id)

    if (!ids.includes(homeOrganizationId)) {
      throw new Error('home organization should remain accessible via membership')
    }
    if (!ids.includes(targetOrganizationId)) {
      throw new Error('team-scoped subject grant should expose target organization')
    }
  })
})

Deno.test('team-scoped subject grant allows resolveOrgId for target organization', async () => {
  await withTeamSubjectGrantFixtures(async ({
    db,
    app,
    userId,
    targetOrganizationId,
  }) => {
    const allowed = await canAccessOrganization(db, userId, targetOrganizationId)
    if (!allowed) {
      throw new Error('canAccessOrganization should accept team-scoped subject grant')
    }

    const response = await app.request(
      `/resolve-org?userId=${encodeURIComponent(userId)}`,
      {
        headers: {
          [ORG_ID_HEADER]: targetOrganizationId,
        },
      },
    )

    if (response.status !== 200) {
      const body = await response.text()
      throw new Error(`resolveOrgId expected 200, got ${response.status}: ${body}`)
    }

    const body = await response.json() as { organizationId: string }
    if (body.organizationId !== targetOrganizationId) {
      throw new Error('resolveOrgId should return the requested organization id')
    }
  })
})

Deno.test('GET /organizations includes org granted via team-scoped subject', async () => {
  await withTeamSubjectGrantFixtures(async ({
    app,
    secrets,
    db,
    userId,
    targetOrganizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await app.request('/organizations', {
      headers: { Cookie: cookie },
    })

    if (response.status !== 200) {
      const body = await response.text()
      throw new Error(`GET /organizations expected 200, got ${response.status}: ${body}`)
    }

    const body = await response.json() as { organizations: Array<{ id: string }> }
    if (!body.organizations.some((org) => org.id === targetOrganizationId)) {
      throw new Error('GET /organizations should include team-granted target organization')
    }
  })
})
