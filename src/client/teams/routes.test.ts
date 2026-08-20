import { assertEquals } from '@std/assert'
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
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { grant, organization, team, teammate, user } from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerTeamRoutes } from './routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createTeamRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerTeamRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
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

async function withTeamFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    managerId: string
    memberId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping team route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createTeamRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Team Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [manager] = await db
    .insert(user)
    .values({
      email: `team-manager-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const managerId = manager!.id

  const [member] = await db
    .insert(user)
    .values({
      email: `team-member-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const memberId = member!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: managerId,
    permission: 'organization:manage',
  })

  try {
    await fn({
      db,
      app,
      secrets,
      managerId,
      memberId,
      organizationId,
    })
  } finally {
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(grant).where(and(
      eq(grant.actorId, managerId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, managerId))
    await db.delete(user).where(eq(user.id, memberId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('GET /teams lists org teams for managers and hides them from regular members', async () => {
  await withTeamFixtures(async ({
    db,
    app,
    secrets,
    managerId,
    memberId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const insertedTeams = await db.insert(team).values([
      {
        organizationId,
        name: 'Platform',
        createdAt: now,
        updatedAt: now,
      },
      {
        organizationId,
        name: 'Support',
        createdAt: now,
        updatedAt: now,
      },
    ]).returning({ id: team.id, name: team.name })
    const platform = insertedTeams.find((row) => row.name === 'Platform')
    if (!platform) {
      throw new TypeError('expected Platform team')
    }
    await db.insert(teammate).values({ teamId: platform.id, userId: memberId })

    const managerCookie = await sessionCookie(db, secrets, managerId)
    const managerRes = await app.request('/teams', {
      headers: {
        Cookie: managerCookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(managerRes.status, 200)
    const managerBody = await managerRes.json() as {
      teams: Array<{ name: string | null }>
    }
    assertEquals(managerBody.teams.length, 2)
    const names = managerBody.teams
      .map((row) => row.name)
      .sort((a, b) => (a ?? '').localeCompare(b ?? ''))
    assertEquals(names, ['Platform', 'Support'])

    const memberCookie = await sessionCookie(db, secrets, memberId)
    const memberRes = await app.request('/teams', {
      headers: {
        Cookie: memberCookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(memberRes.status, 200)
    const memberBody = await memberRes.json() as { teams: unknown[] }
    assertEquals(memberBody.teams.length, 0)
  })
})

test('GET /teams returns an empty list when the org has no teams', async () => {
  await withTeamFixtures(async ({
    db,
    app,
    secrets,
    managerId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, managerId)
    const res = await app.request('/teams', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(res.status, 200)
    const body = await res.json() as { teams: unknown[] }
    assertEquals(body.teams.length, 0)
  })
})
